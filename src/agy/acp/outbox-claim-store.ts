import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import Database from "better-sqlite3";
import type { ClaimedDelivery, DeliveryClaimFence } from "../../admission/controller.js";
import { createOutboxEventMetadata, validateOutboxAck, type OutboxAck } from "../../admission/outbox-protocol.js";

const TOKEN_NONCE_BYTES = 12;

export type OutboxClaimState =
  | "claimed"
  | "replay_reserved"
  | "replay_sent"
  | "orphaned"
  | "acknowledged"
  | "recovery_required"
  | "ambiguous";

export interface OutboxClaimRecord {
  readonly eventId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly fence: DeliveryClaimFence;
  readonly state: OutboxClaimState;
  readonly heartbeatAt: number;
  readonly leaseExpiresAt: number;
  readonly terminalReplayCount: number;
}

export interface OutboxReconnectReplayInput {
  readonly eventId: string;
  readonly requestId: string;
  readonly ownerInstanceId: string;
  readonly now: number;
}

/** @deprecated Controller-owned delivery claim leases are the only durable authority. */
export interface OutboxClaimStore {
  recordClaim(claim: ClaimedDelivery, now: number, leaseMs: number): OutboxClaimRecord;
  heartbeat(fence: DeliveryClaimFence, now: number, leaseMs: number): OutboxClaimRecord;
  reserveReconnectReplay(input: OutboxReconnectReplayInput): OutboxClaimRecord | null;
  markReplaySent(fence: DeliveryClaimFence, now: number): void;
  acknowledge(acknowledgement: OutboxAck, now: number): void;
  markRecoveryRequired(fence: DeliveryClaimFence, now: number): void;
  markAmbiguous(fence: DeliveryClaimFence, now: number): void;
  sweepExpired(now: number): readonly OutboxClaimRecord[];
}

export interface SqliteOutboxClaimStoreOptions {
  readonly databasePath: string;
  /** Purpose-separated 32-byte key; never write this key or a plaintext fence token. */
  readonly encryptionKey: Buffer;
}

export class OutboxClaimStoreFenceError extends Error {
  constructor() {
    super("outbox claim lease does not match its active fence");
    this.name = "OutboxClaimStoreFenceError";
  }
}

export class OutboxClaimStoreIntegrityError extends Error {
  constructor() {
    super("outbox claim lease cannot be verified");
    this.name = "OutboxClaimStoreIntegrityError";
  }
}

interface StoredClaimRow {
  event_id: string;
  request_id: string;
  session_id: string;
  owner_instance_id: string;
  claim_generation: number;
  claim_token_nonce: Buffer;
  claim_token_ciphertext: Buffer;
  claim_token_auth_tag: Buffer;
  state: OutboxClaimState;
  heartbeat_at: number;
  lease_expires_at: number;
  terminal_replay_count: number;
}

interface ClaimIdentity {
  readonly eventId: string;
  readonly requestId: string;
  readonly sessionId: string;
  readonly fence: DeliveryClaimFence;
}

/**
 * @deprecated Controller-owned delivery claim leases are the only durable authority.
 *
 * Experimental, non-authoritative claim state for the ACP delivery bridge.
 * It deliberately does not own `delivery_outbox`, so it cannot enumerate a
 * controller-only claim or atomically settle an ACK. It is not a crash-safety
 * primitive or an acceptance condition for durable delivery.
 */
export class SqliteOutboxClaimStore implements OutboxClaimStore {
  readonly databasePath: string;
  readonly #db: Database.Database;
  readonly #encryptionKey: Buffer;
  #closed = false;

  constructor(options: SqliteOutboxClaimStoreOptions) {
    if (typeof options.databasePath !== "string" || options.databasePath.length === 0) {
      throw new OutboxClaimStoreIntegrityError();
    }
    if (!Buffer.isBuffer(options.encryptionKey) || options.encryptionKey.length !== 32) {
      throw new OutboxClaimStoreIntegrityError();
    }

    this.databasePath = options.databasePath;
    this.#encryptionKey = Buffer.from(options.encryptionKey);
    this.#db = new Database(options.databasePath);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = FULL");
    this.#db.pragma("busy_timeout = 5000");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS acp_outbox_claim_leases (
        event_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        owner_instance_id TEXT NOT NULL,
        claim_generation INTEGER NOT NULL,
        claim_token_nonce BLOB NOT NULL,
        claim_token_ciphertext BLOB NOT NULL,
        claim_token_auth_tag BLOB NOT NULL,
        state TEXT NOT NULL CHECK (state IN (
          'claimed', 'replay_reserved', 'replay_sent', 'orphaned',
          'acknowledged', 'recovery_required', 'ambiguous'
        )),
        heartbeat_at INTEGER NOT NULL,
        lease_expires_at INTEGER NOT NULL,
        terminal_replay_count INTEGER NOT NULL DEFAULT 0,
        replay_reserved_at INTEGER,
        settled_at INTEGER,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS acp_outbox_claim_leases_expiry
        ON acp_outbox_claim_leases (state, lease_expires_at);
    `);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
    this.#encryptionKey.fill(0);
  }

  recordClaim(claim: ClaimedDelivery, now: number, leaseMs: number): OutboxClaimRecord {
    this.assertOpen();
    const identity = claimIdentity(claim);
    validateTime(now);
    validateLease(leaseMs);
    const leaseExpiresAt = now + leaseMs;
    if (!Number.isSafeInteger(leaseExpiresAt)) throw new OutboxClaimStoreFenceError();

    return this.#db.transaction(() => {
      const existing = this.findRow(identity.eventId);
      if (existing) {
        const record = this.toRecord(existing);
        if (!sameIdentity(record, identity) || record.state !== "claimed" || record.leaseExpiresAt <= now) {
          throw new OutboxClaimStoreFenceError();
        }
        const result = this.#db
          .prepare(
            `UPDATE acp_outbox_claim_leases
             SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
             WHERE event_id = ? AND state = 'claimed' AND owner_instance_id = ? AND claim_generation = ?`
          )
          .run(now, leaseExpiresAt, now, identity.eventId, identity.fence.ownerInstanceId, identity.fence.claimGeneration);
        if (result.changes !== 1) throw new OutboxClaimStoreFenceError();
        return this.requireRecord(identity.eventId);
      }

      const sealed = this.sealToken(identity);
      this.#db
        .prepare(
          `INSERT INTO acp_outbox_claim_leases (
             event_id, request_id, session_id, owner_instance_id, claim_generation,
             claim_token_nonce, claim_token_ciphertext, claim_token_auth_tag,
             state, heartbeat_at, lease_expires_at, terminal_replay_count, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, 0, ?)`
        )
        .run(
          identity.eventId,
          identity.requestId,
          identity.sessionId,
          identity.fence.ownerInstanceId,
          identity.fence.claimGeneration,
          sealed.nonce,
          sealed.ciphertext,
          sealed.authTag,
          now,
          leaseExpiresAt,
          now
        );
      return this.requireRecord(identity.eventId);
    })();
  }

  heartbeat(fence: DeliveryClaimFence, now: number, leaseMs: number): OutboxClaimRecord {
    this.assertOpen();
    validateFence(fence);
    validateTime(now);
    validateLease(leaseMs);
    const leaseExpiresAt = now + leaseMs;
    if (!Number.isSafeInteger(leaseExpiresAt)) throw new OutboxClaimStoreFenceError();

    return this.#db.transaction(() => {
      const record = this.requireRecord(fence.eventId);
      if (
        !sameFence(record.fence, fence) ||
        (record.state !== "claimed" && record.state !== "replay_sent") ||
        record.leaseExpiresAt <= now
      ) {
        throw new OutboxClaimStoreFenceError();
      }
      const result = this.#db
        .prepare(
          `UPDATE acp_outbox_claim_leases
           SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
           WHERE event_id = ? AND owner_instance_id = ? AND claim_generation = ?
             AND state IN ('claimed', 'replay_sent') AND lease_expires_at > ?`
        )
        .run(now, leaseExpiresAt, now, fence.eventId, fence.ownerInstanceId, fence.claimGeneration, now);
      if (result.changes !== 1) throw new OutboxClaimStoreFenceError();
      return this.requireRecord(fence.eventId);
    })();
  }

  reserveReconnectReplay(input: OutboxReconnectReplayInput): OutboxClaimRecord | null {
    this.assertOpen();
    validateIdentifier(input.eventId);
    validateIdentifier(input.requestId);
    validateIdentifier(input.ownerInstanceId);
    validateTime(input.now);

    return this.#db.transaction(() => {
      const row = this.findRow(input.eventId);
      if (!row) return null;
      const record = this.toRecord(row);
      if (
        record.requestId !== input.requestId ||
        record.fence.ownerInstanceId !== input.ownerInstanceId ||
        record.state !== "claimed" ||
        record.terminalReplayCount !== 0 ||
        record.leaseExpiresAt <= input.now
      ) {
        return null;
      }
      const result = this.#db
        .prepare(
          `UPDATE acp_outbox_claim_leases
           SET state = 'replay_reserved', terminal_replay_count = 1, replay_reserved_at = ?, updated_at = ?
           WHERE event_id = ? AND request_id = ? AND owner_instance_id = ?
             AND state = 'claimed' AND terminal_replay_count = 0 AND lease_expires_at > ?`
        )
        .run(input.now, input.now, input.eventId, input.requestId, input.ownerInstanceId, input.now);
      return result.changes === 1 ? this.requireRecord(input.eventId) : null;
    })();
  }

  markReplaySent(fence: DeliveryClaimFence, now: number): void {
    this.assertOpen();
    validateFence(fence);
    validateTime(now);
    this.#db.transaction(() => {
      const record = this.requireRecord(fence.eventId);
      if (!sameFence(record.fence, fence)) throw new OutboxClaimStoreFenceError();
      if (record.state === "acknowledged") return;
      if (record.state !== "replay_reserved") throw new OutboxClaimStoreFenceError();
      const result = this.#db
        .prepare(
          `UPDATE acp_outbox_claim_leases
           SET state = 'replay_sent', updated_at = ?
           WHERE event_id = ? AND owner_instance_id = ? AND claim_generation = ? AND state = 'replay_reserved'`
        )
        .run(now, fence.eventId, fence.ownerInstanceId, fence.claimGeneration);
      if (result.changes !== 1) throw new OutboxClaimStoreFenceError();
    })();
  }

  acknowledge(input: OutboxAck, now: number): void {
    this.assertOpen();
    validateTime(now);
    const acknowledgement = validateOutboxAck(input);
    this.#db.transaction(() => {
      const record = this.requireRecord(acknowledgement.eventId);
      if (
        record.sessionId !== acknowledgement.sessionId ||
        record.fence.claimGeneration !== acknowledgement.claimGeneration ||
        !sameToken(record.fence.claimToken, acknowledgement.claimToken)
      ) {
        throw new OutboxClaimStoreFenceError();
      }
      if (record.state === "acknowledged") return;
      if (record.state !== "claimed" && record.state !== "replay_reserved" && record.state !== "replay_sent") {
        throw new OutboxClaimStoreFenceError();
      }
      const result = this.#db
        .prepare(
          `UPDATE acp_outbox_claim_leases
           SET state = 'acknowledged', settled_at = ?, updated_at = ?
           WHERE event_id = ? AND owner_instance_id = ? AND claim_generation = ?
             AND state IN ('claimed', 'replay_reserved', 'replay_sent')`
        )
        .run(now, now, acknowledgement.eventId, record.fence.ownerInstanceId, acknowledgement.claimGeneration);
      if (result.changes !== 1) throw new OutboxClaimStoreFenceError();
    })();
  }

  markRecoveryRequired(fence: DeliveryClaimFence, now: number): void {
    this.transitionFence(fence, now, "recovery_required", ["claimed", "replay_reserved", "replay_sent", "orphaned"]);
  }

  markAmbiguous(fence: DeliveryClaimFence, now: number): void {
    this.assertOpen();
    validateFence(fence);
    validateTime(now);
    this.#db.transaction(() => {
      const record = this.requireRecord(fence.eventId);
      if (!sameFence(record.fence, fence)) throw new OutboxClaimStoreFenceError();
      if (record.state === "acknowledged" || record.state === "ambiguous") return;
      const result = this.#db
        .prepare(
          `UPDATE acp_outbox_claim_leases
           SET state = 'ambiguous', updated_at = ?
           WHERE event_id = ? AND owner_instance_id = ? AND claim_generation = ? AND state != 'acknowledged'`
        )
        .run(now, fence.eventId, fence.ownerInstanceId, fence.claimGeneration);
      if (result.changes !== 1) throw new OutboxClaimStoreFenceError();
    })();
  }

  sweepExpired(now: number): readonly OutboxClaimRecord[] {
    this.assertOpen();
    validateTime(now);
    return this.#db.transaction(() => {
      const rows = this.#db
        .prepare(
          `SELECT event_id, request_id, session_id, owner_instance_id, claim_generation,
                  claim_token_nonce, claim_token_ciphertext, claim_token_auth_tag,
                  state, heartbeat_at, lease_expires_at, terminal_replay_count
           FROM acp_outbox_claim_leases
           WHERE state IN ('claimed', 'replay_reserved', 'replay_sent') AND lease_expires_at <= ?
           ORDER BY event_id ASC`
        )
        .all(now) as StoredClaimRow[];
      const expired: OutboxClaimRecord[] = [];
      for (const row of rows) {
        let record: OutboxClaimRecord;
        try {
          record = this.toRecord(row);
        } catch {
          this.#db
            .prepare(
              `UPDATE acp_outbox_claim_leases
               SET state = 'ambiguous', updated_at = ?
               WHERE event_id = ? AND state IN ('claimed', 'replay_reserved', 'replay_sent') AND lease_expires_at <= ?`
            )
            .run(now, row.event_id, now);
          continue;
        }
        const result = this.#db
          .prepare(
            `UPDATE acp_outbox_claim_leases
             SET state = 'orphaned', updated_at = ?
             WHERE event_id = ? AND owner_instance_id = ? AND claim_generation = ?
               AND state = ? AND lease_expires_at <= ?`
          )
          .run(now, record.eventId, record.fence.ownerInstanceId, record.fence.claimGeneration, record.state, now);
        if (result.changes === 1) expired.push(record);
      }
      return Object.freeze(expired);
    })();
  }

  private transitionFence(
    fence: DeliveryClaimFence,
    now: number,
    state: "recovery_required",
    allowedStates: readonly OutboxClaimState[]
  ): void {
    this.assertOpen();
    validateFence(fence);
    validateTime(now);
    this.#db.transaction(() => {
      const record = this.requireRecord(fence.eventId);
      if (!sameFence(record.fence, fence) || !allowedStates.includes(record.state)) {
        throw new OutboxClaimStoreFenceError();
      }
      const placeholders = allowedStates.map(() => "?").join(", ");
      const result = this.#db
        .prepare(
          `UPDATE acp_outbox_claim_leases
           SET state = ?, updated_at = ?
           WHERE event_id = ? AND owner_instance_id = ? AND claim_generation = ?
             AND state IN (${placeholders})`
        )
        .run(state, now, fence.eventId, fence.ownerInstanceId, fence.claimGeneration, ...allowedStates);
      if (result.changes !== 1) throw new OutboxClaimStoreFenceError();
    })();
  }

  private findRow(eventId: string): StoredClaimRow | undefined {
    return this.#db
      .prepare(
        `SELECT event_id, request_id, session_id, owner_instance_id, claim_generation,
                claim_token_nonce, claim_token_ciphertext, claim_token_auth_tag,
                state, heartbeat_at, lease_expires_at, terminal_replay_count
         FROM acp_outbox_claim_leases WHERE event_id = ?`
      )
      .get(eventId) as StoredClaimRow | undefined;
  }

  private requireRecord(eventId: string): OutboxClaimRecord {
    const row = this.findRow(eventId);
    if (!row) throw new OutboxClaimStoreFenceError();
    return this.toRecord(row);
  }

  private toRecord(row: StoredClaimRow): OutboxClaimRecord {
    const identity: ClaimIdentity = {
      eventId: row.event_id,
      requestId: row.request_id,
      sessionId: row.session_id,
      fence: {
        eventId: row.event_id,
        ownerInstanceId: row.owner_instance_id,
        claimGeneration: row.claim_generation,
        claimToken: ""
      }
    };
    const claimToken = this.openToken(identity, row);
    return Object.freeze({
      eventId: identity.eventId,
      requestId: identity.requestId,
      sessionId: identity.sessionId,
      fence: Object.freeze({ ...identity.fence, claimToken }),
      state: row.state,
      heartbeatAt: row.heartbeat_at,
      leaseExpiresAt: row.lease_expires_at,
      terminalReplayCount: row.terminal_replay_count
    });
  }

  private sealToken(identity: ClaimIdentity): { nonce: Buffer; ciphertext: Buffer; authTag: Buffer } {
    const nonce = randomBytes(TOKEN_NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#encryptionKey, nonce);
    cipher.setAAD(tokenAad(identity));
    return {
      nonce,
      ciphertext: Buffer.concat([cipher.update(identity.fence.claimToken, "utf8"), cipher.final()]),
      authTag: cipher.getAuthTag()
    };
  }

  private openToken(identity: ClaimIdentity, row: StoredClaimRow): string {
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#encryptionKey, row.claim_token_nonce);
      decipher.setAAD(tokenAad(identity));
      decipher.setAuthTag(row.claim_token_auth_tag);
      return Buffer.concat([decipher.update(row.claim_token_ciphertext), decipher.final()]).toString("utf8");
    } catch {
      throw new OutboxClaimStoreIntegrityError();
    }
  }

  private assertOpen(): void {
    if (this.#closed) throw new OutboxClaimStoreIntegrityError();
  }
}

function claimIdentity(claim: ClaimedDelivery): ClaimIdentity {
  const metadata = createOutboxEventMetadata(claim.metadata);
  validateIdentifier(claim.eventId);
  validateIdentifier(claim.requestId);
  validateIdentifier(claim.sessionId);
  validateFence({
    eventId: claim.eventId,
    ownerInstanceId: claim.ownerInstanceId,
    claimGeneration: claim.claimGeneration,
    claimToken: claim.claimToken
  });
  if (
    metadata.eventId !== claim.eventId ||
    metadata.claimGeneration !== claim.claimGeneration ||
    metadata.claimToken !== claim.claimToken
  ) {
    throw new OutboxClaimStoreFenceError();
  }
  return Object.freeze({
    eventId: claim.eventId,
    requestId: claim.requestId,
    sessionId: claim.sessionId,
    fence: Object.freeze({
      eventId: claim.eventId,
      ownerInstanceId: claim.ownerInstanceId,
      claimGeneration: claim.claimGeneration,
      claimToken: claim.claimToken
    })
  });
}

function validateFence(fence: DeliveryClaimFence): void {
  validateIdentifier(fence.eventId);
  validateIdentifier(fence.ownerInstanceId);
  validateIdentifier(fence.claimToken);
  if (!Number.isSafeInteger(fence.claimGeneration) || fence.claimGeneration < 0) {
    throw new OutboxClaimStoreFenceError();
  }
}

function validateIdentifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new OutboxClaimStoreFenceError();
  }
}

function validateTime(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new OutboxClaimStoreFenceError();
}

function validateLease(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new OutboxClaimStoreFenceError();
}

function sameIdentity(record: OutboxClaimRecord, identity: ClaimIdentity): boolean {
  return (
    record.eventId === identity.eventId &&
    record.requestId === identity.requestId &&
    record.sessionId === identity.sessionId &&
    sameFence(record.fence, identity.fence)
  );
}

function sameFence(left: DeliveryClaimFence, right: DeliveryClaimFence): boolean {
  return (
    left.eventId === right.eventId &&
    left.ownerInstanceId === right.ownerInstanceId &&
    left.claimGeneration === right.claimGeneration &&
    sameToken(left.claimToken, right.claimToken)
  );
}

function sameToken(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function tokenAad(identity: ClaimIdentity): Buffer {
  return Buffer.from(
    JSON.stringify([
      "paseo-agy-acp",
      "outbox-claim-store",
      1,
      identity.eventId,
      identity.requestId,
      identity.sessionId,
      identity.fence.ownerInstanceId,
      identity.fence.claimGeneration
    ]),
    "utf8"
  );
}
