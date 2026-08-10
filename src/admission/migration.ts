import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  type BigIntStats
} from "node:fs";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import Database from "better-sqlite3";
import { isSessionModeId, type SessionModeId } from "../agy/cli.js";

/** Bounded preflight limits for an untrusted legacy sessions.json file. */
export const LEGACY_MAX_FILE_BYTES = 1_048_576;
export const LEGACY_MAX_SESSIONS = 1_000;
export const LEGACY_MAX_ROOTS_PER_SESSION = 64;
export const LEGACY_MAX_MESSAGE_IDS_PER_SESSION = 10_000;

export interface LegacySessionSnapshot {
  sessionId: string;
  cwd: string;
  additionalDirectories: string[];
  conversationId: string | null;
  lastStepIdx: number;
  model: string;
  reasoningEffort: string;
  mode?: SessionModeId;
  v2UserMessageIdsByStep: Record<string, string>;
  updatedAt: string;
}

export type LegacySessionPreflight =
  | { status: "absent"; sessions: [] }
  | { status: "valid"; sessions: LegacySessionSnapshot[] };

/** A present legacy state file must never silently degrade into an empty store. */
export class LegacyStatePreflightError extends Error {
  constructor(message: string) {
    super(`legacy session preflight failed: ${message}`);
    this.name = "LegacyStatePreflightError";
  }
}

interface LegacySessionSourceSnapshot {
  status: "valid";
  sessions: LegacySessionSnapshot[];
  bytes: Buffer;
  sha256: string;
}

/** These values intentionally mirror only SessionStore's documented legacy fallbacks. */
interface LegacySessionDefaults {
  conversationId: null;
  lastStepIdx: -1;
  model: string;
  reasoningEffort: string;
  updatedAt: string;
}

const LEGACY_SESSION_DEFAULTS: LegacySessionDefaults = {
  conversationId: null,
  lastStepIdx: -1,
  model: "",
  reasoningEffort: "",
  updatedAt: new Date(0).toISOString()
};

const TOP_LEVEL_FIELDS = new Set(["sessions"]);
const SESSION_FIELDS = new Set([
  "cwd",
  "additionalDirectories",
  "workspaces",
  "conversationId",
  "lastStepIdx",
  "model",
  "modelId",
  "reasoningEffort",
  "reasoningEffect",
  "mode",
  "v2UserMessageIdsByStep",
  "updatedAt"
]);
const MAX_JSON_NESTING = 64;

export function inspectLegacySessionStore(file: string): LegacySessionPreflight {
  const snapshot = readLegacySessionSource(file);
  if (snapshot.status === "absent") return { status: "absent", sessions: [] };
  return { status: "valid", sessions: snapshot.sessions };
}

function readLegacySessionSource(file: string): LegacySessionSourceSnapshot | { status: "absent" } {
  let descriptor: number;
  try {
    const noFollow = constants.O_NOFOLLOW;
    if (typeof noFollow !== "number" || noFollow === 0) {
      throw new LegacyStatePreflightError("secure sessions.json inspection is not supported on this platform");
    }
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | noFollow);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return { status: "absent" };
    if (hasErrorCode(error, "ELOOP")) {
      throw new LegacyStatePreflightError("sessions.json must be a regular file");
    }
    if (error instanceof LegacyStatePreflightError) throw error;
    throw new LegacyStatePreflightError("sessions.json metadata is unreadable");
  }

  try {
    const before = fstatSync(descriptor, { bigint: true });
    assertLegacySourceFile(before);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    assertLegacySourceFile(after);
    if (!sameFileSnapshot(before, after) || BigInt(bytes.byteLength) !== after.size) {
      throw new LegacyStatePreflightError("sessions.json changed during inspection");
    }

    const encoded = decodeUtf8(bytes);
    const parsed = parseJsonWithUniqueKeys(encoded);
    if (!isRecord(parsed)) throw new LegacyStatePreflightError("root must be an object");
    assertKnownFields(parsed, TOP_LEVEL_FIELDS, "top-level");

    const rawSessions = parsed.sessions ?? {};
    if (!isRecord(rawSessions)) throw new LegacyStatePreflightError("sessions must be an object");
    const sessions = Object.entries(rawSessions);
    if (sessions.length > LEGACY_MAX_SESSIONS) {
      throw new LegacyStatePreflightError("sessions.json has too many sessions");
    }

    const normalized = {
      status: "valid",
      sessions: sessions.map(([sessionId, raw]) => normalizeSession(sessionId, raw))
    } as const;
    return {
      ...normalized,
      bytes,
      sha256: sha256(bytes)
    };
  } catch (error) {
    if (error instanceof LegacyStatePreflightError) throw error;
    throw new LegacyStatePreflightError("sessions.json is unreadable");
  } finally {
    closeSync(descriptor);
  }
}

function assertLegacySourceFile(stat: BigIntStats): void {
  if (!stat.isFile()) throw new LegacyStatePreflightError("sessions.json must be a regular file");
  if (stat.size > BigInt(LEGACY_MAX_FILE_BYTES)) {
    throw new LegacyStatePreflightError("sessions.json is too large");
  }
}

function sameFileSnapshot(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function hasErrorCode(error: unknown, expected: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === expected;
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new LegacyStatePreflightError("sessions.json contains invalid UTF-8");
  }
}

function parseJsonWithUniqueKeys(encoded: string): unknown {
  try {
    new JsonDuplicateKeyScanner(encoded).scan();
    return JSON.parse(encoded);
  } catch (error) {
    if (error instanceof LegacyStatePreflightError) throw error;
    throw new LegacyStatePreflightError("sessions.json is invalid JSON");
  }
}

function normalizeSession(sessionId: string, raw: unknown): LegacySessionSnapshot {
  readIdentifier(sessionId, "session id");
  if (!isRecord(raw)) throw new LegacyStatePreflightError(`session ${sessionId} must be an object`);
  assertKnownFields(raw, SESSION_FIELDS, `session ${sessionId}`);

  const cwd = readAbsolutePath(raw.cwd, `session ${sessionId}.cwd`);
  const additionalDirectories = readAdditionalDirectories(raw, cwd, sessionId);
  const conversationId = readOptionalConversationId(raw.conversationId, `session ${sessionId}.conversationId`) ?? LEGACY_SESSION_DEFAULTS.conversationId;
  const lastStepIdx = readOptionalSafeInteger(raw.lastStepIdx, `session ${sessionId}.lastStepIdx`) ?? LEGACY_SESSION_DEFAULTS.lastStepIdx;
  if (lastStepIdx < -1) throw new LegacyStatePreflightError(`session ${sessionId}.lastStepIdx must be at least -1`);

  const model = readAliasedString(raw, "model", "modelId", `session ${sessionId}.model`, LEGACY_SESSION_DEFAULTS.model);
  const reasoningEffort = readAliasedString(
    raw,
    "reasoningEffort",
    "reasoningEffect",
    `session ${sessionId}.reasoningEffort`,
    LEGACY_SESSION_DEFAULTS.reasoningEffort
  );
  const mode = readMode(raw.mode, `session ${sessionId}.mode`);
  const v2UserMessageIdsByStep = readMessageIdMap(raw.v2UserMessageIdsByStep, sessionId, conversationId, lastStepIdx);
  const updatedAt = readUpdatedAt(raw.updatedAt, `session ${sessionId}.updatedAt`);

  const snapshot: LegacySessionSnapshot = {
    sessionId,
    cwd,
    additionalDirectories,
    conversationId,
    lastStepIdx,
    model,
    reasoningEffort,
    v2UserMessageIdsByStep,
    updatedAt
  };
  if (mode !== undefined) snapshot.mode = mode;
  return snapshot;
}

function assertKnownFields(raw: Record<string, unknown>, allowed: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      const fieldLabel = label === "top-level" ? "unknown top-level field" : "unknown field";
      throw new LegacyStatePreflightError(`${label} has an ${fieldLabel} ${key}`);
    }
  }
}

function readAdditionalDirectories(raw: Record<string, unknown>, cwd: string, sessionId: string): string[] {
  const hasAdditionalDirectories = hasOwn(raw, "additionalDirectories");
  const hasWorkspaces = hasOwn(raw, "workspaces");
  const additionalDirectories = readRootArray(raw.additionalDirectories, `session ${sessionId}.additionalDirectories`);
  const workspaces = readRootArray(raw.workspaces, `session ${sessionId}.workspaces`);
  assertUniqueRoots(additionalDirectories, `session ${sessionId}.additionalDirectories`);
  assertUniqueRoots(workspaces, `session ${sessionId}.workspaces`);

  const workspaceDirectories = workspaces.filter((workspace) => workspace !== cwd);
  if (hasAdditionalDirectories && hasWorkspaces && !sameRootSequence(additionalDirectories, workspaceDirectories)) {
    throw new LegacyStatePreflightError(`session ${sessionId} has conflicting aliases additionalDirectories and workspaces`);
  }

  const roots = hasAdditionalDirectories ? additionalDirectories : workspaceDirectories;
  if (roots.length + 1 > LEGACY_MAX_ROOTS_PER_SESSION) {
    throw new LegacyStatePreflightError(`session ${sessionId} has too many roots`);
  }
  assertUniqueRoots([cwd, ...roots], `session ${sessionId}`);
  return roots;
}

function readAliasedString(
  raw: Record<string, unknown>,
  currentKey: string,
  legacyKey: string,
  label: string,
  fallback: string
): string {
  const current = hasOwn(raw, currentKey) ? readNonNulString(raw[currentKey], label) : undefined;
  const legacy = hasOwn(raw, legacyKey) ? readNonNulString(raw[legacyKey], label) : undefined;
  if (current !== undefined && legacy !== undefined && current !== legacy) {
    throw new LegacyStatePreflightError(`${label} has conflicting aliases ${currentKey} and ${legacyKey}`);
  }
  return current ?? legacy ?? fallback;
}

function readOptionalConversationId(value: unknown, label: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  return readIdentifier(value, label);
}

function readMode(value: unknown, label: string): SessionModeId | undefined {
  if (value === undefined) return undefined;
  const mode = readNonNulString(value, label);
  if (!isSessionModeId(mode)) throw new LegacyStatePreflightError(`${label} is not a supported mode`);
  return mode;
}

function readUpdatedAt(value: unknown, label: string): string {
  if (value === undefined) return LEGACY_SESSION_DEFAULTS.updatedAt;
  const updatedAt = readNonNulString(value, label);
  const instant = new Date(updatedAt);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== updatedAt) {
    throw new LegacyStatePreflightError(`${label} must be a canonical ISO timestamp`);
  }
  return updatedAt;
}

function readOptionalSafeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new LegacyStatePreflightError(`${label} must be a safe integer`);
  }
  return value;
}

function readRootArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new LegacyStatePreflightError(`${label} must be an array of strings`);
  if (value.length > LEGACY_MAX_ROOTS_PER_SESSION) throw new LegacyStatePreflightError(`${label} has too many roots`);
  return value.map((entry, index) => readAbsolutePath(entry, `${label}[${index}]`));
}

function readAbsolutePath(value: unknown, label: string): string {
  const root = readNonNulString(value, label);
  if (!path.isAbsolute(root)) throw new LegacyStatePreflightError(`${label} must be an absolute path`);
  return root;
}

function assertUniqueRoots(roots: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const root of roots) {
    const canonical = path.resolve(root);
    if (seen.has(canonical)) throw new LegacyStatePreflightError(`${label} contains a duplicate root`);
    seen.add(canonical);
  }
}

function sameRootSequence(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((root, index) => path.resolve(root) === path.resolve(right[index]!));
}

function readMessageIdMap(
  value: unknown,
  sessionId: string,
  conversationId: string | null,
  lastStepIdx: number
): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new LegacyStatePreflightError(`session ${sessionId}.v2UserMessageIdsByStep must be an object`);
  }
  const entries = Object.entries(value);
  if (entries.length > LEGACY_MAX_MESSAGE_IDS_PER_SESSION) {
    throw new LegacyStatePreflightError(`session ${sessionId} has too many message ids`);
  }
  if (entries.length > 0 && conversationId === null) {
    throw new LegacyStatePreflightError(`session ${sessionId}.v2UserMessageIdsByStep requires conversationId`);
  }

  const result: Record<string, string> = {};
  for (const [stepIndex, messageId] of entries) {
    const numericStepIndex = readMessageStepIndex(stepIndex, sessionId);
    if (numericStepIndex > lastStepIdx) {
      throw new LegacyStatePreflightError(`session ${sessionId}.v2UserMessageIdsByStep has an index beyond lastStepIdx`);
    }
    result[stepIndex] = readIdentifier(messageId, `session ${sessionId}.v2UserMessageIdsByStep[${stepIndex}]`);
  }
  return result;
}

function readMessageStepIndex(value: string, sessionId: string): number {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new LegacyStatePreflightError(`session ${sessionId}.v2UserMessageIdsByStep contains an invalid entry`);
  }
  const stepIndex = Number(value);
  if (!Number.isSafeInteger(stepIndex)) {
    throw new LegacyStatePreflightError(`session ${sessionId}.v2UserMessageIdsByStep contains an invalid entry`);
  }
  return stepIndex;
}

function readIdentifier(value: unknown, label: string): string {
  const identifier = readNonNulString(value, label);
  if (!identifier) throw new LegacyStatePreflightError(`${label} must not be empty`);
  return identifier;
}

function readNonNulString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new LegacyStatePreflightError(`${label} must be a string`);
  if (value.includes("\0")) throw new LegacyStatePreflightError(`${label} must not contain NUL`);
  return value;
}

function hasOwn(raw: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(raw, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface LegacySessionMigrationOptions {
  legacyFile: string;
  databasePath: string;
  backupFile?: string;
}

export type LegacySessionMigrationResult =
  | {
      status: "absent";
      cutoverCommitted: false;
      importedSessionCount: 0;
      backupFile: string;
    }
  | {
      status: "prepared" | "committed" | "rolled_back";
      cutoverCommitted: boolean;
      importedSessionCount: number;
      backupFile: string;
      sourceSha256: string;
    };

export type LegacySessionMigrationInspection = LegacySessionMigrationResult | { status: "not_started" };

export class LegacySessionMigrationError extends Error {
  constructor(message: string) {
    super(`legacy session migration failed: ${message}`);
    this.name = "LegacySessionMigrationError";
  }
}

interface NormalizedMigrationOptions {
  legacyFile: string;
  databasePath: string;
  backupFile: string;
}

interface MigrationRecord {
  singleton: 1;
  sourcePath: string;
  backupPath: string;
  sourceSha256: string;
  sourceSize: number;
  sessionCount: number;
  sessionIds: string[];
  state: "prepared" | "committed" | "rolled_back";
  cutoverCommitted: boolean;
  preparedAt: number;
  committedAt: number | null;
  rolledBackAt: number | null;
}

interface StoredSessionRow {
  session_id: string;
  conversation_id: string | null;
  conversation_cursor: number;
  model: string;
  effort: string;
  mode: string;
  cwd: string;
  roots_json: string;
  v2_user_message_ids_json: string;
  updated_at: number;
}

interface TableColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

interface TableColumnContract {
  name: string;
  type: string;
  notNull: boolean;
  primaryKeyPosition: number;
}

const LEGACY_MIGRATION_TABLE = "legacy_session_migration";
const DEFAULT_LEGACY_MODE: SessionModeId = "default";

const SESSION_TABLE_COLUMNS: readonly TableColumnContract[] = [
  tableColumn("session_id", "TEXT", true, 1),
  tableColumn("conversation_id", "TEXT", false),
  tableColumn("conversation_cursor", "INTEGER", true),
  tableColumn("model", "TEXT", true),
  tableColumn("effort", "TEXT", true),
  tableColumn("mode", "TEXT", true),
  tableColumn("cwd", "TEXT", true),
  tableColumn("roots_json", "TEXT", true),
  tableColumn("v2_user_message_ids_json", "TEXT", true),
  tableColumn("updated_at", "INTEGER", true)
];

const MIGRATION_TABLE_COLUMNS: readonly TableColumnContract[] = [
  tableColumn("singleton", "INTEGER", true, 1),
  tableColumn("source_path", "TEXT", true),
  tableColumn("backup_path", "TEXT", true),
  tableColumn("source_sha256", "TEXT", true),
  tableColumn("source_size", "INTEGER", true),
  tableColumn("session_count", "INTEGER", true),
  tableColumn("session_ids_json", "TEXT", true),
  tableColumn("state", "TEXT", true),
  tableColumn("cutover_committed", "INTEGER", true),
  tableColumn("prepared_at", "INTEGER", true),
  tableColumn("committed_at", "INTEGER", false),
  tableColumn("rolled_back_at", "INTEGER", false)
];

/** Default immutable v1 snapshot retained beside sessions.json. */
export function defaultLegacySessionBackupPath(legacyFile: string): string {
  return `${readMigrationPath(legacyFile, "legacy sessions path")}.v1-backup`;
}

/**
 * Prepare the one-way v2 cutover. Import and cutover=false are one SQLite
 * transaction; publishing the verified backup happens before that transaction.
 */
export function migrateLegacySessions(options: LegacySessionMigrationOptions): LegacySessionMigrationResult {
  const normalized = normalizeMigrationOptions(options);
  const source = readLegacySessionSource(normalized.legacyFile);
  if (source.status === "absent") {
    const existing = inspectLegacySessionMigration(normalized.databasePath);
    if (existing.status !== "not_started") {
      throw new LegacySessionMigrationError("legacy source is missing after migration started");
    }
    return {
      status: "absent",
      cutoverCommitted: false,
      importedSessionCount: 0,
      backupFile: normalized.backupFile
    };
  }

  const sessions = sortSessions(source.sessions);
  const existing = inspectMigrationDatabase(normalized.databasePath, normalized, source, sessions);
  if (existing === undefined) {
    assertTargetSessionsEmptyReadOnly(normalized.databasePath);
  }

  ensureVerifiedBackup(normalized.backupFile, source);
  const confirmedSource = requireUnchangedSource(normalized.legacyFile, source, existing !== undefined);

  return withWritableMigrationDatabase(normalized.databasePath, (db) => {
    assertSessionTable(db);
    ensureMigrationTable(db);
    const current = readMigrationRecord(db);
    if (current !== undefined) {
      assertRecordMatches(current, normalized, confirmedSource, sessions);
      assertTargetMatchesState(db, current.state, sessions);
      return migrationResult(current);
    }

    assertTargetSessionsEmpty(db);
    insertSessions(db, sessions);
    assertImportedSessionsMatch(db, sessions);

    const preparedAt = Date.now();
    db.prepare(
      `INSERT INTO ${LEGACY_MIGRATION_TABLE} (
        singleton, source_path, backup_path, source_sha256, source_size,
        session_count, session_ids_json, state, cutover_committed,
        prepared_at, committed_at, rolled_back_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, 'prepared', 0, ?, NULL, NULL)`
    ).run(
      normalized.legacyFile,
      normalized.backupFile,
      confirmedSource.sha256,
      confirmedSource.bytes.byteLength,
      sessions.length,
      JSON.stringify(sessions.map((session) => session.sessionId)),
      preparedAt
    );

    const prepared = requireMigrationRecord(db);
    assertRecordMatches(prepared, normalized, confirmedSource, sessions);
    return migrationResult(prepared);
  });
}

/** Persist the irreversible cutover fence after all pre-turn checks pass. */
export function commitLegacySessionCutover(options: LegacySessionMigrationOptions): LegacySessionMigrationResult {
  const normalized = normalizeMigrationOptions(options);
  const source = requirePresentSource(normalized.legacyFile);
  const sessions = sortSessions(source.sessions);
  const existing = inspectMigrationDatabase(normalized.databasePath, normalized, source, sessions);
  if (existing === undefined) throw new LegacySessionMigrationError("migration has not been prepared");
  ensureVerifiedBackup(normalized.backupFile, source);
  const confirmedSource = requireUnchangedSource(normalized.legacyFile, source, true);

  return withWritableMigrationDatabase(normalized.databasePath, (db) => {
    assertSessionTable(db);
    const record = requireMigrationRecord(db);
    assertRecordMatches(record, normalized, confirmedSource, sessions);
    if (record.state === "rolled_back") {
      throw new LegacySessionMigrationError("migration was rolled back");
    }
    if (record.state === "committed") return migrationResult(record);

    assertImportedSessionsMatch(db, sessions);
    const changed = db
      .prepare(
        `UPDATE ${LEGACY_MIGRATION_TABLE}
         SET state = 'committed', cutover_committed = 1, committed_at = ?
         WHERE singleton = 1 AND state = 'prepared' AND cutover_committed = 0`
      )
      .run(Date.now());
    if (changed.changes !== 1) throw new LegacySessionMigrationError("cutover state changed concurrently");
    return migrationResult(requireMigrationRecord(db));
  });
}

/** Roll back only the prepared, never-used import. The legacy source is untouched. */
export function rollbackLegacySessionMigration(options: LegacySessionMigrationOptions): LegacySessionMigrationResult {
  const normalized = normalizeMigrationOptions(options);
  const source = requirePresentSource(normalized.legacyFile);
  const sessions = sortSessions(source.sessions);
  const existing = inspectMigrationDatabase(normalized.databasePath, normalized, source, sessions);
  if (existing === undefined) throw new LegacySessionMigrationError("migration has not been prepared");
  ensureVerifiedBackup(normalized.backupFile, source);
  const confirmedSource = requireUnchangedSource(normalized.legacyFile, source, true);

  return withWritableMigrationDatabase(normalized.databasePath, (db) => {
    assertSessionTable(db);
    const record = requireMigrationRecord(db);
    assertRecordMatches(record, normalized, confirmedSource, sessions);
    if (record.state === "committed") {
      throw new LegacySessionMigrationError("cutover is committed; v1 rollback is forbidden");
    }
    if (record.state === "rolled_back") {
      assertTargetSessionsEmpty(db);
      return migrationResult(record);
    }

    assertImportedSessionsMatch(db, sessions);
    const remove = db.prepare("DELETE FROM sessions WHERE session_id = ?");
    for (const session of sessions) {
      if (remove.run(session.sessionId).changes !== 1) {
        throw new LegacySessionMigrationError("imported sessions changed during rollback");
      }
    }
    assertTargetSessionsEmpty(db);
    const changed = db
      .prepare(
        `UPDATE ${LEGACY_MIGRATION_TABLE}
         SET state = 'rolled_back', rolled_back_at = ?
         WHERE singleton = 1 AND state = 'prepared' AND cutover_committed = 0`
      )
      .run(Date.now());
    if (changed.changes !== 1) throw new LegacySessionMigrationError("rollback state changed concurrently");
    return migrationResult(requireMigrationRecord(db));
  });
}

/** Read only the durable cutover state; this performs no repair or migration. */
export function inspectLegacySessionMigration(databasePath: string): LegacySessionMigrationInspection {
  const normalizedPath = readMigrationPath(databasePath, "runtime SQLite path");
  const db = openMigrationDatabase(normalizedPath, true);
  try {
    assertSessionTable(db);
    const record = readMigrationRecord(db);
    return record === undefined ? { status: "not_started" } : migrationResult(record);
  } finally {
    db.close();
  }
}

function normalizeMigrationOptions(options: LegacySessionMigrationOptions): NormalizedMigrationOptions {
  if (!isRecord(options)) throw new LegacySessionMigrationError("options must be an object");
  const legacyFile = readMigrationPath(options.legacyFile, "legacy sessions path");
  const databasePath = readMigrationPath(options.databasePath, "runtime SQLite path");
  const backupFile = options.backupFile === undefined
    ? defaultLegacySessionBackupPath(legacyFile)
    : readMigrationPath(options.backupFile, "legacy backup path");
  if (new Set([legacyFile, databasePath, backupFile]).size !== 3) {
    throw new LegacySessionMigrationError("source, backup, and database paths must be distinct");
  }
  return { legacyFile, databasePath, backupFile };
}

function readMigrationPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) {
    throw new LegacySessionMigrationError(`${label} must be an absolute path`);
  }
  return path.resolve(value);
}

function requirePresentSource(file: string): LegacySessionSourceSnapshot {
  const source = readLegacySessionSource(file);
  if (source.status === "absent") throw new LegacySessionMigrationError("legacy source is missing");
  return source;
}

function requireUnchangedSource(
  file: string,
  expected: LegacySessionSourceSnapshot,
  migrationStarted: boolean
): LegacySessionSourceSnapshot {
  const current = readLegacySessionSource(file);
  if (current.status === "absent" || current.sha256 !== expected.sha256 || !current.bytes.equals(expected.bytes)) {
    const detail = migrationStarted ? "source changed after migration" : "source changed during migration";
    throw new LegacySessionMigrationError(detail);
  }
  return current;
}

function sortSessions(sessions: readonly LegacySessionSnapshot[]): LegacySessionSnapshot[] {
  return [...sessions].sort((left, right) => compareText(left.sessionId, right.sessionId));
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function ensureVerifiedBackup(backupFile: string, source: LegacySessionSourceSnapshot): void {
  const existing = readBackupIfPresent(backupFile);
  if (existing !== undefined) {
    assertBackupMatches(existing, source);
    return;
  }

  const temporary = `${backupFile}.tmp-${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    );
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, source.bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    try {
      linkSync(temporary, backupFile);
      fsyncDirectory(path.dirname(backupFile));
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
    }
  } catch (error) {
    if (error instanceof LegacySessionMigrationError) throw error;
    throw new LegacySessionMigrationError("verified backup could not be created");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        // A published hard link remains durable; an orphaned private staging
        // file is harmless and can be reviewed rather than deleted blindly.
      }
    }
  }

  const published = readBackupIfPresent(backupFile);
  if (published === undefined) throw new LegacySessionMigrationError("verified backup was not published");
  assertBackupMatches(published, source);
}

function readBackupIfPresent(file: string): Buffer | undefined {
  let descriptor: number;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw new LegacySessionMigrationError("backup is unreadable or is not a regular file");
  }

  try {
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new LegacySessionMigrationError("backup is not a regular file");
    if ((Number(before.mode) & 0o077) !== 0) {
      throw new LegacySessionMigrationError("backup permissions are not private");
    }
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (currentUid !== undefined && before.uid !== BigInt(currentUid)) {
      throw new LegacySessionMigrationError("backup is not owned by the current user");
    }
    if (before.size > BigInt(LEGACY_MAX_FILE_BYTES)) {
      throw new LegacySessionMigrationError("backup is too large");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameFileSnapshot(before, after) || BigInt(bytes.byteLength) !== after.size) {
      throw new LegacySessionMigrationError("backup changed during verification");
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

function assertBackupMatches(backup: Buffer, source: LegacySessionSourceSnapshot): void {
  if (sha256(backup) !== source.sha256 || !backup.equals(source.bytes)) {
    throw new LegacySessionMigrationError("backup does not match the legacy source");
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    fsyncSync(descriptor);
  } catch {
    throw new LegacySessionMigrationError("backup directory could not be synchronized");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function inspectMigrationDatabase(
  databasePath: string,
  options: NormalizedMigrationOptions,
  source: LegacySessionSourceSnapshot,
  sessions: readonly LegacySessionSnapshot[]
): MigrationRecord | undefined {
  const db = openMigrationDatabase(databasePath, true);
  try {
    assertSessionTable(db);
    const record = readMigrationRecord(db);
    if (record !== undefined) {
      assertRecordMatches(record, options, source, sessions);
      assertTargetMatchesState(db, record.state, sessions);
    }
    return record;
  } finally {
    db.close();
  }
}

function assertTargetSessionsEmptyReadOnly(databasePath: string): void {
  const db = openMigrationDatabase(databasePath, true);
  try {
    assertSessionTable(db);
    assertTargetSessionsEmpty(db);
  } finally {
    db.close();
  }
}

function withWritableMigrationDatabase<T>(databasePath: string, operation: (db: Database.Database) => T): T {
  const db = openMigrationDatabase(databasePath, false);
  try {
    return db.transaction(operation).immediate(db);
  } catch (error) {
    if (error instanceof LegacySessionMigrationError || error instanceof LegacyStatePreflightError) throw error;
    throw new LegacySessionMigrationError("runtime SQLite transaction failed");
  } finally {
    db.close();
  }
}

function openMigrationDatabase(databasePath: string, readonly: boolean): Database.Database {
  try {
    const db = new Database(databasePath, { readonly, fileMustExist: true });
    db.pragma("busy_timeout = 5000");
    if (!readonly) db.pragma("foreign_keys = ON");
    return db;
  } catch {
    throw new LegacySessionMigrationError("runtime SQLite database could not be opened");
  }
}

function assertSessionTable(db: Database.Database): void {
  assertTableColumns(db, "sessions", SESSION_TABLE_COLUMNS);
}

function ensureMigrationTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${LEGACY_MIGRATION_TABLE} (
      singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
      source_path TEXT NOT NULL,
      backup_path TEXT NOT NULL,
      source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
      source_size INTEGER NOT NULL CHECK (source_size >= 0),
      session_count INTEGER NOT NULL CHECK (session_count >= 0),
      session_ids_json TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('prepared', 'committed', 'rolled_back')),
      cutover_committed INTEGER NOT NULL CHECK (cutover_committed IN (0, 1)),
      prepared_at INTEGER NOT NULL,
      committed_at INTEGER,
      rolled_back_at INTEGER,
      CHECK ((state = 'committed') = (cutover_committed = 1)),
      CHECK ((state = 'committed') = (committed_at IS NOT NULL)),
      CHECK ((state = 'rolled_back') = (rolled_back_at IS NOT NULL))
    );
  `);
  assertTableColumns(db, LEGACY_MIGRATION_TABLE, MIGRATION_TABLE_COLUMNS);
}

function readMigrationRecord(db: Database.Database): MigrationRecord | undefined {
  const object = db
    .prepare("SELECT type FROM sqlite_master WHERE name = ?")
    .get(LEGACY_MIGRATION_TABLE) as { type?: unknown } | undefined;
  if (object === undefined) return undefined;
  if (object.type !== "table") throw new LegacySessionMigrationError("migration ledger is not a table");
  assertTableColumns(db, LEGACY_MIGRATION_TABLE, MIGRATION_TABLE_COLUMNS);

  const rows = db.prepare(`SELECT * FROM ${LEGACY_MIGRATION_TABLE}`).all() as Record<string, unknown>[];
  if (rows.length === 0) return undefined;
  if (rows.length !== 1) throw new LegacySessionMigrationError("migration ledger is ambiguous");
  return decodeMigrationRecord(rows[0]!);
}

function requireMigrationRecord(db: Database.Database): MigrationRecord {
  const record = readMigrationRecord(db);
  if (record === undefined) throw new LegacySessionMigrationError("migration has not been prepared");
  return record;
}

function decodeMigrationRecord(row: Record<string, unknown>): MigrationRecord {
  if (row.singleton !== 1) throw new LegacySessionMigrationError("migration ledger singleton is invalid");
  const sourcePath = readStoredPath(row.source_path, "source path");
  const backupPath = readStoredPath(row.backup_path, "backup path");
  const sourceSha256 = readStoredString(row.source_sha256, "source digest");
  if (!/^[0-9a-f]{64}$/.test(sourceSha256)) throw new LegacySessionMigrationError("migration source digest is invalid");
  const sourceSize = readStoredInteger(row.source_size, "source size", 0);
  const sessionCount = readStoredInteger(row.session_count, "session count", 0);
  const sessionIds = readStoredSessionIds(row.session_ids_json, sessionCount);
  const state = row.state;
  if (state !== "prepared" && state !== "committed" && state !== "rolled_back") {
    throw new LegacySessionMigrationError("migration state is invalid");
  }
  if (row.cutover_committed !== 0 && row.cutover_committed !== 1) {
    throw new LegacySessionMigrationError("cutover_committed is invalid");
  }
  const cutoverCommitted = row.cutover_committed === 1;
  const preparedAt = readStoredInteger(row.prepared_at, "prepared timestamp", 0);
  const committedAt = readStoredNullableInteger(row.committed_at, "committed timestamp");
  const rolledBackAt = readStoredNullableInteger(row.rolled_back_at, "rollback timestamp");
  if (
    cutoverCommitted !== (state === "committed") ||
    (committedAt !== null) !== (state === "committed") ||
    (rolledBackAt !== null) !== (state === "rolled_back")
  ) {
    throw new LegacySessionMigrationError("migration state fields conflict");
  }
  return {
    singleton: 1,
    sourcePath,
    backupPath,
    sourceSha256,
    sourceSize,
    sessionCount,
    sessionIds,
    state,
    cutoverCommitted,
    preparedAt,
    committedAt,
    rolledBackAt
  };
}

function readStoredPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0") || !path.isAbsolute(value) || path.resolve(value) !== value) {
    throw new LegacySessionMigrationError(`migration ${label} is invalid`);
  }
  return value;
}

function readStoredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new LegacySessionMigrationError(`migration ${label} is invalid`);
  }
  return value;
}

function readStoredInteger(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new LegacySessionMigrationError(`migration ${label} is invalid`);
  }
  return value;
}

function readStoredNullableInteger(value: unknown, label: string): number | null {
  if (value === null) return null;
  return readStoredInteger(value, label, 0);
}

function readStoredSessionIds(value: unknown, expectedCount: number): string[] {
  if (typeof value !== "string") throw new LegacySessionMigrationError("migration session ids are invalid");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new LegacySessionMigrationError("migration session ids are invalid");
  }
  if (!Array.isArray(parsed) || parsed.length !== expectedCount) {
    throw new LegacySessionMigrationError("migration session ids are invalid");
  }
  const ids = parsed.map((entry) => {
    if (typeof entry !== "string" || entry.length === 0 || entry.includes("\0")) {
      throw new LegacySessionMigrationError("migration session ids are invalid");
    }
    return entry;
  });
  if (new Set(ids).size !== ids.length || ids.some((id, index) => index > 0 && compareText(ids[index - 1]!, id) >= 0)) {
    throw new LegacySessionMigrationError("migration session ids are not canonical");
  }
  return ids;
}

function assertRecordMatches(
  record: MigrationRecord,
  options: NormalizedMigrationOptions,
  source: LegacySessionSourceSnapshot,
  sessions: readonly LegacySessionSnapshot[]
): void {
  if (record.sourcePath !== options.legacyFile || record.backupPath !== options.backupFile) {
    throw new LegacySessionMigrationError("migration paths do not match the durable record");
  }
  if (record.sourceSha256 !== source.sha256 || record.sourceSize !== source.bytes.byteLength) {
    throw new LegacySessionMigrationError("source changed after migration");
  }
  const ids = sessions.map((session) => session.sessionId);
  if (record.sessionCount !== sessions.length || !sameStringArray(record.sessionIds, ids)) {
    throw new LegacySessionMigrationError("source sessions changed after migration");
  }
}

function migrationResult(record: MigrationRecord): LegacySessionMigrationResult {
  return {
    status: record.state,
    cutoverCommitted: record.cutoverCommitted,
    importedSessionCount: record.sessionCount,
    backupFile: record.backupPath,
    sourceSha256: record.sourceSha256
  };
}

function insertSessions(db: Database.Database, sessions: readonly LegacySessionSnapshot[]): void {
  const insert = db.prepare(`
    INSERT INTO sessions (
      session_id, conversation_id, conversation_cursor, model, effort,
      mode, cwd, roots_json, v2_user_message_ids_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const session of sessions) insert.run(...sessionStorageValues(session));
}

function sessionStorageValues(session: LegacySessionSnapshot): Array<string | number | null> {
  return [
    session.sessionId,
    session.conversationId,
    session.lastStepIdx,
    session.model,
    session.reasoningEffort,
    session.mode ?? DEFAULT_LEGACY_MODE,
    session.cwd,
    JSON.stringify(session.additionalDirectories),
    canonicalMessageIdsJson(session.v2UserMessageIdsByStep),
    Date.parse(session.updatedAt)
  ];
}

function canonicalMessageIdsJson(messageIds: Readonly<Record<string, string>>): string {
  const entries = Object.entries(messageIds).sort((left, right) => Number(left[0]) - Number(right[0]));
  return JSON.stringify(Object.fromEntries(entries));
}

function expectedSessionRows(sessions: readonly LegacySessionSnapshot[]): StoredSessionRow[] {
  return sessions.map((session) => {
    const values = sessionStorageValues(session);
    return {
      session_id: values[0] as string,
      conversation_id: values[1] as string | null,
      conversation_cursor: values[2] as number,
      model: values[3] as string,
      effort: values[4] as string,
      mode: values[5] as string,
      cwd: values[6] as string,
      roots_json: values[7] as string,
      v2_user_message_ids_json: values[8] as string,
      updated_at: values[9] as number
    };
  });
}

function assertImportedSessionsMatch(db: Database.Database, sessions: readonly LegacySessionSnapshot[]): void {
  const actual = db
    .prepare(
      `SELECT session_id, conversation_id, conversation_cursor, model, effort,
              mode, cwd, roots_json, v2_user_message_ids_json, updated_at
       FROM sessions ORDER BY session_id ASC`
    )
    .all() as StoredSessionRow[];
  const expected = expectedSessionRows(sessions);
  if (actual.length !== expected.length || actual.some((row, index) => !sameSessionRow(row, expected[index]!))) {
    throw new LegacySessionMigrationError("imported sessions no longer match the legacy source");
  }
}

function sameSessionRow(left: StoredSessionRow, right: StoredSessionRow): boolean {
  return (
    left.session_id === right.session_id &&
    left.conversation_id === right.conversation_id &&
    left.conversation_cursor === right.conversation_cursor &&
    left.model === right.model &&
    left.effort === right.effort &&
    left.mode === right.mode &&
    left.cwd === right.cwd &&
    left.roots_json === right.roots_json &&
    left.v2_user_message_ids_json === right.v2_user_message_ids_json &&
    left.updated_at === right.updated_at
  );
}

function assertTargetMatchesState(
  db: Database.Database,
  state: MigrationRecord["state"],
  sessions: readonly LegacySessionSnapshot[]
): void {
  if (state === "prepared") assertImportedSessionsMatch(db, sessions);
  else if (state === "rolled_back") assertTargetSessionsEmpty(db);
}

function assertTargetSessionsEmpty(db: Database.Database): void {
  const row = db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count?: unknown };
  if (row.count !== 0) throw new LegacySessionMigrationError("target sessions table is not empty");
}

function assertTableColumns(
  db: Database.Database,
  table: string,
  expected: readonly TableColumnContract[]
): void {
  const object = db.prepare("SELECT type FROM sqlite_master WHERE name = ?").get(table) as { type?: unknown } | undefined;
  if (object?.type !== "table") throw new LegacySessionMigrationError(`required table ${table} is missing or invalid`);
  const actual = db.pragma(`table_info(${sqlString(table)})`) as TableColumnRow[];
  if (actual.length !== expected.length) throw new LegacySessionMigrationError(`table ${table} schema is incompatible`);
  for (const [index, contract] of expected.entries()) {
    const column = actual[index];
    if (
      column === undefined ||
      column.cid !== index ||
      column.name !== contract.name ||
      column.type !== contract.type ||
      column.notnull !== Number(contract.notNull) ||
      column.pk !== contract.primaryKeyPosition ||
      column.dflt_value !== null
    ) {
      throw new LegacySessionMigrationError(`table ${table} schema is incompatible`);
    }
  }
}

function tableColumn(
  name: string,
  type: string,
  notNull: boolean,
  primaryKeyPosition = 0
): TableColumnContract {
  return { name, type, notNull, primaryKeyPosition };
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** JSON.parse accepts duplicate keys, so scan the syntax first and reject them. */
class JsonDuplicateKeyScanner {
  private index = 0;
  private depth = 0;

  constructor(private readonly source: string) {}

  scan(): void {
    this.skipWhitespace();
    this.scanValue();
    this.skipWhitespace();
    if (this.index !== this.source.length) this.invalid();
  }

  private scanValue(): void {
    this.skipWhitespace();
    const token = this.source[this.index];
    if (token === "{") return this.scanObject();
    if (token === "[") return this.scanArray();
    if (token === '"') {
      this.scanString();
      return;
    }
    if (token === "t") return this.scanLiteral("true");
    if (token === "f") return this.scanLiteral("false");
    if (token === "n") return this.scanLiteral("null");
    if (token === "-" || (token !== undefined && token >= "0" && token <= "9")) return this.scanNumber();
    this.invalid();
  }

  private scanObject(): void {
    this.enterContainer();
    try {
      this.index += 1;
      this.skipWhitespace();
      if (this.source[this.index] === "}") {
        this.index += 1;
        return;
      }

      const keys = new Set<string>();
      while (true) {
        if (this.source[this.index] !== '"') this.invalid();
        const key = this.scanString();
        if (keys.has(key)) throw new LegacyStatePreflightError("sessions.json contains a duplicate JSON key");
        keys.add(key);
        this.skipWhitespace();
        if (this.source[this.index] !== ":") this.invalid();
        this.index += 1;
        this.scanValue();
        this.skipWhitespace();
        const delimiter = this.source[this.index];
        if (delimiter === "}") {
          this.index += 1;
          return;
        }
        if (delimiter !== ",") this.invalid();
        this.index += 1;
        this.skipWhitespace();
      }
    } finally {
      this.depth -= 1;
    }
  }

  private scanArray(): void {
    this.enterContainer();
    try {
      this.index += 1;
      this.skipWhitespace();
      if (this.source[this.index] === "]") {
        this.index += 1;
        return;
      }
      while (true) {
        this.scanValue();
        this.skipWhitespace();
        const delimiter = this.source[this.index];
        if (delimiter === "]") {
          this.index += 1;
          return;
        }
        if (delimiter !== ",") this.invalid();
        this.index += 1;
        this.skipWhitespace();
      }
    } finally {
      this.depth -= 1;
    }
  }

  private scanString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const char = this.source[this.index] as string;
      if (char === '"') {
        this.index += 1;
        try {
          return JSON.parse(this.source.slice(start, this.index)) as string;
        } catch {
          this.invalid();
        }
      }
      if (char === "\\") {
        this.index += 1;
        const escape = this.source[this.index];
        if (escape === "u") {
          const codePoint = this.source.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(codePoint)) this.invalid();
          this.index += 5;
          continue;
        }
        if (escape === '"' || escape === "\\" || escape === "/" || escape === "b" || escape === "f" || escape === "n" || escape === "r" || escape === "t") {
          this.index += 1;
          continue;
        }
        this.invalid();
      }
      if (char.charCodeAt(0) <= 0x1f) this.invalid();
      this.index += 1;
    }
    this.invalid();
  }

  private scanLiteral(literal: string): void {
    if (!this.source.startsWith(literal, this.index)) this.invalid();
    this.index += literal.length;
  }

  private scanNumber(): void {
    if (this.source[this.index] === "-") this.index += 1;
    const firstDigit = this.source[this.index];
    if (firstDigit === "0") this.index += 1;
    else if (this.isDigit(firstDigit) && firstDigit !== "0") {
      this.index += 1;
      this.scanDigits();
    } else {
      this.invalid();
    }

    if (this.source[this.index] === ".") {
      this.index += 1;
      this.requireDigit();
      this.scanDigits();
    }
    if (this.source[this.index] === "e" || this.source[this.index] === "E") {
      this.index += 1;
      if (this.source[this.index] === "+" || this.source[this.index] === "-") this.index += 1;
      this.requireDigit();
      this.scanDigits();
    }
  }

  private scanDigits(): void {
    while (this.isDigit(this.source[this.index])) this.index += 1;
  }

  private requireDigit(): void {
    if (!this.isDigit(this.source[this.index])) this.invalid();
    this.index += 1;
  }

  private isDigit(value: string | undefined): boolean {
    return value !== undefined && value >= "0" && value <= "9";
  }

  private enterContainer(): void {
    this.depth += 1;
    if (this.depth > MAX_JSON_NESTING) {
      throw new LegacyStatePreflightError("sessions.json is nested too deeply");
    }
  }

  private skipWhitespace(): void {
    while (true) {
      const char = this.source[this.index];
      if (char !== " " && char !== "\n" && char !== "\r" && char !== "\t") return;
      this.index += 1;
    }
  }

  private invalid(): never {
    throw new LegacyStatePreflightError("sessions.json is invalid JSON");
  }
}
