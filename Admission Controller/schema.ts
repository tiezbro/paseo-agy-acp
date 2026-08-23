import type Database from "better-sqlite3";

/** The newest AdmissionController schema this connector can safely use. */
export const ADMISSION_SCHEMA_VERSION = 3;

/** Raised when an admission database is not exactly the supported schema. */
export class SchemaIntegrityError extends Error {
  constructor(detail: string) {
    super(`admission schema integrity check failed: ${detail}`);
    this.name = "SchemaIntegrityError";
  }
}

interface ColumnSpec {
  name: string;
  type: string;
  notNull: boolean;
  primaryKeyPosition: number;
  defaultValue: string | null;
}

interface ForeignKeySpec {
  from: string;
  table: string;
  to: string;
  onUpdate: string;
  onDelete: string;
  match: string;
}

interface IndexColumnSpec {
  name: string;
  descending: boolean;
}

interface IndexSpec {
  name: string;
  unique: boolean;
  partial: boolean;
  columns: readonly IndexColumnSpec[];
}

interface TableSpec {
  name: string;
  columns: readonly ColumnSpec[];
  foreignKeys: readonly ForeignKeySpec[];
  namedIndexes: readonly IndexSpec[];
  uniqueConstraints: readonly (readonly string[])[];
  requiredSqlFragments?: readonly string[];
}

interface MigrationSpec {
  version: number;
  name: string;
}

interface TableListRow {
  schema: string;
  name: string;
  type: string;
}

interface TableInfoRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKeyRow {
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

interface IndexListRow {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface IndexXInfoRow {
  seqno: number;
  cid: number;
  name: string | null;
  desc: number;
  coll: string;
  key: number;
}

interface MigrationRow {
  version: unknown;
  name: unknown;
}

const MIGRATIONS: readonly MigrationSpec[] = [
  { version: 1, name: "shared-admission-queue" },
  { version: 2, name: "shared-admission-queue-v2" },
  { version: 3, name: "shared-admission-queue-v3" }
];

const TABLES: readonly TableSpec[] = [
  {
    name: "schema_migrations",
    columns: [
      column("version", "INTEGER", false, 1),
      column("name", "TEXT", true),
      column("applied_at", "INTEGER", true)
    ],
    foreignKeys: [],
    namedIndexes: [],
    uniqueConstraints: []
  },
  {
    name: "turn_requests",
    columns: [
      column("request_id", "TEXT", false, 1),
      column("session_id", "TEXT", true),
      column("agent_id", "TEXT", true),
      column("fingerprint", "TEXT", true),
      column("provider", "TEXT", true),
      column("model", "TEXT", true),
      column("state", "TEXT", true),
      column("enqueued_at", "INTEGER", true),
      column("deadline_at", "INTEGER", true),
      column("lease_generation", "INTEGER", true, 0, "0"),
      column("terminal_at", "INTEGER", false),
      column("queued_owner_instance_id", "TEXT", false),
      column("queued_owner_recorded_at", "INTEGER", false)
    ],
    foreignKeys: [],
    namedIndexes: [
      index("turn_requests_queue", ["state", "enqueued_at"]),
      index("turn_requests_queued_owner", ["queued_owner_instance_id"], [], false, true)
    ],
    uniqueConstraints: []
  },
  {
    name: "leases",
    columns: [
      column("lease_id", "TEXT", false, 1),
      column("request_id", "TEXT", true),
      column("generation", "INTEGER", true),
      column("owner_instance_id", "TEXT", true),
      column("phase", "TEXT", true),
      column("acquired_at", "INTEGER", true),
      column("heartbeat_at", "INTEGER", true),
      column("suspect_since", "INTEGER", false),
      column("suspect_reason", "TEXT", false)
    ],
    foreignKeys: [foreignKey("request_id", "turn_requests", "request_id")],
    namedIndexes: [index("leases_phase", ["phase"])],
    uniqueConstraints: [["request_id"]],
    requiredSqlFragments: [
      "suspect_reason TEXT CHECK (suspect_reason IS NULL OR suspect_reason IN ('heartbeat_expired', 'identity_unverifiable'))"
    ]
  },
  {
    name: "cooldowns",
    columns: [
      column("provider", "TEXT", true, 1),
      column("model", "TEXT", true, 2),
      column("not_before", "INTEGER", true),
      column("updated_at", "INTEGER", true)
    ],
    foreignKeys: [],
    namedIndexes: [],
    uniqueConstraints: []
  },
  {
    name: "turn_payloads",
    columns: [
      column("request_id", "TEXT", false, 1),
      column("nonce", "BLOB", true),
      column("ciphertext", "BLOB", true),
      column("auth_tag", "BLOB", true),
      column("key_version", "INTEGER", true),
      column("content_fingerprint", "TEXT", true),
      column("expires_at", "INTEGER", true),
      column("created_at", "INTEGER", true)
    ],
    foreignKeys: [foreignKey("request_id", "turn_requests", "request_id", "CASCADE")],
    namedIndexes: [],
    uniqueConstraints: []
  },
  {
    name: "lease_process_identities",
    columns: [
      column("lease_id", "TEXT", false, 1),
      column("request_id", "TEXT", true),
      column("lease_generation", "INTEGER", true),
      column("owner_instance_id", "TEXT", true),
      column("prompt_channel", "TEXT", true),
      column("connector_owner_instance_id", "TEXT", true),
      column("connector_created_at", "TEXT", true),
      column("connector_boot_id", "TEXT", true),
      column("connector_pid", "INTEGER", true),
      column("connector_start_time_ticks", "TEXT", true),
      column("connector_pid_namespace_inode", "INTEGER", true),
      column("connector_ppid", "INTEGER", true),
      column("connector_pgrp", "INTEGER", true),
      column("connector_session", "INTEGER", true),
      column("child_boot_id", "TEXT", true),
      column("child_pid", "INTEGER", true),
      column("child_start_time_ticks", "TEXT", true),
      column("child_pid_namespace_inode", "INTEGER", true),
      column("child_ppid", "INTEGER", true),
      column("child_pgrp", "INTEGER", true),
      column("child_session", "INTEGER", true),
      column("recorded_at", "INTEGER", true)
    ],
    foreignKeys: [
      foreignKey("lease_id", "leases", "lease_id", "CASCADE"),
      foreignKey("request_id", "turn_requests", "request_id")
    ],
    namedIndexes: [index("lease_process_identities_request", ["request_id"], [], true)],
    uniqueConstraints: []
  },
  {
    name: "start_history",
    columns: [column("lease_id", "TEXT", false, 1), column("started_at", "INTEGER", true)],
    foreignKeys: [],
    namedIndexes: [index("start_history_started", ["started_at"])],
    uniqueConstraints: []
  },
  {
    name: "policy_state",
    columns: [
      column("id", "INTEGER", false, 1),
      column("max_active_turns", "INTEGER", true),
      column("max_concurrent_starts", "INTEGER", true),
      column("min_start_interval_ms", "INTEGER", true),
      column("queue_timeout_ms", "INTEGER", true),
      column("capacity_cooldown_ms", "INTEGER", true),
      column("drain_state", "TEXT", true),
      column("policy_fingerprint", "TEXT", true),
      column("updated_at", "INTEGER", true),
      column("updated_by_owner_instance_id", "TEXT", true)
    ],
    foreignKeys: [],
    namedIndexes: [],
    uniqueConstraints: [],
    requiredSqlFragments: [
      "id INTEGER PRIMARY KEY CHECK (id = 1)",
      "max_active_turns INTEGER NOT NULL CHECK (max_active_turns >= 1)",
      "max_concurrent_starts INTEGER NOT NULL CHECK (max_concurrent_starts >= 1)",
      "min_start_interval_ms INTEGER NOT NULL CHECK (min_start_interval_ms >= 2000)",
      "queue_timeout_ms INTEGER NOT NULL CHECK (queue_timeout_ms > 0 AND queue_timeout_ms <= 1800000)",
      "capacity_cooldown_ms INTEGER NOT NULL CHECK (capacity_cooldown_ms >= 30000)",
      "drain_state TEXT NOT NULL CHECK (drain_state IN ('steady', 'soft_draining_to_1'))"
    ]
  },
  {
    name: "queued_owner_instances",
    columns: [
      column("owner_instance_id", "TEXT", false, 1),
      column("created_at", "TEXT", true),
      column("boot_id", "TEXT", true),
      column("pid", "INTEGER", true),
      column("start_time_ticks", "TEXT", true),
      column("pid_namespace_inode", "INTEGER", true),
      column("ppid", "INTEGER", true),
      column("pgrp", "INTEGER", true),
      column("session", "INTEGER", true),
      column("recorded_at", "INTEGER", true)
    ],
    foreignKeys: [],
    namedIndexes: [],
    uniqueConstraints: []
  },
  {
    name: "sessions",
    columns: [
      column("session_id", "TEXT", true, 1),
      column("conversation_id", "TEXT", false),
      column("conversation_cursor", "INTEGER", true),
      column("model", "TEXT", true),
      column("effort", "TEXT", true),
      column("mode", "TEXT", true),
      column("cwd", "TEXT", true),
      column("roots_json", "TEXT", true),
      column("v2_user_message_ids_json", "TEXT", true),
      column("updated_at", "INTEGER", true)
    ],
    foreignKeys: [],
    namedIndexes: [
      index("sessions_updated_at_session_id", ["updated_at", "session_id"], [true, false]),
      index("sessions_cwd_updated_at_session_id", ["cwd", "updated_at", "session_id"], [false, true, false])
    ],
    uniqueConstraints: []
  },
  {
    name: "events",
    columns: [
      column("event_seq", "INTEGER", false, 1),
      column("kind", "TEXT", true),
      column("from_state", "TEXT", true),
      column("to_state", "TEXT", true),
      column("occurred_at", "INTEGER", true),
      column("correlation_hmac", "TEXT", true)
    ],
    foreignKeys: [],
    namedIndexes: [index("events_occurred", ["occurred_at", "event_seq"])],
    uniqueConstraints: [],
    requiredSqlFragments: ["event_seq INTEGER PRIMARY KEY AUTOINCREMENT"]
  }
];

/**
 * Performs no migration or repair. Callers must enable foreign keys before
 * handing the connection to this guard; any mismatch fails closed.
 */
export function assertAdmissionSchemaIntegrity(db: Database.Database): void {
  try {
    assertForeignKeysEnabled(db);
    assertNoUnexpectedTables(db);

    for (const table of TABLES) {
      assertTable(db, table);
      assertColumns(db, table);
      assertTableDefinition(db, table);
      assertForeignKeys(db, table);
      assertIndexes(db, table);
    }

    assertMigrationLedger(db);
  } catch (error) {
    if (error instanceof SchemaIntegrityError) throw error;
    throw new SchemaIntegrityError("SQLite metadata could not be inspected");
  }
}

function assertNoUnexpectedTables(db: Database.Database): void {
  const expected = new Set(TABLES.map((table) => table.name));
  const rows = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as Array<{ name: unknown }>;
  for (const row of rows) {
    if (typeof row.name !== "string" || !expected.has(row.name)) {
      fail(`unexpected table ${typeof row.name === "string" ? row.name : "unknown"} is present`);
    }
  }
}

function column(
  name: string,
  type: string,
  notNull: boolean,
  primaryKeyPosition = 0,
  defaultValue: string | null = null
): ColumnSpec {
  return { name, type, notNull, primaryKeyPosition, defaultValue };
}

function foreignKey(
  from: string,
  table: string,
  to: string,
  onDelete = "NO ACTION"
): ForeignKeySpec {
  return { from, table, to, onUpdate: "NO ACTION", onDelete, match: "NONE" };
}

function index(
  name: string,
  columns: readonly string[],
  descending: readonly boolean[] = [],
  unique = false,
  partial = false
): IndexSpec {
  return {
    name,
    columns: columns.map((columnName, position) => ({ name: columnName, descending: descending[position] ?? false })),
    unique,
    partial
  };
}

function assertForeignKeysEnabled(db: Database.Database): void {
  if (db.pragma("foreign_keys", { simple: true }) !== 1) {
    fail("PRAGMA foreign_keys=ON is required");
  }
}

function assertTable(db: Database.Database, expected: TableSpec): void {
  const tables = pragmaRows<TableListRow>(db, `table_list(${sqlLiteral(expected.name)})`);
  const matches = tables.filter((table) => table.schema === "main" && table.name === expected.name);
  if (matches.length !== 1 || matches[0]?.type !== "table") {
    fail(`required table ${expected.name} is missing or is not a table`);
  }
}

function assertColumns(db: Database.Database, expected: TableSpec): void {
  const actual = pragmaRows<TableInfoRow>(db, `table_info(${sqlLiteral(expected.name)})`);
  if (actual.length !== expected.columns.length) {
    fail(`table ${expected.name} columns do not match the schema contract`);
  }

  for (const [position, required] of expected.columns.entries()) {
    const found = actual[position];
    if (
      found === undefined ||
      found.cid !== position ||
      found.name !== required.name ||
      found.type !== required.type ||
      found.notnull !== Number(required.notNull) ||
      found.pk !== required.primaryKeyPosition ||
      found.dflt_value !== required.defaultValue
    ) {
      fail(`table ${expected.name} column ${required.name} does not match the schema contract`);
    }
  }
}

function assertTableDefinition(db: Database.Database, expected: TableSpec): void {
  if (expected.requiredSqlFragments === undefined) return;
  const row = db
    .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(expected.name) as { sql: unknown } | undefined;
  if (typeof row?.sql !== "string") fail(`table ${expected.name} definition could not be inspected`);
  const normalized = row.sql.replace(/\s+/g, " ").trim().toUpperCase();
  for (const fragment of expected.requiredSqlFragments) {
    if (!normalized.includes(fragment.replace(/\s+/g, " ").trim().toUpperCase())) {
      fail(`table ${expected.name} definition does not match the schema contract`);
    }
  }
}

function assertForeignKeys(db: Database.Database, expected: TableSpec): void {
  const actual = pragmaRows<ForeignKeyRow>(db, `foreign_key_list(${sqlLiteral(expected.name)})`)
    .map((foreignKey) => foreignKeySignature(foreignKey))
    .sort();
  const required = expected.foreignKeys.map((foreignKey) => foreignKeySignature(foreignKey)).sort();

  if (!sameStrings(actual, required)) {
    fail(`table ${expected.name} foreign keys do not match the schema contract`);
  }
}

function assertIndexes(db: Database.Database, expected: TableSpec): void {
  const allIndexes = pragmaRows<IndexListRow>(db, `index_list(${sqlLiteral(expected.name)})`);
  const namedIndexes = allIndexes.filter((entry) => entry.origin === "c");
  if (namedIndexes.length !== expected.namedIndexes.length) {
    fail(`table ${expected.name} named indexes do not match the schema contract`);
  }

  for (const required of expected.namedIndexes) {
    const found = namedIndexes.find((entry) => entry.name === required.name);
    if (found === undefined) {
      fail(`table ${expected.name} named indexes do not match the schema contract`);
    }
    if (found.unique !== Number(required.unique) || found.partial !== Number(required.partial)) {
      fail(`table ${expected.name} index ${required.name} does not match the schema contract`);
    }
    assertIndexColumns(db, expected.name, required.name, required.columns);
  }

  const uniqueConstraints = allIndexes.filter((entry) => entry.origin === "u");
  if (uniqueConstraints.length !== expected.uniqueConstraints.length) {
    fail(`table ${expected.name} unique constraints do not match the schema contract`);
  }

  const remainingUniqueConstraints = [...uniqueConstraints];
  for (const requiredColumns of expected.uniqueConstraints) {
    const match = remainingUniqueConstraints.find((entry) =>
      indexHasColumns(
        db,
        entry.name,
        requiredColumns.map((name) => ({ name, descending: false }))
      )
    );
    if (match === undefined || match.unique !== 1 || match.partial !== 0) {
      fail(`table ${expected.name} unique constraints do not match the schema contract`);
    }
    remainingUniqueConstraints.splice(remainingUniqueConstraints.indexOf(match), 1);
  }
}

function assertIndexColumns(
  db: Database.Database,
  table: string,
  indexName: string,
  requiredColumns: readonly IndexColumnSpec[]
): void {
  if (!indexHasColumns(db, indexName, requiredColumns)) {
    fail(`table ${table} index ${indexName} does not match the schema contract`);
  }
}

function indexHasColumns(db: Database.Database, indexName: string, requiredColumns: readonly IndexColumnSpec[]): boolean {
  const keyColumns = pragmaRows<IndexXInfoRow>(db, `index_xinfo(${sqlLiteral(indexName)})`)
    .filter((column) => column.key === 1)
    .sort((left, right) => left.seqno - right.seqno);

  return (
    keyColumns.length === requiredColumns.length &&
    keyColumns.every(
      (column, position) =>
        column.seqno === position &&
        column.cid >= 0 &&
        column.name === requiredColumns[position]?.name &&
        column.desc === Number(requiredColumns[position]?.descending) &&
        column.coll === "BINARY"
    )
  );
}

function assertMigrationLedger(db: Database.Database): void {
  const rows = db
    .prepare("SELECT version, name FROM schema_migrations ORDER BY version ASC")
    .all() as MigrationRow[];
  const byVersion = new Map<number, MigrationRow>();

  for (const row of rows) {
    const version = migrationVersion(row.version);
    if (version === undefined) fail("migration ledger contains a non-integer version");
    if (byVersion.has(version)) fail(`migration ledger contains duplicate version ${version}`);
    byVersion.set(version, row);
  }

  for (const expected of MIGRATIONS) {
    const found = byVersion.get(expected.version);
    if (found === undefined) fail(`migration ledger is missing version ${expected.version}`);
    if (found.name !== expected.name) {
      fail(`migration ${expected.version} must be named ${expected.name}`);
    }
  }

  if (byVersion.size !== MIGRATIONS.length) {
    const unexpected = [...byVersion.keys()].find((version) => !MIGRATIONS.some((expected) => expected.version === version));
    fail(`migration ledger has unexpected version ${unexpected ?? "unknown"}`);
  }
}

function migrationVersion(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "bigint" && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(value);
  }
  return undefined;
}

function foreignKeySignature(foreignKey: ForeignKeySpec | ForeignKeyRow): string {
  const onUpdate = "onUpdate" in foreignKey ? foreignKey.onUpdate : foreignKey.on_update;
  const onDelete = "onDelete" in foreignKey ? foreignKey.onDelete : foreignKey.on_delete;
  return JSON.stringify([foreignKey.from, foreignKey.table, foreignKey.to, onUpdate, onDelete, foreignKey.match]);
}

function pragmaRows<Row>(db: Database.Database, source: string): Row[] {
  const rows = db.pragma(source);
  if (!Array.isArray(rows)) fail(`PRAGMA ${source} did not return a row set`);
  return rows as Row[];
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fail(detail: string): never {
  throw new SchemaIntegrityError(detail);
}
