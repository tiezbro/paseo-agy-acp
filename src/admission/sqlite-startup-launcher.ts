import { randomUUID } from "node:crypto";
import * as path from "node:path";
import Database from "better-sqlite3";
import type {
  AgyStartupClass,
  AgyStartupLauncher,
  AgyStartupPermit
} from "../agy/startup-launcher.js";

const TABLE_NAME = "agy_startup_permits";
const HELD_CLASSES = ["auxiliary", "resident_pty"] as const;
const OWNER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PERMIT_ID_PATTERN = OWNER_ID_PATTERN;
const MAX_BUSY_TIMEOUT_MS = 60_000;
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_TTL_MS = 30_000;

/** A shared start-history rate limiter is deliberately not claimed by this store. */
export const SQLITE_STARTUP_GLOBAL_START_RATE_STATUS = "not_implemented" as const;

export type HeldAgyStartupClass = (typeof HELD_CLASSES)[number];

export interface SqliteStartupLauncherOptions {
  readonly databasePath: string;
  readonly ownerInstanceId: string;
  readonly heartbeatTtlMs?: number;
  readonly busyTimeoutMs?: number;
  readonly now?: () => number;
  readonly createPermitId?: () => string;
}

export interface StartupPermitFence {
  readonly classification: HeldAgyStartupClass;
  readonly permitId: string;
  readonly ownerInstanceId: string;
  readonly generation: number;
}

/** Payload-free persistent inventory used by the startup recovery barrier. */
export interface RecoverableStartupPermit extends StartupPermitFence {
  readonly acquiredAt: number;
  readonly heartbeatAt: number;
  readonly heartbeatExpired: boolean;
}

export interface HeldAgyStartupPermit extends AgyStartupPermit {
  readonly fence: StartupPermitFence;
  heartbeat(): void;
}

export class SqliteStartupLauncherError extends Error {
  constructor(detail: string) {
    super(`SQLite startup launcher error: ${detail}`);
    this.name = "SqliteStartupLauncherError";
  }
}

export class SqliteStartupCapacityError extends SqliteStartupLauncherError {
  readonly classification: HeldAgyStartupClass;

  constructor(classification: HeldAgyStartupClass) {
    super(`${classification} capacity is already held`);
    this.name = "SqliteStartupCapacityError";
    this.classification = classification;
  }
}

export class SqliteStartupPermitFenceError extends SqliteStartupLauncherError {
  constructor() {
    super("permit fence no longer matches the active owner");
    this.name = "SqliteStartupPermitFenceError";
  }
}

export class SqliteStartupClockError extends SqliteStartupLauncherError {
  constructor() {
    super("clock observation is invalid or moved backwards");
    this.name = "SqliteStartupClockError";
  }
}

interface StartupPermitRow {
  classification: string;
  permit_id: string;
  owner_instance_id: string;
  generation: number;
  state: string;
  acquired_at: number;
  heartbeat_at: number;
  released_at: number | null;
}

interface DecodedStartupPermitRow {
  classification: HeldAgyStartupClass;
  permitId: string;
  ownerInstanceId: string;
  generation: number;
  state: "active" | "released";
  acquiredAt: number;
  heartbeatAt: number;
  releasedAt: number | null;
}

interface SqliteColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

const CANONICAL_COLUMNS = [
  ["classification", "TEXT", 1, 1],
  ["permit_id", "TEXT", 1, 0],
  ["owner_instance_id", "TEXT", 1, 0],
  ["generation", "INTEGER", 1, 0],
  ["state", "TEXT", 1, 0],
  ["acquired_at", "INTEGER", 1, 0],
  ["heartbeat_at", "INTEGER", 1, 0],
  ["released_at", "INTEGER", 0, 0]
] as const;

/**
 * Cross-process startup permits stored beside the AdmissionController tables.
 * The controller remains the only model-turn execution-capacity owner.
 */
export class SqliteAgyStartupLauncher implements AgyStartupLauncher {
  readonly enabled = true;
  readonly globalStartRateStatus = SQLITE_STARTUP_GLOBAL_START_RATE_STATUS;
  readonly #db!: Database.Database;
  readonly #ownerInstanceId: string;
  readonly #heartbeatTtlMs: number;
  readonly #now: () => number;
  readonly #createPermitId: () => string;
  readonly #selectByClass!: Database.Statement;
  readonly #insertActive!: Database.Statement;
  readonly #reactivate!: Database.Statement;
  readonly #heartbeat!: Database.Statement;
  readonly #release!: Database.Statement;
  readonly #listActive!: Database.Statement;
  readonly #acquireImmediate!: (
    classification: HeldAgyStartupClass,
    permitId: string,
    observedAt: number
  ) => StartupPermitFence;
  #closed = false;

  constructor(input: SqliteStartupLauncherOptions) {
    const options = normalizeOptions(input);
    this.#ownerInstanceId = options.ownerInstanceId;
    this.#heartbeatTtlMs = options.heartbeatTtlMs;
    this.#now = options.now;
    this.#createPermitId = options.createPermitId;

    let db: Database.Database | undefined;
    try {
      db = new Database(options.databasePath);
      db.pragma(`busy_timeout = ${options.busyTimeoutMs}`);
      db.pragma("journal_mode = WAL");
      db.pragma("synchronous = FULL");
      db.exec(`
        CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
          classification TEXT PRIMARY KEY NOT NULL
            CHECK (classification IN ('auxiliary', 'resident_pty')),
          permit_id TEXT NOT NULL,
          owner_instance_id TEXT NOT NULL,
          generation INTEGER NOT NULL CHECK (generation > 0),
          state TEXT NOT NULL CHECK (state IN ('active', 'released')),
          acquired_at INTEGER NOT NULL CHECK (acquired_at >= 0),
          heartbeat_at INTEGER NOT NULL CHECK (heartbeat_at >= acquired_at),
          released_at INTEGER,
          CHECK (
            (state = 'active' AND released_at IS NULL)
            OR (state = 'released' AND released_at IS NOT NULL AND released_at >= heartbeat_at)
          )
        )
      `);
      assertCanonicalTable(db);
      this.#db = db;
      this.#selectByClass = db.prepare(`SELECT * FROM ${TABLE_NAME} WHERE classification = ?`);
      this.#insertActive = db.prepare(
        `INSERT INTO ${TABLE_NAME} (
          classification, permit_id, owner_instance_id, generation, state,
          acquired_at, heartbeat_at, released_at
        ) VALUES (?, ?, ?, 1, 'active', ?, ?, NULL)`
      );
      this.#reactivate = db.prepare(
        `UPDATE ${TABLE_NAME}
         SET permit_id = ?, owner_instance_id = ?, generation = ?, state = 'active',
             acquired_at = ?, heartbeat_at = ?, released_at = NULL
         WHERE classification = ? AND generation = ? AND state = 'released'`
      );
      this.#heartbeat = db.prepare(
        `UPDATE ${TABLE_NAME}
         SET heartbeat_at = ?
         WHERE classification = ? AND permit_id = ? AND owner_instance_id = ?
           AND generation = ? AND state = 'active' AND heartbeat_at <= ?`
      );
      this.#release = db.prepare(
        `UPDATE ${TABLE_NAME}
         SET state = 'released', released_at = ?
         WHERE classification = ? AND permit_id = ? AND owner_instance_id = ?
           AND generation = ? AND state = 'active' AND heartbeat_at <= ?`
      );
      this.#listActive = db.prepare(
        `SELECT * FROM ${TABLE_NAME} WHERE state = 'active' ORDER BY classification ASC`
      );
      this.#acquireImmediate = db.transaction(
        (classification: HeldAgyStartupClass, permitId: string, observedAt: number) =>
          this.acquireInTransaction(classification, permitId, observedAt)
      ).immediate;
    } catch (error) {
      closeQuietly(db);
      if (error instanceof SqliteStartupLauncherError) throw error;
      throw new SqliteStartupLauncherError("SQLite permit store could not be configured");
    }
  }

  acquire(classificationInput: AgyStartupClass): AgyStartupPermit | HeldAgyStartupPermit {
    this.assertOpen();
    const classification = requireStartupClass(classificationInput);
    if (classification === "model_turn") return NOOP_MODEL_START_PERMIT;

    const observedAt = this.observeNow();
    const permitId = this.createPermitId();
    let fence: StartupPermitFence;
    try {
      fence = this.#acquireImmediate(classification, permitId, observedAt);
    } catch (error) {
      if (error instanceof SqliteStartupLauncherError) throw error;
      throw new SqliteStartupLauncherError("SQLite permit acquire failed");
    }
    return new PersistentStartupPermit(this, fence);
  }

  /** Heartbeats are observations only; they never reclaim or transfer a permit. */
  heartbeatPermit(fenceInput: unknown): void {
    this.assertOpen();
    const fence = this.requireOwnedFence(fenceInput);
    const observedAt = this.observeNow();
    let result: Database.RunResult;
    try {
      result = this.#heartbeat.run(observedAt, ...fenceValues(fence), observedAt);
    } catch {
      throw new SqliteStartupLauncherError("SQLite permit heartbeat failed");
    }
    if (result.changes === 1) return;
    const existing = this.readFenceRow(fence.classification);
    if (existing !== null && sameActiveFence(existing, fence) && observedAt < existing.heartbeatAt) {
      throw new SqliteStartupClockError();
    }
    throw new SqliteStartupPermitFenceError();
  }

  releasePermit(fenceInput: unknown): void {
    this.assertOpen();
    const fence = this.requireOwnedFence(fenceInput);
    const observedAt = this.observeNow();
    let result: Database.RunResult;
    try {
      result = this.#release.run(observedAt, ...fenceValues(fence), observedAt);
    } catch {
      throw new SqliteStartupLauncherError("SQLite permit release failed");
    }
    if (result.changes === 1) return;
    const existing = this.readFenceRow(fence.classification);
    if (existing !== null && sameActiveFence(existing, fence) && observedAt < existing.heartbeatAt) {
      throw new SqliteStartupClockError();
    }
    throw new SqliteStartupPermitFenceError();
  }

  listRecoverablePermits(): readonly RecoverableStartupPermit[] {
    this.assertOpen();
    const observedAt = this.observeNow();
    let rows: unknown[];
    try {
      rows = this.#listActive.all() as unknown[];
    } catch {
      throw new SqliteStartupLauncherError("SQLite permit inventory failed");
    }
    const records = rows.map((row) => {
      const decoded = decodeRow(row);
      if (observedAt < decoded.heartbeatAt) throw new SqliteStartupClockError();
      return Object.freeze({
        classification: decoded.classification,
        permitId: decoded.permitId,
        ownerInstanceId: decoded.ownerInstanceId,
        generation: decoded.generation,
        acquiredAt: decoded.acquiredAt,
        heartbeatAt: decoded.heartbeatAt,
        heartbeatExpired: observedAt - decoded.heartbeatAt > this.#heartbeatTtlMs
      });
    });
    return Object.freeze(records);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#db.close();
    } catch {
      throw new SqliteStartupLauncherError("SQLite permit store close failed");
    }
  }

  private acquireInTransaction(
    classification: HeldAgyStartupClass,
    permitId: string,
    observedAt: number
  ): StartupPermitFence {
    const existing = this.readFenceRow(classification);
    if (existing === null) {
      this.#insertActive.run(
        classification,
        permitId,
        this.#ownerInstanceId,
        observedAt,
        observedAt
      );
      return freezeFence(classification, permitId, this.#ownerInstanceId, 1);
    }
    if (existing.state === "active") throw new SqliteStartupCapacityError(classification);
    if (observedAt < existing.heartbeatAt || (existing.releasedAt !== null && observedAt < existing.releasedAt)) {
      throw new SqliteStartupClockError();
    }
    const nextGeneration = existing.generation + 1;
    if (!Number.isSafeInteger(nextGeneration)) throw new SqliteStartupLauncherError("permit generation exhausted");
    const result = this.#reactivate.run(
      permitId,
      this.#ownerInstanceId,
      nextGeneration,
      observedAt,
      observedAt,
      classification,
      existing.generation
    );
    if (result.changes !== 1) throw new SqliteStartupLauncherError("permit generation changed during acquire");
    return freezeFence(classification, permitId, this.#ownerInstanceId, nextGeneration);
  }

  private readFenceRow(classification: HeldAgyStartupClass): DecodedStartupPermitRow | null {
    let row: unknown;
    try {
      row = this.#selectByClass.get(classification);
    } catch {
      throw new SqliteStartupLauncherError("SQLite permit read failed");
    }
    return row === undefined ? null : decodeRow(row);
  }

  private observeNow(): number {
    let observed: unknown;
    try {
      observed = this.#now();
    } catch {
      throw new SqliteStartupClockError();
    }
    if (!Number.isSafeInteger(observed) || (observed as number) < 0) throw new SqliteStartupClockError();
    return observed as number;
  }

  private createPermitId(): string {
    let value: unknown;
    try {
      value = this.#createPermitId();
    } catch {
      throw new SqliteStartupLauncherError("permit ID generation failed");
    }
    if (typeof value !== "string" || !PERMIT_ID_PATTERN.test(value)) {
      throw new SqliteStartupLauncherError("permit ID must be a canonical UUID v4");
    }
    return value;
  }

  private requireOwnedFence(value: unknown): StartupPermitFence {
    const fence = normalizeFence(value);
    if (fence.ownerInstanceId !== this.#ownerInstanceId) {
      throw new SqliteStartupPermitFenceError();
    }
    return fence;
  }

  private assertOpen(): void {
    if (this.#closed) throw new SqliteStartupLauncherError("permit store is closed");
  }
}

class PersistentStartupPermit implements HeldAgyStartupPermit {
  readonly fence: StartupPermitFence;
  readonly #launcher: SqliteAgyStartupLauncher;
  #released = false;

  constructor(launcher: SqliteAgyStartupLauncher, fence: StartupPermitFence) {
    this.#launcher = launcher;
    this.fence = fence;
    Object.freeze(this);
  }

  heartbeat(): void {
    if (this.#released) throw new SqliteStartupPermitFenceError();
    this.#launcher.heartbeatPermit(this.fence);
  }

  release(): void {
    if (this.#released) return;
    this.#launcher.releasePermit(this.fence);
    this.#released = true;
  }
}

const NOOP_MODEL_START_PERMIT: AgyStartupPermit = Object.freeze({ release() {} });

function normalizeOptions(input: unknown): {
  databasePath: string;
  ownerInstanceId: string;
  heartbeatTtlMs: number;
  busyTimeoutMs: number;
  now: () => number;
  createPermitId: () => string;
} {
  if (!isRecord(input)) throw new SqliteStartupLauncherError("options must be an object");
  const allowed = new Set([
    "databasePath",
    "ownerInstanceId",
    "heartbeatTtlMs",
    "busyTimeoutMs",
    "now",
    "createPermitId"
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new SqliteStartupLauncherError("options contain unsupported fields");
  }
  if (typeof input.databasePath !== "string" || !path.isAbsolute(input.databasePath)) {
    throw new SqliteStartupLauncherError("database path must be absolute");
  }
  if (typeof input.ownerInstanceId !== "string" || !OWNER_ID_PATTERN.test(input.ownerInstanceId)) {
    throw new SqliteStartupLauncherError("owner instance ID must be a canonical UUID v4");
  }
  const heartbeatTtlMs = positiveSafeInteger(input.heartbeatTtlMs, DEFAULT_HEARTBEAT_TTL_MS, "heartbeat TTL");
  const busyTimeoutMs = positiveSafeInteger(input.busyTimeoutMs, DEFAULT_BUSY_TIMEOUT_MS, "busy timeout");
  if (busyTimeoutMs > MAX_BUSY_TIMEOUT_MS) {
    throw new SqliteStartupLauncherError("busy timeout exceeds the supported maximum");
  }
  if (input.now !== undefined && typeof input.now !== "function") {
    throw new SqliteStartupLauncherError("clock must be a function");
  }
  if (input.createPermitId !== undefined && typeof input.createPermitId !== "function") {
    throw new SqliteStartupLauncherError("permit ID factory must be a function");
  }
  return {
    databasePath: input.databasePath,
    ownerInstanceId: input.ownerInstanceId,
    heartbeatTtlMs,
    busyTimeoutMs,
    now: input.now as (() => number) | undefined ?? Date.now,
    createPermitId: input.createPermitId as (() => string) | undefined ?? randomUUID
  };
}

function positiveSafeInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new SqliteStartupLauncherError(`${label} must be a positive safe integer`);
  }
  return value as number;
}

function requireStartupClass(value: unknown): AgyStartupClass {
  if (value === "model_turn" || value === "auxiliary" || value === "resident_pty") return value;
  throw new SqliteStartupLauncherError("startup classification is invalid");
}

function normalizeFence(value: unknown): StartupPermitFence {
  if (!isRecord(value) || !hasExactKeys(value, ["classification", "permitId", "ownerInstanceId", "generation"])) {
    throw new SqliteStartupPermitFenceError();
  }
  if (!HELD_CLASSES.includes(value.classification as HeldAgyStartupClass)) throw new SqliteStartupPermitFenceError();
  if (typeof value.permitId !== "string" || !PERMIT_ID_PATTERN.test(value.permitId)) {
    throw new SqliteStartupPermitFenceError();
  }
  if (typeof value.ownerInstanceId !== "string" || !OWNER_ID_PATTERN.test(value.ownerInstanceId)) {
    throw new SqliteStartupPermitFenceError();
  }
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) <= 0) {
    throw new SqliteStartupPermitFenceError();
  }
  return freezeFence(
    value.classification as HeldAgyStartupClass,
    value.permitId,
    value.ownerInstanceId,
    value.generation as number
  );
}

function decodeRow(value: unknown): DecodedStartupPermitRow {
  if (!isRecord(value) || !hasExactKeys(value, CANONICAL_COLUMNS.map(([name]) => name))) {
    throw new SqliteStartupLauncherError("persisted permit row is malformed");
  }
  const classification = requireHeldClass(value.classification);
  if (typeof value.permit_id !== "string" || !PERMIT_ID_PATTERN.test(value.permit_id)) {
    throw new SqliteStartupLauncherError("persisted permit ID is malformed");
  }
  if (typeof value.owner_instance_id !== "string" || !OWNER_ID_PATTERN.test(value.owner_instance_id)) {
    throw new SqliteStartupLauncherError("persisted owner ID is malformed");
  }
  if (!Number.isSafeInteger(value.generation) || (value.generation as number) <= 0) {
    throw new SqliteStartupLauncherError("persisted permit generation is malformed");
  }
  if (value.state !== "active" && value.state !== "released") {
    throw new SqliteStartupLauncherError("persisted permit state is malformed");
  }
  const acquiredAt = requireTimestamp(value.acquired_at);
  const heartbeatAt = requireTimestamp(value.heartbeat_at);
  const releasedAt = value.released_at === null ? null : requireTimestamp(value.released_at);
  if (heartbeatAt < acquiredAt) throw new SqliteStartupLauncherError("persisted permit timestamps are inconsistent");
  if (
    (value.state === "active" && releasedAt !== null) ||
    (value.state === "released" && (releasedAt === null || releasedAt < heartbeatAt))
  ) {
    throw new SqliteStartupLauncherError("persisted permit lifecycle is inconsistent");
  }
  return {
    classification,
    permitId: value.permit_id,
    ownerInstanceId: value.owner_instance_id,
    generation: value.generation as number,
    state: value.state,
    acquiredAt,
    heartbeatAt,
    releasedAt
  };
}

function requireHeldClass(value: unknown): HeldAgyStartupClass {
  if (value === "auxiliary" || value === "resident_pty") return value;
  throw new SqliteStartupLauncherError("persisted permit classification is malformed");
}

function requireTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SqliteStartupLauncherError("persisted permit timestamp is malformed");
  }
  return value as number;
}

function assertCanonicalTable(db: Database.Database): void {
  const columns = db.pragma(`table_info(${TABLE_NAME})`) as SqliteColumn[];
  if (columns.length !== CANONICAL_COLUMNS.length) throw new SqliteStartupLauncherError("permit table shape is not canonical");
  for (let index = 0; index < CANONICAL_COLUMNS.length; index += 1) {
    const actual = columns[index];
    const [name, type, notNull, primaryKey] = CANONICAL_COLUMNS[index];
    if (
      actual?.cid !== index || actual.name !== name || actual.type.toUpperCase() !== type ||
      actual.notnull !== notNull || actual.pk !== primaryKey
    ) {
      throw new SqliteStartupLauncherError("permit table shape is not canonical");
    }
  }
  const table = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(TABLE_NAME) as { sql?: unknown } | undefined;
  const sql = typeof table?.sql === "string" ? table.sql.replace(/\s+/g, " ").toLowerCase() : "";
  for (const required of [
    "classification in ('auxiliary', 'resident_pty')",
    "generation > 0",
    "state in ('active', 'released')",
    "state = 'active' and released_at is null",
    "state = 'released' and released_at is not null"
  ]) {
    if (!sql.includes(required)) throw new SqliteStartupLauncherError("permit table constraints are not canonical");
  }
  const triggers = db.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?"
  ).get(TABLE_NAME) as { count: number };
  if (triggers.count !== 0) throw new SqliteStartupLauncherError("permit table must not have triggers");
}

function freezeFence(
  classification: HeldAgyStartupClass,
  permitId: string,
  ownerInstanceId: string,
  generation: number
): StartupPermitFence {
  return Object.freeze({ classification, permitId, ownerInstanceId, generation });
}

function fenceValues(fence: StartupPermitFence): readonly [string, string, string, number] {
  return [fence.classification, fence.permitId, fence.ownerInstanceId, fence.generation];
}

function sameActiveFence(row: DecodedStartupPermitRow, fence: StartupPermitFence): boolean {
  return row.state === "active" && row.classification === fence.classification &&
    row.permitId === fence.permitId && row.ownerInstanceId === fence.ownerInstanceId &&
    row.generation === fence.generation;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closeQuietly(db: Database.Database | undefined): void {
  try {
    db?.close();
  } catch {}
}
