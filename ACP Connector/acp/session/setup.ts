// ACP session/new, session/load, session/resume: build and reload agy-backed sessions.
// Docs: https://agentclientprotocol.com/protocol/v1/session-setup

import { randomUUID } from "node:crypto";
import type * as v1 from "@agentclientprotocol/sdk";
import {
  configFromEnv,
  isSessionModeId,
  type AgyCliBackend,
  type AgyCliConfig
} from "../../agy/cli.js";
import type { ReplayCache } from "../../agy/db/replay.js";
import { buildModelCatalog } from "../../agy/model/catalog.js";
import { applyModelSelection, initialModelSelection, restoredModelSelection } from "../../agy/model/selection.js";
import type { SessionStoreBackend, StoredSession } from "./store.js";
import type { SessionState } from "./types.js";
import { cancelQueuedPrompts } from "./cancel.js";
import { sessionTurnBusy } from "./prompt.js";
import { turnsOf } from "./turn-scheduler.js";

export interface SessionBuildDeps {
  env: NodeJS.ProcessEnv;
  argv: string[];
  backend: AgyCliBackend;
  getModelOptions(config: AgyCliConfig): Promise<string[]>;
  conversationsDir?: string;
  admissionEnabled?: boolean;
}

/** Build a fresh session bound to `cwd` + ACP `additionalDirectories`. */
export async function buildSession(
  cwd: string,
  additionalDirectories: string[],
  stored: StoredSession | null,
  deps: SessionBuildDeps
): Promise<SessionState> {
  const config = configFromEnv({
    cwd,
    additionalDirectories,
    env: deps.env,
    argv: deps.argv,
    conversationsDir: deps.conversationsDir
  });
  if (deps.admissionEnabled === true) {
    config.promptInArgv = false;
  }
  const modelOptions = await deps.getModelOptions(config);
  const catalog = buildModelCatalog(modelOptions);
  const agy = await deps.backend.startSession(config);

  if (stored?.conversationId) {
    agy.restoreConversation(stored.conversationId, stored.lastStepIdx);
  }

  const selection = stored
    ? restoredModelSelection(stored.model, stored.reasoningEffort, catalog)
    : initialModelSelection(config.model, catalog);
  applyModelSelection(agy, selection.baseModel, selection.reasoningEffort, catalog);
  if (stored?.mode && isSessionModeId(stored.mode)) {
    agy.setMode(stored.mode);
  }

  return {
    sessionId: "", // set by the caller once the ACP session id is known
    cwd,
    additionalDirectories,
    agy,
    catalog,
    selectedBaseModel: selection.baseModel,
    selectedReasoningEffort: selection.reasoningEffort,
    promptQueue: [],
    v2UserMessageIdsByStep: { ...(stored?.v2UserMessageIdsByStep ?? {}) }
  };
}

/** Register a session in the active-sessions map, evicting idle sessions past the capacity limit. */
export async function registerSession(
  sessionId: string,
  session: SessionState,
  sessions: Map<string, SessionState>,
  maxActiveSessions: number
): Promise<void> {
  const replaced = sessions.get(sessionId);
  if (replaced && replaced !== session) {
    sessions.delete(sessionId);
    replaced.closed = true;
    turnsOf(replaced).close();
    cancelQueuedPrompts(replaced);
    await replaced.agy.close().catch(() => {});
  }

  while (sessions.size >= maxActiveSessions) {
    const candidate = [...sessions].find(([, current]) => !sessionTurnBusy(current));
    if (!candidate) break;
    const [evictedId, evicted] = candidate;
    sessions.delete(evictedId);
    evicted.closed = true;
    turnsOf(evicted).close();
    cancelQueuedPrompts(evicted);
    await evicted.agy.close().catch((error) => {
      console.error(
        `[agy-acp] WARN: failed to close evicted session ${evictedId}: ${(error as Error).message}`
      );
    });
  }
  sessions.set(sessionId, session);
}

export async function createSession(
  requestedCwd: string | undefined,
  requestedDirs: string[] | undefined,
  deps: SessionBuildDeps & {
    sessions: Map<string, SessionState>;
    maxActiveSessions: number;
    persistSession(sessionId: string, session: SessionState): Promise<void>;
  }
): Promise<SessionState> {
  const cwd = requestedCwd || process.cwd();
  const additionalDirectories = dedupe(requestedDirs ?? []);
  const sessionId = randomUUID();
  const session = await buildSession(cwd, additionalDirectories, null, deps);
  session.sessionId = sessionId;
  await registerSession(sessionId, session, deps.sessions, deps.maxActiveSessions);
  await deps.persistSession(sessionId, session);
  return session;
}

/** Shared reconstruction for `session/load` and `session/resume`: restore a
 *  persisted session binding and re-register it in memory. */
export async function reloadSession(
  sessionId: string,
  requestedCwd: string | undefined,
  requestedDirs: string[] | undefined,
  deps: SessionBuildDeps & {
    store: SessionStoreBackend;
    sessions: Map<string, SessionState>;
    maxActiveSessions: number;
  }
): Promise<{ session: SessionState; cwd: string; stored: StoredSession }> {
  const stored = await deps.store.restore(sessionId);
  if (!stored) {
    throw new Error(`Unknown session: ${sessionId}`);
  }
  const cwd = requestedCwd || stored.cwd;
  const additionalDirectories = dedupe(requestedDirs ?? stored.additionalDirectories);

  const session = await buildSession(cwd, additionalDirectories, stored, deps);
  session.sessionId = sessionId;
  await registerSession(sessionId, session, deps.sessions, deps.maxActiveSessions);
  return { session, cwd, stored };
}

export function sessionRecord(session: SessionState): StoredSession {
  return {
    cwd: session.cwd,
    additionalDirectories: session.additionalDirectories,
    conversationId: session.agy.conversationId,
    lastStepIdx: session.agy.lastStepIdx,
    model: session.selectedBaseModel,
    reasoningEffort: session.selectedReasoningEffort,
    mode: session.agy.config.mode,
    v2UserMessageIdsByStep: session.v2UserMessageIdsByStep,
    updatedAt: new Date().toISOString()
  };
}

export function persistSession(
  store: SessionStoreBackend,
  sessionId: string,
  session: SessionState
): Promise<void> {
  if (session.closed) return Promise.resolve();
  return store.persist(sessionId, sessionRecord(session));
}

function getUpdateStepRange(u: v1.SessionUpdate): { stepIdx: number; endStepIdx: number } | undefined {
  const rec = u as unknown as Record<string, unknown>;
  const meta = rec._meta as Record<string, unknown> | undefined;
  let startIdx: number | undefined;
  if (typeof meta?.stepIdx === "number") startIdx = meta.stepIdx;
  else if (typeof rec.stepIdx === "number") startIdx = rec.stepIdx;
  else if (typeof rec.messageId === "string") {
    const parsed = parseInt(rec.messageId, 10);
    if (!isNaN(parsed)) startIdx = parsed;
  }
  if (startIdx == null) return undefined;
  const endIdx = typeof meta?.endStepIdx === "number" ? meta.endStepIdx : startIdx;
  return { stepIdx: startIdx, endStepIdx: endIdx };
}

export function filterUpdatesForReplayFrom(
  updates: v1.SessionUpdate[],
  replayFrom: Record<string, unknown>
): v1.SessionUpdate[] {
  const type = String(replayFrom.type ?? "").toLowerCase();

  if (type === "start") {
    return updates;
  }

  if (type === "message") {
    const targetId = typeof replayFrom.messageId === "string" ? replayFrom.messageId : undefined;
    if (!targetId) return updates;
    const targetNum = parseInt(targetId, 10);
    const index = updates.findIndex((u) => {
      const rec = u as unknown as Record<string, unknown>;
      if (rec.messageId === targetId) return true;
      const range = getUpdateStepRange(u);
      if (rec.sessionUpdate === "agent_message_chunk" && range != null && !isNaN(targetNum)) {
        return range.stepIdx <= targetNum && targetNum <= range.endStepIdx;
      }
      return false;
    });
    return index >= 0 ? updates.slice(index) : [];
  }

  if (type === "step" || type === "step_idx" || type === "stepidx") {
    const targetIdx =
      typeof replayFrom.stepIdx === "number"
        ? replayFrom.stepIdx
        : typeof replayFrom.index === "number"
        ? replayFrom.index
        : typeof replayFrom.idx === "number"
        ? replayFrom.idx
        : undefined;
    if (targetIdx == null) return updates;
    const index = updates.findIndex((u) => {
      const range = getUpdateStepRange(u);
      return range != null && range.endStepIdx >= targetIdx;
    });
    return index >= 0 ? updates.slice(index) : [];
  }

  if (type === "tool_call" || type === "toolcall") {
    const targetId = typeof replayFrom.toolCallId === "string" ? replayFrom.toolCallId : undefined;
    if (!targetId) return updates;
    const index = updates.findIndex((u) => {
      const rec = u as unknown as Record<string, unknown>;
      return rec.toolCallId === targetId;
    });
    return index >= 0 ? updates.slice(index) : [];
  }

  throw new Error(`Unsupported replay cursor: ${String(replayFrom.type)}`);
}

/** Replay a persisted conversation's session updates (used by `session/load` and
 *  `session/resume` with `replayFrom`). */
export async function replayConversation(
  replayCache: ReplayCache,
  session: SessionState,
  conversationId: string,
  cwd: string,
  emit: (update: v1.SessionUpdate) => Promise<void>,
  replayFrom?: unknown,
  v2UserMessageIdsByStep?: Record<string, string>
): Promise<void> {
  const replay = replayCache.get(session.agy.config.conversationsDir, conversationId, {
    skipNarration: false,
    cwd
  });
  if (!replay) return;
  const replayUpdates = v2UserMessageIdsByStep
    ? remapV2UserMessageIds(replay.updates, v2UserMessageIdsByStep)
    : replay.updates;
  const updates =
    replayFrom != null
      ? filterUpdatesForReplayFrom(replayUpdates, replayFrom as Record<string, unknown>)
      : replayUpdates;
  for (const update of updates) {
    await emit(update);
  }
}

function remapV2UserMessageIds(
  updates: v1.SessionUpdate[],
  messageIdsByStep: Record<string, string>
): v1.SessionUpdate[] {
  return updates.map((update) => {
    const raw = update as unknown as Record<string, unknown>;
    if (raw.sessionUpdate !== "user_message_chunk") return update;
    const meta = raw._meta as Record<string, unknown> | undefined;
    const messageId = typeof meta?.stepIdx === "number"
      ? messageIdsByStep[String(meta.stepIdx)]
      : undefined;
    return messageId ? ({ ...raw, messageId } as unknown as v1.SessionUpdate) : update;
  });
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
