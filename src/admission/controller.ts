import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";

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
  now: number;
  expiresAt: number;
}

export type RequestState =
  | "queued"
  | "admitted"
  | "starting"
  | "dispatch_intent"
  | "active"
  | "completed"
  | "queue_timeout"
  | "recovery_required";

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
}

export interface PendingDelivery {
  eventId: string;
  requestId: string;
  payload: string;
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
  phase: RequestState;
}

interface PayloadRow {
  nonce: Buffer;
  ciphertext: Buffer;
  auth_tag: Buffer;
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
  state: "pending" | "delivered" | "recovery_required";
  nonce: Buffer | null;
  ciphertext: Buffer | null;
  auth_tag: Buffer | null;
  expires_at: number;
}

export class AdmissionConflictError extends Error {
  constructor(requestId: string) {
    super(`request identity ${requestId} was reused with a different fingerprint`);
    this.name = "AdmissionConflictError";
  }
}

export class PayloadExpiredError extends Error {
  constructor(requestId: string) {
    super(`payload for request ${requestId} has expired`);
    this.name = "PayloadExpiredError";
  }
}

export class DeliveryConflictError extends Error {
  constructor(eventId: string) {
    super(`delivery event ${eventId} was reused with a different fingerprint`);
    this.name = "DeliveryConflictError";
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

  constructor(options: AdmissionControllerOptions) {
    this.databasePath = options.databasePath;
    this.policy = validatePolicy(options.policy);
    this.#encryptionKey = validateEncryptionKey(options.encryptionKey);
    this.#db = new Database(options.databasePath);
    this.#db.pragma("journal_mode = WAL");
    this.#db.pragma("synchronous = FULL");
    this.#db.pragma("busy_timeout = 5000");
    this.migrate();
  }

  close(): void {
    this.#db.close();
  }

  get schemaVersion(): number {
    const row = this.#db
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number | null };
    return row.version ?? 0;
  }

  enqueue(input: EnqueueRequest): { requestId: string; existed: boolean } {
    return this.transaction(() => {
      const existing = this.#db
        .prepare("SELECT fingerprint FROM turn_requests WHERE request_id = ?")
        .get(input.requestId) as { fingerprint: string } | undefined;
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) throw new AdmissionConflictError(input.requestId);
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
      return { requestId: input.requestId, existed: false };
    });
  }

  persistPayload(requestId: string, plaintext: string, now: number, expiresAt: number): void {
    if (!Number.isFinite(now) || !Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new Error("payload expiry must be after persistence time");
    }
    const encrypted = this.encrypt(plaintext);

    this.transaction(() => {
      this.requireRequest(requestId);
      this.#db
        .prepare(
          `INSERT INTO turn_payloads (request_id, nonce, ciphertext, auth_tag, key_version, expires_at, created_at)
           VALUES (?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(request_id) DO UPDATE SET
             nonce = excluded.nonce,
             ciphertext = excluded.ciphertext,
             auth_tag = excluded.auth_tag,
             key_version = excluded.key_version,
             expires_at = excluded.expires_at,
             created_at = excluded.created_at`
        )
        .run(requestId, encrypted.nonce, encrypted.ciphertext, encrypted.authTag, expiresAt, now);
    });
  }

  readPayload(requestId: string, now: number): string {
    const row = this.transaction(() => {
      const row = this.#db
        .prepare("SELECT nonce, ciphertext, auth_tag, expires_at FROM turn_payloads WHERE request_id = ?")
        .get(requestId) as PayloadRow | undefined;
      if (!row) throw new Error(`no payload is available for request ${requestId}`);
      if (row.expires_at <= now) {
        this.#db.prepare("DELETE FROM turn_payloads WHERE request_id = ?").run(requestId);
        return null;
      }
      return row;
    });
    if (!row) throw new PayloadExpiredError(requestId);

    return this.decrypt({ nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag });
  }

  enqueueDelivery(input: EnqueueDelivery): { eventId: string; existed: boolean } {
    if (!Number.isFinite(input.now) || !Number.isFinite(input.expiresAt) || input.expiresAt <= input.now) {
      throw new Error("delivery expiry must be after persistence time");
    }
    return this.transaction(() => {
      const existing = this.#db
        .prepare("SELECT fingerprint FROM delivery_outbox WHERE event_id = ?")
        .get(input.eventId) as { fingerprint: string } | undefined;
      if (existing) {
        if (existing.fingerprint !== input.fingerprint) throw new DeliveryConflictError(input.eventId);
        return { eventId: input.eventId, existed: true };
      }

      this.requireRequest(input.requestId);
      const encrypted = this.encrypt(input.payload);
      this.#db
        .prepare(
          `INSERT INTO delivery_outbox
            (event_id, request_id, fingerprint, state, nonce, ciphertext, auth_tag, expires_at, created_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
        )
        .run(
          input.eventId,
          input.requestId,
          input.fingerprint,
          encrypted.nonce,
          encrypted.ciphertext,
          encrypted.authTag,
          input.expiresAt,
          input.now
        );
      return { eventId: input.eventId, existed: false };
    });
  }

  readPendingDelivery(eventId: string, now: number): PendingDelivery | null {
    const row = this.transaction(() => {
      const row = this.#db
        .prepare(
          `SELECT event_id, request_id, fingerprint, state, nonce, ciphertext, auth_tag, expires_at
           FROM delivery_outbox WHERE event_id = ?`
        )
        .get(eventId) as DeliveryRow | undefined;
      if (!row || row.state !== "pending") return null;
      if (row.expires_at <= now) {
        this.#db
          .prepare(
            `UPDATE delivery_outbox
             SET state = 'recovery_required', nonce = NULL, ciphertext = NULL, auth_tag = NULL, settled_at = ?
             WHERE event_id = ?`
          )
          .run(now, eventId);
        return null;
      }
      return row;
    });
    if (!row) return null;
    if (!row.nonce || !row.ciphertext || !row.auth_tag) {
      throw new Error(`pending delivery ${eventId} has no encrypted payload`);
    }
    return {
      eventId: row.event_id,
      requestId: row.request_id,
      payload: this.decrypt({ nonce: row.nonce, ciphertext: row.ciphertext, authTag: row.auth_tag })
    };
  }

  acknowledgeDelivery(eventId: string, now: number): void {
    this.transaction(() => {
      const row = this.#db
        .prepare("SELECT state FROM delivery_outbox WHERE event_id = ?")
        .get(eventId) as { state: DeliveryRow["state"] } | undefined;
      if (!row) throw new Error(`unknown delivery event ${eventId}`);
      if (row.state === "recovery_required") {
        throw new Error(`delivery event ${eventId} requires recovery`);
      }
      this.#db
        .prepare(
          `UPDATE delivery_outbox
           SET state = 'delivered', nonce = NULL, ciphertext = NULL, auth_tag = NULL, settled_at = ?
           WHERE event_id = ?`
        )
        .run(now, eventId);
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
      return { leaseId, requestId: candidate.request_id, generation };
    });
  }

  markStarting(leaseId: string, now: number): void {
    this.transaction(() => {
      const lease = this.requireLease(leaseId);
      if (lease.phase !== "admitted") throw new Error(`lease ${leaseId} is not admitted`);
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
      this.#db.prepare("INSERT INTO start_history (lease_id, started_at) VALUES (?, ?)").run(leaseId, now);
      this.setLeasePhase(lease, "starting", now);
    });
  }

  markDispatchIntent(leaseId: string, now: number): void {
    this.transition(leaseId, "starting", "dispatch_intent", now);
  }

  markActive(leaseId: string, now: number): void {
    this.transition(leaseId, "dispatch_intent", "active", now);
  }

  heartbeat(leaseId: string, now: number): void {
    this.#db.prepare("UPDATE leases SET heartbeat_at = ? WHERE lease_id = ?").run(now, leaseId);
  }

  release(leaseId: string, now: number, outcome: "completed"): void {
    this.transaction(() => {
      const lease = this.requireLease(leaseId);
      this.#db
        .prepare("UPDATE turn_requests SET state = ?, terminal_at = ? WHERE request_id = ?")
        .run(outcome, now, lease.request_id);
      this.#db.prepare("DELETE FROM leases WHERE lease_id = ?").run(leaseId);
    });
  }

  recoverOwner(leaseId: string, now: number, ownerAlive: boolean): void {
    this.transaction(() => {
      const lease = this.requireLease(leaseId);
      if (ownerAlive) return;

      if (lease.phase === "starting") {
        this.#db
          .prepare("UPDATE turn_requests SET state = 'queued' WHERE request_id = ?")
          .run(lease.request_id);
        this.#db.prepare("DELETE FROM leases WHERE lease_id = ?").run(leaseId);
        return;
      }

      this.#db
        .prepare("UPDATE turn_requests SET state = 'recovery_required', terminal_at = ? WHERE request_id = ?")
        .run(now, lease.request_id);
      this.#db.prepare("UPDATE leases SET phase = 'recovery_required', heartbeat_at = ? WHERE lease_id = ?").run(now, leaseId);
    });
  }

  setCapacityCooldown(provider: string, model: string, notBefore: number, now: number): void {
    this.#db
      .prepare(
        `INSERT INTO cooldowns (provider, model, not_before, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(provider, model) DO UPDATE SET not_before = excluded.not_before, updated_at = excluded.updated_at`
      )
      .run(provider, model, notBefore, now);
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
      if (applied > 1) {
        throw new Error(`admission database schema version ${applied} is newer than this connector supports`);
      }
      if (applied === 1) return;

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
    });
  }

  private transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn)();
  }

  private expireQueued(now: number): void {
    this.#db
      .prepare("UPDATE turn_requests SET state = 'queue_timeout', terminal_at = ? WHERE state = 'queued' AND deadline_at <= ?")
      .run(now, now);
  }

  private activeLeaseCount(): number {
    const row = this.#db
      .prepare(
        `SELECT COUNT(*) AS count FROM leases
         WHERE phase IN ('admitted', 'starting', 'dispatch_intent', 'active', 'recovery_required')`
      )
      .get() as { count: number };
    return row.count;
  }

  private selectEligibleRequest(now: number): RequestRow | null {
    const rows = this.#db
      .prepare(
        `SELECT request_id, session_id, parent_id, fingerprint, provider, model, state, enqueued_at
         , lease_generation
         FROM turn_requests WHERE state = 'queued' ORDER BY enqueued_at ASC, request_id ASC`
      )
      .all() as RequestRow[];
    const activeParents = new Set(
      (this.#db
        .prepare(
          `SELECT DISTINCT request.parent_id AS parent_id
           FROM leases lease JOIN turn_requests request ON request.request_id = lease.request_id
           WHERE lease.phase IN ('admitted', 'starting', 'dispatch_intent', 'active', 'recovery_required')`
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

  private requireLease(leaseId: string): LeaseRow {
    const lease = this.#db
      .prepare("SELECT lease_id, request_id, generation, phase FROM leases WHERE lease_id = ?")
      .get(leaseId) as LeaseRow | undefined;
    if (!lease) throw new Error(`unknown lease ${leaseId}`);
    return lease;
  }

  private requireRequest(requestId: string): void {
    const row = this.#db.prepare("SELECT 1 FROM turn_requests WHERE request_id = ?").get(requestId);
    if (!row) throw new Error(`unknown request ${requestId}`);
  }

  private requireEncryptionKey(): Buffer {
    if (!this.#encryptionKey) throw new Error("payload persistence requires an encryption key");
    return this.#encryptionKey;
  }

  private encrypt(plaintext: string): EncryptedPayload {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.requireEncryptionKey(), nonce);
    return {
      nonce,
      ciphertext: Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]),
      authTag: cipher.getAuthTag()
    };
  }

  private decrypt(payload: EncryptedPayload): string {
    const decipher = createDecipheriv("aes-256-gcm", this.requireEncryptionKey(), payload.nonce);
    decipher.setAuthTag(payload.authTag);
    return Buffer.concat([decipher.update(payload.ciphertext), decipher.final()]).toString("utf8");
  }

  private transition(leaseId: string, expected: RequestState, next: RequestState, now: number): void {
    this.transaction(() => {
      const lease = this.requireLease(leaseId);
      if (lease.phase !== expected) throw new Error(`lease ${leaseId} is not ${expected}`);
      this.setLeasePhase(lease, next, now);
    });
  }

  private setLeasePhase(lease: LeaseRow, phase: RequestState, now: number): void {
    this.#db.prepare("UPDATE leases SET phase = ?, heartbeat_at = ? WHERE lease_id = ?").run(phase, now, lease.lease_id);
    this.#db.prepare("UPDATE turn_requests SET state = ? WHERE request_id = ?").run(phase, lease.request_id);
  }
}

function validatePolicy(policy: AdmissionPolicy): AdmissionPolicy {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value < 0 || (name.startsWith("max") && value < 1)) {
      throw new Error(`invalid admission policy ${name}`);
    }
  }
  return Object.freeze({ ...policy });
}

function validateEncryptionKey(key: Buffer | undefined): Buffer | undefined {
  if (key === undefined) return undefined;
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new Error("admission encryption key must be exactly 32 bytes");
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
