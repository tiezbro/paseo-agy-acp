import * as path from "node:path";
import Database from "better-sqlite3";
import { isSessionModeId } from "../../agy/cli.js";
import type { SessionStoreBackend, StoredSession } from "./store.js";

const MAX_ADDITIONAL_DIRECTORIES = 63;
const MAX_MESSAGE_IDS = 10_000;

interface SqliteTableColumn {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

interface SessionColumnSpec {
  name: string;
  type: string;
  notNull: boolean;
  primaryKeyPosition: number;
}

interface SqliteIndex {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface SqliteIndexColumn {
  seqno: number;
  cid: number;
  name: string | null;
  desc: number;
  coll: string;
  key: number;
}

interface SessionIndexSpec {
  name: string;
  columns: readonly { name: string; descending: boolean }[];
}

interface SessionTableLayout {
  sessionId: string;
  conversationId: string;
  conversationCursor: string;
  model: string;
  effort: string;
  mode: string;
  cwd: string;
  roots: string;
  messageIds: string;
  updatedAt: string;
}

interface DecodedSessionRow {
  sessionId: string;
  session: StoredSession;
}

const SESSION_COLUMNS: readonly SessionColumnSpec[] = [
  { name: "session_id", type: "TEXT", notNull: true, primaryKeyPosition: 1 },
  { name: "conversation_id", type: "TEXT", notNull: false, primaryKeyPosition: 0 },
  { name: "conversation_cursor", type: "INTEGER", notNull: true, primaryKeyPosition: 0 },
  { name: "model", type: "TEXT", notNull: true, primaryKeyPosition: 0 },
  { name: "effort", type: "TEXT", notNull: true, primaryKeyPosition: 0 },
  { name: "mode", type: "TEXT", notNull: true, primaryKeyPosition: 0 },
  { name: "cwd", type: "TEXT", notNull: true, primaryKeyPosition: 0 },
  { name: "roots_json", type: "TEXT", notNull: true, primaryKeyPosition: 0 },
  { name: "v2_user_message_ids_json", type: "TEXT", notNull: true, primaryKeyPosition: 0 },
  { name: "updated_at", type: "INTEGER", notNull: true, primaryKeyPosition: 0 }
];

const SESSION_INDEXES: readonly SessionIndexSpec[] = [
  {
    name: "sessions_updated_at_session_id",
    columns: [
      { name: "updated_at", descending: true },
      { name: "session_id", descending: false }
    ]
  },
  {
    name: "sessions_cwd_updated_at_session_id",
    columns: [
      { name: "cwd", descending: false },
      { name: "updated_at", descending: true },
      { name: "session_id", descending: false }
    ]
  }
];

const CANONICAL_SESSION_LAYOUT: SessionTableLayout = {
  sessionId: "session_id",
  conversationId: "conversation_id",
  conversationCursor: "conversation_cursor",
  model: "model",
  effort: "effort",
  mode: "mode",
  cwd: "cwd",
  roots: "roots_json",
  messageIds: "v2_user_message_ids_json",
  updatedAt: "updated_at"
};

/** Raised when an existing runtime SQLite sessions table cannot be used safely. */
export class SQLiteSessionStoreError extends Error {
  constructor(detail: string) {
    super(`sqlite session store error: ${detail}`);
    this.name = "SQLiteSessionStoreError";
  }
}

/**
 * Optional session persistence backend for the v2 runtime database.
 *
 * This class deliberately creates neither the database nor the sessions table.
 * The runtime schema owner remains responsible for both; callers get a
 * fail-closed error if the table is absent, partial, or incompatible.
 */
export class SQLiteSessionStore implements SessionStoreBackend {
  readonly #db: Database.Database;
  readonly #layout!: SessionTableLayout;
  readonly #selectOne!: Database.Statement;
  readonly #selectAll!: Database.Statement;
  readonly #selectByCwd!: Database.Statement;
  readonly #upsert!: Database.Statement;
  readonly #delete!: Database.Statement;
  readonly #persistTransaction!: (sessionId: string, session: StoredSession) => void;
  #closed = false;

  constructor(databasePath: string) {
    assertDatabasePath(databasePath);
    try {
      this.#db = new Database(databasePath, { fileMustExist: true });
    } catch {
      throw new SQLiteSessionStoreError("runtime SQLite database could not be opened");
    }

    try {
      this.#layout = resolveSessionTableLayout(this.#db);
      // SQLite serializes cross-process writers; these settings make a short
      // conflicting write wait rather than falling back to a shared JSON file.
      this.#db.pragma("busy_timeout = 5000");
      this.#db.pragma("journal_mode = WAL");
      this.#db.pragma("synchronous = FULL");

      const selectColumns = selectColumnsFor(this.#layout);
      const sessions = quoteIdentifier("sessions");
      const sessionId = quoteIdentifier(this.#layout.sessionId);
      const cwd = quoteIdentifier(this.#layout.cwd);
      const updatedAt = quoteIdentifier(this.#layout.updatedAt);
      this.#selectOne = this.#db.prepare(
        `SELECT ${selectColumns} FROM ${sessions} WHERE ${sessionId} = ?`
      );
      this.#selectAll = this.#db.prepare(
        `SELECT ${selectColumns} FROM ${sessions} ORDER BY ${updatedAt} DESC, ${sessionId} ASC`
      );
      this.#selectByCwd = this.#db.prepare(
        `SELECT ${selectColumns} FROM ${sessions} WHERE ${cwd} = ? ORDER BY ${updatedAt} DESC, ${sessionId} ASC`
      );
      this.#upsert = this.#db.prepare(upsertStatementFor(this.#layout));
      this.#delete = this.#db.prepare(`DELETE FROM ${sessions} WHERE ${sessionId} = ?`);
      this.#persistTransaction = this.#db.transaction((id: string, session: StoredSession) => {
        this.#upsert.run(...storageValues(id, session, this.#layout));
        const row = this.#selectOne.get(id);
        if (row === undefined) {
          throw new SQLiteSessionStoreError("session write could not be read back");
        }
        const decoded = decodeSessionRow(row, this.#layout);
        if (decoded.sessionId !== id || !sameSession(decoded.session, session)) {
          throw new SQLiteSessionStoreError("session write did not round-trip exactly");
        }
      });
    } catch (error) {
      closeQuietly(this.#db);
      if (error instanceof SQLiteSessionStoreError) throw error;
      throw new SQLiteSessionStoreError("runtime SQLite sessions table could not be configured");
    }
  }

  async restore(sessionId: string): Promise<StoredSession | null> {
    this.assertOpen();
    const id = readIdentifier(sessionId, "session id");
    const row = this.#selectOne.get(id);
    if (row === undefined) return null;
    return decodeSessionRow(row, this.#layout).session;
  }

  async list(filter?: { cwd?: string | null }): Promise<Array<{ sessionId: string } & StoredSession>> {
    this.assertOpen();
    const cwd = filter?.cwd ?? null;
    const rows = cwd === null ? this.#selectAll.all() : this.#selectByCwd.all(readAbsolutePath(cwd, "cwd filter"));
    return (rows as unknown[]).map((row) => {
      const decoded = decodeSessionRow(row, this.#layout);
      return { sessionId: decoded.sessionId, ...decoded.session };
    });
  }

  async persist(sessionId: string, session: StoredSession): Promise<void> {
    this.assertOpen();
    const id = readIdentifier(sessionId, "session id");
    const normalized = normalizeSessionForWrite(session);
    this.#persistTransaction(id, normalized);
  }

  async delete(sessionId: string): Promise<boolean> {
    this.assertOpen();
    const result = this.#delete.run(readIdentifier(sessionId, "session id"));
    return result.changes > 0;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  private assertOpen(): void {
    if (this.#closed) throw new SQLiteSessionStoreError("store is closed");
  }
}

function assertDatabasePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) {
    throw new SQLiteSessionStoreError("runtime SQLite database path must be an absolute path");
  }
}

function resolveSessionTableLayout(db: Database.Database): SessionTableLayout {
  const table = db
    .prepare("SELECT type FROM sqlite_master WHERE name = ?")
    .get("sessions") as { type?: unknown } | undefined;
  if (table?.type !== "table") {
    throw new SQLiteSessionStoreError("required sessions table is missing or is not a table");
  }

  const columns = (db.prepare("PRAGMA table_info('sessions')").all() as unknown[]).map(parseTableColumn);
  assertCanonicalColumns(columns);
  assertCanonicalIndexes(db);
  return CANONICAL_SESSION_LAYOUT;
}

function parseTableColumn(raw: unknown): SqliteTableColumn {
  if (
    !isRecord(raw) ||
    typeof raw.cid !== "number" ||
    typeof raw.name !== "string" ||
    typeof raw.type !== "string" ||
    typeof raw.notnull !== "number" ||
    !("dflt_value" in raw) ||
    typeof raw.pk !== "number"
  ) {
    throw new SQLiteSessionStoreError("sessions table metadata is malformed");
  }
  return {
    cid: raw.cid,
    name: raw.name,
    type: raw.type,
    notnull: raw.notnull,
    dflt_value: raw.dflt_value,
    pk: raw.pk
  };
}

function assertCanonicalColumns(columns: readonly SqliteTableColumn[]): void {
  if (columns.length !== SESSION_COLUMNS.length) {
    throw new SQLiteSessionStoreError("sessions table columns do not match the canonical schema");
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
      throw new SQLiteSessionStoreError(`sessions table column ${expected.name} does not match the canonical schema`);
    }
  }
}

function assertCanonicalIndexes(db: Database.Database): void {
  const indexes = (db.prepare("PRAGMA index_list('sessions')").all() as unknown[]).map(parseIndex);
  const namedIndexes = indexes.filter((index) => index.origin === "c");
  if (
    namedIndexes.length !== SESSION_INDEXES.length ||
    indexes.some((index) => index.origin !== "c" && index.origin !== "pk")
  ) {
    throw new SQLiteSessionStoreError("sessions table indexes do not match the canonical schema");
  }

  for (const expected of SESSION_INDEXES) {
    const found = namedIndexes.find((index) => index.name === expected.name);
    if (found === undefined || found.unique !== 0 || found.partial !== 0) {
      throw new SQLiteSessionStoreError(`sessions table index ${expected.name} does not match the canonical schema`);
    }
    assertIndexColumns(db, expected);
  }
}

function parseIndex(raw: unknown): SqliteIndex {
  if (
    !isRecord(raw) ||
    typeof raw.name !== "string" ||
    typeof raw.unique !== "number" ||
    typeof raw.origin !== "string" ||
    typeof raw.partial !== "number"
  ) {
    throw new SQLiteSessionStoreError("sessions table index metadata is malformed");
  }
  return { name: raw.name, unique: raw.unique, origin: raw.origin, partial: raw.partial };
}

function assertIndexColumns(db: Database.Database, expected: SessionIndexSpec): void {
  const columns = (db.prepare(`PRAGMA index_xinfo(${quoteIdentifier(expected.name)})`).all() as unknown[])
    .map(parseIndexColumn)
    .filter((column) => column.key === 1)
    .sort((left, right) => left.seqno - right.seqno);
  if (
    columns.length !== expected.columns.length ||
    columns.some(
      (column, position) =>
        column.seqno !== position ||
        column.cid < 0 ||
        column.name !== expected.columns[position]?.name ||
        column.desc !== Number(expected.columns[position]?.descending) ||
        column.coll !== "BINARY"
    )
  ) {
    throw new SQLiteSessionStoreError(`sessions table index ${expected.name} does not match the canonical schema`);
  }
}

function parseIndexColumn(raw: unknown): SqliteIndexColumn {
  if (
    !isRecord(raw) ||
    typeof raw.seqno !== "number" ||
    typeof raw.cid !== "number" ||
    (typeof raw.name !== "string" && raw.name !== null) ||
    typeof raw.desc !== "number" ||
    typeof raw.coll !== "string" ||
    typeof raw.key !== "number"
  ) {
    throw new SQLiteSessionStoreError("sessions table index metadata is malformed");
  }
  return {
    seqno: raw.seqno,
    cid: raw.cid,
    name: raw.name,
    desc: raw.desc,
    coll: raw.coll,
    key: raw.key
  };
}

function selectColumnsFor(layout: SessionTableLayout): string {
  return [
    selectedColumn(layout.sessionId, "session_id"),
    selectedColumn(layout.conversationId, "conversation_id"),
    selectedColumn(layout.conversationCursor, "conversation_cursor"),
    selectedColumn(layout.model, "model"),
    selectedColumn(layout.effort, "effort"),
    selectedColumn(layout.mode, "mode"),
    selectedColumn(layout.cwd, "cwd"),
    selectedColumn(layout.roots, "roots_json"),
    selectedColumn(layout.messageIds, "v2_user_message_ids_json"),
    selectedColumn(layout.updatedAt, "updated_at")
  ].join(", ");
}

function selectedColumn(column: string, alias: string): string {
  return `${quoteIdentifier(column)} AS ${quoteIdentifier(alias)}`;
}

function upsertStatementFor(layout: SessionTableLayout): string {
  const columns = [
    layout.sessionId,
    layout.conversationId,
    layout.conversationCursor,
    layout.model,
    layout.effort,
    layout.mode,
    layout.cwd,
    layout.roots,
    layout.messageIds,
    layout.updatedAt
  ];
  const quotedColumns = columns.map(quoteIdentifier).join(", ");
  const placeholders = columns.map(() => "?").join(", ");
  const updates = columns
    .slice(1)
    .map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`)
    .join(", ");
  return `INSERT INTO ${quoteIdentifier("sessions")} (${quotedColumns}) VALUES (${placeholders})
          ON CONFLICT (${quoteIdentifier(layout.sessionId)}) DO UPDATE SET ${updates}`;
}

function storageValues(sessionId: string, session: StoredSession, layout: SessionTableLayout): Array<string | number | null> {
  return [
    sessionId,
    session.conversationId,
    session.lastStepIdx,
    session.model,
    session.reasoningEffort,
    session.mode!,
    session.cwd,
    JSON.stringify(session.additionalDirectories),
    JSON.stringify(session.v2UserMessageIdsByStep),
    Date.parse(session.updatedAt)
  ];
}

function decodeSessionRow(row: unknown, layout: SessionTableLayout): DecodedSessionRow {
  if (!isRecord(row)) throw new SQLiteSessionStoreError("sessions table returned a malformed row");
  const sessionId = readIdentifier(row.session_id, "stored session id");
  const cwd = readAbsolutePath(row.cwd, "stored cwd");
  const additionalDirectories = readRootsJson(row.roots_json, cwd);
  const conversationId = readNullableIdentifier(row.conversation_id, "stored conversation id");
  const lastStepIdx = readCursor(row.conversation_cursor);
  const model = readText(row.model, "stored model");
  const reasoningEffort = readText(row.effort, "stored reasoning effort");
  const mode = readMode(row.mode, "stored mode");
  const v2UserMessageIdsByStep = readMessageIdsJson(
    row.v2_user_message_ids_json,
    conversationId,
    lastStepIdx
  );
  const updatedAt = readEpochTimestamp(row.updated_at, "stored updated at");
  return {
    sessionId,
    session: {
      cwd,
      additionalDirectories,
      conversationId,
      lastStepIdx,
      model,
      reasoningEffort,
      mode,
      v2UserMessageIdsByStep,
      updatedAt
    }
  };
}

function normalizeSessionForWrite(raw: unknown): StoredSession {
  if (!isRecord(raw)) throw new SQLiteSessionStoreError("session must be an object");
  const cwd = readAbsolutePath(requireField(raw, "cwd"), "session cwd");
  const additionalDirectories = readAdditionalDirectories(requireField(raw, "additionalDirectories"), cwd, "session roots");
  const conversationId = readNullableIdentifier(requireField(raw, "conversationId"), "session conversation id");
  const lastStepIdx = readCursor(requireField(raw, "lastStepIdx"));
  const model = readText(requireField(raw, "model"), "session model");
  const reasoningEffort = readText(requireField(raw, "reasoningEffort"), "session reasoning effort");
  const mode = readMode(requireField(raw, "mode"), "session mode");
  const v2UserMessageIdsByStep = readMessageIdMap(
    requireField(raw, "v2UserMessageIdsByStep"),
    conversationId,
    lastStepIdx,
    "session v2 user message ids"
  );
  const updatedAt = readCanonicalTimestamp(requireField(raw, "updatedAt"), "session updated at");
  return {
    cwd,
    additionalDirectories,
    conversationId,
    lastStepIdx,
    model,
    reasoningEffort,
    mode,
    v2UserMessageIdsByStep,
    updatedAt
  };
}

function requireField(record: Record<string, unknown>, field: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(record, field)) {
    throw new SQLiteSessionStoreError(`session is missing ${field}`);
  }
  return record[field];
}

function readNullableIdentifier(value: unknown, label: string): string | null {
  if (value === null) return null;
  return readIdentifier(value, label);
}

function readIdentifier(value: unknown, label: string): string {
  const identifier = readText(value, label);
  if (identifier.length === 0) throw new SQLiteSessionStoreError(`${label} must not be empty`);
  return identifier;
}

function readText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new SQLiteSessionStoreError(`${label} must be a string without NUL`);
  }
  return value;
}

function readMode(value: unknown, label: string): StoredSession["mode"] & string {
  const mode = readIdentifier(value, label);
  if (!isSessionModeId(mode)) throw new SQLiteSessionStoreError(`${label} is unsupported`);
  return mode;
}

function readCursor(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < -1) {
    throw new SQLiteSessionStoreError("conversation cursor must be a safe integer of at least -1");
  }
  return value;
}

function readAbsolutePath(value: unknown, label: string): string {
  const root = readIdentifier(value, label);
  if (!path.isAbsolute(root)) throw new SQLiteSessionStoreError(`${label} must be an absolute path`);
  return root;
}

function readAdditionalDirectories(value: unknown, cwd: string, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_ADDITIONAL_DIRECTORIES) {
    throw new SQLiteSessionStoreError(`${label} must be a bounded array`);
  }
  const roots = value.map((root, index) => readAbsolutePath(root, `${label}[${index}]`));
  const canonicalRoots = new Set<string>();
  for (const root of [cwd, ...roots]) {
    const canonical = path.resolve(root);
    if (canonicalRoots.has(canonical)) throw new SQLiteSessionStoreError(`${label} contains a duplicate root`);
    canonicalRoots.add(canonical);
  }
  return roots;
}

function readRootsJson(value: unknown, cwd: string): string[] {
  const source = readIdentifier(value, "stored roots");
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new SQLiteSessionStoreError("stored roots are not valid JSON");
  }
  return readAdditionalDirectories(parsed, cwd, "stored roots");
}

function readMessageIdsJson(value: unknown, conversationId: string | null, lastStepIdx: number): Record<string, string> {
  const source = readIdentifier(value, "stored v2 user message ids");
  return readMessageIdMap(parseStringMap(source), conversationId, lastStepIdx, "stored v2 user message ids");
}

function readMessageIdMap(
  value: unknown,
  conversationId: string | null,
  lastStepIdx: number,
  label: string
): Record<string, string> {
  if (!isRecord(value)) throw new SQLiteSessionStoreError(`${label} must be an object`);
  const entries = Object.entries(value);
  if (entries.length > MAX_MESSAGE_IDS) throw new SQLiteSessionStoreError(`${label} has too many entries`);
  if (entries.length > 0 && conversationId === null) {
    throw new SQLiteSessionStoreError(`${label} requires a conversation id`);
  }

  const result: Record<string, string> = {};
  for (const [stepIndex, messageId] of entries) {
    if (!/^(?:0|[1-9]\d*)$/.test(stepIndex)) {
      throw new SQLiteSessionStoreError(`${label} has an invalid cursor`);
    }
    const numericStepIndex = Number(stepIndex);
    if (!Number.isSafeInteger(numericStepIndex) || numericStepIndex > lastStepIdx) {
      throw new SQLiteSessionStoreError(`${label} advances beyond the conversation cursor`);
    }
    result[stepIndex] = readIdentifier(messageId, `${label} entry`);
  }
  return result;
}

function readCanonicalTimestamp(value: unknown, label: string): string {
  const timestamp = readIdentifier(value, label);
  const instant = new Date(timestamp);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== timestamp) {
    throw new SQLiteSessionStoreError(`${label} must be a canonical ISO timestamp`);
  }
  return timestamp;
}

function readEpochTimestamp(value: unknown, label: string): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new SQLiteSessionStoreError(`${label} must be an integer epoch timestamp`);
  }
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime())) {
    throw new SQLiteSessionStoreError(`${label} must be a valid epoch timestamp`);
  }
  return instant.toISOString();
}

/** Parse the only JSON object stored here while rejecting duplicate cursor keys. */
function parseStringMap(source: string): Record<string, string> {
  let index = skipWhitespace(source, 0);
  if (source[index] !== "{") throw new SQLiteSessionStoreError("stored v2 user message ids are not valid JSON");
  index = skipWhitespace(source, index + 1);
  const result: Record<string, string> = {};
  const seen = new Set<string>();
  if (source[index] === "}") {
    index = skipWhitespace(source, index + 1);
    if (index !== source.length) throw new SQLiteSessionStoreError("stored v2 user message ids are not valid JSON");
    return result;
  }

  while (true) {
    const key = readJsonString(source, index);
    index = skipWhitespace(source, key.next);
    if (source[index] !== ":") throw new SQLiteSessionStoreError("stored v2 user message ids are not valid JSON");
    const value = readJsonString(source, skipWhitespace(source, index + 1));
    if (seen.has(key.value)) throw new SQLiteSessionStoreError("stored v2 user message ids contain a duplicate cursor");
    seen.add(key.value);
    result[key.value] = value.value;
    index = skipWhitespace(source, value.next);
    if (source[index] === "}") {
      index = skipWhitespace(source, index + 1);
      if (index !== source.length) throw new SQLiteSessionStoreError("stored v2 user message ids are not valid JSON");
      return result;
    }
    if (source[index] !== ",") throw new SQLiteSessionStoreError("stored v2 user message ids are not valid JSON");
    index = skipWhitespace(source, index + 1);
  }
}

function readJsonString(source: string, index: number): { value: string; next: number } {
  if (source[index] !== '"') throw new SQLiteSessionStoreError("stored v2 user message ids are not valid JSON");
  const start = index;
  index += 1;
  while (index < source.length) {
    const character = source[index]!;
    if (character === '"') {
      const encoded = source.slice(start, index + 1);
      try {
        return { value: JSON.parse(encoded) as string, next: index + 1 };
      } catch {
        throw new SQLiteSessionStoreError("stored v2 user message ids are not valid JSON");
      }
    }
    if (character === "\\") {
      const escape = source[index + 1];
      if (escape === "u") {
        const codePoint = source.slice(index + 2, index + 6);
        if (!/^[0-9a-fA-F]{4}$/.test(codePoint)) {
          throw new SQLiteSessionStoreError("stored v2 user message ids are not valid JSON");
        }
        index += 6;
        continue;
      }
      if (escape === '"' || escape === "\\" || escape === "/" || escape === "b" || escape === "f" || escape === "n" || escape === "r" || escape === "t") {
        index += 2;
        continue;
      }
      throw new SQLiteSessionStoreError("stored v2 user message ids are not valid JSON");
    }
    if (character.charCodeAt(0) <= 0x1f) {
      throw new SQLiteSessionStoreError("stored v2 user message ids are not valid JSON");
    }
    index += 1;
  }
  throw new SQLiteSessionStoreError("stored v2 user message ids are not valid JSON");
}

function skipWhitespace(source: string, index: number): number {
  while (source[index] === " " || source[index] === "\n" || source[index] === "\r" || source[index] === "\t") {
    index += 1;
  }
  return index;
}

function sameSession(left: StoredSession, right: StoredSession): boolean {
  return (
    left.cwd === right.cwd &&
    sameStrings(left.additionalDirectories, right.additionalDirectories) &&
    left.conversationId === right.conversationId &&
    left.lastStepIdx === right.lastStepIdx &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.mode === right.mode &&
    sameStringMap(left.v2UserMessageIdsByStep, right.v2UserMessageIdsByStep) &&
    left.updatedAt === right.updatedAt
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringMap(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left[key] === right[key]);
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closeQuietly(db: Database.Database): void {
  try {
    db.close();
  } catch {
    // Preserve the original schema or configuration error.
  }
}
