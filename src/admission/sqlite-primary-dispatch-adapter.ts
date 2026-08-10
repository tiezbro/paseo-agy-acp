import type {
  ActiveConnectorIdentity
} from "../acp/session/active-registry.js";
import {
  createActiveSessionTurnBinding,
  type ActiveSessionTurnBinding,
  type ActiveSessionTurnRegistry
} from "../acp/session/active-turn-binding.js";
import {
  AdmissionSessionScopeResolver,
  type AdmissionSessionScope
} from "../acp/session/admission-scope-resolver.js";
import type {
  AgyCliSession,
  AgyExactConversationTurn
} from "../agy/cli.js";
import type {
  BoundSqliteProviderObserver,
  SqliteProviderActivityObservation,
  SqliteProviderSnapshot,
  SqliteProviderSnapshotReader
} from "../agy/db/provider-observer.js";
import type { ExactConversationBinding } from "../agy/db/exact-conversation-binder.js";
import type {
  AgyDispatchFence,
  AgyDispatchProcess,
  AgyDispatchWriteResult
} from "../agy/dispatch-boundary.js";
import {
  ACP_OUTBOX_CAPABILITY,
  type OutboxCapability
} from "./outbox-protocol.js";
import {
  isAdmissionPromptAgySpawnContext,
  type AdmissionPromptAgySpawnContext,
  type AdmissionPromptAgyContract,
  type AdmissionPromptProviderActivity,
  type AdmissionPromptProviderContext,
  type AdmissionPromptProviderObserver,
  type AdmissionPromptTerminalObservation
} from "./dispatcher.js";
import {
  normalizeTerminalObservation,
  type OfficialTerminalObservation,
  type OfficialTerminalStatus,
  type TerminalEvidence
} from "./terminal-evidence.js";

type MaybePromise<T> = T | Promise<T>;

const REQUEST_METADATA_FIELDS = ["requestId", "sessionId", "parentId", "provider", "model"] as const;
const FENCE_FIELDS = ["requestId", "leaseId", "generation", "ownerInstanceId"] as const;
const DELIVERY_FIELDS = ["eventId", "fingerprint", "payload", "sequence", "expiresAt", "protocol"] as const;
const IDENTIFIER_MAX_LENGTH = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export type SqlitePrimaryDispatchAdapterErrorCode =
  | "invalid_configuration"
  | "invalid_fence"
  | "metadata_unavailable"
  | "metadata_mismatch"
  | "payload_unavailable"
  | "duplicate_request"
  | "session_unavailable"
  | "process_start_failed"
  | "process_identity_unavailable"
  | "active_session_unavailable"
  | "unknown_request"
  | "provider_context_mismatch"
  | "prompt_mismatch"
  | "conversation_binding_failed"
  | "provider_activity_unobserved"
  | "terminal_unobserved"
  | "terminal_mismatch"
  | "cursor_unavailable"
  | "delivery_unavailable"
  | "wrong_order";

/** Detail-free failure: request content and provider diagnostics never reach the error. */
export class SqlitePrimaryDispatchAdapterError extends Error {
  readonly code: SqlitePrimaryDispatchAdapterErrorCode;

  constructor(code: SqlitePrimaryDispatchAdapterErrorCode) {
    super(`sqlite-primary dispatch adapter rejected: ${code}`);
    this.name = "SqlitePrimaryDispatchAdapterError";
    this.code = code;
  }
}

/** Exact payload-free projection required from the controller request table. */
export interface SqlitePrimaryRequestMetadata {
  readonly requestId: string;
  readonly sessionId: string;
  readonly parentId: string;
  readonly provider: string;
  readonly model: string;
}

export interface SqlitePrimaryRequestMetadataSource {
  readRequestMetadata(requestId: string): unknown;
}

/**
 * The dispatcher does not pass its already-read payload to spawnPromptFree.
 * Production composition therefore supplies this narrow read-only view over
 * the same immutable controller payload row. The prompt is retained only by
 * the underlying once-only stdin capability and is never metadata.
 */
export interface SqlitePrimaryBusinessPromptSource {
  readBusinessPrompt(requestId: string): string;
}

export interface SqlitePrimaryProcessIdentityInput {
  readonly requestId: string;
  readonly leaseId: string;
  readonly generation: number;
  readonly ownerInstanceId: string;
  readonly processId: number;
}

export interface SqlitePrimaryTerminalDeliveryInput {
  readonly requestId: string;
  readonly sessionId: string;
  readonly parentId: string;
  readonly provider: string;
  readonly model: string;
  readonly conversationId: string;
  readonly cursor: number;
  readonly terminal: OfficialTerminalObservation;
}

export interface SqlitePrimaryTerminalDelivery {
  readonly eventId: string;
  readonly fingerprint: string;
  readonly payload: string;
  readonly sequence: number;
  readonly expiresAt: number;
  readonly protocol: OutboxCapability;
}

export interface SqlitePrimaryDispatchAdapterOptions<TProcessIdentity> {
  readonly agentId: string;
  readonly connectorIdentity: ActiveConnectorIdentity;
  readonly requestMetadata: SqlitePrimaryRequestMetadataSource;
  readonly businessPrompts: SqlitePrimaryBusinessPromptSource;
  readonly sessions: AdmissionSessionScopeResolver;
  readonly activeSessions: ActiveSessionTurnRegistry;
  readonly sqliteSnapshots: SqliteProviderSnapshotReader;
  readonly captureProcessIdentity: (
    input: SqlitePrimaryProcessIdentityInput
  ) => TProcessIdentity | null | undefined;
  readonly createTerminalDelivery: (
    input: SqlitePrimaryTerminalDeliveryInput
  ) => MaybePromise<SqlitePrimaryTerminalDelivery>;
}

interface RequestTurn<TProcessIdentity> {
  readonly fence: Readonly<AgyDispatchFence>;
  readonly metadata: Readonly<SqlitePrimaryRequestMetadata>;
  readonly scope: AdmissionSessionScope;
  readonly turn: AgyExactConversationTurn;
  readonly identity: TProcessIdentity;
  readonly activeBinding: ActiveSessionTurnBinding;
  readonly snapshots: TrackingSnapshotReader;
  expectedPrompt: string | null;
  readonly signal: AbortSignal;
  abortListener: (() => void) | null;
  exactBinding: ExactConversationBinding | null;
  pendingTerminal: OfficialTerminalObservation | null;
  promptWritten: boolean;
  activityObserved: boolean;
  terminalObserved: boolean;
  cancelIssued: boolean;
  cleaned: boolean;
}

/**
 * Request-scoped bridge used as both `AdmissionPromptDispatcher.agy` and
 * `AdmissionPromptDispatcher.provider`.
 *
 * It starts exactly one stdin child without writing the prompt. The existing
 * dispatcher remains the sole owner of the irreversible write. stream-json is
 * consumed only by AgyCliSession for the exact conversation identity; all
 * activity and terminal decisions below come from the bound SQLite observer.
 */
export class SqlitePrimaryDispatchAdapter<TProcessIdentity>
implements
  AdmissionPromptAgyContract<AgyExactConversationTurn, TProcessIdentity>,
  AdmissionPromptProviderObserver {
  readonly #agentId: string;
  readonly #connectorIdentity: ActiveConnectorIdentity;
  readonly #requestMetadata: SqlitePrimaryRequestMetadataSource;
  readonly #businessPrompts: SqlitePrimaryBusinessPromptSource;
  readonly #sessions: AdmissionSessionScopeResolver;
  readonly #activeSessions: ActiveSessionTurnRegistry;
  readonly #sqliteSnapshots: SqliteProviderSnapshotReader;
  readonly #captureProcessIdentity: SqlitePrimaryDispatchAdapterOptions<TProcessIdentity>["captureProcessIdentity"];
  readonly #createTerminalDelivery: SqlitePrimaryDispatchAdapterOptions<TProcessIdentity>["createTerminalDelivery"];
  readonly #turns = new Map<string, RequestTurn<TProcessIdentity>>();
  readonly #settledRequests = new Set<string>();
  #closed = false;

  constructor(options: SqlitePrimaryDispatchAdapterOptions<TProcessIdentity>) {
    if (!isRecord(options)) throw failure("invalid_configuration");
    this.#agentId = requireIdentifier(options.agentId, "invalid_configuration");
    this.#connectorIdentity = requireConnectorIdentity(options.connectorIdentity);
    this.#requestMetadata = requireMethodOwner(
      options.requestMetadata,
      "readRequestMetadata",
      "invalid_configuration"
    ) as SqlitePrimaryRequestMetadataSource;
    this.#businessPrompts = requireMethodOwner(
      options.businessPrompts,
      "readBusinessPrompt",
      "invalid_configuration"
    ) as SqlitePrimaryBusinessPromptSource;
    if (!(options.sessions instanceof AdmissionSessionScopeResolver)) {
      throw failure("invalid_configuration");
    }
    this.#sessions = options.sessions;
    this.#activeSessions = requireActiveRegistry(options.activeSessions);
    this.#sqliteSnapshots = requireSnapshotReader(options.sqliteSnapshots);
    if (typeof options.captureProcessIdentity !== "function" || typeof options.createTerminalDelivery !== "function") {
      throw failure("invalid_configuration");
    }
    this.#captureProcessIdentity = options.captureProcessIdentity;
    this.#createTerminalDelivery = options.createTerminalDelivery;
  }

  spawnPromptFree(
    contextInput: AdmissionPromptAgySpawnContext
  ): AgyDispatchProcess<AgyExactConversationTurn, TProcessIdentity> {
    if (this.#closed) throw failure("wrong_order");
    const { fence, signal } = normalizeSpawnContext(contextInput);
    if (this.#turns.has(fence.requestId) || this.#settledRequests.has(fence.requestId)) {
      throw failure("duplicate_request");
    }
    if (fence.ownerInstanceId !== this.#connectorIdentity.ownerInstanceId) {
      throw failure("invalid_fence");
    }

    const metadata = this.readMetadata(fence.requestId);
    let scope: AdmissionSessionScope;
    try {
      scope = this.#sessions.resolve(metadata.sessionId);
    } catch {
      throw failure("session_unavailable");
    }

    const expectedPrompt = this.readPrompt(fence.requestId);
    const snapshots = new TrackingSnapshotReader(this.#sqliteSnapshots);
    let turn: AgyExactConversationTurn;
    let initialConversationId: string | null;
    let initialCursor: number;
    try {
      turn = scope.withAgy((agy) => {
        initialConversationId = readNullableIdentifier(agy.conversationId, "session_unavailable");
        initialCursor = requireCursor(agy.lastStepIdx, "session_unavailable");
        assertConversationCursor(initialConversationId, initialCursor, "session_unavailable");
        const minimumCursor = nextCursor(initialCursor);
        return agy.startExactConversationTurn(expectedPrompt, {
          expectedConversationId: initialConversationId,
          minimumCursor,
          reader: snapshots.reader,
          signal
        });
      });
    } catch {
      throw failure("process_start_failed");
    }

    // Assigned inside the synchronous withAgy callback above.
    const conversationId = initialConversationId!;
    const cursor = initialCursor!;
    const processId = readProcessId(turn.processId);
    if (processId === null) {
      cancelTurn(turn);
      throw failure("process_identity_unavailable");
    }

    let identity: TProcessIdentity | null | undefined;
    try {
      identity = this.#captureProcessIdentity(Object.freeze({
        ...fence,
        processId
      }));
    } catch {
      identity = null;
    }
    if (identity === null || identity === undefined) {
      cancelTurn(turn);
      throw failure("process_identity_unavailable");
    }

    let activeBinding: ActiveSessionTurnBinding;
    try {
      activeBinding = createActiveSessionTurnBinding(this.#activeSessions, {
        agentId: this.#agentId,
        sessionId: metadata.sessionId,
        requestId: metadata.requestId,
        conversationId,
        cursor,
        connectorIdentity: this.#connectorIdentity
      });
    } catch {
      cancelTurn(turn);
      throw failure("active_session_unavailable");
    }

    const state: RequestTurn<TProcessIdentity> = {
      fence,
      metadata,
      scope,
      turn,
      identity,
      activeBinding,
      snapshots,
      expectedPrompt,
      signal,
      abortListener: null,
      exactBinding: null,
      pendingTerminal: null,
      promptWritten: false,
      activityObserved: false,
      terminalObserved: false,
      cancelIssued: false,
      cleaned: false
    };
    this.#turns.set(fence.requestId, state);
    state.abortListener = () => {
      this.cancelTurnOnce(state);
      if (!state.promptWritten) this.cleanupState(state, false);
    };
    try {
      signal.addEventListener("abort", state.abortListener, { once: true });
    } catch {
      this.cleanupState(state, true);
      throw failure("process_start_failed");
    }
    if (signal.aborted && !state.cleaned) {
      this.cancelTurnOnce(state);
      this.cleanupState(state, false);
    }

    return Object.freeze({
      process: turn,
      identity,
      promptChannel: turn.promptChannel,
      writeInitialPrompt: (prompt: string): AgyDispatchWriteResult => this.writePrompt(state, prompt)
    });
  }

  /** Dispatcher-owned completion hook for every path that will not observe this turn again. */
  discardPromptFree(contextInput: AdmissionPromptAgySpawnContext): void {
    const { fence } = normalizeSpawnContext(contextInput);
    const state = this.#turns.get(fence.requestId);
    if (state === undefined) return;
    if (!sameFence(state.fence, fence)) throw failure("invalid_fence");
    this.cleanupState(state, true);
  }

  async observeProviderActivity(
    context: AdmissionPromptProviderContext
  ): Promise<AdmissionPromptProviderActivity> {
    const state = this.requireTurn(context);
    if (!state.promptWritten || state.activityObserved || state.terminalObserved) {
      return this.failTurn(state, "wrong_order");
    }

    const bound = await this.bindConversation(state);
    const activity = await observeActivity(bound.observer);
    const safe = normalizeActivity(activity, bound.conversationId);
    if (safe === null || safe.cursor < bound.cursor) {
      if (state.signal.aborted) {
        const terminal = await this.readTerminal(state, bound);
        if (terminal !== null && (terminal.status === "CANCELED" || terminal.status === "INTERRUPTED")) {
          state.pendingTerminal = terminal;
          state.activityObserved = true;
          return Object.freeze({ status: "terminal_observed" });
        }
      }
      return this.failTurn(state, "provider_activity_unobserved");
    }

    try {
      state.activeBinding.advance({ conversationId: safe.conversationId, cursor: safe.cursor });
      updateAgyCursor(state.scope, safe.conversationId, safe.cursor);
    } catch {
      return this.failTurn(state, "provider_activity_unobserved");
    }
    state.activityObserved = true;
    return Object.freeze({ status: "observed" });
  }

  async observeTerminal(
    context: AdmissionPromptProviderContext
  ): Promise<AdmissionPromptTerminalObservation> {
    const state = this.requireTurn(context);
    if (!state.promptWritten || !state.activityObserved || state.terminalObserved) {
      return this.failTurn(state, "wrong_order");
    }

    const bound = await this.bindConversation(state);
    const terminal = state.pendingTerminal ?? await this.readTerminal(state, bound);
    if (terminal === null) return this.failTurn(state, "terminal_unobserved");
    if (
      state.signal.aborted &&
      terminal.status !== "CANCELED" &&
      terminal.status !== "INTERRUPTED"
    ) {
      return this.failTurn(state, "terminal_mismatch");
    }

    const finalCursor = state.snapshots.cursorFor(bound.conversationId);
    if (finalCursor === null || finalCursor < bound.cursor) {
      return this.failTurn(state, "cursor_unavailable");
    }

    let delivery: SqlitePrimaryTerminalDelivery;
    try {
      delivery = normalizeDelivery(await this.#createTerminalDelivery(Object.freeze({
        ...state.metadata,
        conversationId: bound.conversationId,
        cursor: finalCursor,
        terminal
      })));
    } catch {
      return this.failTurn(state, "delivery_unavailable");
    }
    if (
      state.signal.aborted &&
      terminal.status !== "CANCELED" &&
      terminal.status !== "INTERRUPTED"
    ) {
      return this.failTurn(state, "terminal_mismatch");
    }

    try {
      // ActiveSessionTurnBinding performs final cursor advance before terminal.
      state.activeBinding.markTerminal(terminalStateFor(terminal.status), finalCursor);
      updateAgyCursor(state.scope, bound.conversationId, finalCursor);
    } catch {
      return this.failTurn(state, "terminal_mismatch");
    }
    state.terminalObserved = true;

    const result = Object.freeze({
      observations: Object.freeze({
        mode: "sqlite_primary" as const,
        sqliteReconciliation: terminal
      }),
      delivery
    });
    this.cleanupState(state, false);
    return result;
  }

  /** Cancel every local turn at most once, detach listeners, and release prompt references. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const state of [...this.#turns.values()]) this.cleanupState(state, true);
  }

  private readMetadata(requestId: string): Readonly<SqlitePrimaryRequestMetadata> {
    let value: unknown;
    try {
      value = this.#requestMetadata.readRequestMetadata(requestId);
    } catch {
      throw failure("metadata_unavailable");
    }
    const record = exactRecord(value, REQUEST_METADATA_FIELDS);
    if (record === null) throw failure("metadata_unavailable");
    const metadata = Object.freeze({
      requestId: requireIdentifier(record.requestId, "metadata_unavailable"),
      sessionId: requireIdentifier(record.sessionId, "metadata_unavailable"),
      parentId: requireIdentifier(record.parentId, "metadata_unavailable"),
      provider: requireIdentifier(record.provider, "metadata_unavailable"),
      model: requireIdentifier(record.model, "metadata_unavailable")
    });
    if (metadata.requestId !== requestId || metadata.provider !== "antigravity") {
      throw failure("metadata_mismatch");
    }
    return metadata;
  }

  private readPrompt(requestId: string): string {
    let prompt: unknown;
    try {
      prompt = this.#businessPrompts.readBusinessPrompt(requestId);
    } catch {
      throw failure("payload_unavailable");
    }
    if (typeof prompt !== "string") throw failure("payload_unavailable");
    return prompt;
  }

  private writePrompt(state: RequestTurn<TProcessIdentity>, prompt: string): AgyDispatchWriteResult {
    if (
      state.cleaned ||
      state.promptWritten ||
      state.expectedPrompt === null ||
      typeof prompt !== "string" ||
      prompt !== state.expectedPrompt
    ) {
      this.cleanupState(state, true);
      return Object.freeze({ status: "ambiguous" as const });
    }

    let result;
    try {
      result = state.turn.writeBusinessPrompt();
    } catch {
      result = undefined;
    }
    if (result?.status !== "accepted") {
      this.cleanupState(state, true);
      return Object.freeze({ status: "ambiguous" as const });
    }
    state.promptWritten = true;
    return Object.freeze({ status: "accepted" as const });
  }

  private requireTurn(contextInput: AdmissionPromptProviderContext): RequestTurn<TProcessIdentity> {
    const context = normalizeProviderContext(contextInput);
    const state = this.#turns.get(context.requestId);
    if (state === undefined) throw failure("unknown_request");
    if (
      !sameFence(state.fence, context) ||
      state.metadata.sessionId !== context.sessionId ||
      state.metadata.parentId !== context.parentId ||
      state.metadata.provider !== context.provider ||
      state.metadata.model !== context.model
    ) {
      return this.failTurn(state, "provider_context_mismatch");
    }
    return state;
  }

  private async bindConversation(state: RequestTurn<TProcessIdentity>) {
    let bound;
    try {
      bound = await state.turn.binding;
      if (state.exactBinding === null) {
        state.activeBinding.advance({
          conversationId: bound.conversationId,
          cursor: bound.cursor
        });
        state.exactBinding = bound;
      } else if (
        state.exactBinding !== bound ||
        state.exactBinding.conversationId !== bound.conversationId ||
        state.exactBinding.cursor !== bound.cursor
      ) {
        throw failure("conversation_binding_failed");
      }
    } catch {
      return this.failTurn(state, "conversation_binding_failed");
    }
    return bound;
  }

  private async readTerminal(
    state: RequestTurn<TProcessIdentity>,
    bound: ExactConversationBinding
  ): Promise<OfficialTerminalObservation | null> {
    let source: OfficialTerminalObservation | null;
    try {
      source = await bound.observer.observeTerminal();
    } catch {
      source = null;
    }
    return normalizeSqliteTerminal(source, bound.conversationId);
  }

  private cancelTurnOnce(state: RequestTurn<TProcessIdentity>): void {
    if (state.cancelIssued) return;
    state.cancelIssued = true;
    cancelTurn(state.turn);
  }

  private cleanupState(state: RequestTurn<TProcessIdentity>, cancel: boolean): void {
    if (state.cleaned) return;
    state.cleaned = true;
    if (cancel) this.cancelTurnOnce(state);
    if (state.abortListener !== null) {
      try {
        state.signal.removeEventListener("abort", state.abortListener);
      } catch {}
      state.abortListener = null;
    }
    state.expectedPrompt = null;
    state.pendingTerminal = null;
    state.exactBinding = null;
    if (this.#turns.get(state.fence.requestId) === state) this.#turns.delete(state.fence.requestId);
    this.#settledRequests.add(state.fence.requestId);
  }

  private failTurn(
    state: RequestTurn<TProcessIdentity>,
    code: SqlitePrimaryDispatchAdapterErrorCode
  ): never {
    this.cleanupState(state, true);
    throw failure(code);
  }
}

export function createSqlitePrimaryDispatchAdapter<TProcessIdentity>(
  options: SqlitePrimaryDispatchAdapterOptions<TProcessIdentity>
): SqlitePrimaryDispatchAdapter<TProcessIdentity> {
  return new SqlitePrimaryDispatchAdapter(options);
}

class TrackingSnapshotReader {
  readonly #source: SqliteProviderSnapshotReader;
  readonly #cursors = new Map<string, number>();
  readonly #regressed = new Set<string>();
  readonly reader: SqliteProviderSnapshotReader;

  constructor(source: SqliteProviderSnapshotReader) {
    this.#source = source;
    this.reader = Object.freeze({
      readSnapshot: (conversationId: string) => this.readSnapshot(conversationId)
    });
  }

  private async readSnapshot(conversationId: string): Promise<SqliteProviderSnapshot | null> {
    const snapshot = await this.#source.readSnapshot(conversationId);
    if (
      isRecord(snapshot) &&
      snapshot.conversationId === conversationId &&
      typeof snapshot.cursor === "number" &&
      Number.isSafeInteger(snapshot.cursor) &&
      snapshot.cursor >= 0
    ) {
      const current = this.#cursors.get(conversationId);
      if (current !== undefined && snapshot.cursor < current) this.#regressed.add(conversationId);
      this.#cursors.set(conversationId, snapshot.cursor);
    }
    return snapshot;
  }

  cursorFor(conversationId: string): number | null {
    if (this.#regressed.has(conversationId)) return null;
    return this.#cursors.get(conversationId) ?? null;
  }
}

async function observeActivity(observer: BoundSqliteProviderObserver): Promise<SqliteProviderActivityObservation> {
  try {
    return await observer.observeActivity();
  } catch {
    return Object.freeze({ status: "unobserved" });
  }
}

function normalizeActivity(
  value: SqliteProviderActivityObservation,
  expectedConversationId: string
): { readonly conversationId: string; readonly cursor: number } | null {
  if (!isRecord(value) || value.status !== "observed" || !isRecord(value.activity)) return null;
  const activity = exactRecord(value.activity, ["source", "conversationId", "cursor", "observedAt", "status"]);
  if (
    activity === null ||
    activity.source !== "sqlite_reconciliation" ||
    activity.conversationId !== expectedConversationId ||
    activity.status !== "ACTIVE" ||
    typeof activity.cursor !== "number" ||
    !Number.isSafeInteger(activity.cursor) ||
    activity.cursor < 0 ||
    typeof activity.observedAt !== "number" ||
    !Number.isSafeInteger(activity.observedAt) ||
    activity.observedAt < 0
  ) {
    return null;
  }
  return Object.freeze({ conversationId: expectedConversationId, cursor: activity.cursor });
}

function normalizeSqliteTerminal(
  value: unknown,
  expectedConversationId: string
): OfficialTerminalObservation | null {
  let terminal: TerminalEvidence;
  try {
    terminal = normalizeTerminalObservation(value);
  } catch {
    return null;
  }
  if (terminal.source !== "sqlite_reconciliation" || terminal.conversationId !== expectedConversationId) return null;

  const base = {
    source: terminal.source,
    conversationId: terminal.conversationId,
    observedAt: terminal.observedAt,
    status: terminal.status
  };
  if (terminal.outcome !== "failed") return Object.freeze(base);
  return Object.freeze({
    ...base,
    ...(terminal.failure.httpStatus === undefined ? {} : { httpStatus: terminal.failure.httpStatus }),
    ...(terminal.failure.code === undefined ? {} : { code: terminal.failure.code }),
    ...(terminal.failure.reason === undefined ? {} : { reason: terminal.failure.reason })
  });
}

function normalizeDelivery(value: unknown): SqlitePrimaryTerminalDelivery {
  const record = exactRecord(value, DELIVERY_FIELDS);
  if (record === null) throw failure("delivery_unavailable");
  const sequence = requireNonNegativeInteger(record.sequence, "delivery_unavailable");
  const expiresAt = requireNonNegativeInteger(record.expiresAt, "delivery_unavailable");
  if (record.protocol !== ACP_OUTBOX_CAPABILITY) throw failure("delivery_unavailable");
  return Object.freeze({
    eventId: requireIdentifier(record.eventId, "delivery_unavailable"),
    fingerprint: requireIdentifier(record.fingerprint, "delivery_unavailable"),
    payload: requireString(record.payload, "delivery_unavailable"),
    sequence,
    expiresAt,
    protocol: ACP_OUTBOX_CAPABILITY
  });
}

function normalizeSpawnContext(value: unknown): {
  readonly fence: Readonly<AgyDispatchFence>;
  readonly signal: AbortSignal;
} {
  if (!isAdmissionPromptAgySpawnContext(value)) throw failure("invalid_fence");
  const signal = value.signal;
  if (typeof AbortSignal === "undefined" || !(signal instanceof AbortSignal)) {
    throw failure("invalid_fence");
  }
  return Object.freeze({
    fence: normalizeFence({
      requestId: value.requestId,
      leaseId: value.leaseId,
      generation: value.generation,
      ownerInstanceId: value.ownerInstanceId
    }),
    signal
  });
}

function normalizeFence(value: unknown): Readonly<AgyDispatchFence> {
  const record = exactRecord(value, FENCE_FIELDS);
  if (record === null) throw failure("invalid_fence");
  return Object.freeze({
    requestId: requireIdentifier(record.requestId, "invalid_fence"),
    leaseId: requireIdentifier(record.leaseId, "invalid_fence"),
    generation: requirePositiveInteger(record.generation, "invalid_fence"),
    ownerInstanceId: requireIdentifier(record.ownerInstanceId, "invalid_fence")
  });
}

function normalizeProviderContext(value: unknown): AdmissionPromptProviderContext {
  const record = exactRecord(value, [
    "requestId",
    "leaseId",
    "generation",
    "ownerInstanceId",
    "sessionId",
    "parentId",
    "provider",
    "model"
  ]);
  if (record === null) throw failure("provider_context_mismatch");
  return Object.freeze({
    ...normalizeFence({
      requestId: record.requestId,
      leaseId: record.leaseId,
      generation: record.generation,
      ownerInstanceId: record.ownerInstanceId
    }),
    sessionId: requireIdentifier(record.sessionId, "provider_context_mismatch"),
    parentId: requireIdentifier(record.parentId, "provider_context_mismatch"),
    provider: requireIdentifier(record.provider, "provider_context_mismatch"),
    model: requireIdentifier(record.model, "provider_context_mismatch")
  });
}

function requireConnectorIdentity(value: unknown): ActiveConnectorIdentity {
  const record = exactRecord(value, [
    "ownerInstanceId",
    "createdAt",
    "bootId",
    "pid",
    "startTimeTicks",
    "pidNamespaceInode",
    "ppid",
    "pgrp",
    "session"
  ]);
  if (record === null) throw failure("invalid_configuration");
  return Object.freeze({
    ownerInstanceId: requireIdentifier(record.ownerInstanceId, "invalid_configuration"),
    createdAt: requireString(record.createdAt, "invalid_configuration"),
    bootId: requireIdentifier(record.bootId, "invalid_configuration"),
    pid: requirePositiveInteger(record.pid, "invalid_configuration"),
    startTimeTicks: requireIdentifier(record.startTimeTicks, "invalid_configuration"),
    pidNamespaceInode: requirePositiveInteger(record.pidNamespaceInode, "invalid_configuration"),
    ppid: requirePositiveInteger(record.ppid, "invalid_configuration"),
    pgrp: requirePositiveInteger(record.pgrp, "invalid_configuration"),
    session: requirePositiveInteger(record.session, "invalid_configuration")
  });
}

function requireActiveRegistry(value: unknown): ActiveSessionTurnRegistry {
  return requireMethodOwner(value, "register", "invalid_configuration", [
    "advance",
    "markTerminal",
    "archiveTerminal"
  ]) as ActiveSessionTurnRegistry;
}

function requireSnapshotReader(value: unknown): SqliteProviderSnapshotReader {
  return requireMethodOwner(value, "readSnapshot", "invalid_configuration") as SqliteProviderSnapshotReader;
}

function requireMethodOwner(
  value: unknown,
  method: string,
  code: SqlitePrimaryDispatchAdapterErrorCode,
  additionalMethods: readonly string[] = []
): object {
  if (!isRecord(value)) throw failure(code);
  for (const name of [method, ...additionalMethods]) {
    let candidate: unknown;
    try {
      candidate = value[name];
    } catch {
      throw failure(code);
    }
    if (typeof candidate !== "function") throw failure(code);
  }
  return value;
}

function updateAgyCursor(scope: AdmissionSessionScope, conversationId: string, cursor: number): void {
  scope.withAgy((agy: AgyCliSession) => agy.restoreConversation(conversationId, cursor));
}

function terminalStateFor(status: OfficialTerminalStatus): "completed" | "failed" | "cancelled" {
  if (status === "SUCCESS") return "completed";
  if (status === "ERROR") return "failed";
  return "cancelled";
}

function sameFence(left: AgyDispatchFence, right: AgyDispatchFence): boolean {
  return left.requestId === right.requestId &&
    left.leaseId === right.leaseId &&
    left.generation === right.generation &&
    left.ownerInstanceId === right.ownerInstanceId;
}

function nextCursor(cursor: number): number {
  if (cursor >= Number.MAX_SAFE_INTEGER) throw failure("session_unavailable");
  return cursor + 1;
}

function readProcessId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function cancelTurn(turn: AgyExactConversationTurn): void {
  try {
    turn.cancel();
  } catch {}
}

function assertConversationCursor(
  conversationId: string | null,
  cursor: number,
  code: SqlitePrimaryDispatchAdapterErrorCode
): void {
  if ((conversationId === null && cursor !== -1) || (conversationId !== null && cursor < 0)) {
    throw failure(code);
  }
}

function readNullableIdentifier(
  value: unknown,
  code: SqlitePrimaryDispatchAdapterErrorCode
): string | null {
  return value === null ? null : requireIdentifier(value, code);
}

function requireCursor(value: unknown, code: SqlitePrimaryDispatchAdapterErrorCode): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < -1) throw failure(code);
  return value;
}

function requirePositiveInteger(value: unknown, code: SqlitePrimaryDispatchAdapterErrorCode): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw failure(code);
  return value;
}

function requireNonNegativeInteger(value: unknown, code: SqlitePrimaryDispatchAdapterErrorCode): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw failure(code);
  return value;
}

function requireString(value: unknown, code: SqlitePrimaryDispatchAdapterErrorCode): string {
  if (typeof value !== "string") throw failure(code);
  return value;
}

function requireIdentifier(value: unknown, code: SqlitePrimaryDispatchAdapterErrorCode): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > IDENTIFIER_MAX_LENGTH ||
    value.trim() !== value ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw failure(code);
  }
  return value;
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedKeys.length || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))) {
      return null;
    }
    const record: Record<string, unknown> = Object.create(null);
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(code: SqlitePrimaryDispatchAdapterErrorCode): SqlitePrimaryDispatchAdapterError {
  return new SqlitePrimaryDispatchAdapterError(code);
}
