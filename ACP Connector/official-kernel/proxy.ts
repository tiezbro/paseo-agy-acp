import { performance } from "node:perf_hooks";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { TurnClaim, raceClaim, isTurnCancelled } from "../acp/session/turn-scheduler.js";
import { createOfficialAdmission, issueAdmittedOfficialPromptWrite } from "./admission-fence.js";
import { extractCwd, extractPromptText, extractSessionId, PaseoSessionContext } from "./context.js";
import { blankTurnError, officialResponseError, sessionUpdateShowsVisibleOutput, shouldRejectBlankTurn } from "./errors.js";
import { overlayProductIdentity } from "./identity.js";
import {
  isJsonRpcFailure,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcSuccess,
  isRecord,
  jsonRpcError,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest
} from "./json-rpc.js";
import { bridgeOfficialMcpServers, McpProtocolBridge } from "./mcp-protocol-bridge.js";
import { rewriteMcpServers } from "./mcp-rewrite.js";
import { rewriteModeFields } from "./mode-map.js";
import { createNdjsonParser, encodeNdjson } from "./ndjson.js";
import { augmentAvailableCommands, type AvailableCommand } from "./skill-commands.js";
import { SessionSkillMcpServer } from "./skill-mcp.js";
import { createKernelDiagnostics, createQueueFeedback, supportsSessionNotices } from "./observability.js";
import { SystemMessageFolder } from "./system-message-fold.js";

const INITIALIZE_METHOD = "initialize";
const SESSION_NEW_METHOD = "session/new";
const SESSION_LOAD_METHOD = "session/load";
const SESSION_RESUME_METHOD = "session/resume";
const SESSION_CLOSE_METHOD = "session/close";
const SESSION_PROMPT_METHOD = "session/prompt";
const SESSION_SET_MODE_METHOD = "session/set_mode";
const SESSION_SET_CONFIG_METHOD = "session/set_config_option";
const SESSION_SET_MODEL_METHOD = "session/set_model";
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
  readonly #requestedModels = new Map<JsonRpcId, { sessionId: string; model?: string; concrete: boolean }>();
  readonly #sessionModels = new Map<string, string>();
  readonly #sessionModelFallbacks = new Map<string, string>();
  readonly #sessionCwds = new Map<string, string>();
  readonly #systemMessageFolder = new SystemMessageFolder();
  readonly #env: NodeJS.ProcessEnv;
  readonly #context: PaseoSessionContext;
  readonly #skillMcp: SessionSkillMcpServer;
  readonly #diagnostics: ReturnType<typeof createKernelDiagnostics>;
  #notices = false;
  readonly #sessionSetup = new Map<JsonRpcId, { native: boolean; token?: string }>();
  readonly #skillTokens = new Map<string, string>();
  readonly #firstOutputs = new Map<JsonRpcId, () => void>();
  readonly #requestTimings = new Map<JsonRpcId, () => void>();
  readonly #admission;
  readonly #mcpBridge = new McpProtocolBridge();
  readonly #inFlight = new Set<Promise<void>>();
  #sessionNewTail: Promise<void> = Promise.resolve();
  #closed = false;
  #stopping = false;
  #drainingChild = false;
  #shutdown: ((error?: Error) => void) | undefined;
  readonly #cancelTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(options: OfficialKernelProxyOptions) {
    this.#child = options.child;
    this.#stdin = options.stdin;
    this.#stdout = options.stdout;
    this.#version = options.version;
    this.#env = options.env ?? process.env;
    this.#context = new PaseoSessionContext(this.#env);
    this.#skillMcp = new SessionSkillMcpServer(this.#env);
    this.#diagnostics = createKernelDiagnostics({ env: this.#env });
    this.#admission = createOfficialAdmission(this.#env);
  }

  start(): Promise<void> {
    this.#diagnostics.event("startup");
    const parseClient = createNdjsonParser((message) => {
      const task = this.#onClientMessage(message);
      this.#inFlight.add(task);
      void task.then(() => this.#inFlight.delete(task), () => this.#inFlight.delete(task));
    }, () => this.#writeClient({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid or oversized NDJSON message" } } as unknown as JsonRpcMessage));
    const parseChild = createNdjsonParser((message) => {
      this.#onChildMessage(message);
    }, () => {
      if (!this.#stopping) this.#shutdown?.(new Error("official kernel emitted invalid or oversized NDJSON"));
    });

    this.#stdin.on("data", parseClient);
    this.#child.stdout.on("data", parseChild);
    const endInput = () => { parseClient.end(); this.#shutdown?.(); };
    const endChild = () => parseChild.end();
    this.#stdin.on("end", endInput);

    return new Promise((resolve, reject) => {
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let failure: Error | undefined;
      const streamError = (error: Error) => this.#shutdown?.(error);
      const drainChild = () => { if (!this.#stopping) this.#stdin.resume(); };
      const drainClient = () => { if (!this.#closed) this.#child.stdout.resume(); };
      this.#child.stdin.on("drain", drainChild);
      this.#stdout.on("drain", drainClient);
      this.#shutdown = (error?: Error) => {
        failure ??= error;
        if (this.#closed || this.#stopping) return;
        this.#stopping = true;
        // 关闭时持续排空内核输出；客户端背压不能阻止 child 的 close。
        this.#child.stdout.resume();
        for (const claim of this.#claims.values()) claim.abort();
        this.#child.stdin.end();
        this.#child.kill?.("SIGTERM");
        killTimer = setTimeout(() => {
          if (!this.#closed) this.#child.kill?.("SIGKILL");
        }, 2_000);
        killTimer.unref?.();
      };
      this.#stdin.on("error", streamError);
      this.#stdout.on("error", streamError);
      this.#child.stdin.on("error", streamError);
      this.#child.stdout.on("error", streamError);
      this.#child.stdout.on("end", endChild);
      const finish = (error?: Error) => {
        if (this.#closed) return;
        this.#closed = true;
        if (killTimer) clearTimeout(killTimer);
        for (const timer of this.#cancelTimers.values()) clearTimeout(timer);
        this.#cancelTimers.clear();
        this.#child.stdin.off("drain", drainChild);
        this.#stdout.off("drain", drainClient);
        this.#stdin.off("error", streamError);
        this.#stdout.off("error", streamError);
        this.#child.stdin.off("error", streamError);
        this.#child.stdout.off("error", streamError);
        this.#child.stdout.off("end", endChild);
        this.#shutdown = undefined;
        this.#child.off("error", onError);
        this.#child.off("close", onClose);
        this.#child.off("exit", onExit);
        this.#stdin.off("data", parseClient);
        this.#stdin.off("end", endInput);
        this.#child.stdout.off("data", parseChild);
        for (const claim of this.#claims.values()) claim.abort();
        for (const [id, pending] of this.#pending) {
          pending.resolve(jsonRpcError(id, "official kernel connection closed"));
        }
        this.#pending.clear();
        void (async () => {
          try {
            await Promise.allSettled([this.#mcpBridge.close(), this.#skillMcp.close()]);
            await Promise.allSettled(this.#inFlight);
          } finally {
            this.#admission?.coordinator.close();
            this.#admission?.runtime.close();
            this.#claims.clear();
            this.#sessionCwds.clear();
            this.#sessionModels.clear();
            this.#sessionModelFallbacks.clear();
            this.#requestedModels.clear();
            this.#sessionSetup.clear();
            this.#skillTokens.clear();
            this.#requestTimings.clear();
            this.#firstOutputs.clear();
          }
          if (error) throw error;
        })().then(resolve, reject);
      };
      const onClose = () => finish(failure);
      const onExit = () => {
        // exit 后仍交付尾部响应，但不再让下游背压阻止 stdio 排空及 close。
        this.#drainingChild = true;
        this.#child.stdout.resume();
      };
      const onError = (error: Error) => {
        if (this.#child.pid !== undefined && typeof this.#child.kill === "function") this.#shutdown?.(error);
        else finish(error);
      };
      this.#child.once("error", onError);
      // close 在 stdio 排空后触发，避免 exit 时丢失最后一条内核响应。
      this.#child.once("close", onClose);
      this.#child.once("exit", onExit);
    });
  }

  close(): void { this.#shutdown?.(); }

  #writeClient(message: JsonRpcMessage): void {
    if (this.#closed || this.#stopping) return;
    if (!this.#stdout.write(encodeNdjson(message)) && !this.#drainingChild) this.#child.stdout.pause();
  }

  #writeChild(message: JsonRpcMessage): void {
    if (this.#closed || this.#stopping) throw new Error("official kernel connection closed");
    if (!this.#child.stdin.write(encodeNdjson(message), (error) => {
      if (error) this.#shutdown?.(error);
    })) this.#stdin.pause();
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
        const setup = this.#sessionSetup.get(message.id);
        if (setup?.token) this.#skillMcp.release(setup.token);
        this.#sessionSetup.delete(message.id);
        this.#writeClient(
          jsonRpcError(message.id, error instanceof Error ? error.message : "official kernel proxy failed")
        );
      }
    }
  }

  #onClientNotification(message: JsonRpcMessage & { method: string }): void {
    if (message.method === SESSION_CANCEL_METHOD) {
      const sessionId = extractSessionId("params" in message ? message.params : undefined);
      if (sessionId) {
        this.#claims.get(sessionId)?.abort();
        const dispatched = Array.from(this.#pending.values()).some(pending => pending.method === SESSION_PROMPT_METHOD && pending.sessionId === sessionId);
        if (dispatched && !this.#cancelTimers.has(sessionId)) {
          const configured = Number(this.#env.AGY_ACP_CANCEL_TIMEOUT_MS);
          const timeout = Number.isSafeInteger(configured) && configured > 0 ? configured : 30_000;
          const timer = setTimeout(() => this.#shutdown?.(new Error("official kernel did not acknowledge cancellation")), timeout);
          timer.unref?.();
          this.#cancelTimers.set(sessionId, timer);
        }
        for (const update of this.#systemMessageFolder.finish(sessionId)) this.#writeClient(update);
      }
    }
    this.#writeChild(message);
  }

  async #onClientRequest(request: JsonRpcRequest): Promise<void> {
    let params = request.params;
    if (request.method === INITIALIZE_METHOD) {
      this.#notices = supportsSessionNotices(params);
      this.#requestTimings.set(request.id, this.#diagnostics.start("initialize", { requestId: request.id }));
    }
    if (request.method === SESSION_NEW_METHOD || request.method === SESSION_LOAD_METHOD || request.method === SESSION_RESUME_METHOD) {
      const cwd = extractCwd(params, this.#env);
      if (cwd && isRecord(params)) params = { ...params, cwd };
      else if (cwd && params === undefined) params = { cwd };
      this.#requestTimings.set(request.id, this.#diagnostics.start("session_setup", { requestId: request.id }));
      const prepared = await this.#context.prepareSession(params);
      params = prepared.params;
      const setup: { native: boolean; token?: string } = { native: prepared.native };
      this.#sessionSetup.set(request.id, setup);
      if (isRecord(params)) {
        const servers = Array.isArray(params.mcpServers) ? params.mcpServers : [];
        const names = new Set(servers.flatMap(server => isRecord(server) && typeof server.name === "string" ? [server.name] : []));
        let name = "paseo_skills";
        for (let suffix = 2; names.has(name); suffix++) name = `paseo_skills_${suffix}`;
        const skills = await this.#skillMcp.register(cwd);
        setup.token = skills.token;
        params = { ...params, mcpServers: [...servers, { ...skills.server, name }] };
      }
      if (this.#closed || this.#stopping) return;
    }
    if (request.method === SESSION_NEW_METHOD) {
      params = await bridgeOfficialMcpServers(rewriteMcpServers(rewriteModeFields(params)), this.#mcpBridge);
      await this.#forwardSessionNew(request, params);
      return;
    } else if (
      request.method === SESSION_LOAD_METHOD ||
      request.method === SESSION_RESUME_METHOD
    ) {
      params = await bridgeOfficialMcpServers(rewriteMcpServers(params), this.#mcpBridge);
      const sessionId = extractSessionId(params);
      const cwd = extractCwd(params, this.#env);
      if (sessionId && cwd) {
        this.#sessionCwds.set(sessionId, cwd);
      }
    } else if (request.method === SESSION_SET_MODE_METHOD || request.method === SESSION_SET_CONFIG_METHOD) {
      params = rewriteModeFields(params);
      if (isRecord(params) && typeof params.value === "string") {
        const optionId = params.configId ?? params.id;
        const sessionId = extractSessionId(params);
        if (sessionId && (optionId === "model" || optionId === "thinking_level")) {
          this.#requestedModels.set(request.id, {
            sessionId, model: optionId === "model" ? params.value : undefined, concrete: false
          });
        }
      }
    } else if (request.method === SESSION_SET_MODEL_METHOD) {
      const sessionId = extractSessionId(params);
      if (sessionId && isRecord(params) && typeof params.modelId === "string" && params.modelId.length > 0) {
        this.#requestedModels.set(request.id, { sessionId, model: params.modelId, concrete: true });
      }
    } else if (request.method === SESSION_PROMPT_METHOD) {
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
    if (this.#closed) return;
    const sessionId = extractSessionId(params);
    if (sessionId && this.#claims.has(sessionId)) throw new Error("session already has an active prompt");
    const claim = new TurnClaim("foreground");
    if (sessionId) this.#claims.set(sessionId, claim);
    let responseDelivered = false;
    const turnStartedAt = performance.now();
    let terminalStage: "turn_end" | "turn_fail" | "turn_cancel" = "turn_end";
    let finishAdmissionWait: (() => void) | undefined;
    const firstOutputDone = this.#diagnostics.start("first_kernel_output", { requestId: request.id, sessionId });
    this.#firstOutputs.set(request.id, firstOutputDone);
    try {
      const contextDone = this.#diagnostics.start("daemon_context", { requestId: request.id, sessionId });
      try { params = rewriteModeFields(await raceClaim(this.#context.injectPrompt(params), claim)); }
      finally { contextDone(); }
      if (claim.aborted) {
        this.#writeClient({ jsonrpc: "2.0", id: request.id, result: { stopReason: "cancelled" } });
        return;
      }
      if (this.#closed) return;
      const promptText = extractPromptText(params) || "prompt";
      const rewritten: JsonRpcRequest = { ...request, jsonrpc: "2.0", params };
      const coordinator = this.#admission?.coordinator;
      const processId = this.#child.pid;

      if (coordinator === undefined || processId === undefined) {
        const response = this.#track(rewritten.id, rewritten.method, params);
        claim.throwIfAborted();
        this.#writeChild(rewritten);
        const result = await response;
        responseDelivered = true;
        if (isJsonRpcFailure(result)) terminalStage = "turn_fail";
      else if (isJsonRpcSuccess(result) && isRecord(result.result) && result.result.stopReason === "cancelled") terminalStage = "turn_cancel";
        return;
      }

      let wrote = false;
      const feedback = createQueueFeedback({ notices: this.#notices });
      let queued = false;
      const admissionWaitDone = this.#diagnostics.start("admission_wait", { requestId: request.id, sessionId });
      let admissionWaitFinished = false;
      const admitted = () => {
        if (admissionWaitFinished) return;
        admissionWaitFinished = true;
        admissionWaitDone();
      };
      finishAdmissionWait = admitted;
      const stopReason = await coordinator.admit({
        sessionId: sessionId ?? "session",
        model: (sessionId && (this.#sessionModels.get(sessionId) || this.#sessionModelFallbacks.get(sessionId))) || "unknown",
        promptText,
        claim,
        reportProgress: (progress) => {
          if (!sessionId || claim.aborted) return;
          queued = true;
          const update = feedback(sessionId, progress);
          if (update) this.#writeClient(update);
        },
        execute: async (boundary) => {
          admitted();
          if (queued && sessionId && !claim.aborted) {
            const update = feedback(sessionId, { state: "running" });
            if (update) this.#writeClient(update);
          }
          const response = this.#track(rewritten.id, rewritten.method, params);
          issueAdmittedOfficialPromptWrite(boundary, processId, () => {
            wrote = true;
            this.#writeChild(rewritten);
          });
          const result = await response;
          responseDelivered = true;
          // 断连只用于解开等待；已派发轮次仍交给 Admission 的恢复路径结算。
          if (this.#closed) throw new Error("official kernel connection closed during prompt");
          if (isJsonRpcFailure(result)) throw officialResponseError(result);
          const cancelled = isJsonRpcSuccess(result) && isRecord(result.result) && result.result.stopReason === "cancelled";
          return { stopReason: claim.aborted || cancelled ? "cancelled" : "end_turn" };
        }
      });
      if (stopReason === "cancelled") terminalStage = "turn_cancel";
      if (!wrote) {
        this.#writeClient({
          jsonrpc: "2.0",
          id: request.id,
          result: { stopReason: stopReason === "cancelled" ? "cancelled" : "end_turn" }
        });
      }
    } catch (error) {
      terminalStage = isTurnCancelled(error) ? "turn_cancel" : "turn_fail";
      if (!responseDelivered && isTurnCancelled(error)) {
        this.#writeClient({ jsonrpc: "2.0", id: request.id, result: { stopReason: "cancelled" } });
      } else if (!responseDelivered) throw error;
    } finally {
      finishAdmissionWait?.();
      if (sessionId && this.#claims.get(sessionId) === claim) {
        const timer = this.#cancelTimers.get(sessionId);
        if (timer) clearTimeout(timer);
        this.#cancelTimers.delete(sessionId);
        if (this.#claims.get(sessionId) === claim) this.#claims.delete(sessionId);
      }
      if (this.#firstOutputs.get(request.id) === firstOutputDone) this.#firstOutputs.delete(request.id);
      if (terminalStage === "turn_end" && claim.aborted) terminalStage = "turn_cancel";
      this.#diagnostics.event(terminalStage, { requestId: request.id, sessionId, durationMs: performance.now() - turnStartedAt });
      claim.markReleased();
    }
  }

  #track(id: JsonRpcId, method: string, params: unknown): Promise<JsonRpcMessage> {
    if (this.#closed) return Promise.resolve(jsonRpcError(id, "official kernel connection closed"));
    return new Promise((resolve) => {
      this.#pending.set(id, {
        method,
        sessionId: extractSessionId(params),
        cwd: extractCwd(params, this.#env),
        sawVisibleOutput: false,
        resolve
      });
    });
  }

  #rememberModel(sessionId: string, value: unknown): void {
    if (!isRecord(value)) return;
    const models = isRecord(value.models) ? value.models : {};
    const direct = value.modelId ?? value.currentModelId ?? models.currentModelId;
    if (typeof direct === "string" && direct.length > 0) this.#sessionModels.set(sessionId, direct);
    if (Array.isArray(value.configOptions)) {
      for (const option of value.configOptions) {
        if (isRecord(option) && (option.category === "model" || option.id === "model") && typeof option.currentValue === "string") {
          this.#sessionModelFallbacks.set(sessionId, option.currentValue);
        }
      }
    }
  }

  #onChildMessage(message: JsonRpcMessage): void {
    if (isJsonRpcNotification(message) && message.method === SESSION_UPDATE_METHOD) {
      const sessionId = extractSessionId(message.params);
      if (sessionId && isRecord(message.params)) this.#rememberModel(sessionId, message.params.update);
      if (sessionUpdateShowsVisibleOutput(message.params)) {
        for (const [id, pending] of this.#pending) {
          if (
            pending.method === SESSION_PROMPT_METHOD &&
            (pending.sessionId === undefined || pending.sessionId === sessionId)
          ) {
            pending.sawVisibleOutput = true;
            this.#firstOutputs.get(id)?.();
            this.#firstOutputs.delete(id);
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
        const augmented = augmentAvailableCommands(params.update.availableCommands, cwd, this.#env);
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

      const outboundUpdates = this.#systemMessageFolder.transform(message);
      for (const updateMessage of outboundUpdates) {
        this.#writeClient(updateMessage);
      }
      return;
    }

    if (isJsonRpcSuccess(message) || isJsonRpcFailure(message)) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) {
        this.#writeClient(message);
        return;
      }
      this.#pending.delete(message.id);
      if (pending.method === SESSION_PROMPT_METHOD && pending.sessionId) {
        // 回包前同步释放：客户端可在收到终态的同一调用栈开始下一轮。
        const timer = this.#cancelTimers.get(pending.sessionId);
        if (timer) clearTimeout(timer);
        this.#cancelTimers.delete(pending.sessionId);
        this.#claims.delete(pending.sessionId);
      }
      const requestedModel = this.#requestedModels.get(message.id);
      this.#requestedModels.delete(message.id);
      if (requestedModel && isJsonRpcSuccess(message)) {
        // 显式配置切换可能只返回家族；不能沿用切换前的具体 ID。
        if (!requestedModel.concrete) this.#sessionModels.delete(requestedModel.sessionId);
        if (requestedModel.model !== undefined) {
          const models = requestedModel.concrete ? this.#sessionModels : this.#sessionModelFallbacks;
          models.set(requestedModel.sessionId, requestedModel.model);
        }
      }
      this.#requestTimings.get(message.id)?.();
      this.#requestTimings.delete(message.id);
      const setup = this.#sessionSetup.get(message.id);
      this.#sessionSetup.delete(message.id);
      if (setup?.token && isJsonRpcFailure(message)) this.#skillMcp.release(setup.token);
      let outbound: JsonRpcMessage = message;
      if (pending.method === INITIALIZE_METHOD && isJsonRpcSuccess(message)) {
        this.#context.observeInitialize(message.result);
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
        if (sessionId) {
          this.#rememberModel(sessionId, message.result);
          if (setup) this.#context.bindSession(sessionId, setup.native);
          const previousToken = this.#skillTokens.get(sessionId);
          if (previousToken) this.#skillMcp.release(previousToken);
          if (setup?.token) this.#skillTokens.set(sessionId, setup.token);
          else this.#skillTokens.delete(sessionId);
        } else if (setup?.token) this.#skillMcp.release(setup.token);
      } else if (pending.method === SESSION_CLOSE_METHOD && isJsonRpcSuccess(message) && pending.sessionId) {
        // 只在内核确认关闭后撤销该会话的能力，不能影响同进程的其他会话。
        const sessionId = pending.sessionId;
        const token = this.#skillTokens.get(sessionId);
        if (token) this.#skillMcp.release(token);
        this.#skillTokens.delete(sessionId);
        this.#sessionCwds.delete(sessionId);
        this.#sessionModels.delete(sessionId);
        this.#sessionModelFallbacks.delete(sessionId);
        this.#context.forgetSession(sessionId);
        this.#systemMessageFolder.reset(sessionId);
      } else if (
        pending.method === SESSION_PROMPT_METHOD
      ) {
        for (const update of this.#systemMessageFolder.finish(pending.sessionId)) this.#writeClient(update);
        if (
          isJsonRpcSuccess(message) &&
          shouldRejectBlankTurn(message.result, pending.sawVisibleOutput)
        ) {
          outbound = blankTurnError(message.id);
        }
      }
      if (isJsonRpcSuccess(message) && pending.sessionId && (pending.method === SESSION_SET_CONFIG_METHOD || pending.method === SESSION_SET_MODEL_METHOD)) {
        this.#rememberModel(pending.sessionId, message.result);
      }
      this.#writeClient(outbound);
      pending.resolve(outbound);
      return;
    }

    this.#writeClient(message);
  }
}
