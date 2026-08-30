import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { TurnClaim } from "../acp/session/turn-scheduler.js";
import { createOfficialAdmission, issueAdmittedOfficialPromptWrite } from "./admission-fence.js";
import { extractCwd, extractPromptText, extractSessionId, injectPaseoContext } from "./context.js";
import { blankTurnError, sessionUpdateShowsVisibleOutput, shouldRejectBlankTurn } from "./errors.js";
import { overlayProductIdentity } from "./identity.js";
import {
  isJsonRpcFailure,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcSuccess,
  jsonRpcError,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest
} from "./json-rpc.js";
import { rewriteMcpServers } from "./mcp-rewrite.js";
import { rewriteModeFields } from "./mode-map.js";
import { createNdjsonParser, encodeNdjson } from "./ndjson.js";
import { augmentAvailableCommands, type AvailableCommand } from "./skill-commands.js";

const INITIALIZE_METHOD = "initialize";
const SESSION_NEW_METHOD = "session/new";
const SESSION_LOAD_METHOD = "session/load";
const SESSION_RESUME_METHOD = "session/resume";
const SESSION_PROMPT_METHOD = "session/prompt";
const SESSION_SET_MODE_METHOD = "session/set_mode";
const SESSION_SET_CONFIG_METHOD = "session/set_config_option";
const SESSION_CANCEL_METHOD = "session/cancel";
const SESSION_UPDATE_METHOD = "session/update";

interface PendingClientRequest {
  method: string;
  sessionId?: string;
  cwd?: string;
  sawVisibleOutput: boolean;
  resolve: (message: JsonRpcMessage) => void;
}

export interface OfficialKernelProxyOptions {
  child: ChildProcessWithoutNullStreams;
  stdin: Readable;
  stdout: Writable;
  env?: NodeJS.ProcessEnv;
  version: string;
}

export class OfficialKernelProxy {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #stdin: Readable;
  readonly #stdout: Writable;
  readonly #version: string;
  readonly #pending = new Map<JsonRpcId, PendingClientRequest>();
  readonly #claims = new Map<string, TurnClaim>();
  readonly #sessionCwds = new Map<string, string>();
  readonly #env: NodeJS.ProcessEnv;
  readonly #admission;
  #sessionNewTail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: OfficialKernelProxyOptions) {
    this.#child = options.child;
    this.#stdin = options.stdin;
    this.#stdout = options.stdout;
    this.#version = options.version;
    this.#env = options.env ?? process.env;
    this.#admission = createOfficialAdmission(this.#env);
  }

  start(): Promise<void> {
    const parseClient = createNdjsonParser((message) => {
      void this.#onClientMessage(message);
    });
    const parseChild = createNdjsonParser((message) => {
      this.#onChildMessage(message);
    });

    this.#stdin.on("data", parseClient);
    this.#child.stdout.on("data", parseChild);
    this.#stdin.on("end", () => this.#child.stdin.end());

    return new Promise((resolve, reject) => {
      const finish = () => {
        if (this.#closed) return;
        this.#closed = true;
        this.#admission?.coordinator.close();
        this.#admission?.runtime.close();
        resolve();
      };
      this.#child.once("error", reject);
      this.#child.once("exit", finish);
    });
  }

  #writeClient(message: JsonRpcMessage): void {
    this.#stdout.write(encodeNdjson(message));
  }

  #writeChild(message: JsonRpcMessage): void {
    this.#child.stdin.write(encodeNdjson(message));
  }

  async #onClientMessage(message: JsonRpcMessage): Promise<void> {
    try {
      if (isJsonRpcNotification(message)) {
        this.#onClientNotification(message);
        return;
      }
      if (!isJsonRpcRequest(message)) {
        this.#writeChild(message);
        return;
      }
      await this.#onClientRequest(message);
    } catch (error) {
      if (isJsonRpcRequest(message)) {
        this.#writeClient(
          jsonRpcError(message.id, error instanceof Error ? error.message : "official kernel proxy failed")
        );
      }
    }
  }

  #onClientNotification(message: JsonRpcMessage & { method: string }): void {
    if (message.method === SESSION_CANCEL_METHOD) {
      const sessionId = extractSessionId("params" in message ? message.params : undefined);
      if (sessionId) this.#claims.get(sessionId)?.abort();
    }
    this.#writeChild(message);
  }

  async #onClientRequest(request: JsonRpcRequest): Promise<void> {
    let params = request.params;
    if (request.method === SESSION_NEW_METHOD) {
      params = rewriteMcpServers(rewriteModeFields(params));
      await this.#forwardSessionNew(request, params);
      return;
    } else if (
      request.method === SESSION_LOAD_METHOD ||
      request.method === SESSION_RESUME_METHOD
    ) {
      const sessionId = extractSessionId(params);
      const cwd = extractCwd(params);
      if (sessionId && cwd) {
        this.#sessionCwds.set(sessionId, cwd);
      }
    } else if (request.method === SESSION_SET_MODE_METHOD || request.method === SESSION_SET_CONFIG_METHOD) {
      params = rewriteModeFields(params);
    } else if (request.method === SESSION_PROMPT_METHOD) {
      params = rewriteModeFields(await injectPaseoContext(params, this.#env));
      await this.#handlePrompt(request, params);
      return;
    }

    this.#track(request.id, request.method, params);
    this.#writeChild({ ...request, jsonrpc: "2.0", params });
  }

  // Early session updates have no request id, so keep only one unbound cwd in flight.
  async #forwardSessionNew(request: JsonRpcRequest, params: unknown): Promise<void> {
    const previous = this.#sessionNewTail;
    let release!: () => void;
    this.#sessionNewTail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      const response = this.#track(request.id, request.method, params);
      this.#writeChild({ ...request, jsonrpc: "2.0", params });
      await response;
    } finally {
      release();
    }
  }

  async #handlePrompt(request: JsonRpcRequest, params: unknown): Promise<void> {
    const sessionId = extractSessionId(params);
    const promptText = extractPromptText(params) || "prompt";
    const rewritten: JsonRpcRequest = { ...request, jsonrpc: "2.0", params };
    const coordinator = this.#admission?.coordinator;
    const processId = this.#child.pid;

    if (coordinator === undefined || processId === undefined) {
      this.#track(rewritten.id, rewritten.method, params);
      this.#writeChild(rewritten);
      return;
    }

    const claim = new TurnClaim("foreground");
    if (sessionId) this.#claims.set(sessionId, claim);
    let wrote = false;
    try {
      const stopReason = await coordinator.admit({
        sessionId: sessionId ?? "session",
        model: "official",
        promptText,
        claim,
        execute: async (boundary) => {
          const response = this.#track(rewritten.id, rewritten.method, params);
          issueAdmittedOfficialPromptWrite(boundary, processId, () => {
            wrote = true;
            this.#writeChild(rewritten);
          });
          await response;
          return { stopReason: claim.aborted ? "cancelled" : "end_turn" };
        }
      });
      if (!wrote) {
        this.#writeClient({
          jsonrpc: "2.0",
          id: request.id,
          result: { stopReason: stopReason === "cancelled" ? "cancelled" : "end_turn" }
        });
      }
    } finally {
      if (sessionId) this.#claims.delete(sessionId);
    }
  }

  #track(id: JsonRpcId, method: string, params: unknown): Promise<JsonRpcMessage> {
    return new Promise((resolve) => {
      this.#pending.set(id, {
        method,
        sessionId: extractSessionId(params),
        cwd: extractCwd(params),
        sawVisibleOutput: false,
        resolve
      });
    });
  }

  #onChildMessage(message: JsonRpcMessage): void {
    if (isJsonRpcNotification(message) && message.method === SESSION_UPDATE_METHOD) {
      const sessionId = extractSessionId(message.params);
      if (sessionUpdateShowsVisibleOutput(message.params)) {
        for (const pending of this.#pending.values()) {
          if (
            pending.method === SESSION_PROMPT_METHOD &&
            (pending.sessionId === undefined || pending.sessionId === sessionId)
          ) {
            pending.sawVisibleOutput = true;
          }
        }
      }

      const params = message.params as
        | {
            sessionId?: string;
            update?: {
              sessionUpdate?: string;
              availableCommands?: AvailableCommand[];
            };
          }
        | undefined;

      if (params?.update?.sessionUpdate === "available_commands_update") {
        let cwd = sessionId ? this.#sessionCwds.get(sessionId) : undefined;
        if (!cwd) {
          const pendingSessionNews = Array.from(this.#pending.values()).filter(
            (pending): pending is PendingClientRequest & { cwd: string } =>
              pending.method === SESSION_NEW_METHOD && pending.cwd !== undefined
          );
          if (pendingSessionNews.length === 1) {
            cwd = pendingSessionNews[0].cwd;
            if (sessionId) {
              this.#sessionCwds.set(sessionId, cwd);
            }
          }
        }
        const augmented = augmentAvailableCommands(params.update.availableCommands, cwd);
        message = {
          ...message,
          params: {
            ...params,
            update: {
              ...params.update,
              availableCommands: augmented
            }
          }
        };
      }

      this.#writeClient(message);
      return;
    }

    if (isJsonRpcSuccess(message) || isJsonRpcFailure(message)) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) {
        this.#writeClient(message);
        return;
      }
      this.#pending.delete(message.id);
      let outbound: JsonRpcMessage = message;
      if (pending.method === INITIALIZE_METHOD && isJsonRpcSuccess(message)) {
        outbound = { ...message, result: overlayProductIdentity(message.result, this.#version) };
      } else if (
        (pending.method === SESSION_NEW_METHOD ||
          pending.method === SESSION_LOAD_METHOD ||
          pending.method === SESSION_RESUME_METHOD) &&
        isJsonRpcSuccess(message)
      ) {
        const sessionId = extractSessionId(message.result) ?? pending.sessionId;
        if (sessionId && pending.cwd) {
          this.#sessionCwds.set(sessionId, pending.cwd);
        }
      } else if (
        pending.method === SESSION_PROMPT_METHOD &&
        isJsonRpcSuccess(message) &&
        shouldRejectBlankTurn(message.result, pending.sawVisibleOutput)
      ) {
        outbound = blankTurnError(message.id);
      }
      this.#writeClient(outbound);
      pending.resolve(outbound);
      return;
    }

    this.#writeClient(message);
  }
}

