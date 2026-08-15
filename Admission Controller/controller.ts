import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { ADMISSION_SCHEMA_VERSION, assertAdmissionSchemaIntegrity } from "./schema.js";

const MAX_DISPATCH_CONTENTION_RECHECKS = 500;
const DISPATCH_CONTENTION_RECHECK_DELAY_MS = 2;
const dispatchContentionRetrySignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export interface AdmissionPolicy {
  maxActiveTurns: number;
  maxConcurrentStarts: number;
  minStartIntervalMs: number;
  queueTimeoutMs: number;
  capacityCooldownMs: number;
}

export interface AdmissionControllerOptions {
  databasePath: string;
  policy: AdmissionPolicy;
  encryptionKey?: Buffer;
  contentFingerprintKey?: Buffer;
  /** Test-only synchronous hook for proving rollback at the atomic dispatch boundary. */
  faultInjection?: AdmissionControllerFaultInjection;
}

/** Test-only synchronous hooks for proving rollback at durable transaction midpoints. */
export interface AdmissionControllerFaultInjection {
  afterProcessIdentityPersisted?(): void;
}

export interface EnqueueRequest {
  requestId: string;
  sessionId: string;
  parentId: string;
  fingerprint: string;
  provider: string;
  model: string;
  now: number;
}

export type ConfirmedProviderOutcome = "completed" | "failed" | "cancelled";

export type RequestState =
  | "queued"
  | "admitted"
  | "starting"
  | "dispatch_intent"
  | "dispatch_ambiguous"
  | "active"
  | "provider_terminal"
  | "completed"
  | "failed"
  | "cancelled"
  | "queue_timeout"
  | "recovery_required";

export type SanitizedEventState = RequestState | "absent";

export type SanitizedEventKind =
  | "request_enqueued"
  | "request_cancelled"
  | "request_abandoned"
  | "request_queue_timed_out"
  | "request_admitted"
  | "request_starting"
  | "request_dispatch_intent"
  | "request_active"
  | "request_dispatch_ambiguous"
  | "request_provider_terminal"
  | "request_released"
  | "request_recovery_required"
  | "request_recovery_seat_released";

/** Exact, identifier-free pagination input for the sanitized audit journal. */
export interface SanitizedEventPageRequest {
  afterEventSeq: number;
  limit: number;
}

/** Audit-only state transition. It cannot be used to recover request payloads or identities. */
export interface SanitizedAdmissionEvent {
  readonly eventSeq: number;
  readonly kind: SanitizedEventKind;
  readonly fromState: SanitizedEventState;
  readonly toState: SanitizedEventState;
  readonly occurredAt: number;
  readonly correlationHmac: string;
}

export interface StoredRequest {
  requestId: string;
  sessionId: string;
  parentId: string;
  fingerprint: string;
  provider: string;
  model: string;
  state: RequestState;
  enqueuedAt: number;
}

/** Terminal fact for the existing online ACP output path. */
export interface LiveTurnCompletion {
  readonly outcome: ConfirmedProviderOutcome;
  readonly failure?: Readonly<{
    readonly category: "provider_capacity" | "quota" | "auth" | "permission" | "timeout" | "transport" | "unknown";
    readonly httpStatus?: number;
    readonly code?: string;
    readonly reason?: string;
  }>;
}

/** Durable queue observation. It grants no admission or recovery authority. */
export interface AdmissionQueueSnapshot {
  readonly requestId: string;
  readonly position: number;
  readonly eligiblePosition: number | null;
  readonly enqueuedAt: number;
  readonly waitedMs: number;
  readonly cooldownUntil: number | null;
}

export interface AdmissionLease {
  leaseId: string;
  requestId: string;
  generation: number;
  ownerInstanceId: string;
}

export type LeaseFence = Pick<AdmissionLease, "leaseId" | "generation" | "ownerInstanceId">;

/** Nonterminal controller phases which need a startup recovery decision. */
export type RecoverableDispatchPhase =
  | "admitted"
  | "starting"
  | "dispatch_intent"
  | "dispatch_ambiguous"
  | "active"
  | "recovery_required";

/** Immutable evidence for one Linux process instance. */
export interface VerifiedLinuxProcessIdentity {
  bootId: string;
  pid: number;
  startTimeTicks: string;
  pidNamespaceInode: number;
  ppid: number;
  pgrp: number;
  session: number;
}

/** Connector owner evidence paired with the connector's stable instance ID. */
export interface VerifiedLinuxConnectorIdentity extends VerifiedLinuxProcessIdentity {
  ownerInstanceId: string;
  createdAt: string;
}

/** The only process record accepted at the irreversible dispatch boundary. */
export interface VerifiedLinuxProcessRecord {
  requestId: string;
  leaseId: string;
  generation: number;
  ownerInstanceId: string;
  processIdentity: {
    connector: VerifiedLinuxConnectorIdentity;
    child: VerifiedLinuxProcessIdentity;
  };
  promptChannel: "stdin" | "pty";
}

/** Durable process evidence available to startup recovery, never request content. */
export interface RecoverableDispatchProcessIdentity {
  readonly promptChannel: "stdin" | "pty";
  readonly connector: VerifiedLinuxConnectorIdentity;
  readonly child: VerifiedLinuxProcessIdentity;
}

/**
 * One nonterminal dispatch candidate after connector startup. A null process
 * identity is intentionally explicit: the caller must fail closed into
 * recovery and must not resume or replay the dispatch from this inventory.
 */
export interface RecoverableDispatch {
  readonly requestId: string;
  readonly sessionId: string;
  readonly provider: string;
  readonly model: string;
  readonly fence: LeaseFence;
  readonly phase: RecoverableDispatchPhase;
  readonly heartbeatAt: number;
  readonly processIdentity: RecoverableDispatchProcessIdentity | null;
}

export type DispatchIntentFailureReason =
  | "invalid_process_identity"
  | "stale_lease"
  | "conflicting_intent"
  | "transaction_fault";

/** Result for the dispatcher identity callback. Success means dispatch_intent is already durable too. */
export type ProcessIdentityRecordResult =
  | { status: "recorded"; idempotent: boolean }
  | { status: "not_recorded"; reason: DispatchIntentFailureReason };

/** Result for the dispatch boundary's following commit callback; only an exact durable replay succeeds. */
export type DispatchIntentCommitResult =
  | { status: "committed"; idempotent: boolean }
  | { status: "not_committed"; reason: DispatchIntentFailureReason };

interface RequestRow {
  request_id: string;
  session_id: string;
  parent_id: string;
  fingerprint: string;
  provider: string;
  model: string;
  state: RequestState;
  enqueued_at: number;
  lease_generation: number;
}

interface LeaseRow {
  lease_id: string;
  request_id: string;
  generation: number;
  owner_instance_id: string;
  phase: RequestState;
}

interface DispatchContentionRecheckRow extends LeaseRow {
  request_state: RequestState;
  request_lease_generation: number;
}

interface PayloadRow {
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
  key_version: number;
  content_fingerprint: string | null;
  expires_at: number;
}

interface EncryptedPayload {
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

interface SanitizedEventRow {
  event_seq: unknown;
  kind: unknown;
  from_state: unknown;
  to_state: unknown;
  occurred_at: unknown;
  correlation_hmac: unknown;
}

interface LeaseProcessIdentityRow {
  lease_id: string;
  request_id: string;
  lease_generation: number;
  owner_instance_id: string;
  prompt_channel: "stdin" | "pty";
  connector_owner_instance_id: string;
  connector_created_at: string;
  connector_boot_id: string;
  connector_pid: number;
  connector_start_time_ticks: string;
  connector_pid_namespace_inode: number;
  connector_ppid: number;
  connector_pgrp: number;
  connector_session: number;
  child_boot_id: string;
  child_pid: number;
  child_start_time_ticks: string;
  child_pid_namespace_inode: number;
  child_ppid: number;
  child_pgrp: number;
  child_session: number;
}

/** Raw values from SQLite must be normalized before startup recovery uses them. */
interface RecoverableDispatchRow {
  lease_id: unknown;
  lease_request_id: unknown;
  lease_generation: unknown;
  lease_owner_instance_id: unknown;
  lease_phase: unknown;
  lease_heartbeat_at: unknown;
  request_id: unknown;
  request_session_id: unknown;
  request_provider: unknown;
  request_model: unknown;
  request_state: unknown;
  request_lease_generation: unknown;
  request_enqueued_at: unknown;
  identity_lease_id: unknown;
  identity_request_id: unknown;
  identity_lease_generation: unknown;
  identity_owner_instance_id: unknown;
  identity_prompt_channel: unknown;
  identity_connector_owner_instance_id: unknown;
  identity_connector_created_at: unknown;
  identity_connector_boot_id: unknown;
  identity_connector_pid: unknown;
  identity_connector_start_time_ticks: unknown;
  identity_connector_pid_namespace_inode: unknown;
  identity_connector_ppid: unknown;
  identity_connector_pgrp: unknown;
  identity_connector_session: unknown;
  identity_child_boot_id: unknown;
  identity_child_pid: unknown;
  identity_child_start_time_ticks: unknown;
  identity_child_pid_namespace_inode: unknown;
  identity_child_ppid: unknown;
  identity_child_pgrp: unknown;
  identity_child_session: unknown;
}

type AtomicDispatchIntentOutcome =
  | { status: "committed"; idempotent: boolean }
  | { status: "not_committed"; reason: DispatchIntentFailureReason };

export class AdmissionConflictError extends Error {
  constructor(_requestId: string) {
    super("request identity was reused with different immutable metadata");
    this.name = "AdmissionConflictError";
  }
}

export class PayloadExpiredError extends Error {
  constructor(_requestId: string) {
    super("request payload has expired");
    this.name = "PayloadExpiredError";
  }
}

export class PayloadConflictError extends Error {
  constructor(_requestId: string) {
    super("request already has a different durable payload");
    this.name = "PayloadConflictError";
  }
}

export class LeaseFenceError extends Error {
  constructor(_leaseId: string) {
    super("lease is not owned by the supplied generation fence");
    this.name = "LeaseFenceError";
  }
}

/** Raised when durable recovery inventory data cannot be trusted. */
export class RecoverableDispatchInventoryError extends Error {
  constructor() {
    super("recoverable dispatch inventory contains an invalid durable row");
    this.name = "RecoverableDispatchInventoryError";
  }
}

class AdmissionControllerInjectedFaultError extends Error {
  constructor() {
    super("admission transaction fault injection");
    this.name = "AdmissionControllerInjectedFaultError";
  }
}

/**
 * A local, cross-process admission plane. It deliberately refuses to infer
 * that a dispatched turn is safe to replay after a crash.
 */
export class AdmissionController {
  readonly databasePath: string;
  readonly policy: AdmissionPolicy;
  readonly #db: Database.Database;
  readonly #encryptionKey?: Buffer;
  readonly #contentFingerprintKey?: Buffer;
  readonly #faultInjection?: AdmissionControllerFaultInjection;

  constructor(options: AdmissionControllerOptions) {
    this.databasePath = options.databasePath;
    this.policy = validatePolicy(options.policy);
    this.#encryptionKey = validatePurposeKey(options.encryptionKey, "encryption");
    this.#contentFingerprintKey = validatePurposeKey(options.contentFingerprintKey, "content fingerprint");
    this.#faultInjection = validateFaultInjection(options.faultInjection);
    this.#db = new Database(options.databasePath);
    this.#db.pragma("foreign_keys = ON");
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = FULL");
    this.#db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.#db.close();
    this.#encryptionKey?.fill(0);
    this.#contentFingerprintKey?.fill(0);
  }

  get schemaVersion(): number {
    const row = this.#db
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number | null };
    return row.version ?? 0;
  }

  enqueue(input: EnqueueRequest): { requestId: string; existed: boolean } {
    return this.transaction(() => this.enqueueRequest(input));
  }

  enqueueWithPayload(
    input: EnqueueRequest,
    plaintext: string,
    expiresAt: number
  ): { requestId: string; existed: boolean } {
    this.validatePayloadExpiry(input.now, expiresAt);
    const keyVersion = 1;
    const contentFingerprint = this.contentFingerprint("turn", input.requestId, plaintext);
    const encrypted = this.encrypt(plaintext, this.payloadAad(input.requestId, keyVersion));

    return this.transaction(() => {
      const result = this.enqueueRequest(input);
      const request = this.requireRequestState(input.requestId);
      if (request.state !== "queued") throw new Error("request is no longer queued");

      const existing = this.#db
        .prepare("SELECT content_fingerprint FROM turn_payloads WHERE request_id = ?")
        .get(input.requestId) as { content_fingerprint: string | null } | undefined;
      if (existing) {
        if (existing.content_fingerprint !== contentFingerprint) throw new PayloadConflictError(input.requestId);
        return { requestId: input.requestId, existed: true };
      }

      this.insertPayload(input.requestId, encrypted, keyVersion, contentFingerprint, expiresAt, input.now);
      return result;
    });
  }

  persistPayload(requestId: string, plaintext: string, now: number, expiresAt: number): void {
    this.validatePayloadExpiry(now, expiresAt);
    const keyVersion = 1;
    const contentFingerprint = this.contentFingerprint("turn", requestId, plaintext);
    const encrypted = this.encrypt(plaintext, this.payloadAad(requestId, keyVersion));

    this.transaction(() => {
      const request = this.requireRequestState(requestId);
      if (request.state !== "queued") throw new Error("request is no longer queued");
      const existing = this.#db
        .prepare("SELECT content_fingerprint FROM turn_payloads WHERE request_id = ?")
        .get(requestId) as { content_fingerprint: string | null } | undefined;
      if (existing) {
        if (existing.content_fingerprint !== contentFingerprint) throw new PayloadConflictError(requestId);
        return;
      }
      this.insertPayload(requestId, encrypted, keyVersion, contentFingerprint, expiresAt, now);
    });
  }

  readPayload(requestId: string, now: number): string {
    const row = this.transaction(() => {
      const row = this.#db
        .prepare(
          "SELECT nonce, ciphertext, auth_tag, key_version, content_fingerprint, expires_at FROM turn_payloads WHERE request_id = ?"
        )
        .get(requestId) as PayloadRow | undefined;
      if (!row) throw new Error("no payload is available");
      if (row.expires_at <= now) {
        this.#db.prepare("DELETE FROM turn_payloads WHERE request_id = ?").run(requestId);
        return null;
      }
      return row;
    });
    if (!row) throw new PayloadExpiredError(requestId);
    if (row.content_fingerprint === null) {
      throw new Error("request payload predates authenticated row binding");
    }

    return this.decrypt(
      { nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag },
      this.payloadAad(requestId, row.key_version)
    );
  }

  /** Cancelling after admission needs process and provider-terminal evidence. */
  cancelQueued(requestId: string, now: number): void {
    this.transaction(() => {
      const request = this.#db
        .prepare("SELECT state FROM turn_requests WHERE request_id = ?")
        .get(requestId) as { state: RequestState } | undefined;
      if (!request) throw new Error("unknown request");
      if (request.state !== "queued") throw new Error("request is no longer queued");

      this.#db
        .prepare("UPDATE turn_requests SET state = 'cancelled', terminal_at = ? WHERE request_id = ?")
        .run(now, requestId);
      this.#db.prepare("DELETE FROM turn_payloads WHERE request_id = ?").run(requestId);
      this.journalTransition("request_cancelled", requestId, "queued", "cancelled", now);
    });
  }

  admitNext(now: number, ownerInstanceId: string): AdmissionLease | null {
    validateIdentifier(ownerInstanceId, "admission owner instance ID");
    validateTimestamp(now, "admission timestamp");
    return this.transaction(() => {
      this.expireQueued(now);
      if (!this.hasDispatchCapacity(now)) return null;
      const candidate = this.selectEligibleRequest(now);
      if (!candidate) return null;
      return this.reserveAdmission(candidate, now, ownerInstanceId);
    });
  }

  /**
   * Atomically admit this request only when the global selector chose it.
   * Callers may wait on their own request, but cannot bypass the controller's
   * oldest-eligible and agent-fair ordering.
   */
  admitRequest(requestId: string, now: number, ownerInstanceId: string): AdmissionLease | null {
    validateIdentifier(requestId, "admission request ID");
    validateIdentifier(ownerInstanceId, "admission owner instance ID");
    validateTimestamp(now, "admission timestamp");
    return this.transaction(() => {
      this.expireQueued(now);
      if (!this.hasDispatchCapacity(now)) return null;
      const candidate = this.selectEligibleRequest(now);
      if (candidate?.request_id !== requestId) return null;
      return this.reserveAdmission(candidate, now, ownerInstanceId);
    });
  }

  getQueueSnapshot(requestId: string, now: number): AdmissionQueueSnapshot | null {
    validateIdentifier(requestId, "queue snapshot request ID");
    validateTimestamp(now, "queue snapshot timestamp");
    return this.transaction(() => {
      this.expireQueued(now);
      const rows = this.orderedQueuedRequests();
      const index = rows.findIndex((row) => row.request_id === requestId);
      if (index < 0) return null;
      const row = rows[index]!;
      const eligible = rows.filter((candidate) => !this.isCooldownActive(candidate.provider, candidate.model, now));
      const eligibleIndex = eligible.findIndex((candidate) => candidate.request_id === requestId);
      return Object.freeze({
        requestId,
        position: index + 1,
        eligiblePosition: eligibleIndex < 0 ? null : eligibleIndex + 1,
        enqueuedAt: row.enqueued_at,
        waitedMs: Math.max(0, now - row.enqueued_at),
        cooldownUntil: this.cooldownUntil(row.provider, row.model, now)
      });
    });
  }

  markStarting(fence: LeaseFence, now: number): void {
    this.transaction(() => {
      const lease = this.requireLease(fence);
      if (lease.phase !== "admitted") throw new Error("lease is not admitted");
      const starts = this.#db
        .prepare("SELECT COUNT(*) AS count FROM leases WHERE phase IN ('starting', 'dispatch_intent')")
        .get() as { count: number };
      if (starts.count >= this.policy.maxConcurrentStarts) throw new Error("concurrent start limit reached");
      this.#db
        .prepare("DELETE FROM start_history WHERE started_at < ?")
        .run(now - this.policy.minStartIntervalMs);
      const latestStart = this.#db
        .prepare("SELECT started_at FROM start_history ORDER BY started_at DESC LIMIT 1")
        .get() as { started_at: number } | undefined;
      if (latestStart && now < latestStart.started_at + this.policy.minStartIntervalMs) {
        throw new Error("start interval has not elapsed");
      }
      this.#db.prepare("INSERT INTO start_history (lease_id, started_at) VALUES (?, ?)").run(fence.leaseId, now);
      this.setLeasePhase(lease, "starting", now);
    });
  }

  /**
   * Persist a verified Linux process record and dispatch_intent in one SQLite
   * transaction. The following dispatch-boundary commit callback is an exact replay
   * check, so no crash window exists between those two callbacks.
   */
  recordProcessIdentity(input: unknown): ProcessIdentityRecordResult {
    const outcome = this.persistProcessIdentityAndDispatchIntent(input);
    return outcome.status === "committed"
      ? { status: "recorded", idempotent: outcome.idempotent }
      : { status: "not_recorded", reason: outcome.reason };
  }

  /**
   * Confirm the atomic identity-and-intent persistence. A fresh call performs
   * the same transaction; a matching dispatch_intent record is idempotent.
   */
  commitDispatchIntent(input: unknown): DispatchIntentCommitResult {
    const outcome = this.persistProcessIdentityAndDispatchIntent(input);
    return outcome.status === "committed"
      ? { status: "committed", idempotent: outcome.idempotent }
      : { status: "not_committed", reason: outcome.reason };
  }

  markDispatchIntent(fence: LeaseFence, now: number): void {
    this.transition(fence, "starting", "dispatch_intent", now);
  }

  markActive(fence: LeaseFence, now: number): void {
    this.transaction(() => {
      const lease = this.requireLease(fence);
      if (lease.phase !== "dispatch_intent") throw new Error("lease is not dispatch_intent");
      this.setLeasePhase(lease, "active", now);
      // Once the irreversible write has been issued, the payload must never be
      // available to a recovery path that could repeat the business prompt.
      this.#db.prepare("DELETE FROM turn_payloads WHERE request_id = ?").run(lease.request_id);
    });
  }

  markDispatchAmbiguous(fence: LeaseFence, now: number): void {
    this.transition(fence, "dispatch_intent", "dispatch_ambiguous", now);
  }

  /**
   * End a reserved turn only when the Connector still has direct proof that no
   * business prompt write occurred. This is terminal, never a requeue.
   */
  abandonBeforePrompt(
    fence: LeaseFence,
    now: number,
    outcome: Extract<ConfirmedProviderOutcome, "failed" | "cancelled">
  ): void {
    validateTimestamp(now, "pre-prompt abandonment timestamp");
    this.transaction(() => {
      const lease = this.requireLease(fence);
      if (lease.phase !== "admitted" && lease.phase !== "starting" && lease.phase !== "dispatch_intent") {
        throw new Error("lease is not safely abandonable before prompt write");
      }
      this.#db
        .prepare("UPDATE turn_requests SET state = ?, terminal_at = ? WHERE request_id = ?")
        .run(outcome, now, lease.request_id);
      this.#db.prepare("DELETE FROM turn_payloads WHERE request_id = ?").run(lease.request_id);
      const released = this.#db
        .prepare("DELETE FROM leases WHERE lease_id = ? AND owner_instance_id = ? AND generation = ?")
        .run(fence.leaseId, fence.ownerInstanceId, fence.generation);
      if (released.changes !== 1) throw new LeaseFenceError(fence.leaseId);
      this.journalTransition("request_abandoned", lease.request_id, lease.phase, outcome, now);
    });
  }

  /** Retain an uncertain dispatch as visible capacity debt; never requeue it. */
  markExecutionRecoveryRequired(fence: LeaseFence, now: number): void {
    validateTimestamp(now, "execution recovery timestamp");
    this.transaction(() => {
      const lease = this.requireLease(fence);
      if (lease.phase === "recovery_required") return;
      if (
        lease.phase !== "starting" &&
        lease.phase !== "dispatch_intent" &&
        lease.phase !== "dispatch_ambiguous" &&
        lease.phase !== "active"
      ) {
        throw new Error("lease cannot enter execution recovery");
      }
      const updated = this.#db
        .prepare(
          `UPDATE leases SET phase = 'recovery_required', heartbeat_at = ?
           WHERE lease_id = ? AND owner_instance_id = ? AND generation = ?`
        )
        .run(now, fence.leaseId, fence.ownerInstanceId, fence.generation);
      if (updated.changes !== 1) throw new LeaseFenceError(fence.leaseId);
      this.#db
        .prepare("UPDATE turn_requests SET state = 'recovery_required', terminal_at = ? WHERE request_id = ?")
        .run(now, lease.request_id);
      this.journalTransition("request_recovery_required", lease.request_id, lease.phase, "recovery_required", now);
      this.#db.prepare("DELETE FROM turn_payloads WHERE request_id = ?").run(lease.request_id);
    });
  }

  /**
   * Release only the local seat after the Connector has independently proved
   * that the persisted connector, child, and process group are all gone. The
   * request deliberately remains recovery_required and cannot be replayed.
   */
  releaseExitedRecoverySeat(fence: LeaseFence, now: number): void {
    validateTimestamp(now, "exited recovery seat timestamp");
    this.transaction(() => {
      const lease = this.requireLease(fence);
      if (
        lease.phase === "provider_terminal" ||
        lease.phase === "completed" ||
        lease.phase === "failed" ||
        lease.phase === "cancelled" ||
        lease.phase === "queue_timeout"
      ) {
        throw new Error("lease is not an unresolved local execution");
      }
      this.#db
        .prepare("UPDATE turn_requests SET state = 'recovery_required', terminal_at = ? WHERE request_id = ?")
        .run(now, lease.request_id);
      this.#db.prepare("DELETE FROM turn_payloads WHERE request_id = ?").run(lease.request_id);
      const released = this.#db
        .prepare("DELETE FROM leases WHERE lease_id = ? AND owner_instance_id = ? AND generation = ?")
        .run(fence.leaseId, fence.ownerInstanceId, fence.generation);
      if (released.changes !== 1) throw new LeaseFenceError(fence.leaseId);
      this.journalTransition(
        "request_recovery_seat_released",
        lease.request_id,
        lease.phase,
        "recovery_required",
        now
      );
    });
  }

  /**
   * Persist the terminal state and release the seat used by the existing live
   * ACP update path. No delivery replay record is created.
   */
  completeLiveTurn(fence: LeaseFence, now: number, completion: LiveTurnCompletion): void {
    validateTimestamp(now, "live turn completion timestamp");
    validateLiveTurnCompletion(completion);
    this.transaction(() => {
      const lease = this.requireLease(fence);
      if (lease.phase !== "active") throw new Error("lease is not active");
      const request = this.getRequest(lease.request_id);
      if (request === null) throw new Error("unknown request");

      this.#db
        .prepare("UPDATE turn_requests SET state = 'provider_terminal', terminal_at = ? WHERE request_id = ?")
        .run(now, lease.request_id);
      this.journalTransition("request_provider_terminal", lease.request_id, "active", "provider_terminal", now);

      if (completion.failure?.category === "provider_capacity") {
        const notBefore = now + this.policy.capacityCooldownMs;
        this.#db
          .prepare(
            `INSERT INTO cooldowns (provider, model, not_before, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(provider, model) DO UPDATE SET
               not_before = MAX(cooldowns.not_before, excluded.not_before),
               updated_at = MAX(cooldowns.updated_at, excluded.updated_at)`
          )
          .run(request.provider, request.model, notBefore, now);
      }

      this.#db
        .prepare("UPDATE turn_requests SET state = ?, terminal_at = ? WHERE request_id = ?")
        .run(completion.outcome, now, lease.request_id);
      this.#db.prepare("DELETE FROM turn_payloads WHERE request_id = ?").run(lease.request_id);
      const released = this.#db
        .prepare("DELETE FROM leases WHERE lease_id = ? AND owner_instance_id = ? AND generation = ?")
        .run(fence.leaseId, fence.ownerInstanceId, fence.generation);
      if (released.changes !== 1) throw new LeaseFenceError(fence.leaseId);
      this.journalTransition("request_released", lease.request_id, "provider_terminal", completion.outcome, now);
    });
  }

  heartbeat(fence: LeaseFence, now: number): void {
    const result = this.#db
      .prepare("UPDATE leases SET heartbeat_at = ? WHERE lease_id = ? AND owner_instance_id = ? AND generation = ?")
      .run(now, fence.leaseId, fence.ownerInstanceId, fence.generation);
    if (result.changes !== 1) throw new LeaseFenceError(fence.leaseId);
  }

  setCapacityCooldown(provider: string, model: string, notBefore: number, now: number): void {
    if (!Number.isSafeInteger(notBefore) || !Number.isSafeInteger(now) || notBefore < now) {
      throw new Error("capacity cooldown must use integer timestamps and cannot end before it is recorded");
    }
    this.#db
      .prepare(
        `INSERT INTO cooldowns (provider, model, not_before, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(provider, model) DO UPDATE SET
           not_before = MAX(cooldowns.not_before, excluded.not_before),
           updated_at = MAX(cooldowns.updated_at, excluded.updated_at)`
      )
      .run(provider, model, notBefore, now);
  }

  /**
   * Read an identifier-free page of the append-only audit journal. The exact
   * input shape deliberately provides no request/session/provider lookup seam.
   */
  readSanitizedEvents(input: unknown): readonly SanitizedAdmissionEvent[] {
    const page = normalizeSanitizedEventPageRequest(input);
    const rows = this.#db
      .prepare(
        `SELECT event_seq, kind, from_state, to_state, occurred_at, correlation_hmac
         FROM events WHERE event_seq > ? ORDER BY event_seq ASC LIMIT ?`
      )
      .all(page.afterEventSeq, page.limit) as SanitizedEventRow[];
    return Object.freeze(rows.map((row) => normalizeSanitizedEventRow(row)));
  }

  getRequest(requestId: string): StoredRequest | null {
    const row = this.#db
      .prepare(
        `SELECT request_id, session_id, parent_id, fingerprint, provider, model, state, enqueued_at
         , lease_generation
         FROM turn_requests WHERE request_id = ?`
      )
      .get(requestId) as RequestRow | undefined;
    return row ? toStoredRequest(row) : null;
  }

  /**
   * Enumerate durable, nonterminal dispatches for connector startup recovery.
   * This deliberately reads no prompt or outbox table, never decrypts data,
   * and returns a null identity instead of implying that a dispatch is safe to
   * resume when immutable process evidence is absent.
   */
  listRecoverableDispatches(): readonly RecoverableDispatch[] {
    const rows = this.#db
      .prepare(
        `SELECT lease.lease_id AS lease_id,
                lease.request_id AS lease_request_id,
                lease.generation AS lease_generation,
                lease.owner_instance_id AS lease_owner_instance_id,
                lease.phase AS lease_phase,
                lease.heartbeat_at AS lease_heartbeat_at,
                request.request_id AS request_id,
                request.session_id AS request_session_id,
                request.provider AS request_provider,
                request.model AS request_model,
                request.state AS request_state,
                request.lease_generation AS request_lease_generation,
                request.enqueued_at AS request_enqueued_at,
                identity.lease_id AS identity_lease_id,
                identity.request_id AS identity_request_id,
                identity.lease_generation AS identity_lease_generation,
                identity.owner_instance_id AS identity_owner_instance_id,
                identity.prompt_channel AS identity_prompt_channel,
                identity.connector_owner_instance_id AS identity_connector_owner_instance_id,
                identity.connector_created_at AS identity_connector_created_at,
                identity.connector_boot_id AS identity_connector_boot_id,
                identity.connector_pid AS identity_connector_pid,
                identity.connector_start_time_ticks AS identity_connector_start_time_ticks,
                identity.connector_pid_namespace_inode AS identity_connector_pid_namespace_inode,
                identity.connector_ppid AS identity_connector_ppid,
                identity.connector_pgrp AS identity_connector_pgrp,
                identity.connector_session AS identity_connector_session,
                identity.child_boot_id AS identity_child_boot_id,
                identity.child_pid AS identity_child_pid,
                identity.child_start_time_ticks AS identity_child_start_time_ticks,
                identity.child_pid_namespace_inode AS identity_child_pid_namespace_inode,
                identity.child_ppid AS identity_child_ppid,
                identity.child_pgrp AS identity_child_pgrp,
                identity.child_session AS identity_child_session
         FROM leases AS lease
         LEFT JOIN turn_requests AS request ON request.request_id = lease.request_id
         LEFT JOIN lease_process_identities AS identity ON identity.lease_id = lease.lease_id
         ORDER BY request.enqueued_at ASC, request.request_id ASC, lease.lease_id ASC`
      )
      .all() as RecoverableDispatchRow[];
    const inventory: RecoverableDispatch[] = [];
    for (const row of rows) {
      const dispatch = toRecoverableDispatch(row);
      if (dispatch !== null) inventory.push(dispatch);
    }
    return Object.freeze(inventory);
  }

  private migrate(): void {
    this.transaction(() => {
      this.#db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at INTEGER NOT NULL
        );
      `);
      const applied = this.schemaVersion;
      if (applied > ADMISSION_SCHEMA_VERSION) {
        throw new Error(`admission database schema version ${applied} is newer than this connector supports`);
      }
      if (applied === 0) {
        const existing = this.#db
          .prepare(
            `SELECT COUNT(*) AS count FROM sqlite_master
             WHERE type = 'table' AND name IN (
               'turn_requests', 'leases', 'cooldowns', 'turn_payloads',
               'lease_process_identities', 'start_history', 'sessions', 'events'
             )`
          )
          .get() as { count: number };
        if (existing.count > 0) {
          throw new Error("unversioned admission tables require an explicit migration before use");
        }
        this.#db.exec(`
          CREATE TABLE turn_requests (
            request_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            parent_id TEXT NOT NULL,
            fingerprint TEXT NOT NULL,
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            state TEXT NOT NULL,
            enqueued_at INTEGER NOT NULL,
            deadline_at INTEGER NOT NULL,
            lease_generation INTEGER NOT NULL DEFAULT 0,
            terminal_at INTEGER
          );
          CREATE TABLE leases (
            lease_id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL UNIQUE REFERENCES turn_requests(request_id),
            generation INTEGER NOT NULL,
            owner_instance_id TEXT NOT NULL,
            phase TEXT NOT NULL,
            acquired_at INTEGER NOT NULL,
            heartbeat_at INTEGER NOT NULL
          );
          CREATE TABLE cooldowns (
            provider TEXT NOT NULL,
            model TEXT NOT NULL,
            not_before INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (provider, model)
          );
          CREATE TABLE turn_payloads (
            request_id TEXT PRIMARY KEY REFERENCES turn_requests(request_id) ON DELETE CASCADE,
            nonce BLOB NOT NULL,
            ciphertext BLOB NOT NULL,
            auth_tag BLOB NOT NULL,
            key_version INTEGER NOT NULL,
            content_fingerprint TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            created_at INTEGER NOT NULL
          );
          CREATE TABLE lease_process_identities (
            lease_id TEXT PRIMARY KEY REFERENCES leases(lease_id) ON DELETE CASCADE,
            request_id TEXT NOT NULL REFERENCES turn_requests(request_id),
            lease_generation INTEGER NOT NULL,
            owner_instance_id TEXT NOT NULL,
            prompt_channel TEXT NOT NULL,
            connector_owner_instance_id TEXT NOT NULL,
            connector_created_at TEXT NOT NULL,
            connector_boot_id TEXT NOT NULL,
            connector_pid INTEGER NOT NULL,
            connector_start_time_ticks TEXT NOT NULL,
            connector_pid_namespace_inode INTEGER NOT NULL,
            connector_ppid INTEGER NOT NULL,
            connector_pgrp INTEGER NOT NULL,
            connector_session INTEGER NOT NULL,
            child_boot_id TEXT NOT NULL,
            child_pid INTEGER NOT NULL,
            child_start_time_ticks TEXT NOT NULL,
            child_pid_namespace_inode INTEGER NOT NULL,
            child_ppid INTEGER NOT NULL,
            child_pgrp INTEGER NOT NULL,
            child_session INTEGER NOT NULL,
            recorded_at INTEGER NOT NULL
          );
          CREATE TABLE start_history (
            lease_id TEXT PRIMARY KEY,
            started_at INTEGER NOT NULL
          );
          CREATE TABLE sessions (
            session_id TEXT NOT NULL PRIMARY KEY,
            conversation_id TEXT,
            conversation_cursor INTEGER NOT NULL,
            model TEXT NOT NULL,
            effort TEXT NOT NULL,
            mode TEXT NOT NULL,
            cwd TEXT NOT NULL,
            roots_json TEXT NOT NULL,
            v2_user_message_ids_json TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE events (
            event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            from_state TEXT NOT NULL,
            to_state TEXT NOT NULL,
            occurred_at INTEGER NOT NULL,
            correlation_hmac TEXT NOT NULL
          );
          CREATE INDEX turn_requests_queue ON turn_requests(state, enqueued_at);
          CREATE INDEX leases_phase ON leases(phase);
          CREATE UNIQUE INDEX lease_process_identities_request ON lease_process_identities(request_id);
          CREATE INDEX start_history_started ON start_history(started_at);
          CREATE INDEX sessions_updated_at_session_id ON sessions(updated_at DESC, session_id ASC);
          CREATE INDEX sessions_cwd_updated_at_session_id ON sessions(cwd, updated_at DESC, session_id ASC);
          CREATE INDEX events_occurred ON events(occurred_at, event_seq);
        `);
        this.#db
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, 'shared-admission-queue', ?)")
          .run(ADMISSION_SCHEMA_VERSION, Date.now());
      }

      assertAdmissionSchemaIntegrity(this.#db);
    });
  }

  private transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn)();
  }

  private runInjectedTransactionFault(callback: (() => void) | undefined): void {
    if (callback === undefined) return;
    try {
      callback();
    } catch {
      throw new AdmissionControllerInjectedFaultError();
    }
  }

  private persistProcessIdentityAndDispatchIntent(input: unknown): AtomicDispatchIntentOutcome {
    const record = normalizeVerifiedLinuxProcessRecord(input);
    if (record === null) return { status: "not_committed", reason: "invalid_process_identity" };

    try {
      return this.transaction(() => this.persistProcessIdentityAndDispatchIntentInTransaction(record));
    } catch (error) {
      // Do not expose driver errors or partially durable state to a prompt writer.
      return (
        (isSqliteTransactionContention(error) ? this.recheckDispatchIdentityAfterContention(record) : null) ?? {
          status: "not_committed",
          reason: "transaction_fault"
        }
      );
    }
  }

  /** A failed writer may inspect only a committed, exact winner; it never retries a write. */
  private recheckDispatchIdentityAfterContention(
    record: VerifiedLinuxProcessRecord
  ): AtomicDispatchIntentOutcome | null {
    for (let attempt = 0; attempt < MAX_DISPATCH_CONTENTION_RECHECKS; attempt += 1) {
      try {
        const outcome = this.transaction(() => this.inspectDispatchIdentityContentionWinner(record));
        if (outcome !== "pending") return outcome;
      } catch (error) {
        if (!isSqliteTransactionContention(error)) return null;
      }
      if (attempt < MAX_DISPATCH_CONTENTION_RECHECKS - 1) {
        Atomics.wait(dispatchContentionRetrySignal, 0, 0, DISPATCH_CONTENTION_RECHECK_DELAY_MS);
      }
    }
    return null;
  }

  /** Reads the lease and identity under one snapshot so no partial winner can be inferred. */
  private inspectDispatchIdentityContentionWinner(
    record: VerifiedLinuxProcessRecord
  ): AtomicDispatchIntentOutcome | "pending" | null {
    const lease = this.#db
      .prepare(
        `SELECT lease.lease_id, lease.request_id, lease.generation, lease.owner_instance_id,
                lease.phase, request.state AS request_state,
                request.lease_generation AS request_lease_generation
         FROM leases AS lease
         JOIN turn_requests AS request ON request.request_id = lease.request_id
         WHERE lease.lease_id = ?`
      )
      .get(record.leaseId) as DispatchContentionRecheckRow | undefined;
    if (
      lease === undefined ||
      lease.request_id !== record.requestId ||
      lease.generation !== record.generation ||
      lease.owner_instance_id !== record.ownerInstanceId ||
      lease.request_lease_generation !== record.generation
    ) {
      return null;
    }
    const identity = this.findLeaseProcessIdentity(record.leaseId);
    if (lease.phase === "dispatch_intent" && lease.request_state === "dispatch_intent") {
      if (
        identity === undefined ||
        identity.request_id !== record.requestId ||
        identity.lease_generation !== record.generation ||
        identity.owner_instance_id !== record.ownerInstanceId
      ) {
        return null;
      }
      return sameLeaseProcessIdentity(identity, record)
        ? { status: "committed", idempotent: true }
        : { status: "not_committed", reason: "conflicting_intent" };
    }
    return lease.phase === "starting" && lease.request_state === "starting" && identity === undefined
      ? "pending"
      : null;
  }

  private persistProcessIdentityAndDispatchIntentInTransaction(
    record: VerifiedLinuxProcessRecord
  ): AtomicDispatchIntentOutcome {
    const lease = this.#db
      .prepare(
        "SELECT lease_id, request_id, generation, owner_instance_id, phase FROM leases WHERE lease_id = ?"
      )
      .get(record.leaseId) as LeaseRow | undefined;
    if (
      lease === undefined ||
      lease.request_id !== record.requestId ||
      lease.generation !== record.generation ||
      lease.owner_instance_id !== record.ownerInstanceId
    ) {
      return { status: "not_committed", reason: "stale_lease" };
    }

    const existing = this.findLeaseProcessIdentity(record.leaseId);
    if (lease.phase === "dispatch_intent") {
      return existing !== undefined && sameLeaseProcessIdentity(existing, record)
        ? { status: "committed", idempotent: true }
        : { status: "not_committed", reason: "conflicting_intent" };
    }
    if (lease.phase !== "starting") return { status: "not_committed", reason: "stale_lease" };
    if (existing !== undefined) return { status: "not_committed", reason: "conflicting_intent" };

    const committedAt = Date.now();
    const phase = this.#db
      .prepare(
        `UPDATE leases
         SET phase = 'dispatch_intent', heartbeat_at = ?
         WHERE lease_id = ? AND owner_instance_id = ? AND generation = ? AND phase = 'starting'`
      )
      .run(committedAt, record.leaseId, record.ownerInstanceId, record.generation);
    if (phase.changes !== 1) return { status: "not_committed", reason: "stale_lease" };

    this.insertLeaseProcessIdentity(record, committedAt);
    this.#faultInjection?.afterProcessIdentityPersisted?.();

    const request = this.#db
      .prepare(
        `UPDATE turn_requests
         SET state = 'dispatch_intent'
         WHERE request_id = ? AND lease_generation = ? AND state = 'starting'`
      )
      .run(record.requestId, record.generation);
    if (request.changes !== 1) {
      throw new Error("lease and request state diverged at dispatch intent persistence");
    }
    this.journalTransition(
      "request_dispatch_intent",
      record.requestId,
      "starting",
      "dispatch_intent",
      committedAt
    );
    return { status: "committed", idempotent: false };
  }

  private findLeaseProcessIdentity(leaseId: string): LeaseProcessIdentityRow | undefined {
    return this.#db
      .prepare(
        `SELECT lease_id, request_id, lease_generation, owner_instance_id, prompt_channel,
                connector_owner_instance_id, connector_created_at, connector_boot_id, connector_pid,
                connector_start_time_ticks, connector_pid_namespace_inode, connector_ppid, connector_pgrp,
                connector_session, child_boot_id, child_pid, child_start_time_ticks, child_pid_namespace_inode,
                child_ppid, child_pgrp, child_session
         FROM lease_process_identities
         WHERE lease_id = ?`
      )
      .get(leaseId) as LeaseProcessIdentityRow | undefined;
  }

  private insertLeaseProcessIdentity(record: VerifiedLinuxProcessRecord, recordedAt: number): void {
    const { connector, child } = record.processIdentity;
    this.#db
      .prepare(
        `INSERT INTO lease_process_identities (
           lease_id, request_id, lease_generation, owner_instance_id, prompt_channel,
           connector_owner_instance_id, connector_created_at, connector_boot_id, connector_pid,
           connector_start_time_ticks, connector_pid_namespace_inode, connector_ppid, connector_pgrp,
           connector_session, child_boot_id, child_pid, child_start_time_ticks, child_pid_namespace_inode,
           child_ppid, child_pgrp, child_session, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.leaseId,
        record.requestId,
        record.generation,
        record.ownerInstanceId,
        record.promptChannel,
        connector.ownerInstanceId,
        connector.createdAt,
        connector.bootId,
        connector.pid,
        connector.startTimeTicks,
        connector.pidNamespaceInode,
        connector.ppid,
        connector.pgrp,
        connector.session,
        child.bootId,
        child.pid,
        child.startTimeTicks,
        child.pidNamespaceInode,
        child.ppid,
        child.pgrp,
        child.session,
        recordedAt
      );
  }

  private expireQueued(now: number): void {
    const expired = this.#db
      .prepare(
        "SELECT request_id FROM turn_requests WHERE state = 'queued' AND deadline_at <= ? ORDER BY request_id ASC"
      )
      .all(now) as Array<{ request_id: string }>;
    for (const row of expired) {
      const result = this.#db
        .prepare(
          "UPDATE turn_requests SET state = 'queue_timeout', terminal_at = ? WHERE request_id = ? AND state = 'queued'"
        )
        .run(now, row.request_id);
      if (result.changes === 1) {
        this.#db.prepare("DELETE FROM turn_payloads WHERE request_id = ?").run(row.request_id);
        this.journalTransition("request_queue_timed_out", row.request_id, "queued", "queue_timeout", now);
      }
    }
  }

  private activeLeaseCount(): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS count FROM leases
         WHERE phase IN ('admitted', 'starting', 'dispatch_intent', 'dispatch_ambiguous', 'active', 'recovery_required')`
      )
      .get() as { count: number };
    return row.count;
  }

  private hasSeatCapacity(): boolean {
    return this.activeLeaseCount() < this.policy.maxActiveTurns;
  }

  private hasDispatchCapacity(now: number): boolean {
    if (!this.hasSeatCapacity()) return false;
    const starts = this.#db
      .prepare("SELECT COUNT(*) AS count FROM leases WHERE phase IN ('admitted', 'starting', 'dispatch_intent')")
      .get() as { count: number };
    if (starts.count >= this.policy.maxConcurrentStarts) return false;
    const cutoff = now - this.policy.minStartIntervalMs;
    const recentStart = this.#db
      .prepare("SELECT 1 FROM start_history WHERE started_at > ? LIMIT 1")
      .get(cutoff);
    if (recentStart !== undefined) return false;
    const recentReservation = this.#db
      .prepare(
        "SELECT 1 FROM leases WHERE phase IN ('admitted', 'starting', 'dispatch_intent') AND acquired_at > ? LIMIT 1"
      )
      .get(cutoff);
    return recentReservation === undefined;
  }

  private reserveAdmission(candidate: RequestRow, now: number, ownerInstanceId: string): AdmissionLease {
    const leaseId = randomUUID();
    const generation = candidate.lease_generation + 1;
    const reserved = this.#db
      .prepare(
        "UPDATE turn_requests SET state = 'admitted', lease_generation = ? WHERE request_id = ? AND state = 'queued'"
      )
      .run(generation, candidate.request_id);
    if (reserved.changes !== 1) throw new Error("selected admission request is no longer queued");
    this.#db
      .prepare(
        `INSERT INTO leases (lease_id, request_id, generation, owner_instance_id, phase, acquired_at, heartbeat_at)
         VALUES (?, ?, ?, ?, 'admitted', ?, ?)`
      )
      .run(leaseId, candidate.request_id, generation, ownerInstanceId, now, now);
    this.journalTransition("request_admitted", candidate.request_id, "queued", "admitted", now);
    return Object.freeze({ leaseId, requestId: candidate.request_id, generation, ownerInstanceId });
  }

  private orderedQueuedRequests(): RequestRow[] {
    return this.#db
      .prepare(
        `SELECT turn_requests.request_id, session_id, parent_id, fingerprint, provider, model,
                turn_requests.state, enqueued_at, lease_generation
         FROM turn_requests
         INNER JOIN turn_payloads payload ON payload.request_id = turn_requests.request_id
         WHERE turn_requests.state = 'queued' AND payload.content_fingerprint IS NOT NULL
         ORDER BY enqueued_at ASC, turn_requests.request_id ASC`
      )
      .all() as RequestRow[];
  }

  private selectEligibleRequest(now: number): RequestRow | null {
    const rows = this.orderedQueuedRequests();
    const activeParents = new Set(
      (this.#db
        .prepare(
          `SELECT DISTINCT request.parent_id AS parent_id
           FROM leases lease JOIN turn_requests request ON request.request_id = lease.request_id
           WHERE lease.phase IN ('admitted', 'starting', 'dispatch_intent', 'dispatch_ambiguous', 'active', 'recovery_required')`
        )
        .all() as Array<{ parent_id: string }>).map((row) => row.parent_id)
    );
    const eligible = rows.filter((row) => !this.isCooldownActive(row.provider, row.model, now));
    if (eligible.length === 0) return null;
    return eligible.find((row) => !activeParents.has(row.parent_id)) ?? eligible[0]!;
  }

  private isCooldownActive(provider: string, model: string, now: number): boolean {
    return this.cooldownUntil(provider, model, now) !== null;
  }

  private cooldownUntil(provider: string, model: string, now: number): number | null {
    const row = this.#db
      .prepare("SELECT not_before FROM cooldowns WHERE provider = ? AND model = ?")
      .get(provider, model) as { not_before: number } | undefined;
    return row !== undefined && row.not_before > now ? row.not_before : null;
  }

  private requireLease(fence: LeaseFence): LeaseRow {
    const lease = this.requireLeaseById(fence.leaseId);
    if (lease.generation !== fence.generation || lease.owner_instance_id !== fence.ownerInstanceId) {
      throw new LeaseFenceError(fence.leaseId);
    }
    return lease;
  }

  private requireLeaseById(leaseId: string): LeaseRow {
    const lease = this.#db
      .prepare(
        "SELECT lease_id, request_id, generation, owner_instance_id, phase FROM leases WHERE lease_id = ?"
      )
      .get(leaseId) as LeaseRow | undefined;
    if (!lease) throw new Error("unknown lease");
    return lease;
  }

  private requireRequest(requestId: string): void {
    const row = this.#db.prepare("SELECT 1 FROM turn_requests WHERE request_id = ?").get(requestId);
    if (!row) throw new Error("unknown request");
  }

  private requireRequestState(requestId: string): { state: RequestState } {
    const row = this.#db
      .prepare("SELECT state FROM turn_requests WHERE request_id = ?")
      .get(requestId) as { state: RequestState } | undefined;
    if (!row) throw new Error("unknown request");
    return row;
  }

  private requireEncryptionKey(): Buffer {
    if (!this.#encryptionKey) throw new Error("payload persistence requires an encryption key");
    return this.#encryptionKey;
  }

  private requireContentFingerprintKey(): Buffer {
    if (!this.#contentFingerprintKey) {
      throw new Error("admission event correlation requires a content fingerprint key");
    }
    return this.#contentFingerprintKey;
  }

  private journalTransition(
    kind: SanitizedEventKind,
    requestId: string,
    fromState: SanitizedEventState,
    toState: SanitizedEventState,
    occurredAt: number
  ): void {
    validateIdentifier(requestId, "event correlation input");
    validateTimestamp(occurredAt, "event timestamp");
    if (!isAllowedSanitizedEventTransition(kind, fromState, toState)) {
      throw new Error("admission event transition is not allowlisted");
    }
    const correlationHmac = createHmac("sha256", this.requireContentFingerprintKey())
      .update(JSON.stringify(["paseo-agy-acp", "admission-event-correlation", 1]), "utf8")
      .update(Buffer.from([0]))
      .update(requestId, "utf8")
      .digest("hex");
    this.#db
      .prepare(
        `INSERT INTO events (kind, from_state, to_state, occurred_at, correlation_hmac)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(kind, fromState, toState, occurredAt, correlationHmac);
  }

  private encrypt(plaintext: string, aad: string): EncryptedPayload {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.requireEncryptionKey(), nonce);
    cipher.setAAD(Buffer.from(aad, "utf8"));
    return {
      nonce,
      ciphertext: Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]),
      authTag: cipher.getAuthTag()
    };
  }

  private decrypt(payload: EncryptedPayload, aad: string): string {
    const decipher = createDecipheriv("aes-256-gcm", this.requireEncryptionKey(), payload.nonce);
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(payload.authTag);
    return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]).toString("utf8");
  }

  private enqueueRequest(input: EnqueueRequest): { requestId: string; existed: boolean } {
    validateEnqueueRequest(input);
    const existing = this.#db
      .prepare(
        `SELECT session_id, parent_id, fingerprint, provider, model
         FROM turn_requests WHERE request_id = ?`
      )
      .get(input.requestId) as
      | { session_id: string; parent_id: string; fingerprint: string; provider: string; model: string }
      | undefined;
    if (existing) {
      if (
        existing.session_id !== input.sessionId ||
        existing.parent_id !== input.parentId ||
        existing.fingerprint !== input.fingerprint ||
        existing.provider !== input.provider ||
        existing.model !== input.model
      ) {
        throw new AdmissionConflictError(input.requestId);
      }
      return { requestId: input.requestId, existed: true };
    }

    this.#db
      .prepare(
        `INSERT INTO turn_requests
          (request_id, session_id, parent_id, fingerprint, provider, model, state, enqueued_at, deadline_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`
      )
      .run(
        input.requestId,
        input.sessionId,
        input.parentId,
        input.fingerprint,
        input.provider,
        input.model,
        input.now,
        input.now + this.policy.queueTimeoutMs
      );
    this.journalTransition("request_enqueued", input.requestId, "absent", "queued", input.now);
    return { requestId: input.requestId, existed: false };
  }

  private insertPayload(
    requestId: string,
    encrypted: EncryptedPayload,
    keyVersion: number,
    contentFingerprint: string,
    expiresAt: number,
    now: number
  ): void {
    this.#db
      .prepare(
        `INSERT INTO turn_payloads
          (request_id, nonce, ciphertext, auth_tag, key_version, content_fingerprint, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        requestId,
        encrypted.nonce,
        encrypted.ciphertext,
        encrypted.authTag,
        keyVersion,
        contentFingerprint,
        expiresAt,
        now
      );
  }

  private contentFingerprint(domain: string, id: string, plaintext: string): string {
    return createHmac("sha256", this.requireContentFingerprintKey())
      .update(JSON.stringify(["paseo-agy-acp", domain, "content", 1, id]), "utf8")
      .update(Buffer.from([0]))
      .update(plaintext, "utf8")
      .digest("hex");
  }

  private payloadAad(requestId: string, keyVersion: number): string {
    return JSON.stringify(["paseo-agy-acp", "turn", 1, requestId, keyVersion]);
  }

  private validatePayloadExpiry(now: number, expiresAt: number): void {
    if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new Error("payload expiry must be after persistence time");
    }
  }

  private transition(fence: LeaseFence, expected: RequestState, next: RequestState, now: number): void {
    this.transaction(() => {
      const lease = this.requireLease(fence);
      if (lease.phase !== expected) throw new Error(`lease is not ${expected}`);
      this.setLeasePhase(lease, next, now);
    });
  }

  private setLeasePhase(lease: LeaseRow, phase: RequestState, now: number): void {
    const result = this.#db
      .prepare(
        "UPDATE leases SET phase = ?, heartbeat_at = ? WHERE lease_id = ? AND owner_instance_id = ? AND generation = ?"
      )
      .run(phase, now, lease.lease_id, lease.owner_instance_id, lease.generation);
    if (result.changes !== 1) throw new LeaseFenceError(lease.lease_id);
    this.#db.prepare("UPDATE turn_requests SET state = ? WHERE request_id = ?").run(phase, lease.request_id);
    this.journalTransition(requestTransitionKind(lease.phase, phase), lease.request_id, lease.phase, phase, now);
  }
}

const SANITIZED_EVENT_TRANSITIONS = new Set<string>([
  transitionSignature("request_enqueued", "absent", "queued"),
  transitionSignature("request_cancelled", "queued", "cancelled"),
  ...(["admitted", "starting", "dispatch_intent"] as const).flatMap((fromState) => [
    transitionSignature("request_abandoned", fromState, "failed"),
    transitionSignature("request_abandoned", fromState, "cancelled")
  ]),
  transitionSignature("request_queue_timed_out", "queued", "queue_timeout"),
  transitionSignature("request_admitted", "queued", "admitted"),
  transitionSignature("request_starting", "admitted", "starting"),
  transitionSignature("request_dispatch_intent", "starting", "dispatch_intent"),
  transitionSignature("request_active", "dispatch_intent", "active"),
  transitionSignature("request_dispatch_ambiguous", "dispatch_intent", "dispatch_ambiguous"),
  transitionSignature("request_provider_terminal", "active", "provider_terminal"),
  transitionSignature("request_released", "provider_terminal", "completed"),
  transitionSignature("request_released", "provider_terminal", "failed"),
  transitionSignature("request_released", "provider_terminal", "cancelled"),
  ...(["admitted", "starting", "dispatch_intent", "dispatch_ambiguous", "active", "recovery_required"] as const).map(
    (fromState) => transitionSignature("request_recovery_required", fromState, "recovery_required")
  ),
  ...(["admitted", "starting", "dispatch_intent", "dispatch_ambiguous", "active", "recovery_required"] as const).map(
    (fromState) => transitionSignature("request_recovery_seat_released", fromState, "recovery_required")
  )
]);

function transitionSignature(
  kind: SanitizedEventKind,
  fromState: SanitizedEventState,
  toState: SanitizedEventState
): string {
  return `${kind}\0${fromState}\0${toState}`;
}

function isAllowedSanitizedEventTransition(
  kind: SanitizedEventKind,
  fromState: SanitizedEventState,
  toState: SanitizedEventState
): boolean {
  return SANITIZED_EVENT_TRANSITIONS.has(transitionSignature(kind, fromState, toState));
}

function requestTransitionKind(fromState: RequestState, toState: RequestState): SanitizedEventKind {
  if (fromState === "admitted" && toState === "starting") return "request_starting";
  if (fromState === "starting" && toState === "dispatch_intent") return "request_dispatch_intent";
  if (fromState === "dispatch_intent" && toState === "active") return "request_active";
  if (fromState === "dispatch_intent" && toState === "dispatch_ambiguous") {
    return "request_dispatch_ambiguous";
  }
  throw new Error("request transition is not journalled by the generic lease transition path");
}

function normalizeSanitizedEventPageRequest(input: unknown): SanitizedEventPageRequest {
  const record = dataRecord(input, ["afterEventSeq", "limit"]);
  if (record === null) throw new Error("sanitized event page request must have the exact supported shape");
  if (typeof record.afterEventSeq !== "number" || !Number.isSafeInteger(record.afterEventSeq) || record.afterEventSeq < 0) {
    throw new Error("sanitized event cursor must be a non-negative safe integer");
  }
  if (typeof record.limit !== "number" || !Number.isSafeInteger(record.limit) || record.limit < 1 || record.limit > 1_000) {
    throw new Error("sanitized event page limit must be between 1 and 1000");
  }
  return Object.freeze({ afterEventSeq: record.afterEventSeq, limit: record.limit });
}

function normalizeSanitizedEventRow(row: SanitizedEventRow): SanitizedAdmissionEvent {
  if (typeof row.event_seq !== "number" || !Number.isSafeInteger(row.event_seq) || row.event_seq < 1) {
    throw new Error("sanitized event journal contains an invalid sequence");
  }
  if (!isSanitizedEventKind(row.kind) || !isSanitizedEventState(row.from_state) || !isSanitizedEventState(row.to_state)) {
    throw new Error("sanitized event journal contains a non-allowlisted transition");
  }
  validateTimestamp(row.occurred_at, "sanitized event timestamp");
  if (typeof row.correlation_hmac !== "string" || !/^[0-9a-f]{64}$/.test(row.correlation_hmac)) {
    throw new Error("sanitized event journal contains an invalid correlation HMAC");
  }
  if (!isAllowedSanitizedEventTransition(row.kind, row.from_state, row.to_state)) {
    throw new Error("sanitized event journal contains a non-allowlisted transition");
  }
  return Object.freeze({
    eventSeq: row.event_seq,
    kind: row.kind,
    fromState: row.from_state,
    toState: row.to_state,
    occurredAt: row.occurred_at,
    correlationHmac: row.correlation_hmac
  });
}

function isSanitizedEventKind(value: unknown): value is SanitizedEventKind {
  return (
    value === "request_enqueued" ||
    value === "request_cancelled" ||
    value === "request_abandoned" ||
    value === "request_queue_timed_out" ||
    value === "request_admitted" ||
    value === "request_starting" ||
    value === "request_dispatch_intent" ||
    value === "request_active" ||
    value === "request_dispatch_ambiguous" ||
    value === "request_provider_terminal" ||
    value === "request_released" ||
    value === "request_recovery_required" ||
    value === "request_recovery_seat_released"
  );
}

function isSanitizedEventState(value: unknown): value is SanitizedEventState {
  if (value === "absent") return true;
  try {
    normalizeRequestState(value);
    return true;
  } catch {
    return false;
  }
}

function validatePolicy(policy: AdmissionPolicy): AdmissionPolicy {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 0 || (name.startsWith("max") && value < 1)) {
      throw new Error(`invalid admission policy ${name}`);
    }
  }
  if (policy.maxActiveTurns !== 1 && policy.maxActiveTurns !== 3) {
    throw new Error("invalid admission policy maxActiveTurns");
  }
  return Object.freeze({ ...policy });
}

function validateEnqueueRequest(input: EnqueueRequest): void {
  for (const field of ["requestId", "sessionId", "parentId", "fingerprint", "provider", "model"] as const) {
    const value = input[field];
    if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
      throw new Error(`invalid request metadata ${field}`);
    }
  }
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new Error("invalid request timestamp");
  }
}

function validateIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} must be a non-empty single-line identifier`);
  }
}

function validateTimestamp(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function validateFaultInjection(value: unknown): AdmissionControllerFaultInjection | undefined {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("fault injection must be an object");
    }
    const callbacks = value as { afterProcessIdentityPersisted?: unknown };
    const callback = (value: unknown): (() => void) | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== "function") {
        throw new Error("fault injection callback must be a function");
      }
      return value as () => void;
    };
    const afterProcessIdentityPersisted = callback(callbacks.afterProcessIdentityPersisted);
    return Object.freeze({
      afterProcessIdentityPersisted:
        afterProcessIdentityPersisted === undefined ? undefined : () => afterProcessIdentityPersisted()
    });
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error("fault injection is invalid");
  }
}

function isSqliteTransactionContention(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "SqliteError") return false;
  const code = (error as { code?: unknown }).code;
  return (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_BUSY_RECOVERY" ||
    code === "SQLITE_BUSY_SNAPSHOT" ||
    code === "SQLITE_BUSY_TIMEOUT" ||
    code === "SQLITE_LOCKED" ||
    code === "SQLITE_LOCKED_SHAREDCACHE"
  );
}

function normalizeVerifiedLinuxProcessRecord(value: unknown): VerifiedLinuxProcessRecord | null {
  try {
    const record = dataRecord(value, ["requestId", "leaseId", "generation", "ownerInstanceId", "processIdentity", "promptChannel"]);
    if (record === null) return null;
    const processIdentity = dataRecord(record.processIdentity, ["connector", "child"]);
    if (processIdentity === null) return null;

    const ownerInstanceId = normalizeOwnerInstanceId(record.ownerInstanceId);
    const connector = normalizeVerifiedLinuxConnectorIdentity(processIdentity.connector);
    const child = normalizeVerifiedLinuxProcessIdentity(processIdentity.child);
    if (connector.ownerInstanceId !== ownerInstanceId) return null;
    const promptChannel = record.promptChannel;
    if (promptChannel !== "stdin" && promptChannel !== "pty") return null;

    return Object.freeze({
      requestId: normalizeIdentifier(record.requestId, "process record request ID"),
      leaseId: normalizeIdentifier(record.leaseId, "process record lease ID"),
      generation: normalizePositiveSafeInteger(record.generation, "process record generation", Number.MAX_SAFE_INTEGER),
      ownerInstanceId,
      processIdentity: Object.freeze({ connector, child }),
      promptChannel
    });
  } catch {
    return null;
  }
}

function normalizeVerifiedLinuxConnectorIdentity(value: unknown): VerifiedLinuxConnectorIdentity {
  const record = dataRecord(value, [
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
  if (record === null) throw new Error("connector identity is invalid");
  return Object.freeze({
    ownerInstanceId: normalizeOwnerInstanceId(record.ownerInstanceId),
    createdAt: normalizeCanonicalUtcTimestamp(record.createdAt),
    ...normalizeVerifiedLinuxProcessIdentityFields(record)
  });
}

function normalizeVerifiedLinuxProcessIdentity(value: unknown): VerifiedLinuxProcessIdentity {
  const record = dataRecord(value, ["bootId", "pid", "startTimeTicks", "pidNamespaceInode", "ppid", "pgrp", "session"]);
  if (record === null) throw new Error("process identity is invalid");
  return normalizeVerifiedLinuxProcessIdentityFields(record);
}

function normalizeVerifiedLinuxProcessIdentityFields(record: Record<string, unknown>): VerifiedLinuxProcessIdentity {
  return Object.freeze({
    bootId: normalizeBootId(record.bootId),
    pid: normalizePositiveSafeInteger(record.pid, "process PID", 2_147_483_647),
    startTimeTicks: normalizeStartTimeTicks(record.startTimeTicks),
    pidNamespaceInode: normalizePositiveSafeInteger(record.pidNamespaceInode, "PID namespace inode", 4_294_967_295),
    ppid: normalizePositiveSafeInteger(record.ppid, "process parent PID", 2_147_483_647),
    pgrp: normalizePositiveSafeInteger(record.pgrp, "process group", 2_147_483_647),
    session: normalizePositiveSafeInteger(record.session, "process session", 2_147_483_647)
  });
}

function sameLeaseProcessIdentity(row: LeaseProcessIdentityRow, record: VerifiedLinuxProcessRecord): boolean {
  const { connector, child } = record.processIdentity;
  return (
    row.request_id === record.requestId &&
    row.lease_generation === record.generation &&
    row.owner_instance_id === record.ownerInstanceId &&
    row.prompt_channel === record.promptChannel &&
    row.connector_owner_instance_id === connector.ownerInstanceId &&
    row.connector_created_at === connector.createdAt &&
    row.connector_boot_id === connector.bootId &&
    row.connector_pid === connector.pid &&
    row.connector_start_time_ticks === connector.startTimeTicks &&
    row.connector_pid_namespace_inode === connector.pidNamespaceInode &&
    row.connector_ppid === connector.ppid &&
    row.connector_pgrp === connector.pgrp &&
    row.connector_session === connector.session &&
    row.child_boot_id === child.bootId &&
    row.child_pid === child.pid &&
    row.child_start_time_ticks === child.startTimeTicks &&
    row.child_pid_namespace_inode === child.pidNamespaceInode &&
    row.child_ppid === child.ppid &&
    row.child_pgrp === child.pgrp &&
    row.child_session === child.session
  );
}

function dataRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const record = value as Record<string, unknown>;
    const keys = Object.getOwnPropertyNames(record);
    if (
      Object.getOwnPropertySymbols(record).length !== 0 ||
      keys.length !== expectedKeys.length ||
      keys.some((key) => !expectedKeys.includes(key))
    ) {
      return null;
    }
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    }
    return record;
  } catch {
    return null;
  }
}

function normalizeIdentifier(value: unknown, label: string): string {
  validateIdentifier(value, label);
  return value;
}

function normalizeOwnerInstanceId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error("process record owner instance ID must be a canonical UUID v4");
  }
  return value;
}

function normalizeCanonicalUtcTimestamp(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error("connector creation timestamp must be canonical UTC");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error("connector creation timestamp is invalid");
  }
  return value;
}

function normalizeBootId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ||
    /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)
  ) {
    throw new Error("process boot ID is invalid");
  }
  return value;
}

function normalizeStartTimeTicks(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) {
    throw new Error("process start time is invalid");
  }
  return value;
}

function normalizePositiveSafeInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function toRecoverableDispatch(row: RecoverableDispatchRow): RecoverableDispatch | null {
  try {
    const requestId = normalizeIdentifier(row.request_id, "recoverable dispatch request ID");
    const leaseRequestId = normalizeIdentifier(row.lease_request_id, "recoverable dispatch lease request ID");
    const sessionId = normalizeIdentifier(row.request_session_id, "recoverable dispatch session ID");
    const provider = normalizeIdentifier(row.request_provider, "recoverable dispatch provider");
    const model = normalizeIdentifier(row.request_model, "recoverable dispatch model");
    const fence = Object.freeze({
      leaseId: normalizeIdentifier(row.lease_id, "recoverable dispatch lease ID"),
      generation: normalizePositiveSafeInteger(
        row.lease_generation,
        "recoverable dispatch lease generation",
        Number.MAX_SAFE_INTEGER
      ),
      ownerInstanceId: normalizeIdentifier(row.lease_owner_instance_id, "recoverable dispatch lease owner")
    });
    const requestLeaseGeneration = normalizePositiveSafeInteger(
      row.request_lease_generation,
      "recoverable dispatch request lease generation",
      Number.MAX_SAFE_INTEGER
    );
    const phase = normalizeRequestState(row.lease_phase);
    const requestState = normalizeRequestState(row.request_state);
    validateTimestamp(row.lease_heartbeat_at, "recoverable dispatch heartbeat");
    validateTimestamp(row.request_enqueued_at, "recoverable dispatch enqueue timestamp");

    if (leaseRequestId !== requestId || requestLeaseGeneration !== fence.generation) {
      throw new Error("lease/request fence mismatch");
    }

    const processIdentity = toRecoverableDispatchProcessIdentity(row, requestId, fence);
    if (processIdentity !== null && (phase === "admitted" || phase === "starting")) {
      throw new Error("process identity predates dispatch intent");
    }

    if (!isRecoverableDispatchPhase(phase) || requestState !== phase) {
      throw new Error("nonterminal lease/request state mismatch");
    }

    return Object.freeze({
      requestId,
      sessionId,
      provider,
      model,
      fence,
      phase,
      heartbeatAt: row.lease_heartbeat_at,
      processIdentity
    });
  } catch {
    throw new RecoverableDispatchInventoryError();
  }
}

function toRecoverableDispatchProcessIdentity(
  row: RecoverableDispatchRow,
  requestId: string,
  fence: LeaseFence
): RecoverableDispatchProcessIdentity | null {
  const values = [
    row.identity_lease_id,
    row.identity_request_id,
    row.identity_lease_generation,
    row.identity_owner_instance_id,
    row.identity_prompt_channel,
    row.identity_connector_owner_instance_id,
    row.identity_connector_created_at,
    row.identity_connector_boot_id,
    row.identity_connector_pid,
    row.identity_connector_start_time_ticks,
    row.identity_connector_pid_namespace_inode,
    row.identity_connector_ppid,
    row.identity_connector_pgrp,
    row.identity_connector_session,
    row.identity_child_boot_id,
    row.identity_child_pid,
    row.identity_child_start_time_ticks,
    row.identity_child_pid_namespace_inode,
    row.identity_child_ppid,
    row.identity_child_pgrp,
    row.identity_child_session
  ];
  if (values.every((value) => value === null)) return null;
  if (values.some((value) => value === null || value === undefined)) {
    throw new Error("partial process identity");
  }

  const identityLeaseId = normalizeIdentifier(row.identity_lease_id, "recoverable process identity lease ID");
  const identityRequestId = normalizeIdentifier(row.identity_request_id, "recoverable process identity request ID");
  const identityLeaseGeneration = normalizePositiveSafeInteger(
    row.identity_lease_generation,
    "recoverable process identity lease generation",
    Number.MAX_SAFE_INTEGER
  );
  const identityOwnerInstanceId = normalizeIdentifier(
    row.identity_owner_instance_id,
    "recoverable process identity owner"
  );
  if (
    identityLeaseId !== fence.leaseId ||
    identityRequestId !== requestId ||
    identityLeaseGeneration !== fence.generation ||
    identityOwnerInstanceId !== fence.ownerInstanceId
  ) {
    throw new Error("process identity fence mismatch");
  }
  if (row.identity_prompt_channel !== "stdin" && row.identity_prompt_channel !== "pty") {
    throw new Error("process identity prompt channel is invalid");
  }

  const connector = normalizeVerifiedLinuxConnectorIdentity({
    ownerInstanceId: row.identity_connector_owner_instance_id,
    createdAt: row.identity_connector_created_at,
    bootId: row.identity_connector_boot_id,
    pid: row.identity_connector_pid,
    startTimeTicks: row.identity_connector_start_time_ticks,
    pidNamespaceInode: row.identity_connector_pid_namespace_inode,
    ppid: row.identity_connector_ppid,
    pgrp: row.identity_connector_pgrp,
    session: row.identity_connector_session
  });
  if (connector.ownerInstanceId !== fence.ownerInstanceId) {
    throw new Error("connector process identity owner mismatch");
  }
  const child = normalizeVerifiedLinuxProcessIdentity({
    bootId: row.identity_child_boot_id,
    pid: row.identity_child_pid,
    startTimeTicks: row.identity_child_start_time_ticks,
    pidNamespaceInode: row.identity_child_pid_namespace_inode,
    ppid: row.identity_child_ppid,
    pgrp: row.identity_child_pgrp,
    session: row.identity_child_session
  });
  return Object.freeze({ promptChannel: row.identity_prompt_channel, connector, child });
}

function normalizeRequestState(value: unknown): RequestState {
  switch (value) {
    case "queued":
    case "admitted":
    case "starting":
    case "dispatch_intent":
    case "dispatch_ambiguous":
    case "active":
    case "provider_terminal":
    case "completed":
    case "failed":
    case "cancelled":
    case "queue_timeout":
    case "recovery_required":
      return value;
    default:
      throw new Error("request state is invalid");
  }
}

function isRecoverableDispatchPhase(value: RequestState): value is RecoverableDispatchPhase {
  return (
    value === "admitted" ||
    value === "starting" ||
    value === "dispatch_intent" ||
    value === "dispatch_ambiguous" ||
    value === "active" ||
    value === "recovery_required"
  );
}

function validateLiveTurnCompletion(value: LiveTurnCompletion): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("live turn completion must be an object");
  }
  if (value.outcome !== "completed" && value.outcome !== "failed" && value.outcome !== "cancelled") {
    throw new Error("live turn completion outcome is invalid");
  }
  if (value.outcome !== "failed" && value.failure !== undefined) {
    throw new Error("live turn completion failure is inconsistent");
  }
  if (value.failure === undefined) return;
  const categories = new Set([
    "provider_capacity",
    "quota",
    "auth",
    "permission",
    "timeout",
    "transport",
    "unknown"
  ]);
  if (!categories.has(value.failure.category)) throw new Error("live turn failure category is invalid");
  if (
    value.failure.httpStatus !== undefined &&
    (!Number.isInteger(value.failure.httpStatus) || value.failure.httpStatus < 100 || value.failure.httpStatus > 599)
  ) {
    throw new Error("live turn failure HTTP status is invalid");
  }
  for (const signal of [value.failure.code, value.failure.reason]) {
    if (signal !== undefined) validateIdentifier(signal, "live turn failure signal");
  }
}

function validatePurposeKey(
  key: Buffer | undefined,
  purpose: "encryption" | "content fingerprint"
): Buffer | undefined {
  if (key === undefined) return undefined;
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error(`admission ${purpose} key must be exactly 32 bytes`);
  }
  return Buffer.from(key);
}

function toStoredRequest(row: RequestRow): StoredRequest {
  return {
    requestId: row.request_id,
    sessionId: row.session_id,
    parentId: row.parent_id,
    fingerprint: row.fingerprint,
    provider: row.provider,
    model: row.model,
    state: row.state,
    enqueuedAt: row.enqueued_at
  };
}
