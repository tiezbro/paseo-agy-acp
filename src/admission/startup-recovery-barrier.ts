import type {
  DeliveryClaimLease,
  RecoverableDispatch,
  RecoverableDispatchProcessIdentity,
  VerifiedLinuxConnectorIdentity,
  VerifiedLinuxProcessIdentity
} from "./controller.js";
import type { RecoverableStartupPermit } from "./sqlite-startup-launcher.js";
import type { ActiveSessionRecord } from "../acp/session/active-registry.js";

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_PID = 2_147_483_647;
const MAX_PID_NAMESPACE_INODE = 4_294_967_295;
const MAX_START_TIME_TICKS = 18_446_744_073_709_551_615n;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const OWNER_INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;

const SOURCE_FIELDS = [
  "listRecoverableDispatches",
  "listActiveSessions",
  "listRecoverableOutboxClaims",
  "listRecoverablePermits",
  "inspectProcessResidue"
] as const;
const DISPATCH_FIELDS = [
  "requestId",
  "sessionId",
  "provider",
  "model",
  "fence",
  "phase",
  "heartbeatAt",
  "processIdentity"
] as const;
const FENCE_FIELDS = ["leaseId", "generation", "ownerInstanceId"] as const;
const PROCESS_RECORD_FIELDS = ["promptChannel", "connector", "child"] as const;
const PROCESS_IDENTITY_FIELDS = [
  "bootId",
  "pid",
  "startTimeTicks",
  "pidNamespaceInode",
  "ppid",
  "pgrp",
  "session"
] as const;
const CONNECTOR_IDENTITY_FIELDS = ["ownerInstanceId", "createdAt", ...PROCESS_IDENTITY_FIELDS] as const;
const ACTIVE_SESSION_FIELDS = [
  "agentId",
  "sessionId",
  "requestId",
  "conversationId",
  "cursor",
  "connectorIdentity",
  "leaseGeneration",
  "terminalState"
] as const;
const OUTBOX_CLAIM_FIELDS = [
  "eventId",
  "requestId",
  "ownerInstanceId",
  "claimGeneration",
  "state",
  "heartbeatAt",
  "leaseExpiresAt",
  "terminalReplayCount"
] as const;
const STARTUP_PERMIT_FIELDS = [
  "classification",
  "permitId",
  "ownerInstanceId",
  "generation",
  "acquiredAt",
  "heartbeatAt",
  "heartbeatExpired"
] as const;
const STARTUP_PERMIT_WITH_PROCESS_IDENTITY_FIELDS = [
  ...STARTUP_PERMIT_FIELDS,
  "processIdentity"
] as const;
const STARTUP_PERMIT_PROCESS_IDENTITY_FIELDS = ["connector", "child"] as const;
const PROCESS_INVENTORY_FIELDS = ["observations", "untrackedResidue"] as const;
const PROCESS_OBSERVATION_FIELDS = [
  "requestId",
  "leaseId",
  "generation",
  "ownerInstanceId",
  "connector",
  "child",
  "residue"
] as const;

export type StartupRecoveryProcessState = "same" | "gone" | "pid_reused" | "unverifiable";
export type StartupRecoveryResidueState = "empty" | "present" | "unverifiable";

/** A payload-free process identity usable by the Linux-only residue scanner. */
export interface StartupRecoveryProcessIdentity {
  readonly connector: VerifiedLinuxConnectorIdentity;
  readonly child: VerifiedLinuxProcessIdentity;
}

/**
 * The persistent permit inventory may be enriched with an exact process
 * identity by a repository-owned adapter. The SQLite launcher itself need not
 * invent one when its durable contract cannot express it.
 */
export interface StartupRecoveryPermit extends RecoverableStartupPermit {
  readonly processIdentity?: StartupRecoveryProcessIdentity | null;
}

/** The payload-free subject passed to the Linux-only residue inspector. */
export interface StartupRecoveryProcessSubject {
  /** Dispatch request ID or a deterministic startup-permit subject ID. */
  readonly requestId: string;
  readonly fence: RecoverableDispatch["fence"];
  readonly processIdentity: StartupRecoveryProcessIdentity;
}

/** One observation bound to the exact durable dispatch fence. */
export interface StartupRecoveryProcessObservation {
  readonly requestId: string;
  readonly leaseId: string;
  readonly generation: number;
  readonly ownerInstanceId: string;
  readonly connector: StartupRecoveryProcessState;
  readonly child: StartupRecoveryProcessState;
  readonly residue: StartupRecoveryResidueState;
}

/**
 * A complete Linux scan includes observations for known process identities and
 * an independent answer for connector/agy residue not represented by SQLite.
 */
export interface StartupRecoveryProcessInventory {
  readonly observations: readonly StartupRecoveryProcessObservation[];
  readonly untrackedResidue: StartupRecoveryResidueState;
}

/**
 * Narrow, read-only capabilities. Every source enumerates payload-free durable
 * metadata only; none can decrypt, reclaim, release, signal, requeue, or dispatch.
 */
export interface StartupRecoveryBarrierSources {
  listRecoverableDispatches():
    | readonly RecoverableDispatch[]
    | PromiseLike<readonly RecoverableDispatch[]>;
  listActiveSessions():
    | readonly ActiveSessionRecord[]
    | PromiseLike<readonly ActiveSessionRecord[]>;
  listRecoverableOutboxClaims():
    | readonly DeliveryClaimLease[]
    | PromiseLike<readonly DeliveryClaimLease[]>;
  listRecoverablePermits():
    | readonly StartupRecoveryPermit[]
    | PromiseLike<readonly StartupRecoveryPermit[]>;
  inspectProcessResidue(subjects: readonly StartupRecoveryProcessSubject[]):
    | StartupRecoveryProcessInventory
    | PromiseLike<StartupRecoveryProcessInventory>;
}

export type StartupRecoveryIssue =
  | "dispatch_inventory_unavailable"
  | "active_session_inventory_unavailable"
  | "outbox_claim_inventory_unavailable"
  | "startup_permit_inventory_unavailable"
  | "dispatch_inventory_invalid"
  | "active_session_inventory_invalid"
  | "outbox_claim_inventory_invalid"
  | "startup_permit_inventory_invalid"
  | "duplicate_dispatch"
  | "duplicate_active_session"
  | "duplicate_outbox_claim"
  | "duplicate_startup_permit"
  | "active_session_orphaned"
  | "active_session_dispatch_mismatch"
  | "active_session_missing"
  | "dispatch_process_identity_missing"
  | "startup_permit_owner_fence_mismatch"
  | "process_inventory_unavailable"
  | "process_inventory_invalid"
  | "process_observation_missing"
  | "process_observation_orphaned"
  | "process_observation_mismatch"
  | "untracked_process_residue"
  | "untracked_process_residue_unverifiable"
  | "recoverable_dispatch_pending"
  | "active_session_pending"
  | "outbox_claim_pending"
  | "startup_permit_pending";

export interface StartupRecoveryInventoryCounts {
  readonly dispatches: number | null;
  readonly activeSessions: number | null;
  readonly outboxClaims: number | null;
  readonly startupPermits: number | null;
  readonly processObservations: number | null;
}

export interface StartupRecoveryReady {
  readonly status: "ready";
  readonly counts: StartupRecoveryInventoryCounts;
  readonly issues: readonly [];
}

export type StartupRecoveryBlockedReason =
  | "inventory_unavailable"
  | "inventory_invalid"
  | "inventory_inconsistent"
  | "process_evidence_unavailable"
  | "process_residue_present"
  | "recovery_pending";

export interface StartupRecoveryBlocked {
  readonly status: "blocked";
  readonly reason: StartupRecoveryBlockedReason;
  readonly counts: StartupRecoveryInventoryCounts;
  readonly issues: readonly StartupRecoveryIssue[];
}

export type StartupRecoveryReadiness = StartupRecoveryReady | StartupRecoveryBlocked;

export class StartupRecoveryBarrierConfigurationError extends Error {
  constructor() {
    super("startup recovery barrier configuration is invalid");
    this.name = "StartupRecoveryBarrierConfigurationError";
  }
}

/**
 * One-shot asynchronous startup barrier. It performs inventory and Linux
 * observation only: it has no controller mutation, decryption, claim, TTL
 * recovery, permit release, signal, requeue, or provider-dispatch capability.
 */
export class StartupRecoveryBarrier {
  readonly #sources: StartupRecoveryBarrierSources;
  #decision: Promise<StartupRecoveryReadiness> | undefined;

  constructor(value: unknown) {
    this.#sources = normalizeSources(value);
  }

  waitUntilReady(): Promise<StartupRecoveryReadiness> {
    this.#decision ??= this.evaluate();
    return this.#decision;
  }

  private async evaluate(): Promise<StartupRecoveryReadiness> {
    const [dispatchResult, sessionResult, outboxResult, permitResult] = await Promise.all([
      readInventory(() => this.#sources.listRecoverableDispatches(), normalizeDispatches),
      readInventory(() => this.#sources.listActiveSessions(), normalizeActiveSessions),
      readInventory(() => this.#sources.listRecoverableOutboxClaims(), normalizeOutboxClaims),
      readInventory(() => this.#sources.listRecoverablePermits(), normalizeStartupPermits)
    ]);
    const counts: MutableCounts = {
      dispatches: inventoryCount(dispatchResult),
      activeSessions: inventoryCount(sessionResult),
      outboxClaims: inventoryCount(outboxResult),
      startupPermits: inventoryCount(permitResult),
      processObservations: null
    };
    const sourceIssues = sourceInventoryIssues(dispatchResult, sessionResult, outboxResult, permitResult);
    if (sourceIssues.length > 0) {
      return blocked(
        sourceIssues.some((issue) => issue.endsWith("_unavailable")) ? "inventory_unavailable" : "inventory_invalid",
        counts,
        sourceIssues
      );
    }
    if (
      dispatchResult.status !== "ok" ||
      sessionResult.status !== "ok" ||
      outboxResult.status !== "ok" ||
      permitResult.status !== "ok"
    ) {
      return blocked("inventory_invalid", counts, ["dispatch_inventory_invalid"]);
    }

    const dispatches = dispatchResult.value;
    const activeSessions = sessionResult.value;
    const outboxClaims = outboxResult.value;
    const startupPermits = permitResult.value;
    const consistencyIssues = reconcileDurableInventories(dispatches, activeSessions, outboxClaims, startupPermits);
    if (consistencyIssues.length > 0) {
      return blocked("inventory_inconsistent", counts, consistencyIssues);
    }

    const subjects = Object.freeze([
      ...dispatches.flatMap((dispatch) => dispatch.processIdentity === null ? [] : [processSubject(dispatch)]),
      ...startupPermits.flatMap((permit) =>
        permit.processIdentity == null ? [] : [startupPermitProcessSubject(permit)]
      )
    ]);
    const processResult = await readProcessInventory(() => this.#sources.inspectProcessResidue(subjects));
    if (processResult.status === "unavailable") {
      return blocked("process_evidence_unavailable", counts, ["process_inventory_unavailable"]);
    }
    if (processResult.status === "invalid") {
      return blocked("inventory_invalid", counts, ["process_inventory_invalid"]);
    }
    if (processResult.status !== "ok") {
      return blocked("process_evidence_unavailable", counts, ["process_inventory_unavailable"]);
    }
    counts.processObservations = processResult.value.observations.length;

    const processIssues = reconcileProcessInventory(subjects, processResult.value);
    if (processIssues.length > 0) {
      const reason = processIssues.includes("untracked_process_residue_unverifiable")
        ? "process_evidence_unavailable"
        : processIssues.includes("untracked_process_residue")
          ? "process_residue_present"
          : "inventory_inconsistent";
      return blocked(reason, counts, processIssues);
    }

    const pendingIssues: StartupRecoveryIssue[] = [];
    if (dispatches.length > 0) pendingIssues.push("recoverable_dispatch_pending");
    if (activeSessions.length > 0) pendingIssues.push("active_session_pending");
    if (outboxClaims.length > 0) pendingIssues.push("outbox_claim_pending");
    if (startupPermits.length > 0) pendingIssues.push("startup_permit_pending");
    if (pendingIssues.length > 0) return blocked("recovery_pending", counts, pendingIssues);

    return Object.freeze({
      status: "ready",
      counts: freezeCounts(counts),
      issues: Object.freeze([] as [])
    });
  }
}

type InventoryRead<T> =
  | Readonly<{ status: "ok"; value: readonly T[] }>
  | Readonly<{ status: "unavailable" | "invalid" }>;

interface MutableCounts {
  dispatches: number | null;
  activeSessions: number | null;
  outboxClaims: number | null;
  startupPermits: number | null;
  processObservations: number | null;
}

async function readInventory<T>(
  read: () => readonly T[] | PromiseLike<readonly T[]>,
  normalize: (value: unknown) => readonly T[] | null
): Promise<InventoryRead<T>> {
  let value: unknown;
  try {
    value = await read();
  } catch {
    return Object.freeze({ status: "unavailable" });
  }
  const normalized = normalize(value);
  return normalized === null
    ? Object.freeze({ status: "invalid" })
    : Object.freeze({ status: "ok", value: normalized });
}

async function readProcessInventory(
  read: () => StartupRecoveryProcessInventory | PromiseLike<StartupRecoveryProcessInventory>
): Promise<
  | Readonly<{ status: "ok"; value: StartupRecoveryProcessInventory }>
  | Readonly<{ status: "unavailable" | "invalid" }>
> {
  let value: unknown;
  try {
    value = await read();
  } catch {
    return Object.freeze({ status: "unavailable" });
  }
  const normalized = normalizeProcessInventory(value);
  return normalized === null
    ? Object.freeze({ status: "invalid" })
    : Object.freeze({ status: "ok", value: normalized });
}

function sourceInventoryIssues(
  dispatches: InventoryRead<RecoverableDispatch>,
  sessions: InventoryRead<ActiveSessionRecord>,
  outbox: InventoryRead<DeliveryClaimLease>,
  permits: InventoryRead<StartupRecoveryPermit>
): StartupRecoveryIssue[] {
  const issues: StartupRecoveryIssue[] = [];
  if (dispatches.status !== "ok") issues.push(`dispatch_inventory_${dispatches.status}`);
  if (sessions.status !== "ok") issues.push(`active_session_inventory_${sessions.status}`);
  if (outbox.status !== "ok") issues.push(`outbox_claim_inventory_${outbox.status}`);
  if (permits.status !== "ok") issues.push(`startup_permit_inventory_${permits.status}`);
  return issues;
}

function reconcileDurableInventories(
  dispatches: readonly RecoverableDispatch[],
  sessions: readonly ActiveSessionRecord[],
  outboxClaims: readonly DeliveryClaimLease[],
  startupPermits: readonly StartupRecoveryPermit[]
): StartupRecoveryIssue[] {
  const issues = new Set<StartupRecoveryIssue>();
  const dispatchByRequest = new Map<string, RecoverableDispatch>();
  const leaseIds = new Set<string>();
  for (const dispatch of dispatches) {
    if (dispatchByRequest.has(dispatch.requestId) || leaseIds.has(dispatch.fence.leaseId)) {
      issues.add("duplicate_dispatch");
    }
    dispatchByRequest.set(dispatch.requestId, dispatch);
    leaseIds.add(dispatch.fence.leaseId);
    if (dispatch.processIdentity === null && dispatch.phase !== "admitted" && dispatch.phase !== "starting") {
      issues.add("dispatch_process_identity_missing");
    }
  }

  const sessionRequests = new Set<string>();
  const sessionScopes = new Set<string>();
  for (const session of sessions) {
    const scope = `${session.agentId}\u0000${session.sessionId}`;
    if (sessionRequests.has(session.requestId) || sessionScopes.has(scope)) issues.add("duplicate_active_session");
    sessionRequests.add(session.requestId);
    sessionScopes.add(scope);

    const dispatch = dispatchByRequest.get(session.requestId);
    if (dispatch === undefined) {
      issues.add("active_session_orphaned");
      continue;
    }
    if (
      session.sessionId !== dispatch.sessionId ||
      session.leaseGeneration !== dispatch.fence.generation ||
      dispatch.processIdentity === null ||
      !sameConnectorIdentity(session.connectorIdentity, dispatch.processIdentity.connector)
    ) {
      issues.add("active_session_dispatch_mismatch");
    }
  }

  for (const dispatch of dispatches) {
    if (dispatch.phase === "active" && !sessionRequests.has(dispatch.requestId)) {
      issues.add("active_session_missing");
    }
  }

  const eventIds = new Set<string>();
  for (const claim of outboxClaims) {
    if (eventIds.has(claim.eventId)) issues.add("duplicate_outbox_claim");
    eventIds.add(claim.eventId);
  }

  const permitClassifications = new Set<string>();
  const permitIds = new Set<string>();
  for (const permit of startupPermits) {
    if (permitClassifications.has(permit.classification) || permitIds.has(permit.permitId)) {
      issues.add("duplicate_startup_permit");
    }
    permitClassifications.add(permit.classification);
    permitIds.add(permit.permitId);
    if (permit.processIdentity != null && permit.processIdentity.connector.ownerInstanceId !== permit.ownerInstanceId) {
      issues.add("startup_permit_owner_fence_mismatch");
    }
  }
  return [...issues];
}

function reconcileProcessInventory(
  subjects: readonly StartupRecoveryProcessSubject[],
  inventory: StartupRecoveryProcessInventory
): StartupRecoveryIssue[] {
  const issues = new Set<StartupRecoveryIssue>();
  const subjectsByRequest = new Map(subjects.map((subject) => [subject.requestId, subject]));
  const observedRequests = new Set<string>();

  for (const observation of inventory.observations) {
    if (observedRequests.has(observation.requestId)) {
      issues.add("process_observation_mismatch");
      continue;
    }
    observedRequests.add(observation.requestId);
    const subject = subjectsByRequest.get(observation.requestId);
    if (subject === undefined) {
      issues.add("process_observation_orphaned");
      continue;
    }
    if (
      observation.leaseId !== subject.fence.leaseId ||
      observation.generation !== subject.fence.generation ||
      observation.ownerInstanceId !== subject.fence.ownerInstanceId
    ) {
      issues.add("process_observation_mismatch");
    }
  }
  for (const subject of subjects) {
    if (!observedRequests.has(subject.requestId)) issues.add("process_observation_missing");
  }
  if (inventory.untrackedResidue === "present") issues.add("untracked_process_residue");
  if (inventory.untrackedResidue === "unverifiable") issues.add("untracked_process_residue_unverifiable");
  return [...issues];
}

function processSubject(dispatch: RecoverableDispatch): StartupRecoveryProcessSubject {
  if (dispatch.processIdentity === null) throw new Error("unreachable missing process identity");
  return Object.freeze({
    requestId: dispatch.requestId,
    fence: Object.freeze({ ...dispatch.fence }),
    processIdentity: Object.freeze({
      promptChannel: dispatch.processIdentity.promptChannel,
      connector: Object.freeze({ ...dispatch.processIdentity.connector }),
      child: Object.freeze({ ...dispatch.processIdentity.child })
    })
  });
}

function startupPermitProcessSubject(permit: StartupRecoveryPermit): StartupRecoveryProcessSubject {
  const processIdentity = permit.processIdentity;
  if (processIdentity == null) throw new Error("unreachable missing startup permit process identity");
  return Object.freeze({
    requestId: startupPermitSubjectId(permit),
    fence: Object.freeze({
      leaseId: permit.permitId,
      generation: permit.generation,
      ownerInstanceId: permit.ownerInstanceId
    }),
    processIdentity: Object.freeze({
      connector: Object.freeze({ ...processIdentity.connector }),
      child: Object.freeze({ ...processIdentity.child })
    })
  });
}

function startupPermitSubjectId(permit: StartupRecoveryPermit): string {
  return `startup-permit:${permit.classification}:${permit.permitId}`;
}

function normalizeSources(value: unknown): StartupRecoveryBarrierSources {
  const record = exactRecord(value, SOURCE_FIELDS);
  if (
    record === null ||
    SOURCE_FIELDS.some((field) => typeof record[field] !== "function")
  ) {
    throw new StartupRecoveryBarrierConfigurationError();
  }
  return Object.freeze({
    listRecoverableDispatches: (record.listRecoverableDispatches as StartupRecoveryBarrierSources["listRecoverableDispatches"]).bind(value),
    listActiveSessions: (record.listActiveSessions as StartupRecoveryBarrierSources["listActiveSessions"]).bind(value),
    listRecoverableOutboxClaims: (record.listRecoverableOutboxClaims as StartupRecoveryBarrierSources["listRecoverableOutboxClaims"]).bind(value),
    listRecoverablePermits: (record.listRecoverablePermits as StartupRecoveryBarrierSources["listRecoverablePermits"]).bind(value),
    inspectProcessResidue: (record.inspectProcessResidue as StartupRecoveryBarrierSources["inspectProcessResidue"]).bind(value)
  });
}

function normalizeDispatches(value: unknown): readonly RecoverableDispatch[] | null {
  if (!Array.isArray(value)) return null;
  const normalized: RecoverableDispatch[] = [];
  for (const item of value) {
    const record = exactRecord(item, DISPATCH_FIELDS);
    const fence = record === null ? null : normalizeFence(record.fence);
    const processIdentity = record === null ? undefined : normalizeDispatchProcessIdentity(record.processIdentity);
    if (
      record === null ||
      fence === null ||
      processIdentity === undefined ||
      !isIdentifier(record.requestId) ||
      !isIdentifier(record.sessionId) ||
      !isIdentifier(record.provider) ||
      !isIdentifier(record.model) ||
      !isRecoverablePhase(record.phase) ||
      !isTimestamp(record.heartbeatAt)
    ) return null;
    if ((record.phase === "admitted" || record.phase === "starting") && processIdentity !== null) return null;
    normalized.push(Object.freeze({
      requestId: record.requestId,
      sessionId: record.sessionId,
      provider: record.provider,
      model: record.model,
      fence,
      phase: record.phase,
      heartbeatAt: record.heartbeatAt,
      processIdentity
    }));
  }
  return Object.freeze(normalized);
}

function normalizeActiveSessions(value: unknown): readonly ActiveSessionRecord[] | null {
  if (!Array.isArray(value)) return null;
  const normalized: ActiveSessionRecord[] = [];
  for (const item of value) {
    const record = exactRecord(item, ACTIVE_SESSION_FIELDS);
    const connector = record === null ? null : normalizeConnectorIdentity(record.connectorIdentity);
    if (
      record === null ||
      connector === null ||
      !isIdentifier(record.agentId) ||
      !isIdentifier(record.sessionId) ||
      !isIdentifier(record.requestId) ||
      !isConversation(record.conversationId, record.cursor) ||
      !isPositiveSafeInteger(record.leaseGeneration) ||
      record.terminalState !== null
    ) return null;
    normalized.push(Object.freeze({
      agentId: record.agentId,
      sessionId: record.sessionId,
      requestId: record.requestId,
      conversationId: record.conversationId,
      cursor: record.cursor as number,
      connectorIdentity: connector,
      leaseGeneration: record.leaseGeneration,
      terminalState: null
    }));
  }
  return Object.freeze(normalized);
}

function normalizeOutboxClaims(value: unknown): readonly DeliveryClaimLease[] | null {
  if (!Array.isArray(value)) return null;
  const normalized: DeliveryClaimLease[] = [];
  for (const item of value) {
    const record = exactRecord(item, OUTBOX_CLAIM_FIELDS);
    if (
      record === null ||
      !isIdentifier(record.eventId) ||
      !isIdentifier(record.requestId) ||
      !isIdentifier(record.ownerInstanceId) ||
      !isPositiveSafeInteger(record.claimGeneration) ||
      !isRecoverableClaimState(record.state) ||
      !isTimestamp(record.heartbeatAt) ||
      !isTimestamp(record.leaseExpiresAt) ||
      !isNonnegativeSafeInteger(record.terminalReplayCount)
    ) return null;
    normalized.push(Object.freeze({
      eventId: record.eventId,
      requestId: record.requestId,
      ownerInstanceId: record.ownerInstanceId,
      claimGeneration: record.claimGeneration,
      state: record.state,
      heartbeatAt: record.heartbeatAt,
      leaseExpiresAt: record.leaseExpiresAt,
      terminalReplayCount: record.terminalReplayCount
    }));
  }
  return Object.freeze(normalized);
}

function normalizeStartupPermits(value: unknown): readonly StartupRecoveryPermit[] | null {
  if (!Array.isArray(value)) return null;
  const normalized: StartupRecoveryPermit[] = [];
  for (const item of value) {
    const withoutProcessIdentity = exactRecord(item, STARTUP_PERMIT_FIELDS);
    const record = withoutProcessIdentity ?? exactRecord(item, STARTUP_PERMIT_WITH_PROCESS_IDENTITY_FIELDS);
    const processIdentity = withoutProcessIdentity === null && record !== null
      ? normalizeStartupPermitProcessIdentity(record.processIdentity)
      : null;
    if (record === null || processIdentity === undefined) return null;
    const {
      classification,
      permitId,
      ownerInstanceId,
      generation,
      acquiredAt,
      heartbeatAt,
      heartbeatExpired
    } = record;
    if (
      !isStartupPermitClass(classification) ||
      !isOwnerInstanceId(permitId) ||
      !isOwnerInstanceId(ownerInstanceId) ||
      !isPositiveSafeInteger(generation) ||
      !isTimestamp(acquiredAt) ||
      !isTimestamp(heartbeatAt) ||
      heartbeatAt < acquiredAt ||
      typeof heartbeatExpired !== "boolean"
    ) return null;
    normalized.push(Object.freeze({
      classification,
      permitId,
      ownerInstanceId,
      generation,
      acquiredAt,
      heartbeatAt,
      heartbeatExpired,
      processIdentity
    }));
  }
  return Object.freeze(normalized);
}

function normalizeStartupPermitProcessIdentity(
  value: unknown
): StartupRecoveryProcessIdentity | null | undefined {
  if (value === null) return null;
  const record = exactRecord(value, STARTUP_PERMIT_PROCESS_IDENTITY_FIELDS);
  const connector = record === null ? null : normalizeConnectorIdentity(record.connector);
  const child = record === null ? null : normalizeProcessIdentity(record.child);
  if (record === null || connector === null || child === null) return undefined;
  return Object.freeze({ connector, child });
}

function normalizeProcessInventory(value: unknown): StartupRecoveryProcessInventory | null {
  const record = exactRecord(value, PROCESS_INVENTORY_FIELDS);
  if (record === null || !Array.isArray(record.observations) || !isResidueState(record.untrackedResidue)) return null;
  const observations: StartupRecoveryProcessObservation[] = [];
  for (const item of record.observations) {
    const observation = exactRecord(item, PROCESS_OBSERVATION_FIELDS);
    if (
      observation === null ||
      !isIdentifier(observation.requestId) ||
      !isIdentifier(observation.leaseId) ||
      !isPositiveSafeInteger(observation.generation) ||
      !isIdentifier(observation.ownerInstanceId) ||
      !isProcessState(observation.connector) ||
      !isProcessState(observation.child) ||
      !isResidueState(observation.residue) ||
      (observation.residue === "empty" && (observation.connector === "same" || observation.child === "same"))
    ) return null;
    observations.push(Object.freeze({
      requestId: observation.requestId,
      leaseId: observation.leaseId,
      generation: observation.generation,
      ownerInstanceId: observation.ownerInstanceId,
      connector: observation.connector,
      child: observation.child,
      residue: observation.residue
    }));
  }
  return Object.freeze({ observations: Object.freeze(observations), untrackedResidue: record.untrackedResidue });
}

function normalizeFence(value: unknown): RecoverableDispatch["fence"] | null {
  const record = exactRecord(value, FENCE_FIELDS);
  if (
    record === null ||
    !isIdentifier(record.leaseId) ||
    !isPositiveSafeInteger(record.generation) ||
    !isIdentifier(record.ownerInstanceId)
  ) return null;
  return Object.freeze({
    leaseId: record.leaseId,
    generation: record.generation,
    ownerInstanceId: record.ownerInstanceId
  });
}

function normalizeDispatchProcessIdentity(value: unknown): RecoverableDispatchProcessIdentity | null | undefined {
  if (value === null) return null;
  const record = exactRecord(value, PROCESS_RECORD_FIELDS);
  const connector = record === null ? null : normalizeConnectorIdentity(record.connector);
  const child = record === null ? null : normalizeProcessIdentity(record.child);
  if (record === null || connector === null || child === null || (record.promptChannel !== "stdin" && record.promptChannel !== "pty")) {
    return undefined;
  }
  return Object.freeze({ promptChannel: record.promptChannel, connector, child });
}

function normalizeConnectorIdentity(value: unknown): VerifiedLinuxConnectorIdentity | null {
  const record = exactRecord(value, CONNECTOR_IDENTITY_FIELDS);
  const identity = normalizeProcessIdentityFields(record);
  if (
    record === null ||
    identity === null ||
    !isOwnerInstanceId(record.ownerInstanceId) ||
    !isCanonicalTimestamp(record.createdAt)
  ) return null;
  return Object.freeze({ ownerInstanceId: record.ownerInstanceId, createdAt: record.createdAt, ...identity });
}

function normalizeProcessIdentity(value: unknown): VerifiedLinuxProcessIdentity | null {
  return normalizeProcessIdentityFields(exactRecord(value, PROCESS_IDENTITY_FIELDS));
}

function normalizeProcessIdentityFields(record: Record<string, unknown> | null): VerifiedLinuxProcessIdentity | null {
  if (
    record === null ||
    !isBootId(record.bootId) ||
    !isPositiveInteger(record.pid, MAX_PID) ||
    !isStartTimeTicks(record.startTimeTicks) ||
    !isPositiveInteger(record.pidNamespaceInode, MAX_PID_NAMESPACE_INODE) ||
    !isPositiveInteger(record.ppid, MAX_PID) ||
    !isPositiveInteger(record.pgrp, MAX_PID) ||
    !isPositiveInteger(record.session, MAX_PID)
  ) return null;
  return Object.freeze({
    bootId: record.bootId,
    pid: record.pid,
    startTimeTicks: record.startTimeTicks,
    pidNamespaceInode: record.pidNamespaceInode,
    ppid: record.ppid,
    pgrp: record.pgrp,
    session: record.session
  });
}

function sameConnectorIdentity(left: VerifiedLinuxConnectorIdentity, right: VerifiedLinuxConnectorIdentity): boolean {
  return CONNECTOR_IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function exactRecord(value: unknown, expectedFields: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Object.getOwnPropertyNames(value);
    if (
      Object.getOwnPropertySymbols(value).length > 0 ||
      keys.length !== expectedFields.length ||
      keys.some((key) => !expectedFields.includes(key))
    ) return null;
    const record = value as Record<string, unknown>;
    for (const key of expectedFields) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    }
    return record;
  } catch {
    return null;
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value && !CONTROL_CHARACTER_PATTERN.test(value);
}

function isOwnerInstanceId(value: unknown): value is string {
  return typeof value === "string" && OWNER_INSTANCE_ID_PATTERN.test(value);
}

function isBootId(value: unknown): value is string {
  return typeof value === "string" && BOOT_ID_PATTERN.test(value) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_UTC_TIMESTAMP_PATTERN.test(value)) return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown, maximum: number): value is number {
  return isPositiveSafeInteger(value) && value <= maximum;
}

function isStartTimeTicks(value: unknown): value is string {
  return typeof value === "string" && POSITIVE_DECIMAL_PATTERN.test(value) && BigInt(value) <= MAX_START_TIME_TICKS;
}

function isConversation(conversationId: unknown, cursor: unknown): conversationId is string | null {
  return isNonnegativeSafeInteger(cursor)
    ? isIdentifier(conversationId)
    : cursor === -1 && conversationId === null;
}

function isRecoverablePhase(value: unknown): value is RecoverableDispatch["phase"] {
  return value === "admitted" || value === "starting" || value === "dispatch_intent" ||
    value === "dispatch_ambiguous" || value === "active" || value === "recovery_required";
}

function isRecoverableClaimState(value: unknown): value is DeliveryClaimLease["state"] {
  return value === "claimed" || value === "replay_reserved" || value === "recovery_required";
}

function isStartupPermitClass(value: unknown): value is StartupRecoveryPermit["classification"] {
  return value === "auxiliary" || value === "resident_pty";
}

function isProcessState(value: unknown): value is StartupRecoveryProcessState {
  return value === "same" || value === "gone" || value === "pid_reused" || value === "unverifiable";
}

function isResidueState(value: unknown): value is StartupRecoveryResidueState {
  return value === "empty" || value === "present" || value === "unverifiable";
}

function inventoryCount<T>(result: InventoryRead<T>): number | null {
  return result.status === "ok" ? result.value.length : null;
}

function blocked(
  reason: StartupRecoveryBlockedReason,
  counts: MutableCounts,
  issues: readonly StartupRecoveryIssue[]
): StartupRecoveryBlocked {
  return Object.freeze({
    status: "blocked",
    reason,
    counts: freezeCounts(counts),
    issues: Object.freeze([...issues])
  });
}

function freezeCounts(counts: MutableCounts): StartupRecoveryInventoryCounts {
  return Object.freeze({ ...counts });
}
