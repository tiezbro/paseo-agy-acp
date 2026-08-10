import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import {
  ACP_OUTBOX_CAPABILITY,
  ACP_OUTBOX_CAPABILITY_VERSION,
  ACP_OUTBOX_DELIVERY_SEMANTICS,
  createOutboxEventMetadata,
  validateOutboxAck,
  type OutboxAck,
  type OutboxCapability,
  type OutboxEventMetadata
} from "./outbox-protocol.js";
import {
  planRecoveryResolution,
  validateRecoveryResolution,
  type RecoveryClaimToken,
  type RecoveryEvidenceCode,
  type RecoveryReasonCode,
  type RecoveryResolutionAction,
  type RecoveryResolutionPlan
} from "./recovery-resolution.js";
import { ADMISSION_SCHEMA_VERSION, assertAdmissionSchemaIntegrity } from "./schema.js";
import {
  confirmTerminalEvidence,
  parseTerminalEvidenceInput,
  type LegacyDualSourceTerminalObservations,
  type TerminalEvidenceInput
} from "./terminal-evidence.js";

const DEFAULT_DELIVERY_CLAIM_LEASE_MS = 30_000;
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
  claimTokenKey?: Buffer;
  /** Test-only synchronous hook for proving rollback at the atomic dispatch boundary. */
  faultInjection?: AdmissionControllerFaultInjection;
}

/** Test-only synchronous hooks for proving rollback at durable transaction midpoints. */
export interface AdmissionControllerFaultInjection {
  afterProcessIdentityPersisted?(): void;
  afterProviderTerminalOutboxPersisted?(): void;
  afterDeliveryOutboxSettled?(): void;
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

export interface EnqueueDelivery {
  eventId: string;
  requestId: string;
  fingerprint: string;
  payload: string;
  sequence: number;
  now: number;
  expiresAt: number;
  /** Must be the exact result of successful ACP outbox capability negotiation. */
  protocol: OutboxCapability;
}

/**
 * New callers must submit TerminalEvidenceInput. The exact legacy dual-source
 * shape remains a narrow compatibility adapter until source wiring changes.
 */
export type ProviderTerminalObservations = TerminalEvidenceInput | LegacyDualSourceTerminalObservations;

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
  | "recovery_required"
  | "recovery_resolved";

export type SanitizedEventState = RequestState | "absent" | DeliveryClaimLeaseState | "pending";

export type SanitizedEventKind =
  | "request_enqueued"
  | "request_cancelled"
  | "request_queue_timed_out"
  | "request_admitted"
  | "request_starting"
  | "request_dispatch_intent"
  | "request_active"
  | "request_dispatch_ambiguous"
  | "request_provider_terminal"
  | "request_released"
  | "request_recovery_required"
  | "request_recovery_requeued"
  | "request_recovery_completed"
  | "request_recovery_cancelled"
  | "request_recovery_unknown_released"
  | "delivery_enqueued"
  | "delivery_claimed"
  | "delivery_replay_reserved"
  | "delivery_delivered"
  | "delivery_recovery_required";

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

/** @deprecated Recovery is now claimed and resolved with a durable fence. */
export interface OwnerRecoveryEvidence {
  ownerAlive: boolean;
  preDispatchProcessTerminated: boolean;
}

export interface PendingDelivery {
  eventId: string;
  requestId: string;
  payload: string;
}

/** A persisted outbox fence. The bearer token is derived, never stored in SQLite. */
export interface DeliveryClaimFence {
  eventId: string;
  ownerInstanceId: string;
  claimGeneration: number;
  claimToken: string;
}

/** One encrypted outbox payload held by exactly one delivery worker. */
export interface ClaimedDelivery extends PendingDelivery, DeliveryClaimFence {
  sessionId: string;
  sequence: number;
  metadata: OutboxEventMetadata;
}

/** Input for the controller-owned atomic outbox claim transaction. */
export interface AtomicDeliveryClaimInput {
  eventId: string;
  ownerInstanceId: string;
  now: number;
  leaseMs: number;
}

export type DeliveryClaimLeaseState = "claimed" | "replay_reserved" | "delivered" | "recovery_required";

/** Durable, enumerable claim metadata. It deliberately never contains payload or claim token material. */
export interface DeliveryClaimLease {
  eventId: string;
  requestId: string;
  ownerInstanceId: string;
  claimGeneration: number;
  state: DeliveryClaimLeaseState;
  heartbeatAt: number;
  leaseExpiresAt: number;
  terminalReplayCount: number;
}

export interface TerminalReplayReservationInput {
  requestId: string;
  ownerInstanceId: string;
  fence: DeliveryClaimFence;
  now: number;
}

/** Sweep metadata is intentionally payload-free: callers cannot resend from a recovery scan. */
export interface ExpiredDeliveryClaimSweepResult {
  eventId: string;
  requestId: string;
  claimGeneration: number;
  reason: "lease_expired" | "legacy_claim" | "invalid_lease";
}

export interface RecoveryResolutionAttestations {
  actorHmac: string;
  evidenceHmac: string;
}

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
  terminal_outcome: "completed" | "failed" | "cancelled" | null;
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

interface DeliveryRow {
  event_id: string;
  request_id: string;
  fingerprint: string;
  state: "pending" | "claimed" | "delivered" | "recovery_required";
  nonce: Buffer | null;
  ciphertext: Buffer | null;
  auth_tag: Buffer | null;
  key_version: number | null;
  expires_at: number;
  sequence: number;
  protocol_version: number;
  protocol_semantics: string;
  claim_generation: number;
  claim_owner_instance_id: string | null;
  claim_acquired_at: number | null;
  lease_id: string | null;
  lease_generation: number | null;
  session_id?: string;
}

interface DeliveryClaimLeaseRow {
  event_id: string;
  request_id: string;
  owner_instance_id: string;
  claim_generation: number;
  state: DeliveryClaimLeaseState;
  heartbeat_at: number;
  lease_expires_at: number;
  terminal_replay_count: number;
  replay_reserved_at: number | null;
  settled_at: number | null;
}

interface RecoverableOutboxClaimRow {
  lease_event_id: unknown;
  lease_request_id: unknown;
  lease_owner_instance_id: unknown;
  lease_claim_generation: unknown;
  lease_state: unknown;
  lease_heartbeat_at: unknown;
  lease_expires_at: unknown;
  lease_terminal_replay_count: unknown;
  outbox_event_id: unknown;
  outbox_request_id: unknown;
  outbox_owner_instance_id: unknown;
  outbox_claim_generation: unknown;
  outbox_state: unknown;
}

interface ExpiredDeliveryClaimRow {
  event_id: string;
  request_id: string;
  claim_generation: number;
  expires_at: number;
  outbox_owner_instance_id: string | null;
  lease_request_id: string | null;
  lease_owner_instance_id: string | null;
  lease_claim_generation: number | null;
  lease_state: DeliveryClaimLeaseState | null;
  lease_expires_at: number | null;
}

interface SanitizedEventRow {
  event_seq: unknown;
  kind: unknown;
  from_state: unknown;
  to_state: unknown;
  occurred_at: unknown;
  correlation_hmac: unknown;
}

interface RecoveryClaimRow {
  lease_id: string;
  request_id: string;
  lease_generation: number;
  recovery_generation: number;
  claimant_instance_id: string;
  prior_phase: RequestState;
  state: "claimed" | "resolved";
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
  lease_terminal_outcome: unknown;
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

export class DeliveryConflictError extends Error {
  constructor(_eventId: string) {
    super("delivery event was reused with a different fingerprint");
    this.name = "DeliveryConflictError";
  }
}

export class DeliveryClaimFenceError extends Error {
  constructor(_eventId: string) {
    super("delivery event is not owned by the supplied claim fence");
    this.name = "DeliveryClaimFenceError";
  }
}

export class RecoveryClaimFenceError extends Error {
  constructor(_leaseId: string) {
    super("recovery claim is not current");
    this.name = "RecoveryClaimFenceError";
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

/** Raised when an outbox row and its controller-owned claim lease do not form one exact fence. */
export class RecoverableOutboxClaimInventoryError extends Error {
  constructor() {
    super("recoverable outbox claim inventory contains an invalid durable row");
    this.name = "RecoverableOutboxClaimInventoryError";
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
  readonly #claimTokenKey?: Buffer;
  readonly #faultInjection?: AdmissionControllerFaultInjection;

  constructor(options: AdmissionControllerOptions) {
    this.databasePath = options.databasePath;
    this.policy = validatePolicy(options.policy);
    this.#encryptionKey = validatePurposeKey(options.encryptionKey, "encryption");
    this.#contentFingerprintKey = validatePurposeKey(options.contentFingerprintKey, "content fingerprint");
    this.#claimTokenKey = validatePurposeKey(options.claimTokenKey, "claim token");
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
    this.#claimTokenKey?.fill(0);
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

  enqueueDelivery(input: EnqueueDelivery): { eventId: string; existed: boolean } {
    this.validateDeliveryInput(input);
    return this.transaction(() => {
      return this.insertDelivery(input, null);
    });
  }

  /** Claim a named pending event. A claimed event is never implicitly reclaimed. */
  claimPendingDelivery(eventId: string, ownerInstanceId: string, now: number): ClaimedDelivery | null {
    return this.claimPendingDeliveryAtomically({ eventId, ownerInstanceId, now, leaseMs: DEFAULT_DELIVERY_CLAIM_LEASE_MS });
  }

  /**
   * Atomically changes the outbox row to claimed and persists the controller-owned
   * lease that makes a crash-recovery sweep possible.
   */
  claimPendingDeliveryAtomically(input: AtomicDeliveryClaimInput): ClaimedDelivery | null {
    validateAtomicDeliveryClaimInput(input);
    this.requireClaimTokenKey();
    const leaseExpiresAt = deliveryClaimLeaseExpiry(input.now, input.leaseMs);

    const row = this.transaction(() => {
      const row = this.requireDelivery(input.eventId);
      if (row.state !== "pending") return null;
      if (row.expires_at <= input.now || !this.isNegotiatedDelivery(row)) {
        this.markDeliveryRecovery(row.event_id, input.now, null);
        return null;
      }

      const result = this.#db
        .prepare(
          `UPDATE delivery_outbox
           SET state = 'claimed', claim_generation = claim_generation + 1,
               claim_owner_instance_id = ?, claim_acquired_at = ?
           WHERE event_id = ? AND state = 'pending' AND claim_generation = ?`
        )
        .run(input.ownerInstanceId, input.now, input.eventId, row.claim_generation);
      if (result.changes !== 1) return null;

      const claimed = this.requireDelivery(input.eventId);
      this.#db
        .prepare(
          `INSERT INTO delivery_claim_leases
             (event_id, request_id, owner_instance_id, claim_generation, state,
              heartbeat_at, lease_expires_at, terminal_replay_count, updated_at)
           VALUES (?, ?, ?, ?, 'claimed', ?, ?, 0, ?)`
        )
        .run(
          claimed.event_id,
          claimed.request_id,
          input.ownerInstanceId,
          claimed.claim_generation,
          input.now,
          leaseExpiresAt,
          input.now
        );
      this.journalTransition("delivery_claimed", claimed.request_id, "pending", "claimed", input.now);
      return claimed;
    });
    if (!row) return null;

    try {
      return this.toClaimedDelivery(row);
    } catch (error) {
      this.markClaimedDeliveryRecovery(row, input.now);
      throw error;
    }
  }

  /** Extend a controller-owned claim only when the exact fence is still live. */
  heartbeatClaimedDelivery(fence: DeliveryClaimFence, now: number, leaseMs: number): DeliveryClaimLease {
    validateDeliveryClaimFence(fence);
    validateTimestamp(now, "delivery claim heartbeat timestamp");
    validateDeliveryClaimLeaseMs(leaseMs);
    const leaseExpiresAt = deliveryClaimLeaseExpiry(now, leaseMs);

    const heartbeat = this.transaction(() => {
      const row = this.requireDelivery(fence.eventId);
      this.assertDeliveryClaim(row, fence);
      const lease = this.requireDeliveryClaimLease(row, fence);
      if (row.state !== "claimed" || !isActiveDeliveryClaimLeaseState(lease.state)) {
        throw new DeliveryClaimFenceError(fence.eventId);
      }
      if (row.expires_at <= now || lease.leaseExpiresAt <= now) {
        this.markDeliveryRecovery(row.event_id, now, fence);
        return null;
      }
      const result = this.#db
        .prepare(
          `UPDATE delivery_claim_leases
           SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
           WHERE event_id = ? AND request_id = ? AND owner_instance_id = ? AND claim_generation = ?
             AND state IN ('claimed', 'replay_reserved') AND lease_expires_at > ?`
        )
        .run(now, leaseExpiresAt, now, row.event_id, row.request_id, fence.ownerInstanceId, fence.claimGeneration, now);
      if (result.changes !== 1) throw new DeliveryClaimFenceError(fence.eventId);
      return this.requireDeliveryClaimLease(row, fence);
    });
    if (heartbeat === null) throw new DeliveryClaimFenceError(fence.eventId);
    return heartbeat;
  }

  /** Reserve at most one reconnect replay for an exact, still-live terminal delivery claim. */
  reserveTerminalReplay(input: TerminalReplayReservationInput): DeliveryClaimLease | null {
    validateTerminalReplayReservationInput(input);

    return this.transaction(() => {
      if (input.ownerInstanceId !== input.fence.ownerInstanceId) return null;
      const row = this.requireDelivery(input.fence.eventId);
      if (row.request_id !== input.requestId || row.state !== "claimed") return null;
      this.assertDeliveryClaim(row, input.fence);
      const lease = this.requireDeliveryClaimLease(row, input.fence);
      if (lease.state !== "claimed" || lease.terminalReplayCount !== 0) return null;
      if (row.expires_at <= input.now || lease.leaseExpiresAt <= input.now) {
        this.markDeliveryRecovery(row.event_id, input.now, input.fence);
        return null;
      }
      const result = this.#db
        .prepare(
          `UPDATE delivery_claim_leases
           SET state = 'replay_reserved', terminal_replay_count = 1, replay_reserved_at = ?, updated_at = ?
           WHERE event_id = ? AND request_id = ? AND owner_instance_id = ? AND claim_generation = ?
             AND state = 'claimed' AND terminal_replay_count = 0 AND lease_expires_at > ?`
        )
        .run(
          input.now,
          input.now,
          row.event_id,
          input.requestId,
          input.ownerInstanceId,
          input.fence.claimGeneration,
          input.now
        );
      if (result.changes !== 1) return null;
      this.journalTransition(
        "delivery_replay_reserved",
        row.request_id,
        "claimed",
        "replay_reserved",
        input.now
      );
      return this.requireDeliveryClaimLease(row, input.fence);
    });
  }

  /**
   * Enumerates only controller-owned durable claim metadata and fails expired or
   * legacy claimed rows closed. It never decrypts or returns an outbox payload.
   */
  sweepExpiredDeliveryClaims(now: number): readonly ExpiredDeliveryClaimSweepResult[] {
    validateTimestamp(now, "delivery claim sweep timestamp");
    return this.transaction(() => {
      const rows = this.#db
        .prepare(
          `SELECT outbox.event_id, outbox.request_id, outbox.claim_generation, outbox.expires_at,
                  outbox.claim_owner_instance_id AS outbox_owner_instance_id,
                  lease.request_id AS lease_request_id,
                  lease.owner_instance_id AS lease_owner_instance_id,
                  lease.claim_generation AS lease_claim_generation,
                  lease.state AS lease_state, lease.lease_expires_at
           FROM delivery_outbox AS outbox
           LEFT JOIN delivery_claim_leases AS lease ON lease.event_id = outbox.event_id
           WHERE outbox.state = 'claimed'
           ORDER BY outbox.event_id ASC`
        )
        .all() as ExpiredDeliveryClaimRow[];
      const swept: ExpiredDeliveryClaimSweepResult[] = [];

      for (const row of rows) {
        if (
          row.lease_owner_instance_id === null ||
          row.lease_claim_generation === null ||
          row.lease_state === null ||
          row.lease_expires_at === null
        ) {
          if (this.sweepClaimedDeliveryToRecovery(row.event_id, now, null)) {
            swept.push(Object.freeze({
              eventId: row.event_id,
              requestId: row.request_id,
              claimGeneration: row.claim_generation,
              reason: "legacy_claim"
            }));
          }
          continue;
        }

        const expired = row.expires_at <= now || row.lease_expires_at <= now;
        const active = isActiveDeliveryClaimLeaseState(row.lease_state);
        const exactLease =
          row.outbox_owner_instance_id !== null &&
          row.lease_request_id === row.request_id &&
          row.lease_owner_instance_id === row.outbox_owner_instance_id &&
          row.lease_claim_generation === row.claim_generation;
        if (!expired && active && exactLease) continue;
        if (
          this.sweepClaimedDeliveryToRecovery(row.event_id, now, {
            ownerInstanceId: row.lease_owner_instance_id,
            claimGeneration: row.lease_claim_generation,
            state: row.lease_state
          })
        ) {
          swept.push(Object.freeze({
            eventId: row.event_id,
            requestId: row.request_id,
            claimGeneration: row.claim_generation,
            reason: exactLease && expired ? "lease_expired" : "invalid_lease"
          }));
        }
      }
      return Object.freeze(swept);
    });
  }

  /** Claim the oldest eligible event. A concurrent worker may win the race. */
  claimNextPendingDelivery(ownerInstanceId: string, now: number): ClaimedDelivery | null {
    validateIdentifier(ownerInstanceId, "delivery claim owner");
    validateTimestamp(now, "delivery claim timestamp");
    const row = this.#db
      .prepare("SELECT event_id FROM delivery_outbox WHERE state = 'pending' ORDER BY created_at ASC, event_id ASC LIMIT 1")
      .get() as { event_id: string } | undefined;
    return row ? this.claimPendingDelivery(row.event_id, ownerInstanceId, now) : null;
  }

  /** Re-read a payload only when the caller still owns its exact claim fence. */
  readClaimedDelivery(fence: DeliveryClaimFence, now: number): ClaimedDelivery {
    validateDeliveryClaimFence(fence);
    validateTimestamp(now, "delivery read timestamp");
    const row = this.transaction(() => {
      const row = this.requireDelivery(fence.eventId);
      this.assertDeliveryClaim(row, fence);
      const lease = this.requireDeliveryClaimLease(row, fence);
      if (row.state !== "claimed") throw new DeliveryClaimFenceError(fence.eventId);
      if (!isActiveDeliveryClaimLeaseState(lease.state)) throw new DeliveryClaimFenceError(fence.eventId);
      if (row.expires_at <= now || lease.leaseExpiresAt <= now) {
        this.markDeliveryRecovery(row.event_id, now, fence);
        return null;
      }
      return row;
    });
    if (!row) throw new DeliveryClaimFenceError(fence.eventId);
    try {
      return this.toClaimedDelivery(row);
    } catch (error) {
      this.markClaimedDeliveryRecovery(row, now);
      throw error;
    }
  }

  /**
   * ACK acceptance is intentionally limited to the exact negotiated v1
   * at-least-once record and the current bearer token derived for that claim.
   */
  acknowledgeDelivery(input: unknown, now: number): void {
    validateTimestamp(now, "delivery acknowledgement timestamp");
    const acknowledgement = validateOutboxAck(input);
    const status = this.transaction(() => {
      const row = this.requireDelivery(acknowledgement.eventId);
      const fence: DeliveryClaimFence = {
        eventId: acknowledgement.eventId,
        ownerInstanceId: row.claim_owner_instance_id ?? "",
        claimGeneration: acknowledgement.claimGeneration,
        claimToken: acknowledgement.claimToken
      };
      if (row.session_id !== acknowledgement.sessionId || !this.isNegotiatedDelivery(row)) {
        throw new DeliveryClaimFenceError(acknowledgement.eventId);
      }
      this.assertDeliveryClaim(row, fence);
      const lease = this.requireDeliveryClaimLease(row, fence);
      if (row.state === "delivered") {
        if (lease.state !== "delivered") throw new DeliveryClaimFenceError(acknowledgement.eventId);
        return "delivered" as const;
      }
      if (row.state !== "claimed") throw new DeliveryClaimFenceError(acknowledgement.eventId);
      if (!isActiveDeliveryClaimLeaseState(lease.state)) throw new DeliveryClaimFenceError(acknowledgement.eventId);
      if (row.expires_at <= now || lease.leaseExpiresAt <= now) {
        this.markDeliveryRecovery(row.event_id, now, fence);
        return "expired" as const;
      }

      const result = this.#db
        .prepare(
          `UPDATE delivery_outbox
           SET state = 'delivered', nonce = NULL, ciphertext = NULL, auth_tag = NULL, settled_at = ?
           WHERE event_id = ? AND state = 'claimed' AND claim_owner_instance_id = ? AND claim_generation = ?`
        )
        .run(now, row.event_id, fence.ownerInstanceId, fence.claimGeneration);
      if (result.changes !== 1) throw new DeliveryClaimFenceError(acknowledgement.eventId);
      this.runInjectedTransactionFault(this.#faultInjection?.afterDeliveryOutboxSettled);
      const settled = this.#db
        .prepare(
          `UPDATE delivery_claim_leases
           SET state = 'delivered', settled_at = ?, updated_at = ?
           WHERE event_id = ? AND request_id = ? AND owner_instance_id = ? AND claim_generation = ?
             AND state IN ('claimed', 'replay_reserved')`
        )
        .run(now, now, row.event_id, row.request_id, fence.ownerInstanceId, fence.claimGeneration);
      if (settled.changes !== 1) throw new DeliveryClaimFenceError(acknowledgement.eventId);
      this.journalTransition("delivery_delivered", row.request_id, lease.state, "delivered", now);
      return "delivered" as const;
    });
    if (status === "expired") throw new DeliveryClaimFenceError(acknowledgement.eventId);
  }

  /** A transport failure must use the claim fence and cannot reopen the event. */
  markDeliveryRecoveryRequired(fence: DeliveryClaimFence, now: number): void {
    validateDeliveryClaimFence(fence);
    validateTimestamp(now, "delivery recovery timestamp");
    this.transaction(() => {
      const row = this.requireDelivery(fence.eventId);
      this.assertDeliveryClaim(row, fence);
      const lease = this.requireDeliveryClaimLease(row, fence);
      if (row.state !== "claimed") throw new DeliveryClaimFenceError(fence.eventId);
      if (!isActiveDeliveryClaimLeaseState(lease.state)) throw new DeliveryClaimFenceError(fence.eventId);
      this.markDeliveryRecovery(row.event_id, now, fence);
    });
  }

  admitNext(now: number, ownerInstanceId: string): AdmissionLease | null {
    return this.transaction(() => {
      this.expireQueued(now);
      if (this.activeLeaseCount() >= this.policy.maxActiveTurns) return null;

      const candidate = this.selectEligibleRequest(now);
      if (!candidate) return null;

      const leaseId = randomUUID();
      const generation = candidate.lease_generation + 1;
      this.#db
        .prepare("UPDATE turn_requests SET state = 'admitted', lease_generation = ? WHERE request_id = ?")
        .run(generation, candidate.request_id);
      this.#db
        .prepare(
          `INSERT INTO leases (lease_id, request_id, generation, owner_instance_id, phase, acquired_at, heartbeat_at)
           VALUES (?, ?, ?, ?, 'admitted', ?, ?)`
        )
        .run(leaseId, candidate.request_id, generation, ownerInstanceId, now, now);
      this.journalTransition("request_admitted", candidate.request_id, "queued", "admitted", now);
      return { leaseId, requestId: candidate.request_id, generation, ownerInstanceId };
    });
  }

  /**
   * Atomically admit one exact queued request without touching any other
   * request. Targeted dispatch uses strict FIFO: a later live request cannot
   * bypass an older durable request, including one held by provider cooldown.
   */
  admitRequest(requestId: string, now: number, ownerInstanceId: string): AdmissionLease | null {
    validateIdentifier(requestId, "admission request ID");
    validateIdentifier(ownerInstanceId, "admission owner instance ID");
    validateTimestamp(now, "admission timestamp");
    const startRateCutoff = now - this.policy.minStartIntervalMs;

    return this.transaction(() => {
      const claimed = this.#db
        .prepare(
          `UPDATE turn_requests AS target
           SET state = 'admitted', lease_generation = lease_generation + 1
           WHERE target.request_id = ?
             AND target.state = 'queued'
             AND target.deadline_at > ?
             AND EXISTS (
               SELECT 1
               FROM turn_payloads AS payload
               WHERE payload.request_id = target.request_id
                 AND payload.content_fingerprint IS NOT NULL
             )
             AND NOT EXISTS (
               SELECT 1
               FROM cooldowns AS cooldown
               WHERE cooldown.provider = target.provider
                 AND cooldown.model = target.model
                 AND cooldown.not_before > ?
             )
             AND NOT EXISTS (
               SELECT 1
               FROM turn_requests AS earlier
               INNER JOIN turn_payloads AS earlier_payload ON earlier_payload.request_id = earlier.request_id
               WHERE earlier.state = 'queued'
                 AND earlier.deadline_at > ?
                 AND earlier_payload.content_fingerprint IS NOT NULL
                 AND (
                   earlier.enqueued_at < target.enqueued_at
                   OR (earlier.enqueued_at = target.enqueued_at AND earlier.request_id < target.request_id)
                 )
             )
             AND (
               SELECT COUNT(*)
               FROM leases
               WHERE phase IN ('admitted', 'starting', 'dispatch_intent', 'dispatch_ambiguous', 'active', 'recovery_required')
             ) < ?
             AND (
               SELECT COUNT(*)
               FROM leases
               WHERE phase IN ('admitted', 'starting', 'dispatch_intent')
             ) < ?
             AND NOT EXISTS (
               SELECT 1
               FROM start_history
               WHERE started_at > ?
             )
             AND NOT EXISTS (
               SELECT 1
               FROM leases
               WHERE phase IN ('admitted', 'starting', 'dispatch_intent')
                 AND acquired_at > ?
             )`
        )
        .run(
          requestId,
          now,
          now,
          now,
          this.policy.maxActiveTurns,
          this.policy.maxConcurrentStarts,
          startRateCutoff,
          startRateCutoff
        );
      if (claimed.changes !== 1) return null;

      const request = this.#db
        .prepare(
          `SELECT request_id, session_id, parent_id, fingerprint, provider, model,
                  state, enqueued_at, lease_generation
           FROM turn_requests
           WHERE request_id = ? AND state = 'admitted'`
        )
        .get(requestId) as RequestRow | undefined;
      if (!request) throw new Error("targeted admission lost its request reservation");

      const leaseId = randomUUID();
      this.#db
        .prepare(
          `INSERT INTO leases (lease_id, request_id, generation, owner_instance_id, phase, acquired_at, heartbeat_at)
           VALUES (?, ?, ?, ?, 'admitted', ?, ?)`
        )
        .run(leaseId, request.request_id, request.lease_generation, ownerInstanceId, now, now);
      this.journalTransition("request_admitted", request.request_id, "queued", "admitted", now);
      return { leaseId, requestId: request.request_id, generation: request.lease_generation, ownerInstanceId };
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
    this.transition(fence, "dispatch_intent", "active", now);
  }

  markDispatchAmbiguous(fence: LeaseFence, now: number): void {
    this.transition(fence, "dispatch_intent", "dispatch_ambiguous", now);
  }

  markProviderTerminal(
    fence: LeaseFence,
    now: number,
    observations: ProviderTerminalObservations,
    delivery: EnqueueDelivery
  ): { eventId: string; existed: boolean } {
    validateTimestamp(now, "provider terminal timestamp");
    this.validateDeliveryInput(delivery);
    if (delivery.now !== now) throw new Error("terminal delivery timestamp must equal the provider terminal timestamp");
    const evidenceInput = parseTerminalEvidenceInput(observations);
    const confirmed = evidenceInput === null ? null : confirmTerminalEvidence(evidenceInput);
    if (confirmed === null || confirmed.outcome !== "confirmed") {
      throw new Error("provider terminal evidence requires recovery");
    }
    const outcome =
      confirmed.status === "SUCCESS"
        ? "completed"
        : confirmed.status === "ERROR"
          ? "failed"
          : "cancelled";
    const failure = confirmed.sqliteReconciliation.outcome === "failed" ? confirmed.sqliteReconciliation.failure : null;

    return this.transaction(() => {
      const lease = this.requireLease(fence);
      if (lease.phase !== "active") throw new Error("lease is not active");
      if (delivery.requestId !== lease.request_id) {
        throw new DeliveryConflictError(delivery.eventId);
      }
      const delivered = this.insertDelivery(delivery, { leaseId: lease.lease_id, leaseGeneration: lease.generation });
      this.runInjectedTransactionFault(this.#faultInjection?.afterProviderTerminalOutboxPersisted);
      const result = this.#db
        .prepare(
          `UPDATE leases
           SET phase = 'provider_terminal', terminal_outcome = ?, heartbeat_at = ?,
               terminal_conversation_id = ?, terminal_status = ?,
               terminal_stream_observed_at = ?, terminal_sqlite_observed_at = ?,
               terminal_failure_category = ?, terminal_http_status = ?, terminal_code = ?, terminal_reason = ?
           WHERE lease_id = ? AND owner_instance_id = ? AND generation = ?`
        )
        .run(
          outcome,
          now,
          confirmed.conversationId,
          confirmed.status,
          confirmed.streamJson?.observedAt ?? null,
          confirmed.sqliteReconciliation.observedAt,
          failure?.category ?? null,
          failure?.httpStatus ?? null,
          failure?.code ?? null,
          failure?.reason ?? null,
          fence.leaseId,
          fence.ownerInstanceId,
          fence.generation
        );
      if (result.changes !== 1) throw new LeaseFenceError(fence.leaseId);
      this.#db
        .prepare("UPDATE turn_requests SET state = 'provider_terminal', terminal_at = ? WHERE request_id = ?")
        .run(now, lease.request_id);
      this.journalTransition("request_provider_terminal", lease.request_id, "active", "provider_terminal", now);
      return delivered;
    });
  }

  heartbeat(fence: LeaseFence, now: number): void {
    const result = this.#db
      .prepare("UPDATE leases SET heartbeat_at = ? WHERE lease_id = ? AND owner_instance_id = ? AND generation = ?")
      .run(now, fence.leaseId, fence.ownerInstanceId, fence.generation);
    if (result.changes !== 1) throw new LeaseFenceError(fence.leaseId);
  }

  release(fence: LeaseFence, now: number): void {
    this.transaction(() => {
      const lease = this.requireLease(fence);
      if (lease.phase !== "provider_terminal" || lease.terminal_outcome === null) {
        throw new Error("lease has no confirmed provider terminal outcome");
      }
      this.#db
        .prepare("UPDATE turn_requests SET state = ?, terminal_at = ? WHERE request_id = ?")
        .run(lease.terminal_outcome, now, lease.request_id);
      const result = this.#db
        .prepare("DELETE FROM leases WHERE lease_id = ? AND owner_instance_id = ? AND generation = ?")
        .run(fence.leaseId, fence.ownerInstanceId, fence.generation);
      if (result.changes !== 1) throw new LeaseFenceError(fence.leaseId);
      this.journalTransition("request_released", lease.request_id, "provider_terminal", lease.terminal_outcome, now);
    });
  }

  /**
   * Mark a suspect owner as recovery_required and allocate one durable recovery
   * claim. This intentionally accepts no caller boolean about process death or
   * dispatch: any proof must be represented by a later signed resolution.
   */
  recoverOwner(leaseId: string, now: number, claimantInstanceId: string): RecoveryClaimToken {
    validateIdentifier(leaseId, "lease ID");
    validateIdentifier(claimantInstanceId, "recovery claimant");
    validateTimestamp(now, "owner recovery timestamp");
    return this.transaction(() => {
      const lease = this.requireLeaseById(leaseId);
      if (lease.phase === "provider_terminal") {
        throw new RecoveryClaimFenceError(leaseId);
      }
      const existing = this.#db
        .prepare(
          `SELECT lease_id, request_id, lease_generation, recovery_generation, claimant_instance_id, prior_phase, state
           FROM recovery_claims WHERE lease_id = ?`
        )
        .get(leaseId) as RecoveryClaimRow | undefined;
      if (existing) {
        if (
          existing.state !== "claimed" ||
          existing.claimant_instance_id !== claimantInstanceId ||
          existing.request_id !== lease.request_id ||
          existing.lease_generation !== lease.generation
        ) {
          throw new RecoveryClaimFenceError(leaseId);
        }
        return recoveryClaimToken(existing);
      }

      this.#db
        .prepare("UPDATE turn_requests SET state = 'recovery_required', terminal_at = ? WHERE request_id = ?")
        .run(now, lease.request_id);
      const updated = this.#db
        .prepare(
          `UPDATE leases SET phase = 'recovery_required', heartbeat_at = ?
           WHERE lease_id = ? AND owner_instance_id = ? AND generation = ?`
        )
        .run(now, leaseId, lease.owner_instance_id, lease.generation);
      if (updated.changes !== 1) throw new LeaseFenceError(leaseId);
      const claim: RecoveryClaimRow = {
        lease_id: lease.lease_id,
        request_id: lease.request_id,
        lease_generation: lease.generation,
        recovery_generation: 1,
        claimant_instance_id: claimantInstanceId,
        prior_phase: lease.phase,
        state: "claimed"
      };
      this.#db
        .prepare(
          `INSERT INTO recovery_claims
            (lease_id, request_id, lease_generation, recovery_generation, claimant_instance_id, prior_phase, state, claimed_at)
           VALUES (?, ?, ?, ?, ?, ?, 'claimed', ?)`
        )
        .run(
          claim.lease_id,
          claim.request_id,
          claim.lease_generation,
          claim.recovery_generation,
          claim.claimant_instance_id,
          claim.prior_phase,
          now
        );
      this.journalTransition("request_recovery_required", lease.request_id, lease.phase, "recovery_required", now);
      return recoveryClaimToken(claim);
    });
  }

  /** Create the two HMAC attestations required by the recovery-resolution contract. */
  createRecoveryResolutionAttestations(
    claim: RecoveryClaimToken,
    action: RecoveryResolutionAction,
    evidenceCode: RecoveryEvidenceCode,
    reasonCode: RecoveryReasonCode
  ): RecoveryResolutionAttestations {
    const current = this.requireCurrentRecoveryClaim(claim);
    return Object.freeze({
      actorHmac: this.recoveryHmac("actor", [current]),
      evidenceHmac: this.recoveryHmac("evidence", [current, action, evidenceCode, reasonCode])
    });
  }

  /**
   * Apply a pure recovery plan against the still-current durable claim. Invalid
   * plans, stale claims, unsigned evidence, and post-dispatch requeue attempts
   * leave the lease in recovery_required.
   */
  resolveRecovery(input: unknown, now: number, delivery?: EnqueueDelivery): RecoveryResolutionPlan {
    validateTimestamp(now, "recovery resolution timestamp");
    return this.transaction(() => {
      const resolution = validateRecoveryResolution(input);
      if (resolution === null) return rejectedRecoveryPlan("invalid_resolution");
      const row = this.#db
        .prepare(
          `SELECT lease_id, request_id, lease_generation, recovery_generation, claimant_instance_id, prior_phase, state
           FROM recovery_claims WHERE lease_id = ?`
        )
        .get(resolution.claim.leaseId) as RecoveryClaimRow | undefined;
      if (!row || row.state !== "claimed") return rejectedRecoveryPlan("claim_mismatch");

      const claim = recoveryClaimToken(row);
      const plan = planRecoveryResolution({ state: "recovery_required", claim }, resolution);
      if (!plan.accepted) return plan;
      if (!this.hasRecoveryAttestations(plan)) return rejectedRecoveryPlan("evidence_mismatch");

      const lease = this.requireLeaseById(plan.claim.leaseId);
      if (
        lease.request_id !== plan.claim.requestId ||
        lease.generation !== plan.claim.leaseGeneration ||
        lease.phase !== "recovery_required"
      ) {
        return rejectedRecoveryPlan("claim_mismatch");
      }

      switch (plan.action) {
        case "confirmed_not_dispatched_requeue":
          if (lease.phase !== "recovery_required" || !this.isPreDispatchRecoveryLease(lease.lease_id)) {
            return rejectedRecoveryPlan("evidence_mismatch");
          }
          this.#db
            .prepare("UPDATE turn_requests SET state = 'queued', terminal_at = NULL WHERE request_id = ?")
            .run(lease.request_id);
          this.journalTransition(
            "request_recovery_requeued",
            lease.request_id,
            "recovery_required",
            "queued",
            now
          );
          break;
        case "confirmed_completed":
        case "confirmed_cancelled": {
          if (delivery === undefined) return rejectedRecoveryPlan("evidence_mismatch");
          this.validateDeliveryInput(delivery);
          if (delivery.now !== now || delivery.requestId !== lease.request_id) return rejectedRecoveryPlan("evidence_mismatch");
          this.insertDelivery(delivery, { leaseId: lease.lease_id, leaseGeneration: lease.generation });
          this.#db
            .prepare("UPDATE turn_requests SET state = ?, terminal_at = ? WHERE request_id = ?")
            .run(plan.nextState, now, lease.request_id);
          this.journalTransition(
            plan.nextState === "completed" ? "request_recovery_completed" : "request_recovery_cancelled",
            lease.request_id,
            "recovery_required",
            plan.nextState,
            now
          );
          break;
        }
        case "acknowledge_unknown_release":
          this.#db
            .prepare("UPDATE turn_requests SET state = 'recovery_resolved', terminal_at = ? WHERE request_id = ?")
            .run(now, lease.request_id);
          this.journalTransition(
            "request_recovery_unknown_released",
            lease.request_id,
            "recovery_required",
            "recovery_resolved",
            now
          );
          break;
      }

      const resolved = this.#db
        .prepare(
          `UPDATE recovery_claims
           SET state = 'resolved', resolved_at = ?, action = ?, evidence_code = ?, reason_code = ?,
               actor_hmac = ?, evidence_hmac = ?
           WHERE lease_id = ? AND request_id = ? AND lease_generation = ? AND recovery_generation = ?
             AND claimant_instance_id = ? AND state = 'claimed'`
        )
        .run(
          now,
          plan.action,
          plan.evidenceCode,
          plan.reasonCode,
          plan.actorHmac,
          plan.evidenceHmac,
          plan.claim.leaseId,
          plan.claim.requestId,
          plan.claim.leaseGeneration,
          plan.claim.recoveryGeneration,
          plan.claim.claimantInstanceId
        );
      if (resolved.changes !== 1) throw new RecoveryClaimFenceError(plan.claim.leaseId);
      const released = this.#db
        .prepare("DELETE FROM leases WHERE lease_id = ? AND generation = ?")
        .run(plan.claim.leaseId, plan.claim.leaseGeneration);
      if (released.changes !== 1) throw new RecoveryClaimFenceError(plan.claim.leaseId);
      return plan;
    });
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
                lease.terminal_outcome AS lease_terminal_outcome,
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

  /**
   * Enumerate only payload-free, non-delivered outbox claim leases. The two
   * tables are read in one snapshot and any partial or mismatched fence rejects
   * the complete inventory instead of silently omitting recovery work.
   */
  listRecoverableOutboxClaims(): readonly DeliveryClaimLease[] {
    return this.transaction(() => {
      const leaseRows = this.#db
        .prepare(
          `SELECT lease.event_id AS lease_event_id,
                  lease.request_id AS lease_request_id,
                  lease.owner_instance_id AS lease_owner_instance_id,
                  lease.claim_generation AS lease_claim_generation,
                  lease.state AS lease_state,
                  lease.heartbeat_at AS lease_heartbeat_at,
                  lease.lease_expires_at AS lease_expires_at,
                  lease.terminal_replay_count AS lease_terminal_replay_count,
                  outbox.event_id AS outbox_event_id,
                  outbox.request_id AS outbox_request_id,
                  outbox.claim_owner_instance_id AS outbox_owner_instance_id,
                  outbox.claim_generation AS outbox_claim_generation,
                  outbox.state AS outbox_state
           FROM delivery_claim_leases AS lease
           LEFT JOIN delivery_outbox AS outbox ON outbox.event_id = lease.event_id
           WHERE lease.state IN ('claimed', 'replay_reserved', 'recovery_required')
           ORDER BY lease.event_id ASC`
        )
        .all() as RecoverableOutboxClaimRow[];
      const outboxRows = this.#db
        .prepare(
          `SELECT lease.event_id AS lease_event_id,
                  lease.request_id AS lease_request_id,
                  lease.owner_instance_id AS lease_owner_instance_id,
                  lease.claim_generation AS lease_claim_generation,
                  lease.state AS lease_state,
                  lease.heartbeat_at AS lease_heartbeat_at,
                  lease.lease_expires_at AS lease_expires_at,
                  lease.terminal_replay_count AS lease_terminal_replay_count,
                  outbox.event_id AS outbox_event_id,
                  outbox.request_id AS outbox_request_id,
                  outbox.claim_owner_instance_id AS outbox_owner_instance_id,
                  outbox.claim_generation AS outbox_claim_generation,
                  outbox.state AS outbox_state
           FROM delivery_outbox AS outbox
           LEFT JOIN delivery_claim_leases AS lease ON lease.event_id = outbox.event_id
           WHERE outbox.state IN ('claimed', 'recovery_required')
           ORDER BY outbox.event_id ASC`
        )
        .all() as RecoverableOutboxClaimRow[];

      if (leaseRows.length !== outboxRows.length) throw new RecoverableOutboxClaimInventoryError();
      const inventory = leaseRows.map((row) => recoverableOutboxClaim(row));
      for (let index = 0; index < outboxRows.length; index += 1) {
        const counterpart = recoverableOutboxClaim(outboxRows[index]);
        if (!sameRecoverableOutboxClaim(inventory[index], counterpart)) {
          throw new RecoverableOutboxClaimInventoryError();
        }
      }
      return Object.freeze(inventory);
    });
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
        const unversionedCore = this.#db
          .prepare(
            `SELECT COUNT(*) AS count FROM sqlite_master
             WHERE type = 'table' AND name IN ('turn_requests', 'leases', 'turn_payloads', 'delivery_outbox')`
          )
          .get() as { count: number };
        if (unversionedCore.count > 0) {
          throw new Error("unversioned admission tables require an explicit migration before use");
        }

        this.#db.exec(`
      CREATE TABLE IF NOT EXISTS turn_requests (
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
      CREATE TABLE IF NOT EXISTS leases (
        lease_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE REFERENCES turn_requests(request_id),
        generation INTEGER NOT NULL,
        owner_instance_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        acquired_at INTEGER NOT NULL,
        heartbeat_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cooldowns (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        not_before INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, model)
      );
      CREATE TABLE IF NOT EXISTS turn_payloads (
        request_id TEXT PRIMARY KEY REFERENCES turn_requests(request_id) ON DELETE CASCADE,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        key_version INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivery_outbox (
        event_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL REFERENCES turn_requests(request_id),
        fingerprint TEXT NOT NULL,
        state TEXT NOT NULL,
        nonce BLOB,
        ciphertext BLOB,
        auth_tag BLOB,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        settled_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS start_history (
        lease_id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS turn_requests_queue ON turn_requests(state, enqueued_at);
      CREATE INDEX IF NOT EXISTS leases_phase ON leases(phase);
      CREATE INDEX IF NOT EXISTS delivery_outbox_pending ON delivery_outbox(state, created_at);
      CREATE INDEX IF NOT EXISTS start_history_started ON start_history(started_at);
    `);
        this.#db
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'admission-controller-core', ?)")
          .run(Date.now());
      }

      if (this.schemaVersion === 1) {
        this.#db.exec("ALTER TABLE leases ADD COLUMN terminal_outcome TEXT");
        this.#db
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, 'provider-terminal-proof', ?)")
          .run(Date.now());
      }

      if (this.schemaVersion === 2) {
        this.#db.exec(`
          ALTER TABLE turn_payloads ADD COLUMN content_fingerprint TEXT;
          ALTER TABLE delivery_outbox ADD COLUMN key_version INTEGER;
        `);
        this.#db
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (3, 'authenticated-row-binding', ?)")
          .run(Date.now());
      }

      if (this.schemaVersion === 3) {
        this.#db.exec(`
          ALTER TABLE leases ADD COLUMN terminal_conversation_id TEXT;
          ALTER TABLE leases ADD COLUMN terminal_status TEXT;
          ALTER TABLE leases ADD COLUMN terminal_stream_observed_at INTEGER;
          ALTER TABLE leases ADD COLUMN terminal_sqlite_observed_at INTEGER;
          ALTER TABLE leases ADD COLUMN terminal_failure_category TEXT;
          ALTER TABLE leases ADD COLUMN terminal_http_status INTEGER;
          ALTER TABLE leases ADD COLUMN terminal_code TEXT;
          ALTER TABLE leases ADD COLUMN terminal_reason TEXT;
        `);
        this.#db
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (4, 'structured-terminal-evidence', ?)")
          .run(Date.now());
      }

      if (this.schemaVersion === 4) {
        this.#db.exec(`
          ALTER TABLE delivery_outbox ADD COLUMN sequence INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE delivery_outbox ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE delivery_outbox ADD COLUMN protocol_semantics TEXT NOT NULL DEFAULT 'unnegotiated';
          ALTER TABLE delivery_outbox ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0;
          ALTER TABLE delivery_outbox ADD COLUMN claim_owner_instance_id TEXT;
          ALTER TABLE delivery_outbox ADD COLUMN claim_acquired_at INTEGER;
          ALTER TABLE delivery_outbox ADD COLUMN lease_id TEXT;
          ALTER TABLE delivery_outbox ADD COLUMN lease_generation INTEGER;
        `);
        // A v4 pending row has no negotiated protocol or claim fence, so never replay it.
        this.#db
          .prepare(
            `UPDATE delivery_outbox
             SET state = 'recovery_required', nonce = NULL, ciphertext = NULL, auth_tag = NULL, settled_at = ?
             WHERE state = 'pending'`
          )
          .run(Date.now());
        this.#db
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (5, 'durable-outbox-claims', ?)")
          .run(Date.now());
      }

      if (this.schemaVersion === 5) {
        this.#db.exec(`
          CREATE TABLE recovery_claims (
            lease_id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL REFERENCES turn_requests(request_id),
            lease_generation INTEGER NOT NULL,
            recovery_generation INTEGER NOT NULL,
            claimant_instance_id TEXT NOT NULL,
            prior_phase TEXT NOT NULL,
            state TEXT NOT NULL,
            claimed_at INTEGER NOT NULL,
            resolved_at INTEGER,
            action TEXT,
            evidence_code TEXT,
            reason_code TEXT,
            actor_hmac TEXT,
            evidence_hmac TEXT
          );
          CREATE INDEX recovery_claims_request ON recovery_claims(request_id);
        `);
        this.#db
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (6, 'fenced-recovery-resolution', ?)")
          .run(Date.now());
      }

      if (this.schemaVersion === 6) {
        this.#db.exec(`
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
          CREATE INDEX sessions_updated_at_session_id ON sessions(updated_at DESC, session_id ASC);
          CREATE INDEX sessions_cwd_updated_at_session_id ON sessions(cwd, updated_at DESC, session_id ASC);
        `);
        this.#db
          .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (7, 'sqlite-session-store', ?)")
          .run(Date.now());
      }

      if (this.schemaVersion === 7) {
        const migrationAt = Date.now();
        this.#db.exec(`
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
          CREATE UNIQUE INDEX lease_process_identities_request ON lease_process_identities(request_id);
        `);
        // v7 retained no immutable child identity, so every pre-terminal in-flight
        // lease is unknown after upgrade and must not be treated as replayable.
        this.#db
          .prepare(
            `UPDATE turn_requests
             SET state = 'recovery_required', terminal_at = ?
             WHERE request_id IN (
               SELECT request_id FROM leases
               WHERE phase IN ('starting', 'dispatch_intent', 'dispatch_ambiguous', 'active')
             )`
          )
          .run(migrationAt);
        this.#db
          .prepare(
            `UPDATE leases
             SET phase = 'recovery_required', heartbeat_at = ?
             WHERE phase IN ('starting', 'dispatch_intent', 'dispatch_ambiguous', 'active')`
          )
          .run(migrationAt);
        this.#db
          .prepare(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (8, 'atomic-process-dispatch-intent', ?)"
          )
          .run(migrationAt);
      }

      if (this.schemaVersion === 8) {
        const migrationAt = Date.now();
        this.#db.exec(`
          CREATE TABLE delivery_claim_leases (
            event_id TEXT PRIMARY KEY REFERENCES delivery_outbox(event_id) ON DELETE CASCADE,
            request_id TEXT NOT NULL REFERENCES turn_requests(request_id),
            owner_instance_id TEXT NOT NULL,
            claim_generation INTEGER NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('claimed', 'replay_reserved', 'delivered', 'recovery_required')),
            heartbeat_at INTEGER NOT NULL,
            lease_expires_at INTEGER NOT NULL,
            terminal_replay_count INTEGER NOT NULL DEFAULT 0,
            replay_reserved_at INTEGER,
            settled_at INTEGER,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX delivery_claim_leases_expiry ON delivery_claim_leases(state, lease_expires_at);
        `);
        // v8 claims have no controller-owned lease or replay reservation. They
        // are ambiguous across a crash and must never be replayed after upgrade.
        this.#db
          .prepare(
            `UPDATE delivery_outbox
             SET state = 'recovery_required', nonce = NULL, ciphertext = NULL, auth_tag = NULL, settled_at = ?
             WHERE state = 'claimed'`
          )
          .run(migrationAt);
        this.#db
          .prepare(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (9, 'atomic-outbox-claim-leases', ?)"
          )
          .run(migrationAt);
      }

      if (this.schemaVersion === 9) {
        const migrationAt = Date.now();
        this.#db.exec(`
          CREATE TABLE events (
            event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL,
            from_state TEXT NOT NULL,
            to_state TEXT NOT NULL,
            occurred_at INTEGER NOT NULL,
            correlation_hmac TEXT NOT NULL
          );
          CREATE INDEX events_occurred ON events(occurred_at, event_seq);
        `);
        this.#db
          .prepare(
            "INSERT INTO schema_migrations (version, name, applied_at) VALUES (10, 'sanitized-admission-events', ?)"
          )
          .run(migrationAt);
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
                lease.phase, lease.terminal_outcome, request.state AS request_state,
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
      lease.terminal_outcome !== null ||
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
        "SELECT lease_id, request_id, generation, owner_instance_id, phase, terminal_outcome FROM leases WHERE lease_id = ?"
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

  private selectEligibleRequest(now: number): RequestRow | null {
    const rows = this.#db
      .prepare(
        `SELECT turn_requests.request_id, session_id, parent_id, fingerprint, provider, model,
         turn_requests.state, enqueued_at, lease_generation
         FROM turn_requests
         INNER JOIN turn_payloads payload ON payload.request_id = turn_requests.request_id
         WHERE turn_requests.state = 'queued' AND payload.content_fingerprint IS NOT NULL
         ORDER BY enqueued_at ASC, turn_requests.request_id ASC`
      )
      .all() as RequestRow[];
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
    const row = this.#db
      .prepare("SELECT not_before FROM cooldowns WHERE provider = ? AND model = ?")
      .get(provider, model) as { not_before: number } | undefined;
    return row !== undefined && row.not_before > now;
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
        "SELECT lease_id, request_id, generation, owner_instance_id, phase, terminal_outcome FROM leases WHERE lease_id = ?"
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

  private validateDeliveryInput(input: EnqueueDelivery): void {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error("delivery input must be an object");
    }
    validateIdentifier(input.eventId, "delivery event ID");
    validateIdentifier(input.requestId, "delivery request ID");
    validateIdentifier(input.fingerprint, "delivery fingerprint");
    if (typeof input.payload !== "string") throw new Error("delivery payload must be a string");
    validateTimestamp(input.now, "delivery timestamp");
    validateTimestamp(input.expiresAt, "delivery expiry");
    if (input.expiresAt <= input.now) throw new Error("delivery expiry must be after persistence time");
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0) {
      throw new Error("delivery sequence must be a non-negative safe integer");
    }
    if (!isNegotiatedOutboxProtocol(input.protocol)) {
      throw new Error("delivery requires a negotiated at-least-once outbox protocol");
    }
  }

  private insertDelivery(
    input: EnqueueDelivery,
    attachment: { leaseId: string; leaseGeneration: number } | null
  ): { eventId: string; existed: boolean } {
    const existing = this.findDelivery(input.eventId);
    if (existing) {
      if (
        existing.request_id !== input.requestId ||
        existing.fingerprint !== input.fingerprint ||
        existing.sequence !== input.sequence ||
        !this.isNegotiatedDelivery(existing) ||
        existing.lease_id !== (attachment?.leaseId ?? null) ||
        existing.lease_generation !== (attachment?.leaseGeneration ?? null)
      ) {
        throw new DeliveryConflictError(input.eventId);
      }
      return { eventId: input.eventId, existed: true };
    }

    this.requireRequest(input.requestId);
    const keyVersion = 1;
    const encrypted = this.encrypt(input.payload, this.deliveryAad(input.eventId, input.requestId, keyVersion));
    this.#db
      .prepare(
        `INSERT INTO delivery_outbox
          (event_id, request_id, fingerprint, state, nonce, ciphertext, auth_tag, expires_at, created_at, key_version,
           sequence, protocol_version, protocol_semantics, claim_generation, lease_id, lease_generation)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      )
      .run(
        input.eventId,
        input.requestId,
        input.fingerprint,
        encrypted.nonce,
        encrypted.ciphertext,
        encrypted.authTag,
        input.expiresAt,
        input.now,
        keyVersion,
        input.sequence,
        ACP_OUTBOX_CAPABILITY_VERSION,
        ACP_OUTBOX_DELIVERY_SEMANTICS,
        attachment?.leaseId ?? null,
        attachment?.leaseGeneration ?? null
      );
    this.journalTransition("delivery_enqueued", input.requestId, "absent", "pending", input.now);
    return { eventId: input.eventId, existed: false };
  }

  private findDelivery(eventId: string): DeliveryRow | undefined {
    return this.#db
      .prepare(
        `SELECT outbox.event_id, outbox.request_id, outbox.fingerprint, outbox.state,
                outbox.nonce, outbox.ciphertext, outbox.auth_tag, outbox.key_version, outbox.expires_at,
                outbox.sequence, outbox.protocol_version, outbox.protocol_semantics, outbox.claim_generation,
                outbox.claim_owner_instance_id, outbox.claim_acquired_at, outbox.lease_id, outbox.lease_generation,
                request.session_id
         FROM delivery_outbox outbox
         JOIN turn_requests request ON request.request_id = outbox.request_id
         WHERE outbox.event_id = ?`
      )
      .get(eventId) as DeliveryRow | undefined;
  }

  private requireDelivery(eventId: string): DeliveryRow {
    const row = this.findDelivery(eventId);
    if (!row) throw new Error("unknown delivery event");
    return row;
  }

  private findDeliveryClaimLease(eventId: string): DeliveryClaimLeaseRow | undefined {
    return this.#db
      .prepare(
        `SELECT event_id, request_id, owner_instance_id, claim_generation, state,
                heartbeat_at, lease_expires_at, terminal_replay_count, replay_reserved_at, settled_at
         FROM delivery_claim_leases WHERE event_id = ?`
      )
      .get(eventId) as DeliveryClaimLeaseRow | undefined;
  }

  private requireDeliveryClaimLease(row: DeliveryRow, fence: DeliveryClaimFence): DeliveryClaimLease {
    const lease = this.findDeliveryClaimLease(row.event_id);
    if (
      !lease ||
      lease.request_id !== row.request_id ||
      lease.owner_instance_id !== fence.ownerInstanceId ||
      lease.claim_generation !== fence.claimGeneration ||
      !isDeliveryClaimLeaseState(lease.state) ||
      !Number.isSafeInteger(lease.heartbeat_at) ||
      !Number.isSafeInteger(lease.lease_expires_at) ||
      !Number.isSafeInteger(lease.terminal_replay_count) ||
      lease.heartbeat_at < 0 ||
      lease.lease_expires_at < 0 ||
      lease.terminal_replay_count < 0
    ) {
      throw new DeliveryClaimFenceError(fence.eventId);
    }
    return Object.freeze({
      eventId: lease.event_id,
      requestId: lease.request_id,
      ownerInstanceId: lease.owner_instance_id,
      claimGeneration: lease.claim_generation,
      state: lease.state,
      heartbeatAt: lease.heartbeat_at,
      leaseExpiresAt: lease.lease_expires_at,
      terminalReplayCount: lease.terminal_replay_count
    });
  }

  private isNegotiatedDelivery(row: DeliveryRow): boolean {
    return (
      row.protocol_version === ACP_OUTBOX_CAPABILITY_VERSION &&
      row.protocol_semantics === ACP_OUTBOX_DELIVERY_SEMANTICS
    );
  }

  private toClaimedDelivery(row: DeliveryRow): ClaimedDelivery {
    if (
      row.state !== "claimed" ||
      !row.nonce ||
      !row.ciphertext ||
      !row.auth_tag ||
      row.key_version === null ||
      row.claim_owner_instance_id === null ||
      row.session_id === undefined
    ) {
      throw new DeliveryClaimFenceError(row.event_id);
    }
    const claimToken = this.deliveryClaimToken(row);
    const payload = this.decrypt(
      { nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag },
      this.deliveryAad(row.event_id, row.request_id, row.key_version)
    );
    return Object.freeze({
      eventId: row.event_id,
      requestId: row.request_id,
      sessionId: row.session_id,
      payload,
      sequence: row.sequence,
      ownerInstanceId: row.claim_owner_instance_id,
      claimGeneration: row.claim_generation,
      claimToken,
      metadata: createOutboxEventMetadata({
        v: ACP_OUTBOX_CAPABILITY_VERSION,
        eventId: row.event_id,
        sequence: row.sequence,
        claimGeneration: row.claim_generation,
        claimToken
      })
    });
  }

  private assertDeliveryClaim(row: DeliveryRow, fence: DeliveryClaimFence): void {
    if (
      row.event_id !== fence.eventId ||
      row.claim_owner_instance_id === null ||
      row.claim_owner_instance_id !== fence.ownerInstanceId ||
      row.claim_generation !== fence.claimGeneration ||
      !sameHmac(this.deliveryClaimToken(row), fence.claimToken)
    ) {
      throw new DeliveryClaimFenceError(fence.eventId);
    }
  }

  private deliveryClaimToken(row: DeliveryRow): string {
    if (row.claim_owner_instance_id === null || row.session_id === undefined) {
      throw new DeliveryClaimFenceError(row.event_id);
    }
    return this.claimHmac("delivery", [
      row.event_id,
      row.request_id,
      row.session_id,
      row.sequence,
      row.protocol_version,
      row.protocol_semantics,
      row.claim_owner_instance_id,
      row.claim_generation
    ]);
  }

  private markDeliveryRecovery(eventId: string, now: number, fence: DeliveryClaimFence | null): void {
    const row = this.requireDelivery(eventId);
    const fromState: SanitizedEventState =
      fence === null ? "pending" : (this.findDeliveryClaimLease(eventId)?.state ?? "claimed");
    const statement =
      fence === null
        ? `UPDATE delivery_outbox
           SET state = 'recovery_required', nonce = NULL, ciphertext = NULL, auth_tag = NULL, settled_at = ?
           WHERE event_id = ? AND state = 'pending'`
        : `UPDATE delivery_outbox
           SET state = 'recovery_required', nonce = NULL, ciphertext = NULL, auth_tag = NULL, settled_at = ?
           WHERE event_id = ? AND state = 'claimed' AND claim_owner_instance_id = ? AND claim_generation = ?`;
    const result =
      fence === null
        ? this.#db.prepare(statement).run(now, eventId)
        : this.#db.prepare(statement).run(now, eventId, fence.ownerInstanceId, fence.claimGeneration);
    if (fence === null) {
      if (result.changes === 1) {
        this.journalTransition("delivery_recovery_required", row.request_id, "pending", "recovery_required", now);
      }
      return;
    }
    if (result.changes !== 1) throw new DeliveryClaimFenceError(eventId);
    const settled = this.#db
      .prepare(
        `UPDATE delivery_claim_leases
         SET state = 'recovery_required', settled_at = ?, updated_at = ?
         WHERE event_id = ? AND owner_instance_id = ? AND claim_generation = ?
           AND state IN ('claimed', 'replay_reserved')`
      )
      .run(now, now, eventId, fence.ownerInstanceId, fence.claimGeneration);
    if (settled.changes !== 1) throw new DeliveryClaimFenceError(eventId);
    this.journalTransition("delivery_recovery_required", row.request_id, fromState, "recovery_required", now);
  }

  private sweepClaimedDeliveryToRecovery(
    eventId: string,
    now: number,
    lease: { ownerInstanceId: string; claimGeneration: number; state: DeliveryClaimLeaseState } | null
  ): boolean {
    const row = this.requireDelivery(eventId);
    const recovered = this.#db
      .prepare(
        `UPDATE delivery_outbox
         SET state = 'recovery_required', nonce = NULL, ciphertext = NULL, auth_tag = NULL, settled_at = ?
         WHERE event_id = ? AND state = 'claimed'`
      )
      .run(now, eventId);
    if (recovered.changes !== 1) return false;
    if (lease !== null) {
      this.#db
        .prepare(
          `UPDATE delivery_claim_leases
           SET state = 'recovery_required', settled_at = ?, updated_at = ?
           WHERE event_id = ? AND owner_instance_id = ? AND claim_generation = ?`
        )
        .run(now, now, eventId, lease.ownerInstanceId, lease.claimGeneration);
    }
    this.journalTransition(
      "delivery_recovery_required",
      row.request_id,
      "claimed",
      "recovery_required",
      now
    );
    return true;
  }

  private markClaimedDeliveryRecovery(row: DeliveryRow, now: number): void {
    if (row.claim_owner_instance_id === null) return;
    const fence: DeliveryClaimFence = {
      eventId: row.event_id,
      ownerInstanceId: row.claim_owner_instance_id,
      claimGeneration: row.claim_generation,
      claimToken: this.deliveryClaimToken(row)
    };
    this.transaction(() => this.markDeliveryRecovery(row.event_id, now, fence));
  }

  private requireCurrentRecoveryClaim(claim: RecoveryClaimToken): RecoveryClaimToken {
    const row = this.#db
      .prepare(
        `SELECT lease_id, request_id, lease_generation, recovery_generation, claimant_instance_id, prior_phase, state
         FROM recovery_claims WHERE lease_id = ?`
      )
      .get(claim.leaseId) as RecoveryClaimRow | undefined;
    if (!row || row.state !== "claimed" || !sameRecoveryClaim(recoveryClaimToken(row), claim)) {
      throw new RecoveryClaimFenceError(claim.leaseId);
    }
    return recoveryClaimToken(row);
  }

  private hasRecoveryAttestations(plan: Extract<RecoveryResolutionPlan, { accepted: true }>): boolean {
    const actor = this.recoveryHmac("actor", [plan.claim]);
    const evidence = this.recoveryHmac("evidence", [plan.claim, plan.action, plan.evidenceCode, plan.reasonCode]);
    return sameHmac(actor, plan.actorHmac) && sameHmac(evidence, plan.evidenceHmac);
  }

  private recoveryHmac(label: "actor" | "evidence", values: readonly unknown[]): string {
    return this.claimHmac(`recovery:${label}`, values);
  }

  private claimHmac(domain: string, values: readonly unknown[]): string {
    return createHmac("sha256", this.requireClaimTokenKey())
      .update(JSON.stringify(["paseo-agy-acp", "admission-claim", 1, domain, values]), "utf8")
      .digest("hex");
  }

  private isPreDispatchRecoveryLease(leaseId: string): boolean {
    const row = this.#db
      .prepare("SELECT prior_phase FROM recovery_claims WHERE lease_id = ? AND state = 'claimed'")
      .get(leaseId) as { prior_phase: RequestState } | undefined;
    return row?.prior_phase === "admitted" || row?.prior_phase === "starting";
  }

  private requireEncryptionKey(): Buffer {
    if (!this.#encryptionKey) throw new Error("payload persistence requires an encryption key");
    return this.#encryptionKey;
  }

  private requireClaimTokenKey(): Buffer {
    if (!this.#claimTokenKey) throw new Error("delivery and recovery claims require a claim token key");
    return this.#claimTokenKey;
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

  private deliveryAad(eventId: string, requestId: string, keyVersion: number): string {
    return JSON.stringify(["paseo-agy-acp", "delivery", 1, eventId, requestId, keyVersion]);
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
  transitionSignature("request_recovery_requeued", "recovery_required", "queued"),
  transitionSignature("request_recovery_completed", "recovery_required", "completed"),
  transitionSignature("request_recovery_cancelled", "recovery_required", "cancelled"),
  transitionSignature("request_recovery_unknown_released", "recovery_required", "recovery_resolved"),
  transitionSignature("delivery_enqueued", "absent", "pending"),
  transitionSignature("delivery_claimed", "pending", "claimed"),
  transitionSignature("delivery_replay_reserved", "claimed", "replay_reserved"),
  transitionSignature("delivery_delivered", "claimed", "delivered"),
  transitionSignature("delivery_delivered", "replay_reserved", "delivered"),
  transitionSignature("delivery_recovery_required", "pending", "recovery_required"),
  transitionSignature("delivery_recovery_required", "claimed", "recovery_required"),
  transitionSignature("delivery_recovery_required", "replay_reserved", "recovery_required")
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
    value === "request_queue_timed_out" ||
    value === "request_admitted" ||
    value === "request_starting" ||
    value === "request_dispatch_intent" ||
    value === "request_active" ||
    value === "request_dispatch_ambiguous" ||
    value === "request_provider_terminal" ||
    value === "request_released" ||
    value === "request_recovery_required" ||
    value === "request_recovery_requeued" ||
    value === "request_recovery_completed" ||
    value === "request_recovery_cancelled" ||
    value === "request_recovery_unknown_released" ||
    value === "delivery_enqueued" ||
    value === "delivery_claimed" ||
    value === "delivery_replay_reserved" ||
    value === "delivery_delivered" ||
    value === "delivery_recovery_required"
  );
}

function isSanitizedEventState(value: unknown): value is SanitizedEventState {
  if (value === "absent" || value === "pending" || isDeliveryClaimLeaseState(value)) return true;
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

function validateAtomicDeliveryClaimInput(input: AtomicDeliveryClaimInput): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("atomic delivery claim input must be an object");
  }
  validateIdentifier(input.eventId, "delivery event ID");
  validateIdentifier(input.ownerInstanceId, "delivery claim owner");
  validateTimestamp(input.now, "delivery claim timestamp");
  validateDeliveryClaimLeaseMs(input.leaseMs);
}

function validateDeliveryClaimFence(fence: DeliveryClaimFence): void {
  if (typeof fence !== "object" || fence === null || Array.isArray(fence)) {
    throw new DeliveryClaimFenceError("unknown");
  }
  validateIdentifier(fence.eventId, "delivery event ID");
  validateIdentifier(fence.ownerInstanceId, "delivery claim owner");
  if (!Number.isSafeInteger(fence.claimGeneration) || fence.claimGeneration < 1) {
    throw new DeliveryClaimFenceError(fence.eventId);
  }
  if (typeof fence.claimToken !== "string" || !/^[0-9a-f]{64}$/.test(fence.claimToken)) {
    throw new DeliveryClaimFenceError(fence.eventId);
  }
}

function validateDeliveryClaimLeaseMs(leaseMs: unknown): asserts leaseMs is number {
  if (typeof leaseMs !== "number" || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new Error("delivery claim lease duration must be a positive safe integer");
  }
}

function deliveryClaimLeaseExpiry(now: number, leaseMs: number): number {
  const expiry = now + leaseMs;
  if (!Number.isSafeInteger(expiry)) throw new Error("delivery claim lease expiry exceeds safe integer range");
  return expiry;
}

function validateTerminalReplayReservationInput(input: TerminalReplayReservationInput): void {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("terminal replay reservation input must be an object");
  }
  validateIdentifier(input.requestId, "terminal replay request ID");
  validateIdentifier(input.ownerInstanceId, "terminal replay owner");
  validateDeliveryClaimFence(input.fence);
  validateTimestamp(input.now, "terminal replay timestamp");
}

function isDeliveryClaimLeaseState(value: unknown): value is DeliveryClaimLeaseState {
  return value === "claimed" || value === "replay_reserved" || value === "delivered" || value === "recovery_required";
}

function isActiveDeliveryClaimLeaseState(value: DeliveryClaimLeaseState): value is "claimed" | "replay_reserved" {
  return value === "claimed" || value === "replay_reserved";
}

function recoverableOutboxClaim(row: RecoverableOutboxClaimRow): DeliveryClaimLease {
  try {
    validateIdentifier(row.lease_event_id, "recoverable outbox lease event ID");
    validateIdentifier(row.lease_request_id, "recoverable outbox lease request ID");
    validateIdentifier(row.lease_owner_instance_id, "recoverable outbox lease owner");
    validateIdentifier(row.outbox_event_id, "recoverable outbox event ID");
    validateIdentifier(row.outbox_request_id, "recoverable outbox request ID");
    validateIdentifier(row.outbox_owner_instance_id, "recoverable outbox owner");
    validateTimestamp(row.lease_heartbeat_at, "recoverable outbox heartbeat");
    validateTimestamp(row.lease_expires_at, "recoverable outbox lease expiry");
  } catch {
    throw new RecoverableOutboxClaimInventoryError();
  }

  const state = row.lease_state;
  const generation = row.lease_claim_generation;
  const outboxGeneration = row.outbox_claim_generation;
  const replayCount = row.lease_terminal_replay_count;
  const expectedOutboxState = state === "recovery_required" ? "recovery_required" : "claimed";
  if (
    (state !== "claimed" && state !== "replay_reserved" && state !== "recovery_required") ||
    row.outbox_state !== expectedOutboxState ||
    row.lease_event_id !== row.outbox_event_id ||
    row.lease_request_id !== row.outbox_request_id ||
    row.lease_owner_instance_id !== row.outbox_owner_instance_id ||
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    outboxGeneration !== generation ||
    typeof replayCount !== "number" ||
    !Number.isSafeInteger(replayCount) ||
    replayCount < 0 ||
    replayCount > 1 ||
    (state === "claimed" && replayCount !== 0) ||
    (state === "replay_reserved" && replayCount !== 1) ||
    (row.lease_expires_at as number) <= (row.lease_heartbeat_at as number)
  ) {
    throw new RecoverableOutboxClaimInventoryError();
  }

  return Object.freeze({
    eventId: row.lease_event_id,
    requestId: row.lease_request_id,
    ownerInstanceId: row.lease_owner_instance_id,
    claimGeneration: generation,
    state,
    heartbeatAt: row.lease_heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
    terminalReplayCount: replayCount
  });
}

function sameRecoverableOutboxClaim(left: DeliveryClaimLease, right: DeliveryClaimLease): boolean {
  return (
    left.eventId === right.eventId &&
    left.requestId === right.requestId &&
    left.ownerInstanceId === right.ownerInstanceId &&
    left.claimGeneration === right.claimGeneration &&
    left.state === right.state &&
    left.heartbeatAt === right.heartbeatAt &&
    left.leaseExpiresAt === right.leaseExpiresAt &&
    left.terminalReplayCount === right.terminalReplayCount
  );
}

function validateFaultInjection(value: unknown): AdmissionControllerFaultInjection | undefined {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("fault injection must be an object");
    }
    const callbacks = value as {
      afterProcessIdentityPersisted?: unknown;
      afterProviderTerminalOutboxPersisted?: unknown;
      afterDeliveryOutboxSettled?: unknown;
    };
    const callback = (value: unknown): (() => void) | undefined => {
      if (value === undefined) return undefined;
      if (typeof value !== "function") {
        throw new Error("fault injection callback must be a function");
      }
      return value as () => void;
    };
    const afterProcessIdentityPersisted = callback(callbacks.afterProcessIdentityPersisted);
    const afterProviderTerminalOutboxPersisted = callback(callbacks.afterProviderTerminalOutboxPersisted);
    const afterDeliveryOutboxSettled = callback(callbacks.afterDeliveryOutboxSettled);
    return Object.freeze({
      afterProcessIdentityPersisted:
        afterProcessIdentityPersisted === undefined ? undefined : () => afterProcessIdentityPersisted(),
      afterProviderTerminalOutboxPersisted:
        afterProviderTerminalOutboxPersisted === undefined ? undefined : () => afterProviderTerminalOutboxPersisted(),
      afterDeliveryOutboxSettled:
        afterDeliveryOutboxSettled === undefined ? undefined : () => afterDeliveryOutboxSettled()
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
    const terminalOutcome = normalizeLeaseTerminalOutcome(row.lease_terminal_outcome);
    validateTimestamp(row.lease_heartbeat_at, "recoverable dispatch heartbeat");
    validateTimestamp(row.request_enqueued_at, "recoverable dispatch enqueue timestamp");

    if (leaseRequestId !== requestId || requestLeaseGeneration !== fence.generation) {
      throw new Error("lease/request fence mismatch");
    }

    const processIdentity = toRecoverableDispatchProcessIdentity(row, requestId, fence);
    if (processIdentity !== null && (phase === "admitted" || phase === "starting")) {
      throw new Error("process identity predates dispatch intent");
    }

    if (phase === "provider_terminal") {
      if (requestState !== "provider_terminal" || terminalOutcome === null) {
        throw new Error("terminal lease/request state mismatch");
      }
      return null;
    }
    if (!isRecoverableDispatchPhase(phase) || requestState !== phase || terminalOutcome !== null) {
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
    case "recovery_resolved":
      return value;
    default:
      throw new Error("request state is invalid");
  }
}

function normalizeLeaseTerminalOutcome(value: unknown): "completed" | "failed" | "cancelled" | null {
  if (value === null || value === "completed" || value === "failed" || value === "cancelled") return value;
  throw new Error("lease terminal outcome is invalid");
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

function isNegotiatedOutboxProtocol(value: unknown): value is OutboxCapability {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const record = value as Record<string, unknown>;
    const fields = Object.getOwnPropertyNames(record);
    if (
      Object.getOwnPropertySymbols(record).length !== 0 ||
      fields.length !== 4 ||
      !fields.includes("key") ||
      !fields.includes("version") ||
      !fields.includes("semantics") ||
      !fields.includes("ackMethod")
    ) {
      return false;
    }
    const entries = fields.map((field) => [field, Object.getOwnPropertyDescriptor(record, field)] as const);
    if (entries.some(([, descriptor]) => descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))) {
      return false;
    }
    const values = Object.fromEntries(entries.map(([field, descriptor]) => [field, descriptor!.value]));
    return (
      values.key === ACP_OUTBOX_CAPABILITY.key &&
      values.version === ACP_OUTBOX_CAPABILITY.version &&
      values.semantics === ACP_OUTBOX_CAPABILITY.semantics &&
      values.ackMethod === ACP_OUTBOX_CAPABILITY.ackMethod
    );
  } catch {
    return false;
  }
}

function sameHmac(expected: string, candidate: unknown): boolean {
  if (typeof candidate !== "string" || !/^[0-9a-f]{64}$/.test(candidate) || !/^[0-9a-f]{64}$/.test(expected)) {
    return false;
  }
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(candidate, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function recoveryClaimToken(row: RecoveryClaimRow): RecoveryClaimToken {
  return Object.freeze({
    requestId: row.request_id,
    leaseId: row.lease_id,
    leaseGeneration: row.lease_generation,
    recoveryGeneration: row.recovery_generation,
    claimantInstanceId: row.claimant_instance_id
  });
}

function sameRecoveryClaim(left: RecoveryClaimToken, right: RecoveryClaimToken): boolean {
  return (
    left.requestId === right.requestId &&
    left.leaseId === right.leaseId &&
    left.leaseGeneration === right.leaseGeneration &&
    left.recoveryGeneration === right.recoveryGeneration &&
    left.claimantInstanceId === right.claimantInstanceId
  );
}

function rejectedRecoveryPlan(
  rejectionCode: "invalid_resolution" | "claim_mismatch" | "evidence_mismatch"
): RecoveryResolutionPlan {
  return Object.freeze({ accepted: false, nextState: "recovery_required", rejectionCode });
}

function validatePurposeKey(
  key: Buffer | undefined,
  purpose: "encryption" | "content fingerprint" | "claim token"
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
