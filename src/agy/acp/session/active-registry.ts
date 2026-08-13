import * as path from "node:path";
import Database from "better-sqlite3";

const TABLE_NAME = "active_antigravity_sessions";
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_PID = 2_147_483_647;
const MAX_PID_NAMESPACE_INODE = 4_294_967_295;
const MAX_START_TIME_TICKS = 18_446_744_073_709_551_615n;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const OWNER_INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const SQLITE_OPERATION_BUSY_TIMEOUT_MS = 5000;
const SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS = 100;
const SQLITE_INITIALIZATION_RETRY_LIMIT = 8;
const SQLITE_INITIALIZATION_RETRY_DELAY_MS = 5;
const sqliteInitializationRetrySignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

const TERMINAL_STATES = ["completed", "failed", "cancelled"] as const;

/** Immutable connector ownership evidence persisted with an active session. */
export interface ActiveConnectorIdentity {
  readonly ownerInstanceId: string;
  readonly createdAt: string;
  readonly bootId: string;
  readonly pid: number;
  readonly startTimeTicks: string;
  readonly pidNamespaceInode: number;
  readonly ppid: number;
  readonly pgrp: number;
  readonly session: number;
}

/** The only terminal outcomes accepted by the registry. */
export type ActiveSessionTerminalState = (typeof TERMINAL_STATES)[number];

/** The allowlisted metadata required to begin durable active-session tracking. */
export interface ActiveSessionRegistration {
  readonly agentId: string;
  readonly sessionId: string;
  readonly requestId: string;
  readonly conversationId: string | null;
  readonly cursor: number;
  readonly connectorIdentity: ActiveConnectorIdentity;
}

/** A generation-bound capability required for every owner mutation. */
export interface ActiveSessionFence {
  readonly requestId: string;
  readonly ownerInstanceId: string;
  readonly leaseGeneration: number;
}

/** A bounded cursor update that contains no request content. */
export interface ActiveSessionAdvance {
  readonly conversationId: string | null;
  readonly cursor: number;
}

/** Restart-safe active-session inventory entry. It deliberately contains no prompt or credential data. */
export interface ActiveSessionRecord extends ActiveSessionRegistration {
  readonly leaseGeneration: number;
  readonly terminalState: ActiveSessionTerminalState | null;
}

export class ActiveSessionRegistryError extends Error {
  constructor(detail: string) {
    super(`active session registry error: ${detail}`);
    this.name = "ActiveSessionRegistryError";
  }
}

/** Raised when a stale connector attempts to mutate a record it no longer owns. */
export class ActiveSessionLeaseFenceError extends ActiveSessionRegistryError {
  constructor() {
    super("session lease fence no longer matches the active owner");
    this.name = "ActiveSessionLeaseFenceError";
  }
}

/** Raised when a cursor update would violate the durable conversation binding or progression rules. */
export class ActiveSessionAdvanceError extends ActiveSessionRegistryError {
  constructor() {
    super("session cursor update violates the current conversation binding or progression");
    this.name = "ActiveSessionAdvanceError";
  }
}

/** Raised when a request ID or in-flight session is already bound to different metadata. */
export class ActiveSessionConflictError extends ActiveSessionRegistryError {
  constructor() {
    super("session registration conflicts with an existing record");
    this.name = "ActiveSessionConflictError";
  }
}

interface ActiveSessionRow {
  request_id: string;
  agent_id: string;
  session_id: string;
  conversation_id: string | null;
  conversation_cursor: number;
  connector_owner_instance_id: string;
  connector_created_at: string;
  connector_boot_id: string;
  connector_pid: number;
  connector_start_time_ticks: string;
  connector_pid_namespace_inode: number;
  connector_ppid: number;
  connector_pgrp: number;
  connector_session: number;
  lease_generation: number;
  terminal_state: string | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
}

interface StoredActiveSession extends ActiveSessionRecord {
  readonly archivedAt: number | null;
}

interface SqliteTableColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

interface SessionColumnSpec {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly primaryKeyPosition: number;
}

const SESSION_COLUMNS: readonly SessionColumnSpec[] = [
  { name: "request_id", type: "TEXT", notNull: true, primaryKeyPosition: 1 },
  { name: "agent_id", type: "TEXT", notNull: true, primaryKeyPosition: 0 },
  { name: "session_id", type: "TEXT", notNull: true, primaryKeyPosition: 0 },
  { name: "conversation_id", type: "TEXT", notNull: false, primaryKeyPosition: 0 },
  { name: "conversation_cursor", type: "INTEGER", notNull: true, primaryKeyPosition: 0 },
  { name: "connector_owner_instance_id", type: "TEXT", notNull: true, primaryKeyPosition: 0 },
  { name: "connector_created_at", type: "TEXT", notNull: true, primaryKeyPosition: 0 },
  { name: "connector_boot_id", type: "TEXT", notNull: true, primaryKeyPosition: 0 },
  { name: "connector_pid", type: "INTEGER", notNull: true, primaryKeyPosition: 0 },
  { name: "connector_start_time_ticks", type: "TEXT", notNull: true, primaryKeyPosition: 0 },
  { name: "connector_pid_namespace_inode", type: "INTEGER", notNull: true, primaryKeyPosition: 0 },
  { name: "connector_ppid", type: "INTEGER", notNull: true, primaryKeyPosition: 0 },
  { name: "connector_pgrp", type: "INTEGER", notNull: true, primaryKeyPosition: 0 },
  { name: "connector_session", type: "INTEGER", notNull: true, primaryKeyPosition: 0 },
  { name: "lease_generation", type: "INTEGER", notNull: true, primaryKeyPosition: 0 },
  { name: "terminal_state", type: "TEXT", notNull: false, primaryKeyPosition: 0 },
  { name: "archived_at", type: "INTEGER", notNull: false, primaryKeyPosition: 0 },
  { name: "created_at", type: "INTEGER", notNull: true, primaryKeyPosition: 0 },
  { name: "updated_at", type: "INTEGER", notNull: true, primaryKeyPosition: 0 }
];

/**
 * A dedicated SQLite WAL registry for restart inventory only. Its public write
 * shapes are exact allowlists, so request content and authentication material
 * cannot be smuggled into the durable session metadata.
 */
export class ActiveSessionRegistry {
  readonly #db!: Database.Database;
  readonly #insert!: Database.Statement;
  readonly #selectByRequestId!: Database.Statement;
  readonly #listInFlight!: Database.Statement;
  readonly #advance!: Database.Statement;
  readonly #takeOverStale!: Database.Statement;
  readonly #markTerminal!: Database.Statement;
  readonly #archiveTerminal!: Database.Statement;
  readonly #cleanupArchived!: Database.Statement;
  #closed = false;

  constructor(databasePath: string) {
    assertDatabasePath(databasePath);
    let db: Database.Database | undefined;
    try {
      db = new Database(databasePath);
      db.pragma(`busy_timeout = ${SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS}`);
      initializeRegistrySchema(db);
      db.pragma(`busy_timeout = ${SQLITE_OPERATION_BUSY_TIMEOUT_MS}`);

      this.#db = db;
      this.#insert = db.prepare(
        `INSERT INTO ${TABLE_NAME} (
          request_id, agent_id, session_id, conversation_id, conversation_cursor,
          connector_owner_instance_id, connector_created_at, connector_boot_id,
          connector_pid, connector_start_time_ticks, connector_pid_namespace_inode,
          connector_ppid, connector_pgrp, connector_session, lease_generation,
          terminal_state, archived_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, ?)
        ON CONFLICT(request_id) DO NOTHING`
      );
      this.#selectByRequestId = db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE request_id = ?`);
      this.#listInFlight = db.prepare(
        `SELECT * FROM ${TABLE_NAME}
         WHERE terminal_state IS NULL AND archived_at IS NULL
         ORDER BY agent_id ASC, session_id ASC, request_id ASC`
      );
      this.#advance = db.prepare(
        `UPDATE ${TABLE_NAME}
         SET conversation_id = ?, conversation_cursor = ?, updated_at = ?
         WHERE request_id = ?
           AND connector_owner_instance_id = ?
           AND lease_generation = ?
           AND terminal_state IS NULL
           AND archived_at IS NULL
           AND (
             (conversation_id IS NULL AND conversation_cursor = -1)
             OR (
               conversation_id IS NOT NULL
               AND conversation_id = ?
               AND conversation_cursor <= ?
             )
           )`
      );
      this.#takeOverStale = db.prepare(
        `UPDATE ${TABLE_NAME}
         SET connector_owner_instance_id = ?, connector_created_at = ?, connector_boot_id = ?,
             connector_pid = ?, connector_start_time_ticks = ?, connector_pid_namespace_inode = ?,
             connector_ppid = ?, connector_pgrp = ?, connector_session = ?,
             lease_generation = ?, updated_at = ?
         WHERE request_id = ?
           AND connector_owner_instance_id = ?
           AND lease_generation = ?
           AND terminal_state IS NULL
           AND archived_at IS NULL`
      );
      this.#markTerminal = db.prepare(
        `UPDATE ${TABLE_NAME}
         SET terminal_state = ?, updated_at = ?
         WHERE request_id = ?
           AND connector_owner_instance_id = ?
           AND lease_generation = ?
           AND terminal_state IS NULL
           AND archived_at IS NULL`
      );
      this.#archiveTerminal = db.prepare(
        `UPDATE ${TABLE_NAME}
         SET archived_at = ?, updated_at = ?
         WHERE request_id = ?
           AND connector_owner_instance_id = ?
           AND lease_generation = ?
           AND terminal_state IS NOT NULL
           AND archived_at IS NULL`
      );
      this.#cleanupArchived = db.prepare(
        `DELETE FROM ${TABLE_NAME} WHERE terminal_state IS NOT NULL AND archived_at IS NOT NULL`
      );
    } catch (error) {
      closeQuietly(db);
      if (error instanceof ActiveSessionRegistryError) throw error;
      throw new ActiveSessionRegistryError("SQLite registry could not be configured");
    }
  }

  /** Register a new active request, or return the same fence for an exact idempotent retry. */
  register(input: unknown): ActiveSessionFence {
    this.assertOpen();
    const registration = normalizeRegistration(input);
    const timestamp = now();
    let result: Database.RunResult;
    try {
      result = this.#insert.run(...registrationValues(registration), timestamp, timestamp);
    } catch (error) {
      if (isConstraintError(error)) throw new ActiveSessionConflictError();
      throw new ActiveSessionRegistryError("SQLite registry write failed");
    }

    if (result.changes === 1) {
      return fenceFor(registration.requestId, registration.connectorIdentity.ownerInstanceId, 1);
    }

    const existing = this.readByRequestId(registration.requestId);
    if (existing === null || !sameRegistration(existing, registration)) throw new ActiveSessionConflictError();
    return fenceFor(existing.requestId, existing.connectorIdentity.ownerInstanceId, existing.leaseGeneration);
  }

  /** List exactly the records a restart owner may need to recover; terminal and archived rows are excluded. */
  listInFlight(): readonly ActiveSessionRecord[] {
    this.assertOpen();
    return Object.freeze(
      (this.#listInFlight.all() as unknown[]).map((row) => publicRecord(decodeRow(row)))
    );
  }

  /**
   * Advance the persisted conversation cursor only while the supplied
   * owner-generation fence remains current. A conversation may bind once from
   * null/-1, then its identifier is immutable and its cursor never decreases.
   */
  advance(fenceInput: unknown, updateInput: unknown): void {
    this.assertOpen();
    const fence = normalizeFence(fenceInput);
    const update = normalizeAdvance(updateInput);
    let result: Database.RunResult;
    try {
      result = this.#advance.run(
        update.conversationId,
        update.cursor,
        now(),
        ...fenceValues(fence),
        update.conversationId,
        update.cursor
      );
    } catch {
      throw new ActiveSessionRegistryError("SQLite registry cursor update failed");
    }
    if (result.changes === 1) return;

    const existing = this.readByRequestId(fence.requestId);
    if (existing !== null && sameFence(existing, fence) && isActive(existing)) {
      if (sameAdvance(existing, update)) return;
      throw new ActiveSessionAdvanceError();
    }
    throw new ActiveSessionLeaseFenceError();
  }

  /**
   * Move a known stale active record to a replacement connector. The caller is
   * responsible for establishing staleness; this method atomically increments
   * the lease generation so the prior owner is immediately fenced out.
   */
  takeOverStale(fenceInput: unknown, connectorInput: unknown): ActiveSessionFence {
    this.assertOpen();
    const fence = normalizeFence(fenceInput);
    const connectorIdentity = normalizeConnectorIdentity(connectorInput);
    if (connectorIdentity.ownerInstanceId === fence.ownerInstanceId) {
      throw new ActiveSessionRegistryError("stale takeover requires a replacement connector owner");
    }
    if (fence.leaseGeneration >= Number.MAX_SAFE_INTEGER) {
      throw new ActiveSessionRegistryError("lease generation is exhausted");
    }
    const replacementGeneration = fence.leaseGeneration + 1;
    const result = this.#takeOverStale.run(
      ...connectorValues(connectorIdentity),
      replacementGeneration,
      now(),
      ...fenceValues(fence)
    );
    if (result.changes !== 1) throw new ActiveSessionLeaseFenceError();
    return fenceFor(fence.requestId, connectorIdentity.ownerInstanceId, replacementGeneration);
  }

  /** Persist one terminal state. Retrying the same terminal write under the same fence is a no-op. */
  markTerminal(fenceInput: unknown, terminalState: unknown): void {
    this.assertOpen();
    const fence = normalizeFence(fenceInput);
    const state = normalizeTerminalState(terminalState);
    const result = this.#markTerminal.run(state, now(), ...fenceValues(fence));
    if (result.changes === 1) return;

    const existing = this.readByRequestId(fence.requestId);
    if (
      existing !== null &&
      sameFence(existing, fence) &&
      existing.terminalState === state
    ) {
      return;
    }
    throw new ActiveSessionLeaseFenceError();
  }

  /** Mark a terminal row as archived. Repeating the same archival is a no-op. */
  archiveTerminal(fenceInput: unknown): boolean {
    this.assertOpen();
    const fence = normalizeFence(fenceInput);
    const timestamp = now();
    const result = this.#archiveTerminal.run(timestamp, timestamp, ...fenceValues(fence));
    if (result.changes === 1) return true;

    const existing = this.readByRequestId(fence.requestId);
    if (existing !== null && sameFence(existing, fence) && existing.terminalState !== null && existing.archivedAt !== null) {
      return false;
    }
    throw new ActiveSessionLeaseFenceError();
  }

  /** Delete archived terminal rows. Calling it again after cleanup returns zero. */
  cleanupArchived(): number {
    this.assertOpen();
    return this.#cleanupArchived.run().changes;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  private assertOpen(): void {
    if (this.#closed) throw new ActiveSessionRegistryError("registry is closed");
  }

  private readByRequestId(requestId: string): StoredActiveSession | null {
    const row = this.#selectByRequestId.get(requestId);
    return row === undefined ? null : decodeRow(row);
  }
}

function initializeRegistrySchema(db: Database.Database): void {
  for (let attempt = 0; attempt < SQLITE_INITIALIZATION_RETRY_LIMIT; attempt += 1) {
    try {
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = FULL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
          request_id TEXT PRIMARY KEY NOT NULL,
          agent_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          conversation_id TEXT,
          conversation_cursor INTEGER NOT NULL,
          connector_owner_instance_id TEXT NOT NULL,
          connector_created_at TEXT NOT NULL,
          connector_boot_id TEXT NOT NULL,
          connector_pid INTEGER NOT NULL,
          connector_start_time_ticks TEXT NOT NULL,
          connector_pid_namespace_inode INTEGER NOT NULL,
          connector_ppid INTEGER NOT NULL,
          connector_pgrp INTEGER NOT NULL,
          connector_session INTEGER NOT NULL,
          lease_generation INTEGER NOT NULL CHECK (lease_generation > 0),
          terminal_state TEXT CHECK (terminal_state IS NULL OR terminal_state IN ('completed', 'failed', 'cancelled')),
          archived_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK (
            (conversation_id IS NULL AND conversation_cursor = -1)
            OR (conversation_id IS NOT NULL AND conversation_cursor >= 0)
          ),
          CHECK (archived_at IS NULL OR terminal_state IS NOT NULL)
        );
      `);
      assertCanonicalTable(db);
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS active_antigravity_sessions_one_inflight_session
          ON ${TABLE_NAME} (agent_id ASC, session_id ASC)
          WHERE terminal_state IS NULL AND archived_at IS NULL;
        CREATE INDEX IF NOT EXISTS active_antigravity_sessions_archived
          ON ${TABLE_NAME} (archived_at ASC, request_id ASC)
          WHERE archived_at IS NOT NULL;
      `);
      return;
    } catch (error) {
      if (!isSqliteInitializationContention(error) || attempt === SQLITE_INITIALIZATION_RETRY_LIMIT - 1) {
        throw error;
      }
      Atomics.wait(
        sqliteInitializationRetrySignal,
        0,
        0,
        SQLITE_INITIALIZATION_RETRY_DELAY_MS * (attempt + 1)
      );
    }
  }
}

function isSqliteInitializationContention(error: unknown): boolean {
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

function assertDatabasePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) {
    throw new ActiveSessionRegistryError("SQLite database path must be an absolute path");
  }
}

function assertCanonicalTable(db: Database.Database): void {
  const columns = (db.prepare(`PRAGMA table_info('${TABLE_NAME}')`).all() as unknown[]).map(parseTableColumn);
  if (columns.length !== SESSION_COLUMNS.length) {
    throw new ActiveSessionRegistryError("SQLite registry table does not match the canonical schema");
  }

  for (const [position, expected] of SESSION_COLUMNS.entries()) {
    const found = columns[position];
    if (
      found === undefined ||
      found.cid !== position ||
      found.name !== expected.name ||
      found.type !== expected.type ||
      found.notnull !== Number(expected.notNull) ||
      found.dflt_value !== null ||
      found.pk !== expected.primaryKeyPosition
    ) {
      throw new ActiveSessionRegistryError("SQLite registry table does not match the canonical schema");
    }
  }
}

function parseTableColumn(value: unknown): SqliteTableColumn {
  if (
    !isRecord(value) ||
    typeof value.cid !== "number" ||
    typeof value.name !== "string" ||
    typeof value.type !== "string" ||
    typeof value.notnull !== "number" ||
    !("dflt_value" in value) ||
    typeof value.pk !== "number"
  ) {
    throw new ActiveSessionRegistryError("SQLite registry schema metadata is malformed");
  }
  return {
    cid: value.cid,
    name: value.name,
    type: value.type,
    notnull: value.notnull,
    dflt_value: value.dflt_value,
    pk: value.pk
  };
}

function normalizeRegistration(value: unknown): ActiveSessionRegistration {
  const record = exactRecord(value, ["agentId", "sessionId", "requestId", "conversationId", "cursor", "connectorIdentity"]);
  if (record === null) throw new ActiveSessionRegistryError("session registration must contain only allowlisted metadata");

  const conversationId = readNullableIdentifier(record.conversationId, "conversation ID");
  const cursor = readCursor(record.cursor);
  assertConversationBinding(conversationId, cursor, () => new ActiveSessionRegistryError("session conversation binding is invalid"));

  return Object.freeze({
    agentId: readIdentifier(record.agentId, "agent ID"),
    sessionId: readIdentifier(record.sessionId, "session ID"),
    requestId: readIdentifier(record.requestId, "request ID"),
    conversationId,
    cursor,
    connectorIdentity: normalizeConnectorIdentity(record.connectorIdentity)
  });
}

function normalizeConnectorIdentity(value: unknown): ActiveConnectorIdentity {
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
  if (record === null) throw new ActiveSessionRegistryError("connector identity must contain only allowlisted metadata");

  const ownerInstanceId = readOwnerInstanceId(record.ownerInstanceId);
  const createdAt = readCanonicalTimestamp(record.createdAt, "connector creation timestamp");
  const bootId = readBootId(record.bootId);
  const pid = readPositiveInteger(record.pid, "connector PID", MAX_PID);
  const startTimeTicks = readStartTimeTicks(record.startTimeTicks);
  const pidNamespaceInode = readPositiveInteger(record.pidNamespaceInode, "PID namespace inode", MAX_PID_NAMESPACE_INODE);
  const ppid = readPositiveInteger(record.ppid, "connector parent PID", MAX_PID);
  const pgrp = readPositiveInteger(record.pgrp, "connector process group", MAX_PID);
  const session = readPositiveInteger(record.session, "connector session", MAX_PID);

  return Object.freeze({
    ownerInstanceId,
    createdAt,
    bootId,
    pid,
    startTimeTicks,
    pidNamespaceInode,
    ppid,
    pgrp,
    session
  });
}

function normalizeFence(value: unknown): ActiveSessionFence {
  const record = exactRecord(value, ["requestId", "ownerInstanceId", "leaseGeneration"]);
  if (record === null) throw new ActiveSessionRegistryError("session lease fence is invalid");
  return Object.freeze({
    requestId: readIdentifier(record.requestId, "request ID"),
    ownerInstanceId: readOwnerInstanceId(record.ownerInstanceId),
    leaseGeneration: readLeaseGeneration(record.leaseGeneration)
  });
}

function normalizeAdvance(value: unknown): ActiveSessionAdvance {
  const record = exactRecord(value, ["conversationId", "cursor"]);
  if (record === null) throw new ActiveSessionAdvanceError();
  try {
    const conversationId = readNullableIdentifier(record.conversationId, "conversation ID");
    const cursor = readCursor(record.cursor);
    assertConversationBinding(conversationId, cursor, () => new ActiveSessionAdvanceError());
    return Object.freeze({ conversationId, cursor });
  } catch (error) {
    if (error instanceof ActiveSessionAdvanceError) throw error;
    throw new ActiveSessionAdvanceError();
  }
}

function normalizeTerminalState(value: unknown): ActiveSessionTerminalState {
  if (!TERMINAL_STATES.includes(value as ActiveSessionTerminalState)) {
    throw new ActiveSessionRegistryError("terminal state is unsupported");
  }
  return value as ActiveSessionTerminalState;
}

function decodeRow(value: unknown): StoredActiveSession {
  if (!isRecord(value)) throw new ActiveSessionRegistryError("SQLite registry returned a malformed row");
  const connectorIdentity = normalizeConnectorIdentity({
    ownerInstanceId: value.connector_owner_instance_id,
    createdAt: value.connector_created_at,
    bootId: value.connector_boot_id,
    pid: value.connector_pid,
    startTimeTicks: value.connector_start_time_ticks,
    pidNamespaceInode: value.connector_pid_namespace_inode,
    ppid: value.connector_ppid,
    pgrp: value.connector_pgrp,
    session: value.connector_session
  });
  const terminalState = value.terminal_state === null ? null : normalizeTerminalState(value.terminal_state);
  const archivedAt = readNullableTimestamp(value.archived_at, "stored archive timestamp");
  if (archivedAt !== null && terminalState === null) {
    throw new ActiveSessionRegistryError("stored archived session has no terminal state");
  }
  readTimestamp(value.created_at, "stored creation timestamp");
  readTimestamp(value.updated_at, "stored update timestamp");

  const conversationId = readNullableIdentifier(value.conversation_id, "stored conversation ID");
  const cursor = readCursor(value.conversation_cursor);
  assertConversationBinding(conversationId, cursor, () => new ActiveSessionRegistryError("stored conversation binding is invalid"));

  return Object.freeze({
    requestId: readIdentifier(value.request_id, "stored request ID"),
    agentId: readIdentifier(value.agent_id, "stored agent ID"),
    sessionId: readIdentifier(value.session_id, "stored session ID"),
    conversationId,
    cursor,
    connectorIdentity,
    leaseGeneration: readLeaseGeneration(value.lease_generation),
    terminalState,
    archivedAt
  });
}

function publicRecord(stored: StoredActiveSession): ActiveSessionRecord {
  return Object.freeze({
    agentId: stored.agentId,
    sessionId: stored.sessionId,
    requestId: stored.requestId,
    conversationId: stored.conversationId,
    cursor: stored.cursor,
    connectorIdentity: Object.freeze({ ...stored.connectorIdentity }),
    leaseGeneration: stored.leaseGeneration,
    terminalState: stored.terminalState
  });
}

function registrationValues(registration: ActiveSessionRegistration): readonly [
  string,
  string,
  string,
  string | null,
  number,
  string,
  string,
  string,
  number,
  string,
  number,
  number,
  number,
  number
] {
  return [
    registration.requestId,
    registration.agentId,
    registration.sessionId,
    registration.conversationId,
    registration.cursor,
    ...connectorValues(registration.connectorIdentity)
  ];
}

function connectorValues(identity: ActiveConnectorIdentity): readonly [string, string, string, number, string, number, number, number, number] {
  return [
    identity.ownerInstanceId,
    identity.createdAt,
    identity.bootId,
    identity.pid,
    identity.startTimeTicks,
    identity.pidNamespaceInode,
    identity.ppid,
    identity.pgrp,
    identity.session
  ];
}

function fenceValues(fence: ActiveSessionFence): readonly [string, string, number] {
  return [fence.requestId, fence.ownerInstanceId, fence.leaseGeneration];
}

function fenceFor(requestId: string, ownerInstanceId: string, leaseGeneration: number): ActiveSessionFence {
  return Object.freeze({ requestId, ownerInstanceId, leaseGeneration });
}

function sameRegistration(existing: StoredActiveSession, candidate: ActiveSessionRegistration): boolean {
  return (
    existing.terminalState === null &&
    existing.archivedAt === null &&
    existing.agentId === candidate.agentId &&
    existing.sessionId === candidate.sessionId &&
    existing.requestId === candidate.requestId &&
    existing.conversationId === candidate.conversationId &&
    existing.cursor === candidate.cursor &&
    sameConnectorIdentity(existing.connectorIdentity, candidate.connectorIdentity)
  );
}

function sameAdvance(existing: StoredActiveSession, update: ActiveSessionAdvance): boolean {
  return existing.conversationId === update.conversationId && existing.cursor === update.cursor;
}

function isActive(existing: StoredActiveSession): boolean {
  return existing.terminalState === null && existing.archivedAt === null;
}

function sameFence(existing: StoredActiveSession, fence: ActiveSessionFence): boolean {
  return (
    existing.requestId === fence.requestId &&
    existing.connectorIdentity.ownerInstanceId === fence.ownerInstanceId &&
    existing.leaseGeneration === fence.leaseGeneration
  );
}

function sameConnectorIdentity(left: ActiveConnectorIdentity, right: ActiveConnectorIdentity): boolean {
  return (
    left.ownerInstanceId === right.ownerInstanceId &&
    left.createdAt === right.createdAt &&
    left.bootId === right.bootId &&
    left.pid === right.pid &&
    left.startTimeTicks === right.startTimeTicks &&
    left.pidNamespaceInode === right.pidNamespaceInode &&
    left.ppid === right.ppid &&
    left.pgrp === right.pgrp &&
    left.session === right.session
  );
}

function readIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    value.trim() !== value ||
    CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new ActiveSessionRegistryError(`${label} is invalid`);
  }
  return value;
}

function readNullableIdentifier(value: unknown, label: string): string | null {
  return value === null ? null : readIdentifier(value, label);
}

function readOwnerInstanceId(value: unknown): string {
  if (typeof value !== "string" || !OWNER_INSTANCE_ID_PATTERN.test(value)) {
    throw new ActiveSessionRegistryError("connector owner instance ID is invalid");
  }
  return value;
}

function readCanonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !ISO_UTC_TIMESTAMP_PATTERN.test(value)) {
    throw new ActiveSessionRegistryError(`${label} is invalid`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ActiveSessionRegistryError(`${label} is invalid`);
  }
  return value;
}

function readBootId(value: unknown): string {
  if (typeof value !== "string" || !BOOT_ID_PATTERN.test(value) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value)) {
    throw new ActiveSessionRegistryError("connector boot ID is invalid");
  }
  return value;
}

function readPositiveInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ActiveSessionRegistryError(`${label} is invalid`);
  }
  return value;
}

function readStartTimeTicks(value: unknown): string {
  if (typeof value !== "string" || !POSITIVE_DECIMAL_PATTERN.test(value) || BigInt(value) > MAX_START_TIME_TICKS) {
    throw new ActiveSessionRegistryError("connector start time is invalid");
  }
  return value;
}

function readCursor(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < -1) {
    throw new ActiveSessionRegistryError("conversation cursor is invalid");
  }
  return value;
}

function assertConversationBinding(
  conversationId: string | null,
  cursor: number,
  error: () => Error
): void {
  if ((conversationId === null && cursor !== -1) || (conversationId !== null && cursor < 0)) {
    throw error();
  }
}

function readLeaseGeneration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ActiveSessionRegistryError("lease generation is invalid");
  }
  return value;
}

function readTimestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ActiveSessionRegistryError(`${label} is invalid`);
  }
  return value;
}

function readNullableTimestamp(value: unknown, label: string): number | null {
  return value === null ? null : readTimestamp(value, label);
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== expectedKeys.length || Object.getOwnPropertySymbols(value).length !== 0) return null;

    const record: Record<string, unknown> = Object.create(null);
    for (const key of expectedKeys) {
      if (!names.includes(key)) return null;
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

function isConstraintError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof value.code === "string" &&
    value.code.startsWith("SQLITE_CONSTRAINT")
  );
}

function now(): number {
  const timestamp = Date.now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new ActiveSessionRegistryError("system clock is invalid");
  }
  return timestamp;
}

function closeQuietly(db: Database.Database | undefined): void {
  if (db === undefined) return;
  try {
    db.close();
  } catch {
    // Construction already failed; the original failure is the useful signal.
  }
}
