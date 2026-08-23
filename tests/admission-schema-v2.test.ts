import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdmissionController,
  AdmissionMigrationError,
  type AdmissionPolicy,
  type EnqueueRequest
} from "../Admission Controller/controller.js";
import {
  ADMISSION_SCHEMA_VERSION,
  SchemaIntegrityError,
  assertAdmissionSchemaIntegrity
} from "../Admission Controller/schema.js";

const stateDirs: string[] = [];
const controllers: AdmissionController[] = [];

const POLICY: AdmissionPolicy = {
  maxActiveTurns: 3,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 2_000,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

type V2EnqueueRequest = Omit<EnqueueRequest, "parentId"> & { agentId: string };

interface ColumnInfo {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface ForeignKeyInfo {
  from: string;
  table: string;
  to: string;
}

interface IndexInfo {
  name: string;
  origin: string;
  partial: number;
}

interface IndexColumnInfo {
  seqno: number;
  name: string | null;
  key: number;
}

function databasePath(): string {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-schema-v2-"));
  stateDirs.push(stateDir);
  return path.join(stateDir, "runtime.sqlite");
}

function openController(file: string): AdmissionController {
  const admission = new AdmissionController({
    databasePath: file,
    policy: POLICY,
    encryptionKey: Buffer.alloc(32, 81),
    contentFingerprintKey: Buffer.alloc(32, 82)
  });
  controllers.push(admission);
  return admission;
}

function createLegacyV1Database(file: string): void {
  const db = new Database(file);
  try {
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      );
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
      INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'shared-admission-queue', 1);
    `);
  } finally {
    db.close();
  }
}

function tableNames(db: Database.Database): string[] {
  return (db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>).map((row) => row.name);
}

function columns(db: Database.Database, table: string): ColumnInfo[] {
  return db.pragma(`table_info('${table}')`) as ColumnInfo[];
}

function columnNames(db: Database.Database, table: string): string[] {
  return columns(db, table).map((column) => column.name);
}

function foreignKeys(db: Database.Database, table: string): ForeignKeyInfo[] {
  return db.pragma(`foreign_key_list('${table}')`) as ForeignKeyInfo[];
}

function namedIndexes(db: Database.Database, table: string): IndexInfo[] {
  return (db.pragma(`index_list('${table}')`) as IndexInfo[]).filter((index) => index.origin === "c");
}

function indexColumns(db: Database.Database, indexName: string): string[] {
  return (db.pragma(`index_xinfo('${indexName}')`) as IndexColumnInfo[])
    .filter((column) => column.key === 1)
    .sort((left, right) => left.seqno - right.seqno)
    .map((column) => column.name ?? "");
}

function tableSql(db: Database.Database, table: string): string {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as
    | { sql: string }
    | undefined;
  return row?.sql ?? "";
}

function sessionLayout(db: Database.Database): object {
  return {
    columns: columns(db, "sessions"),
    indexes: namedIndexes(db, "sessions").map((index) => ({
      name: index.name,
      partial: index.partial,
      columns: indexColumns(db, index.name)
    }))
  };
}

function assertLegacyConnectorRejects(file: string, supportedVersion: number): void {
  const db = new Database(file, { readonly: true });
  try {
    const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number | null };
    const applied = row.version ?? 0;
    if (applied > supportedVersion) {
      throw new Error(`admission database schema version ${applied} is newer than this connector supports`);
    }
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const admission of controllers.splice(0)) admission.close();
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

describe("Admission schema v2 migration", () => {
  it("migrates a legacy v1 database to the exact v2 shape without changing sessions", () => {
    const file = databasePath();
    createLegacyV1Database(file);
    const before = new Database(file, { readonly: true });
    const beforeSessions = sessionLayout(before);
    before.close();

    const admission = openController(file);

    const db = new Database(file, { readonly: true });
    try {
      db.pragma("foreign_keys = ON");
      const sqliteVersion = db.prepare("SELECT sqlite_version() AS version").get() as { version: string };
      expect(sqliteVersion.version.localeCompare("3.25.0", undefined, { numeric: true })).toBeGreaterThanOrEqual(0);
      expect(ADMISSION_SCHEMA_VERSION).toBe(3);
      expect(admission.schemaVersion).toBe(3);
      expect(() => assertAdmissionSchemaIntegrity(db)).not.toThrow(SchemaIntegrityError);
      expect(tableNames(db)).toEqual([
        "cooldowns",
        "events",
        "lease_process_identities",
        "leases",
        "policy_state",
        "queued_owner_instances",
        "schema_migrations",
        "sessions",
        "start_history",
        "turn_payloads",
        "turn_requests"
      ]);
      expect(columnNames(db, "turn_requests")).toEqual([
        "request_id",
        "session_id",
        "agent_id",
        "fingerprint",
        "provider",
        "model",
        "state",
        "enqueued_at",
        "deadline_at",
        "lease_generation",
        "terminal_at",
        "queued_owner_instance_id",
        "queued_owner_recorded_at"
      ]);
      expect(columnNames(db, "turn_requests")).not.toContain("parent_id");
      expect(foreignKeys(db, "turn_requests")).toEqual([]);
      expect(namedIndexes(db, "turn_requests")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "turn_requests_queue", partial: 0 }),
          expect.objectContaining({ name: "turn_requests_queued_owner", partial: 1 })
        ])
      );
      expect(columnNames(db, "leases")).toEqual([
        "lease_id",
        "request_id",
        "generation",
        "owner_instance_id",
        "phase",
        "acquired_at",
        "heartbeat_at",
        "suspect_since",
        "suspect_reason"
      ]);
      expect(columnNames(db, "policy_state")).toEqual([
        "id",
        "max_active_turns",
        "max_concurrent_starts",
        "min_start_interval_ms",
        "queue_timeout_ms",
        "capacity_cooldown_ms",
        "drain_state",
        "policy_fingerprint",
        "updated_at",
        "updated_by_owner_instance_id"
      ]);
      expect(columns(db, "policy_state").find((column) => column.name === "policy_fingerprint")).toMatchObject({
        type: "TEXT",
        notnull: 1
      });
      expect(tableSql(db, "policy_state")).toMatch(/CHECK\s*\(\s*id\s*=\s*1\s*\)/i);
      expect(db.prepare("SELECT COUNT(*) AS count FROM policy_state").get()).toEqual({ count: 0 });
      expect(columnNames(db, "queued_owner_instances")).toEqual([
        "owner_instance_id",
        "created_at",
        "boot_id",
        "pid",
        "start_time_ticks",
        "pid_namespace_inode",
        "ppid",
        "pgrp",
        "session",
        "recorded_at"
      ]);
      expect(foreignKeys(db, "queued_owner_instances")).toEqual([]);
      expect(db.prepare("SELECT version, name FROM schema_migrations ORDER BY version ASC").all()).toEqual([
        { version: 1, name: "shared-admission-queue" },
        { version: 2, name: "shared-admission-queue-v2" },
        { version: 3, name: "shared-admission-queue-v3" }
      ]);
      expect(sessionLayout(db)).toEqual(beforeSessions);
      expect(() => assertLegacyConnectorRejects(file, 1)).toThrow(/newer than this connector supports/);
    } finally {
      db.close();
    }
  });

  it("accepts EnqueueRequest.agentId as the only request owner API spelling", () => {
    const file = databasePath();
    createLegacyV1Database(file);
    const admission = openController(file);
    const request: V2EnqueueRequest = {
      requestId: "agent-api-request",
      sessionId: "agent-api-session",
      agentId: "agent-alpha",
      fingerprint: "agent-api-request",
      provider: "antigravity",
      model: "model-test",
      now: 1_000
    };

    expect(() => admission.enqueueWithPayload(request as unknown as EnqueueRequest, "private prompt", 61_000)).not.toThrow();
    expect(admission.getRequest("agent-api-request")).toMatchObject({
      requestId: "agent-api-request",
      sessionId: "agent-api-session",
      agentId: "agent-alpha"
    });

    const db = new Database(file, { readonly: true });
    try {
      expect(db.prepare("SELECT agent_id FROM turn_requests WHERE request_id = ?").get("agent-api-request")).toEqual({
        agent_id: "agent-alpha"
      });
      expect(() => db.prepare("SELECT parent_id FROM turn_requests").all()).toThrow();
    } finally {
      db.close();
    }
  });

  it("rejects EnqueueRequest.parentId instead of treating it as a v2 alias", () => {
    const file = databasePath();
    createLegacyV1Database(file);
    const admission = openController(file);

    expect(() => admission.enqueueWithPayload({
      requestId: "legacy-api-request",
      sessionId: "legacy-api-session",
      parentId: "legacy-parent",
      fingerprint: "legacy-api-request",
      provider: "antigravity",
      model: "model-test",
      now: 1_000
    }, "private prompt", 61_000)).toThrow(/parentId is not accepted/);

    const db = new Database(file, { readonly: true });
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM turn_requests WHERE request_id = ?").get("legacy-api-request")).toEqual({
        count: 0
      });
    } finally {
      db.close();
    }
  });

  it("rolls back the v2 DDL transaction if migration fails after the rename point", () => {
    const file = databasePath();
    createLegacyV1Database(file);
    const conflict = new Database(file);
    try {
      conflict.exec("CREATE TABLE policy_state (id INTEGER PRIMARY KEY)");
    } finally {
      conflict.close();
    }

    expect(() => openController(file)).toThrow(AdmissionMigrationError);

    const db = new Database(file, { readonly: true });
    try {
      expect(columnNames(db, "turn_requests")).toContain("parent_id");
      expect(columnNames(db, "turn_requests")).not.toContain("agent_id");
      expect(columnNames(db, "turn_requests")).not.toContain("queued_owner_instance_id");
      expect(columnNames(db, "leases")).not.toContain("suspect_since");
      expect(db.prepare("SELECT version, name FROM schema_migrations ORDER BY version ASC").all()).toEqual([
        { version: 1, name: "shared-admission-queue" }
      ]);
    } finally {
      db.close();
    }
  });
});
