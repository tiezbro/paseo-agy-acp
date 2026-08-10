// ACP session/prompt: user message, agent execution loop, permission requests.
// Docs: https://agentclientprotocol.com/protocol/v1/prompt-turn
//
// Turn ownership (who may talk to agy, and when) lives in `turn-scheduler.ts`.
// Every accepted request here follows the same shape:
//
//   claim the slot (synchronously)  ->  runTurnBody  ->  exactly one terminal
//
// `runTurnBody` is shared by all five entry points (v1 foreground, v1 queued,
// v2 foreground, v2 queued, v2 steer) so a fix lands in one place instead of
// five. Cancellation unwinds by throwing, so no path can "forget" to re-check.

import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";
import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import type {
  AgentContext as V1AgentContext,
  PromptRequest as V1PromptRequest,
  PromptResponse as V1PromptResponse
} from "@agentclientprotocol/sdk";
import type {
  AgentContext as V2AgentContext,
  PromptRequest as V2PromptRequest,
  PromptResponse as V2PromptResponse
} from "@agentclientprotocol/sdk/experimental/v2";
import type { ClientElicitationCapability } from "../tool-calls/elicitation.js";
import type { ClientToolCallNameCapability } from "../initialize.js";
import type { SessionModeId } from "../../agy/cli.js";
import { contentBlocksToPrompt } from "../content/index.js";
import type { ClientFileSystem } from "../../agy/edit/bridge.js";
import {
  interpretSlashCommand,
  isClientTextSlashPrompt,
  parseSlashCommand,
  resolveModelValue
} from "../slash-commands/index.js";
import { MODEL_CONFIG_ID } from "./config-options.js";
import { MODE_CONFIG_ID } from "./modes.js";
import { requestPermissionV1, requestPermissionV2 } from "./request-permission.js";
import type { QueuedPromptV1, QueuedPromptV2, SessionState, TurnIntent } from "./types.js";
import type { PromptAdmission } from "../../admission/prompt-seam.js";
import {
  ACP_REQUEST_IDENTITY_CAPABILITY_KEY,
  validateRequestIdentityPromptMetadata
} from "../../admission/request-identity-protocol.js";
import {
  isTurnCancelled,
  onAbort,
  raceClaim,
  raceSignal,
  TurnCancelled,
  turnsOf,
  type TurnClaim
} from "./turn-scheduler.js";
import { createTerminalOutputTracker, createToolCallContentTracker, expandSessionUpdateToV2, sessionUpdateToV1 } from "./update-wire.js";

export interface PromptTurnDeps {
  requireSession(sessionId: string): SessionState;
  applyConfigOption(sessionId: string, configId: string, value: unknown): Promise<void>;
  persistSession(sessionId: string, session: SessionState): Promise<void>;
  /** Omitted by default so legacy prompt execution stays exactly on its existing path. */
  admission?: PromptAdmission;
}

export interface PromptV1Deps extends PromptTurnDeps {
  notifyCurrentModeUpdate(client: V1AgentContext, sessionId: string, mode: SessionModeId): Promise<void>;
  notifyConfigOptionUpdateV1(client: V1AgentContext, sessionId: string, session: SessionState): Promise<void>;
  clientFileSystemV1(client: V1AgentContext, sessionId: string): ClientFileSystem | undefined;
  clientElicitationV1?(client: V1AgentContext): ClientElicitationCapability | undefined;
  clientToolCallNameV1?(client: V1AgentContext): ClientToolCallNameCapability | undefined;
}

export interface PromptV2Deps extends PromptTurnDeps {
  notifyConfigOptionUpdateV2(client: V2AgentContext, sessionId: string, session: SessionState): Promise<void>;
  clientElicitationV2?(client: V2AgentContext): ClientElicitationCapability | undefined;
  clientToolCallNameV2?(client: V2AgentContext): ClientToolCallNameCapability | undefined;
}

type StopReason = "end_turn" | "cancelled";

const MAX_PASEO_APPEND_CHARS = 200_000;
const PASEO_APPEND_RETRY_ATTEMPTS = 25;
const PASEO_APPEND_RETRY_DELAY_MS = 20;

export function parseTurnIntent(params: unknown): TurnIntent | undefined {
  if (!params || typeof params !== "object") return undefined;
  const meta = (params as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== "object") return undefined;
  const intent = (meta as Record<string, unknown>)["agy-acp/turnIntent"];
  if (intent === "queue" || intent === "steer") return intent;
  return undefined;
}

async function findPaseoAgentState(
  dir: string,
  fileName: string,
  depth = 4
): Promise<string | undefined> {
  if (depth < 0) return undefined;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === fileName) return child;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findPaseoAgentState(path.join(dir, entry.name), fileName, depth - 1);
    if (found) return found;
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolvePaseoHome(): string {
  const configured = process.env.PASEO_HOME?.trim();
  if (configured) {
    if (configured === "~") return os.homedir();
    if (configured.startsWith("~/") || configured.startsWith("~\\")) {
      return path.join(os.homedir(), configured.slice(2));
    }
    return configured;
  }

  const homeDir = process.env.HOME || os.homedir();
  return homeDir ? path.join(homeDir, ".paseo") : "";
}

async function readPaseoDaemonAppendSystemPrompt(): Promise<string> {
  const home = resolvePaseoHome();
  const agentId = process.env.PASEO_AGENT_ID;
  if (!home || !agentId || agentId.includes("/") || agentId.includes("\\")) return "";

  for (let attempt = 0; attempt < PASEO_APPEND_RETRY_ATTEMPTS; attempt++) {
    try {
      const statePath = await findPaseoAgentState(path.join(home, "agents"), `${agentId}.json`);
      if (statePath) {
        const state = JSON.parse(await readFile(statePath, "utf8")) as {
          persistence?: { metadata?: { daemonAppendSystemPrompt?: unknown } };
        };
        const append = state.persistence?.metadata?.daemonAppendSystemPrompt;
        if (typeof append === "string" && append.trim()) {
          return append.trim().slice(0, MAX_PASEO_APPEND_CHARS);
        }
      }
    } catch {
      // Paseo may still be writing the state file. Retry briefly, then fail open.
    }
    if (attempt < PASEO_APPEND_RETRY_ATTEMPTS - 1) {
      await delay(PASEO_APPEND_RETRY_DELAY_MS);
    }
  }
  return "";
}

async function withPaseoDaemonSystemContext(promptText: string): Promise<string> {
  const append = await readPaseoDaemonAppendSystemPrompt();
  if (!append) return promptText;
  return [
    "[Paseo daemon system context]",
    append,
    "[/Paseo daemon system context]",
    "",
    promptText
  ].join("\n");
}

function notifyV2BestEffort(
  client: V2AgentContext,
  sessionId: string,
  update: v2.SessionUpdate
): void {
  try {
    void client.notify(v2.methods.client.session.update, { sessionId, update }).catch(() => {});
  } catch {
    // Teardown must not wait for or fail on a disconnected client transport.
  }
}

/** True when a turn is running or a steer has reserved the next turn. */
export function sessionTurnBusy(session: SessionState): boolean {
  return turnsOf(session).busy();
}

/**
 * Start the next queued prompt if the session is free. Safe to call from any
 * finalizer; it is a no-op while a turn or steer reservation owns the slot.
 */
export function notifyIdleAndDrainQueue(session: SessionState): void {
  if (session.closed) return;
  const turns = turnsOf(session);
  if (turns.busy()) return;
  if (session.promptQueue.length === 0) return;

  const next = session.promptQueue.shift()!;
  if (next.version === "v1") {
    next.detachQueueCancel?.();
    if (next.signal?.aborted) {
      next.resolve({ stopReason: "cancelled" });
      notifyIdleAndDrainQueue(session);
      return;
    }
    void executeQueuedV1Turn(next).catch((error) => {
      console.error(`[agy-acp] queued v1 turn failed: ${(error as Error).message}`);
    });
  } else {
    if (next.controller.signal.aborted) {
      notifyV2BestEffort(next.client, next.params.sessionId, {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled"
      });
      notifyIdleAndDrainQueue(session);
      return;
    }
    void executeQueuedV2Turn(next).catch((error) => {
      console.error(`[agy-acp] queued v2 turn failed: ${(error as Error).message}`);
    });
  }
}

/**
 * Honor curated ACP slash commands that map onto session config (mode / model /
 * reasoningEffort). Returns true when the prompt was fully handled without
 * spawning agy. Unknown or non-slash prompts return false (pass through).
 */
export async function applyCuratedSlashCommand(
  sessionId: string,
  promptText: string,
  notify: {
    modeChanged?: (mode: SessionModeId) => Promise<void>;
    configChanged: () => Promise<void>;
  },
  deps: PromptTurnDeps
): Promise<boolean> {
  const parsed = parseSlashCommand(promptText);
  if (!parsed) return false;

  const result = interpretSlashCommand(parsed);
  if (result.kind === "pass") return false;
  if (result.kind === "error") {
    throw new Error(result.message);
  }

  const session = deps.requireSession(sessionId);
  let value = result.value;
  if (result.configId === MODEL_CONFIG_ID) {
    const resolved = resolveModelValue(value, session.catalog);
    if (!resolved) {
      throw new Error(`Unknown model: ${value}`);
    }
    value = resolved;
  }

  const previousMode = session.agy.config.mode;
  await deps.applyConfigOption(sessionId, result.configId, value);
  const after = deps.requireSession(sessionId);

  if (
    result.configId === MODE_CONFIG_ID &&
    after.agy.config.mode !== previousMode &&
    notify.modeChanged
  ) {
    await notify.modeChanged(after.agy.config.mode);
  }
  await notify.configChanged();
  return true;
}

/**
 * Per-version hooks for the shared turn body. Progress notifications differ
 * between v1 and v2; the ordering, cancellation, and persistence rules do not.
 */
interface TurnAdapter {
  /** Enabled admission owns prompt dispatch outside this module. */
  admit?(promptText: string, claim: TurnClaim): Promise<StopReason>;
  /** v2 foreground only — queued v2 already published it, v1 has no concept. */
  announceUserMessage?(promptText: string): Promise<void>;
  /** v2 only. */
  announceRunning?(): Promise<void>;
  forwardUpdates(promptText: string, claim: TurnClaim): Promise<{ stopReason: string }>;
  applySlash(promptText: string): Promise<boolean>;
}

/**
 * The one turn body. Converts content, honors curated slash commands, runs agy,
 * and persists. Throws `TurnCancelled` the moment the claim is aborted — every
 * await is guarded, so there is no "recheck the flag afterwards" step to omit.
 */
async function runTurnBody(
  sessionId: string,
  promptBlocks: v1.ContentBlock[],
  session: SessionState,
  claim: TurnClaim,
  adapter: TurnAdapter,
  deps: PromptTurnDeps,
  /** Queued v2 converts at enqueue time; re-converting would rewrite attachments. */
  preconverted?: string
): Promise<StopReason> {
  const guard = <T>(promise: Promise<T>) => raceClaim(promise, claim);
  const ensureLive = () => {
    claim.throwIfAborted();
    if (session.closed) throw new TurnCancelled();
  };

  ensureLive();
  const promptText = preconverted ?? await guard(contentBlocksToPrompt(promptBlocks, session.cwd));
  // Curated slash commands reconfigure the local connector and never launch
  // agy, so they do not consume a global admission request.
  if (adapter.admit && isClientTextSlashPrompt(promptBlocks)) {
    const handled = await guard(adapter.applySlash(promptText));
    if (handled) {
      ensureLive();
      return "end_turn";
    }
    ensureLive();
  }
  if (adapter.admit) {
    ensureLive();
    const backendPromptText = await guard(withPaseoDaemonSystemContext(promptText));
    ensureLive();
    return guard(adapter.admit(backendPromptText, claim));
  }
  const backendPromptText = await guard(withPaseoDaemonSystemContext(promptText));
  ensureLive();

  if (adapter.announceUserMessage) {
    await guard(adapter.announceUserMessage(promptText));
    ensureLive();
  }
  if (adapter.announceRunning) {
    await guard(adapter.announceRunning());
    ensureLive();
  }

  // Only intercept pure client text blocks; a resource or image payload whose
  // flattened body happens to read `/plan` must be forwarded to agy verbatim.
  if (isClientTextSlashPrompt(promptBlocks)) {
    const handled = await guard(adapter.applySlash(promptText));
    if (handled) {
      ensureLive();
      return "end_turn";
    }
    ensureLive();
  }

  // The backend is now the thing to stop, so route aborts to it. `onAbort`
  // fires immediately if the claim is already aborted.
  const stopBackend = () => {
    session.agy.cancel().catch(() => {
      // The prompt loop surfaces process failures through its own result.
    });
  };
  const detach = onAbort(claim.signal, stopBackend);
  try {
    ensureLive();
    const outcome = await adapter.forwardUpdates(backendPromptText, claim);
    if (!session.closed) {
      await deps.persistSession(sessionId, session);
    }
    return outcome.stopReason === "cancelled" || claim.aborted || session.closed
      ? "cancelled"
      : "end_turn";
  } catch (error) {
    // Persist even on failure: agy's conversation id/step position may have
    // advanced before it errored out, and that partial progress is worth
    // resuming from on the next prompt.
    if (!claim.aborted && !session.closed) {
      await deps.persistSession(sessionId, session).catch(() => {});
    }
    throw error;
  } finally {
    detach();
  }
}

function admissionAdapter(
  params: { sessionId: string; _meta?: unknown },
  session: SessionState,
  deps: PromptTurnDeps
): TurnAdapter["admit"] {
  const admission = deps.admission;
  if (!admission) return undefined;

  return async (promptText, claim) => admission.seam.admit({
    sessionId: params.sessionId,
    model: session.selectedBaseModel,
    promptText,
    claim,
    requestIdentity: validateRequestIdentityPromptMetadata(
      admission.requestIdentity,
      promptRequestIdentityMetadata(params)
    )
  });
}

function promptRequestIdentityMetadata(params: { _meta?: unknown }): unknown {
  const meta = params._meta;
  if (!meta || typeof meta !== "object") return undefined;
  return (meta as Record<string, unknown>)[ACP_REQUEST_IDENTITY_CAPABILITY_KEY];
}

function v1Adapter(
  params: V1PromptRequest,
  client: V1AgentContext,
  session: SessionState,
  deps: PromptV1Deps
): TurnAdapter {
  return {
    admit: admissionAdapter(params, session, deps),
    applySlash: (promptText) => applyCuratedSlashCommand(
      params.sessionId,
      promptText,
      {
        // ACP transition: send both legacy current_mode_update (modes-API clients)
        // and config_option_update (configOptions clients) on slash mode changes.
        modeChanged: (mode) => deps.notifyCurrentModeUpdate(client, params.sessionId, mode),
        configChanged: async () => {
          await deps.notifyConfigOptionUpdateV1(
            client,
            params.sessionId,
            deps.requireSession(params.sessionId)
          );
        }
      },
      deps
    ),
    forwardUpdates: async (promptText, claim) => {
      const tracker = createTerminalOutputTracker();
      const clientToolCallName = deps.clientToolCallNameV1?.(client);
      return session.agy.prompt(promptText, async (update) => {
        // I4: agy's print-mode poll loop awaits this callback, so a wedged v1
        // transport would otherwise pin the turn even after the backend dies.
        await raceClaim(
          client.notify(v1.methods.client.session.update, {
            sessionId: params.sessionId,
            update: sessionUpdateToV1(update, tracker, { clientToolCallName })
          }),
          claim
        );
      }, async (toolCall, { toolName, questionIndex }) => {
        const elicitationCap = deps.clientElicitationV1?.(client);
        return requestPermissionV1(
          client,
          params.sessionId,
          toolCall,
          toolName,
          claim.signal,
          questionIndex,
          elicitationCap,
          clientToolCallName
        );
      }, deps.clientFileSystemV1(client, params.sessionId), deps.clientElicitationV1?.(client));
    }
  };
}

function v2Adapter(
  params: V2PromptRequest,
  client: V2AgentContext,
  session: SessionState,
  deps: PromptV2Deps,
  options: { userMessageId?: string; announceUserMessage: boolean }
): TurnAdapter {
  const notify = async (update: v2.SessionUpdate) => {
    await client.notify(v2.methods.client.session.update, {
      sessionId: params.sessionId,
      update
    });
  };
  // Assigned when announced (foreground) or supplied by the queue (already
  // announced at enqueue time); recorded against agy's step index afterwards.
  let userMessageId = options.userMessageId ?? "";

  const adapter: TurnAdapter = {
    admit: admissionAdapter(params, session, deps),
    announceUserMessage: options.announceUserMessage
      ? async (promptText: string) => {
          userMessageId = v2UserMessageId(params.prompt as v1.ContentBlock[], promptText);
          await notify({
            sessionUpdate: "user_message",
            messageId: userMessageId,
            content: params.prompt as v2.ContentBlock[]
          });
        }
      : undefined,
    announceRunning: () => notify({ sessionUpdate: "state_update", state: "running" }),
    applySlash: (promptText) => applyCuratedSlashCommand(
      params.sessionId,
      promptText,
      {
        configChanged: () => deps.notifyConfigOptionUpdateV2(
          client,
          params.sessionId,
          deps.requireSession(params.sessionId)
        )
      },
      deps
    ),
    forwardUpdates: async (promptText, claim) => {
      const terminalTracker = createTerminalOutputTracker();
      const toolContentTracker = createToolCallContentTracker();
      const clientToolCallName = deps.clientToolCallNameV2?.(client);
      try {
        return await session.agy.prompt(promptText, async (update) => {
          for (const v2Update of expandSessionUpdateToV2(update, terminalTracker, toolContentTracker, { clientToolCallName })) {
            await raceClaim(notify(v2Update), claim);
          }
        }, async (toolCall, { toolName, questionIndex }) => {
          const elicitationCap = deps.clientElicitationV2?.(client);
          return requestPermissionV2(
            client,
            params.sessionId,
            toolCall,
            toolName,
            claim.signal,
            questionIndex,
            elicitationCap,
            clientToolCallName
          );
        }, undefined, deps.clientElicitationV2?.(client));
      } finally {
        const userStepIdxs = session.agy.lastPromptUserStepIdxs;
        if (userStepIdxs.length > 1) {
          throw new Error(`Expected at most one user step for a prompt, observed: ${userStepIdxs.join(", ")}`);
        }
        if (userStepIdxs.length === 1 && userMessageId) {
          session.v2UserMessageIdsByStep[String(userStepIdxs[0])] = userMessageId;
        }
      }
    }
  };
  return adapter;
}

/**
 * Emit a v2 turn's single terminal `idle` update.
 *
 * Racing the claim matters: if the session is closed or cancelled while this
 * notification is in flight on a stalled transport, teardown must not be held
 * up — and neither must the turn slot, which is only released afterwards.
 */
function v2TerminalEmitter(
  client: V2AgentContext,
  sessionId: string,
  session: SessionState,
  claim: TurnClaim
): (stopReason: StopReason) => Promise<void> {
  return async (stopReason) => {
    const update: v2.SessionUpdate = {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason
    };
    if (session.closed || claim.aborted) {
      notifyV2BestEffort(client, sessionId, update);
      return;
    }
    try {
      await raceClaim(
        client.notify(v2.methods.client.session.update, { sessionId, update }),
        claim
      );
    } catch (error) {
      if (!isTurnCancelled(error)) throw error;
      notifyV2BestEffort(client, sessionId, update);
    }
  };
}

/** Slash selections get a distinguishable message id, matching v2 clients. */
function v2UserMessageId(promptBlocks: v1.ContentBlock[], promptText: string): string {
  const parsedSlash = isClientTextSlashPrompt(promptBlocks) ? parseSlashCommand(promptText) : null;
  const slashResult = parsedSlash ? interpretSlashCommand(parsedSlash) : null;
  return slashResult && slashResult.kind !== "pass"
    ? `slash-${randomUUID()}`
    : `user-${randomUUID()}`;
}

/**
 * Run a claimed turn to completion and report exactly one terminal outcome.
 * Every accepted request — foreground, queued, steered, or one that fails
 * during setup — ends here, so a prompt can never vanish without a terminal.
 */
async function completeTurn(
  session: SessionState,
  claim: TurnClaim,
  body: () => Promise<StopReason>,
  report: {
    terminal(stopReason: StopReason): void | Promise<void>;
    failure(error: unknown): void | Promise<void>;
  }
): Promise<void> {
  const turns = turnsOf(session);
  try {
    let stopReason: StopReason;
    try {
      stopReason = await body();
    } catch (error) {
      if (isTurnCancelled(error) || claim.aborted || session.closed) {
        stopReason = "cancelled";
      } else {
        await report.failure(error);
        return;
      }
    }
    await report.terminal(stopReason);
  } finally {
    turns.release(claim);
    notifyIdleAndDrainQueue(session);
  }
}

/**
 * v1 `session/prompt`: response carries stopReason after the full turn.
 *
 * Prompt forwarding: client `params.prompt` is encoded normally. When running
 * under Paseo, daemon-provided system context may be recovered from Paseo agent
 * state and prepended only to the backend prompt; the ACP-visible user message
 * is not rewritten. No adapter-authored follow-ups are generated.
 */
export async function handlePromptV1(
  params: V1PromptRequest,
  client: V1AgentContext,
  signal: AbortSignal | undefined,
  deps: PromptV1Deps
): Promise<V1PromptResponse> {
  const session = deps.requireSession(params.sessionId);
  const turns = turnsOf(session);

  if (turns.busy()) {
    const intent = parseTurnIntent(params);
    if (intent === "queue") {
      return enqueueV1(params, client, signal, session, deps);
    }
    if (intent !== "steer") {
      throw new Error(`Session already has an active prompt: ${params.sessionId}`);
    }
    // Reserve synchronously: the claim (and its abort controller) must exist
    // before the first await so a cancel during the wait is never dropped.
    const claim = turns.reserveSteer(signal);
    let response: V1PromptResponse = { stopReason: "cancelled" };
    await completeTurn(
      session,
      claim,
      async () => {
        await turns.promote(claim, () => session.agy.cancel());
        return runTurnBody(
          params.sessionId,
          params.prompt,
          session,
          claim,
          v1Adapter(params, client, session, deps),
          deps
        );
      },
      {
        terminal: (stopReason) => {
          response = { stopReason };
        },
        failure: (error) => {
          throw error;
        }
      }
    );
    return response;
  }

  const claim = turns.claimIdle("foreground", signal);
  let response: V1PromptResponse = { stopReason: "cancelled" };
  await completeTurn(
    session,
    claim,
    () => runTurnBody(
      params.sessionId,
      params.prompt,
      session,
      claim,
      v1Adapter(params, client, session, deps),
      deps
    ),
    {
      terminal: (stopReason) => {
        response = { stopReason };
      },
      failure: (error) => {
        throw error;
      }
    }
  );
  return response;
}

function enqueueV1(
  params: V1PromptRequest,
  client: V1AgentContext,
  signal: AbortSignal | undefined,
  session: SessionState,
  deps: PromptV1Deps
): Promise<V1PromptResponse> {
  return new Promise<V1PromptResponse>((resolve, reject) => {
    const queuedId = `q-${randomUUID()}`;
    const item: QueuedPromptV1 = {
      id: queuedId,
      version: "v1",
      params,
      client,
      signal,
      deps,
      resolve,
      reject
    };
    session.promptQueue.push(item);
    if (signal) {
      // The listener's job ends when the item leaves the FIFO by any path —
      // afterwards the turn's claim owns cancellation. Detaching keeps a
      // long-lived request signal from pinning the session.
      let detach: () => void = () => {};
      detach = onAbort(signal, () => {
        detach();
        const idx = session.promptQueue.findIndex((q) => q.id === queuedId);
        if (idx >= 0) {
          session.promptQueue.splice(idx, 1);
          resolve({ stopReason: "cancelled" });
        }
      });
      item.detachQueueCancel = detach;
    }
  });
}

async function executeQueuedV1Turn(item: QueuedPromptV1): Promise<void> {
  const { params, client, signal, deps, resolve, reject } = item;
  const session = deps.requireSession(params.sessionId);
  const claim = turnsOf(session).claimIdle("queued", signal, item.id);

  await completeTurn(
    session,
    claim,
    () => runTurnBody(
      params.sessionId,
      params.prompt,
      session,
      claim,
      v1Adapter(params, client, session, deps),
      deps
    ),
    {
      terminal: (stopReason) => resolve({ stopReason }),
      failure: (error) => reject(error as Error)
    }
  );
}

/**
 * v2 `session/prompt`: respond `{}` immediately on acceptance. Foreground
 * progress and stopReason arrive as `state_update` notifications.
 *
 * Prompt forwarding: client `params.prompt` is encoded normally. When running
 * under Paseo, daemon-provided system context may be recovered from Paseo agent
 * state and prepended only to the backend prompt; the ACP-visible user message
 * is not rewritten. No adapter-authored follow-ups are generated.
 */
export async function handlePromptV2(
  params: V2PromptRequest,
  client: V2AgentContext,
  deps: PromptV2Deps
): Promise<V2PromptResponse> {
  const session = deps.requireSession(params.sessionId);
  const turns = turnsOf(session);

  if (turns.busy()) {
    const intent = parseTurnIntent(params);
    if (intent === "queue") {
      const queuedId = enqueueV2(params, client, session, deps);
      // Surface the cancellation handle: the user_message notification carries
      // a different id and may arrive late (or wedge), so the acceptance
      // response is the only reliable place to hand it over.
      return { _meta: { "agy-acp/queuedPromptId": queuedId } };
    }
    if (intent !== "steer") {
      throw new Error(`Session already has an active prompt: ${params.sessionId}`);
    }
    // Reserve synchronously, acknowledge the RPC, then displace the active turn
    // on the next task so backend shutdown latency cannot delay acceptance.
    const claim = turns.reserveSteer();
    void nextTask()
      .then(() => runV2Turn(params, client, session, claim, deps, {
        announceUserMessage: true,
        displaceActive: true
      }))
      .catch((error) => {
        console.error(`[agy-acp] v2 steer turn failed: ${(error as Error).message}`);
      });
    return {};
  }

  const claim = turns.claimIdle("foreground");
  void nextTask()
    .then(() => runV2Turn(params, client, session, claim, deps, {
      announceUserMessage: true,
      displaceActive: false
    }))
    .catch((error) => {
      console.error(`[agy-acp] v2 prompt turn failed: ${(error as Error).message}`);
    });
  return {};
}

/** Queue the RPC response ahead of any session/update the turn emits. */
function nextTask(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

async function runV2Turn(
  params: V2PromptRequest,
  client: V2AgentContext,
  session: SessionState,
  claim: TurnClaim,
  deps: PromptV2Deps,
  options: {
    announceUserMessage: boolean;
    displaceActive: boolean;
    userMessageId?: string;
    promptBlocks?: v1.ContentBlock[];
  }
): Promise<void> {
  const adapter = v2Adapter(params, client, session, deps, {
    announceUserMessage: options.announceUserMessage,
    userMessageId: options.userMessageId
  });
  const turns = turnsOf(session);
  const emitTerminal = v2TerminalEmitter(client, params.sessionId, session, claim);

  await completeTurn(
    session,
    claim,
    async () => {
      if (options.displaceActive) {
        await turns.promote(claim, () => session.agy.cancel());
      }
      return runTurnBody(
        params.sessionId,
        options.promptBlocks ?? (params.prompt as v1.ContentBlock[]),
        session,
        claim,
        adapter,
        deps
      );
    },
    {
      terminal: emitTerminal,
      failure: async (error) => {
        console.error(`[agy-acp] v2 turn failed: ${(error as Error).message}`);
        // The RPC already returned `{}`; a setup or backend failure must still
        // land the client back in `idle` rather than leaving it in `running`.
        await emitTerminal("end_turn").catch(() => {});
      }
    }
  );
}

function enqueueV2(
  params: V2PromptRequest,
  client: V2AgentContext,
  session: SessionState,
  deps: PromptV2Deps
): string {
  const controller = new AbortController();
  const queuedId = `q-${randomUUID()}`;
  const queued: QueuedPromptV2 = {
    id: queuedId,
    version: "v2",
    params,
    client,
    ready: Promise.resolve(),
    controller,
    deps
  };
  // Enter FIFO before conversion or client transport awaits can reorder
  // concurrently admitted queue requests.
  session.promptQueue.push(queued);

  // Global admission must start only after executeQueuedV2Turn has acquired
  // the local claim. The legacy path intentionally retains eager conversion
  // and user-message publication below.
  if (deps.admission) {
    notifyIdleAndDrainQueue(session);
    return queuedId;
  }

  const previousPreparation = session.promptQueuePreparation ?? Promise.resolve();
  queued.ready = previousPreparation
    .catch(() => {})
    .then(() => nextTask())
    .then(async () => {
      controller.signal.throwIfAborted();
      const promptText = await contentBlocksToPrompt(
        params.prompt as v1.ContentBlock[],
        session.cwd
      );
      controller.signal.throwIfAborted();
      const userMessageId = v2UserMessageId(params.prompt as v1.ContentBlock[], promptText);

      // I4: this delivery is serialized across the FIFO, so a wedged transport
      // would otherwise jam every later queued prompt; cancelling the item
      // must unwedge the chain.
      await raceSignal(
        client.notify(v2.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "user_message",
            messageId: userMessageId,
            content: params.prompt as v2.ContentBlock[]
          }
        }),
        controller.signal
      );
      controller.signal.throwIfAborted();
      if (session.closed) throw new TurnCancelled();
      queued.promptText = promptText;
      queued.userMessageId = userMessageId;
    });
  session.promptQueuePreparation = queued.ready.then(() => {}, () => {});

  void queued.ready.catch(() => {
    const idx = session.promptQueue.findIndex((item) => item.id === queuedId);
    if (idx < 0) return; // The FIFO executor owns terminal reporting.
    session.promptQueue.splice(idx, 1);
    notifyV2BestEffort(client, params.sessionId, {
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: controller.signal.aborted || session.closed ? "cancelled" : "end_turn"
    });
    notifyIdleAndDrainQueue(session);
  });

  notifyIdleAndDrainQueue(session);
  return queuedId;
}

async function executeQueuedV2Turn(item: QueuedPromptV2): Promise<void> {
  const { params, client, controller, deps } = item;
  const session = deps.requireSession(params.sessionId);
  const claim = turnsOf(session).claimIdle("queued", controller.signal, item.id);
  const emitTerminal = v2TerminalEmitter(client, params.sessionId, session, claim);

  // Cancelling this turn must also abort preparation: if user_message
  // delivery is still wedged, the item's `ready` would otherwise stay pinned
  // in `promptQueuePreparation` and jam every later queued prompt (I4).
  const propagateCancellation = onAbort(claim.signal, () => controller.abort());
  try {
    await completeTurn(
      session,
      claim,
      async () => {
        if (deps.admission) {
          const adapter = v2Adapter(params, client, session, deps, {
            announceUserMessage: true
          });
          return runTurnBody(
            params.sessionId,
            params.prompt as v1.ContentBlock[],
            session,
            claim,
            adapter,
            deps
          );
        }
        // Preparation (content conversion + user_message) ran at enqueue time.
        await raceClaim(item.ready, claim);
        claim.throwIfAborted();
        const { promptText, userMessageId } = item;
        if (promptText === undefined || userMessageId === undefined) {
          throw new Error("Queued v2 prompt preparation completed without content");
        }
        const adapter = v2Adapter(params, client, session, deps, {
          announceUserMessage: false,
          userMessageId
        });
        return runTurnBody(
          params.sessionId,
          params.prompt as v1.ContentBlock[],
          session,
          claim,
          adapter,
          deps,
          promptText
        );
      },
      {
        terminal: emitTerminal,
        failure: async (error) => {
          console.error(`[agy-acp] queued v2 turn failed: ${(error as Error).message}`);
          await emitTerminal("end_turn").catch(() => {});
        }
      }
    );
  } finally {
    propagateCancellation();
  }
}
