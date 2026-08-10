import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AdmissionController, type AdmissionPolicy } from "../src/admission/controller.js";
import {
  ADMISSION_SCHEMA_VERSION,
  assertAdmissionSchemaIntegrity,
  SchemaIntegrityError
} from "../src/admission/schema.js";

const stateDirs: string[] = [];
const databases: Database.Database[] = [];
const DEFAULT_POLICY: AdmissionPolicy = {
  maxActiveTurns: 1,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

interface SchemaFixtureOptions {
  turnRequestId?: string;
  sessionId?: string;
  turnRequestsExtraColumn?: string;
  leasesRequestId?: string;
  payloadRequestId?: string;
  deliveryOutboxSettledAt?: string;
  deliveryClaimLeaseExtraColumn?: string;
  deliveryClaimLeaseExpiryIndex?: string;
  turnRequestsQueueIndex?: string;
  sessionsSessionId?: string;
  sessionsMode?: string;
  sessionsExtraColumn?: string;
  sessionsUpdatedAtIndex?: string;
  sessionsCwdUpdatedAtIndex?: string;
  processIdentityLeaseId?: string;
  processIdentityExtraColumn?: string;
  processIdentityRequestIndex?: string;
  eventsExtraColumn?: string;
  eventsSequence?: string;
  eventsOccurredIndex?: string;
  extraIndex?: string;
}

function databasePath(): string {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-admission-schema-"));
  stateDirs.push(stateDir);
  return path.join(stateDir, "runtime.sqlite");
}

function track(db: Database.Database): Database.Database {
  databases.push(db);
  return db;
}

function currentDatabase(readonly = false): Database.Database {
  const file = databasePath();
  const controller = new AdmissionController({ databasePath: file, policy: DEFAULT_POLICY });
  controller.close();

  const db = new Database(file, { readonly });
  db.pragma("foreign_keys = ON");
  return track(db);
}

function schemaFixture(options: SchemaFixtureOptions = {}): Database.Database {
  const db = track(new Database(databasePath()));
  db.pragma("foreign_keys = ON");

  const deliveryOutboxColumns = [
    "event_id TEXT PRIMARY KEY",
    "request_id TEXT NOT NULL REFERENCES turn_requests(request_id)",
    "fingerprint TEXT NOT NULL",
    "state TEXT NOT NULL",
    "nonce BLOB",
    "ciphertext BLOB",
    "auth_tag BLOB",
    "expires_at INTEGER NOT NULL",
    "created_at INTEGER NOT NULL",
    options.deliveryOutboxSettledAt ?? "settled_at INTEGER",
    "key_version INTEGER",
    "sequence INTEGER NOT NULL DEFAULT 0",
    "protocol_version INTEGER NOT NULL DEFAULT 0",
    "protocol_semantics TEXT NOT NULL DEFAULT 'unnegotiated'",
    "claim_generation INTEGER NOT NULL DEFAULT 0",
    "claim_owner_instance_id TEXT",
    "claim_acquired_at INTEGER",
    "lease_id TEXT",
    "lease_generation INTEGER"
  ].filter((column) => column.length > 0);
  const indexes = [
    options.turnRequestsQueueIndex ?? "CREATE INDEX turn_requests_queue ON turn_requests(state, enqueued_at);",
    "CREATE INDEX leases_phase ON leases(phase);",
    "CREATE INDEX delivery_outbox_pending ON delivery_outbox(state, created_at);",
    options.deliveryClaimLeaseExpiryIndex ??
      "CREATE INDEX delivery_claim_leases_expiry ON delivery_claim_leases(state, lease_expires_at);",
    "CREATE INDEX recovery_claims_request ON recovery_claims(request_id);",
    "CREATE INDEX start_history_started ON start_history(started_at);",
    options.processIdentityRequestIndex ??
      "CREATE UNIQUE INDEX lease_process_identities_request ON lease_process_identities(request_id);",
    options.sessionsUpdatedAtIndex ??
      "CREATE INDEX sessions_updated_at_session_id ON sessions(updated_at DESC, session_id ASC);",
    options.sessionsCwdUpdatedAtIndex ??
      "CREATE INDEX sessions_cwd_updated_at_session_id ON sessions(cwd, updated_at DESC, session_id ASC);",
    options.eventsOccurredIndex ?? "CREATE INDEX events_occurred ON events(occurred_at, event_seq);",
    options.extraIndex ?? ""
  ].filter((statement) => statement.length > 0);

  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    CREATE TABLE turn_requests (
      request_id ${options.turnRequestId ?? "TEXT PRIMARY KEY"},
      session_id ${options.sessionId ?? "TEXT NOT NULL"},
      parent_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      state TEXT NOT NULL,
      enqueued_at INTEGER NOT NULL,
      deadline_at INTEGER NOT NULL,
      lease_generation INTEGER NOT NULL DEFAULT 0,
      terminal_at INTEGER${options.turnRequestsExtraColumn ? `, ${options.turnRequestsExtraColumn}` : ""}
    );
    CREATE TABLE leases (
      lease_id TEXT PRIMARY KEY,
      request_id ${options.leasesRequestId ?? "TEXT NOT NULL UNIQUE REFERENCES turn_requests(request_id)"},
      generation INTEGER NOT NULL,
      owner_instance_id TEXT NOT NULL,
      phase TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      terminal_outcome TEXT,
      terminal_conversation_id TEXT,
      terminal_status TEXT,
      terminal_stream_observed_at INTEGER,
      terminal_sqlite_observed_at INTEGER,
      terminal_failure_category TEXT,
      terminal_http_status INTEGER,
      terminal_code TEXT,
      terminal_reason TEXT
    );
    CREATE TABLE cooldowns (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      not_before INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, model)
    );
    CREATE TABLE turn_payloads (
      request_id ${options.payloadRequestId ?? "TEXT PRIMARY KEY REFERENCES turn_requests(request_id) ON DELETE CASCADE"},
      nonce BLOB NOT NULL,
      ciphertext BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      key_version INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      content_fingerprint TEXT
    );
    CREATE TABLE delivery_outbox (
      ${deliveryOutboxColumns.join(",\n      ")}
    );
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
      updated_at INTEGER NOT NULL${options.deliveryClaimLeaseExtraColumn ? `, ${options.deliveryClaimLeaseExtraColumn}` : ""}
    );
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
    CREATE TABLE lease_process_identities (
      lease_id ${options.processIdentityLeaseId ?? "TEXT PRIMARY KEY REFERENCES leases(lease_id) ON DELETE CASCADE"},
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
      recorded_at INTEGER NOT NULL${options.processIdentityExtraColumn ? `, ${options.processIdentityExtraColumn}` : ""}
    );
    CREATE TABLE start_history (
      lease_id TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      session_id ${options.sessionsSessionId ?? "TEXT NOT NULL PRIMARY KEY"},
      conversation_id TEXT,
      conversation_cursor INTEGER NOT NULL,
      model TEXT NOT NULL,
      effort TEXT NOT NULL,
      mode ${options.sessionsMode ?? "TEXT NOT NULL"},
      cwd TEXT NOT NULL,
      roots_json TEXT NOT NULL,
      v2_user_message_ids_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL${options.sessionsExtraColumn ? `, ${options.sessionsExtraColumn}` : ""}
    );
    CREATE TABLE events (
      event_seq ${options.eventsSequence ?? "INTEGER PRIMARY KEY AUTOINCREMENT"},
      kind TEXT NOT NULL,
      from_state TEXT NOT NULL,
      to_state TEXT NOT NULL,
      occurred_at INTEGER NOT NULL,
      correlation_hmac TEXT NOT NULL${options.eventsExtraColumn ? `, ${options.eventsExtraColumn}` : ""}
    );
    ${indexes.join("\n    ")}
  `);
  const insertMigration = db.prepare(
    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)"
  );
  insertMigration.run(1, "admission-controller-core", 1_000);
  insertMigration.run(2, "provider-terminal-proof", 2_000);
  insertMigration.run(3, "authenticated-row-binding", 3_000);
  insertMigration.run(4, "structured-terminal-evidence", 4_000);
  insertMigration.run(5, "durable-outbox-claims", 5_000);
  insertMigration.run(6, "fenced-recovery-resolution", 6_000);
  insertMigration.run(7, "sqlite-session-store", 7_000);
  insertMigration.run(8, "atomic-process-dispatch-intent", 8_000);
  insertMigration.run(9, "atomic-outbox-claim-leases", 9_000);
  insertMigration.run(10, "sanitized-admission-events", 10_000);
  return db;
}

function downgradeToVersionNine(db: Database.Database): void {
  db.exec(`
    DROP INDEX events_occurred;
    DROP TABLE events;
    DELETE FROM schema_migrations WHERE version = 10;
  `);
}

function downgradeToVersionEight(db: Database.Database): void {
  downgradeToVersionNine(db);
  db.exec(`
    DROP INDEX delivery_claim_leases_expiry;
    DROP TABLE delivery_claim_leases;
    DELETE FROM schema_migrations WHERE version = 9;
  `);
}

function downgradeToVersionSeven(db: Database.Database): void {
  downgradeToVersionEight(db);
  db.exec(`
    DROP INDEX lease_process_identities_request;
    DROP TABLE lease_process_identities;
    DELETE FROM schema_migrations WHERE version = 8;
  `);
}

function downgradeToVersionSix(db: Database.Database): void {
  downgradeToVersionSeven(db);
  db.exec(`
    DROP INDEX sessions_updated_at_session_id;
    DROP INDEX sessions_cwd_updated_at_session_id;
    DROP TABLE sessions;
    DELETE FROM schema_migrations WHERE version = 7;
  `);
}

function expectSchemaFailure(db: Database.Database, message: RegExp): void {
  expect(() => assertAdmissionSchemaIntegrity(db)).toThrow(SchemaIntegrityError);
  expect(() => assertAdmissionSchemaIntegrity(db)).toThrow(message);
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const stateDir of stateDirs.splice(0)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

describe("admission schema integrity", () => {
  it("fresh creation installs the exact v10 sanitized event journal through a read-only connection", () => {
    const db = currentDatabase(true);

    expect(ADMISSION_SCHEMA_VERSION).toBe(10);
    expect(assertAdmissionSchemaIntegrity(db)).toBeUndefined();
    expect((db.pragma("table_info('lease_process_identities')") as Array<{ name: string }>).map((column) => column.name)).toEqual([
      "lease_id",
      "request_id",
      "lease_generation",
      "owner_instance_id",
      "prompt_channel",
      "connector_owner_instance_id",
      "connector_created_at",
      "connector_boot_id",
      "connector_pid",
      "connector_start_time_ticks",
      "connector_pid_namespace_inode",
      "connector_ppid",
      "connector_pgrp",
      "connector_session",
      "child_boot_id",
      "child_pid",
      "child_start_time_ticks",
      "child_pid_namespace_inode",
      "child_ppid",
      "child_pgrp",
      "child_session",
      "recorded_at"
    ]);
    expect(db.pragma("table_info('sessions')")).toEqual([
      { cid: 0, name: "session_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
      { cid: 1, name: "conversation_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
      { cid: 2, name: "conversation_cursor", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 3, name: "model", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 4, name: "effort", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 5, name: "mode", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 6, name: "cwd", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 7, name: "roots_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 8, name: "v2_user_message_ids_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 9, name: "updated_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 }
    ]);
    expect(
      (db.pragma("index_list('sessions')") as Array<{ name: string; origin: string }>)
        .filter((index) => index.origin === "c")
        .map((index) => index.name)
        .sort()
    ).toEqual(["sessions_cwd_updated_at_session_id", "sessions_updated_at_session_id"]);
    expect((db.pragma("table_info('delivery_claim_leases')") as Array<{ name: string }>).map((column) => column.name)).toEqual([
      "event_id",
      "request_id",
      "owner_instance_id",
      "claim_generation",
      "state",
      "heartbeat_at",
      "lease_expires_at",
      "terminal_replay_count",
      "replay_reserved_at",
      "settled_at",
      "updated_at"
    ]);
    expect(db.pragma("table_info('events')")).toEqual([
      { cid: 0, name: "event_seq", type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
      { cid: 1, name: "kind", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 2, name: "from_state", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 3, name: "to_state", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 4, name: "occurred_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
      { cid: 5, name: "correlation_hmac", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 }
    ]);
  });

  it("upgrades a current v9 database with an empty journal and no fabricated history", () => {
    const legacy = currentDatabase();
    downgradeToVersionNine(legacy);
    legacy.prepare("INSERT INTO cooldowns (provider, model, not_before, updated_at) VALUES (?, ?, ?, ?)").run(
      "antigravity",
      "model-1",
      2_000,
      1_000
    );

    const migrated = new AdmissionController({ databasePath: legacy.name, policy: DEFAULT_POLICY });

    expect(migrated.schemaVersion).toBe(10);
    expect(assertAdmissionSchemaIntegrity(legacy)).toBeUndefined();
    expect(legacy.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
    expect(legacy.prepare("SELECT provider, model FROM cooldowns").all()).toEqual([
      { provider: "antigravity", model: "model-1" }
    ]);
    migrated.close();
  });

  it("rolls back the v10 journal migration when its canonical index name conflicts", () => {
    const legacy = currentDatabase();
    downgradeToVersionNine(legacy);
    legacy.exec("CREATE INDEX events_occurred ON cooldowns(updated_at)");

    expect(() => new AdmissionController({ databasePath: legacy.name, policy: DEFAULT_POLICY })).toThrow(
      /events_occurred/i
    );
    expect(legacy.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 9 });
    expect(legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'").get()).toBeUndefined();
  });

  it("upgrades a current v6 database to the sessions contract", () => {
    const legacy = currentDatabase();
    downgradeToVersionSix(legacy);

    const migrated = new AdmissionController({ databasePath: legacy.name, policy: DEFAULT_POLICY });

    expect(migrated.schemaVersion).toBe(10);
    expect(assertAdmissionSchemaIntegrity(legacy)).toBeUndefined();
    migrated.close();
  });

  it("rolls back the v7 sessions migration when an index name conflicts", () => {
    const legacy = currentDatabase();
    downgradeToVersionSix(legacy);
    legacy.exec("CREATE INDEX sessions_updated_at_session_id ON cooldowns(updated_at)");

    expect(() => new AdmissionController({ databasePath: legacy.name, policy: DEFAULT_POLICY })).toThrow(
      /sessions_updated_at_session_id/i
    );
    expect(legacy.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 6 });
    expect(legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get()).toBeUndefined();
  });

  it("upgrades a current v7 database to the atomic process-dispatch contract", () => {
    const legacy = currentDatabase();
    downgradeToVersionSeven(legacy);

    const migrated = new AdmissionController({ databasePath: legacy.name, policy: DEFAULT_POLICY });

    expect(migrated.schemaVersion).toBe(10);
    expect(assertAdmissionSchemaIntegrity(legacy)).toBeUndefined();
    migrated.close();
  });

  it("upgrades v8 claimed deliveries to recovery while preserving pending and delivered rows", () => {
    const legacy = currentDatabase();
    downgradeToVersionEight(legacy);
    legacy.exec(`
      INSERT INTO turn_requests
        (request_id, session_id, parent_id, fingerprint, provider, model, state, enqueued_at, deadline_at, lease_generation)
      VALUES
        ('v8-claimed-request', 'session-claimed', 'parent-claimed', 'fingerprint-claimed', 'antigravity', 'model-1', 'queued', 1000, 2000, 0),
        ('v8-pending-request', 'session-pending', 'parent-pending', 'fingerprint-pending', 'antigravity', 'model-1', 'queued', 1001, 2001, 0),
        ('v8-delivered-request', 'session-delivered', 'parent-delivered', 'fingerprint-delivered', 'antigravity', 'model-1', 'queued', 1002, 2002, 0);
      INSERT INTO delivery_outbox
        (event_id, request_id, fingerprint, state, nonce, ciphertext, auth_tag, expires_at, created_at, key_version,
         sequence, protocol_version, protocol_semantics, claim_generation, claim_owner_instance_id, claim_acquired_at)
      VALUES
        ('v8-claimed-event', 'v8-claimed-request', 'fingerprint-claimed', 'claimed', X'01', X'02', X'03', 5000, 1000, 1, 0, 1, 'at-least-once', 4, 'legacy-owner', 1003),
        ('v8-pending-event', 'v8-pending-request', 'fingerprint-pending', 'pending', X'04', X'05', X'06', 5000, 1001, 1, 0, 1, 'at-least-once', 0, NULL, NULL),
        ('v8-delivered-event', 'v8-delivered-request', 'fingerprint-delivered', 'delivered', NULL, NULL, NULL, 5000, 1002, 1, 0, 1, 'at-least-once', 1, 'old-owner', 1004);
    `);

    const migrated = new AdmissionController({ databasePath: legacy.name, policy: DEFAULT_POLICY });

    expect(migrated.schemaVersion).toBe(10);
    expect(
      legacy
        .prepare(
          `SELECT event_id, state, nonce IS NOT NULL AS has_payload
           FROM delivery_outbox WHERE event_id LIKE 'v8-%' ORDER BY event_id ASC`
        )
        .all()
    ).toEqual([
      { event_id: "v8-claimed-event", state: "recovery_required", has_payload: 0 },
      { event_id: "v8-delivered-event", state: "delivered", has_payload: 0 },
      { event_id: "v8-pending-event", state: "pending", has_payload: 1 }
    ]);
    expect(legacy.prepare("SELECT COUNT(*) AS count FROM delivery_claim_leases").get()).toEqual({ count: 0 });
    migrated.close();
  });

  it("fails closed for v7 in-flight leases that have no durable process identity", () => {
    const legacy = currentDatabase();
    legacy
      .prepare(
        `INSERT INTO turn_requests
          (request_id, session_id, parent_id, fingerprint, provider, model, state, enqueued_at, deadline_at, lease_generation)
         VALUES (?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?)`
      )
      .run("v7-inflight", "session-1", "parent-1", "fingerprint-1", "antigravity", "model-1", 1_000, 2_000, 1);
    legacy
      .prepare(
        `INSERT INTO leases (lease_id, request_id, generation, owner_instance_id, phase, acquired_at, heartbeat_at)
         VALUES (?, ?, ?, ?, 'starting', ?, ?)`
      )
      .run("lease-v7-inflight", "v7-inflight", 1, "owner-v7", 1_000, 1_000);
    downgradeToVersionSeven(legacy);

    const migrated = new AdmissionController({ databasePath: legacy.name, policy: DEFAULT_POLICY });

    expect(legacy.prepare("SELECT state FROM turn_requests WHERE request_id = 'v7-inflight'").get()).toEqual({
      state: "recovery_required"
    });
    expect(legacy.prepare("SELECT phase FROM leases WHERE lease_id = 'lease-v7-inflight'").get()).toEqual({
      phase: "recovery_required"
    });
    migrated.close();
  });

  it("rolls back the v8 process-identity migration when its request index name conflicts", () => {
    const legacy = currentDatabase();
    downgradeToVersionSeven(legacy);
    legacy.exec("CREATE INDEX lease_process_identities_request ON cooldowns(updated_at)");

    expect(() => new AdmissionController({ databasePath: legacy.name, policy: DEFAULT_POLICY })).toThrow(
      /lease_process_identities_request/i
    );
    expect(legacy.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 7 });
    expect(
      legacy.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lease_process_identities'").get()
    ).toBeUndefined();
  });

  it("requires foreign key enforcement to already be enabled", () => {
    const db = currentDatabase();
    db.pragma("foreign_keys = OFF");

    expectSchemaFailure(db, /foreign_keys=ON/);
  });

  it("rejects a fake MAX schema version when a ledger version is missing", () => {
    const db = currentDatabase();
    db.prepare("DELETE FROM schema_migrations WHERE version = 5").run();

    expect(db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 10 });
    expectSchemaFailure(db, /migration ledger.*version 5/i);
  });

  it("rejects wrong migration names and unexpected ledger versions", () => {
    const wrongName = currentDatabase();
    wrongName.prepare("UPDATE schema_migrations SET name = ? WHERE version = 2").run("not-provider-terminal-proof");
    expectSchemaFailure(wrongName, /migration 2/i);

    const extraVersion = currentDatabase();
    extraVersion
      .prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (11, 'future', 11_000)")
      .run();
    expectSchemaFailure(extraVersion, /migration ledger/i);
  });

  it("rejects missing and extra columns", () => {
    expectSchemaFailure(schemaFixture({ deliveryOutboxSettledAt: "" }), /delivery_outbox.*columns/i);
    expectSchemaFailure(schemaFixture({ deliveryClaimLeaseExtraColumn: "unexpected TEXT" }), /delivery_claim_leases.*columns/i);
    expectSchemaFailure(schemaFixture({ turnRequestsExtraColumn: "unexpected TEXT" }), /turn_requests.*columns/i);
    expectSchemaFailure(schemaFixture({ sessionsExtraColumn: "prompt TEXT" }), /sessions.*columns/i);
    expectSchemaFailure(schemaFixture({ processIdentityExtraColumn: "unexpected TEXT" }), /lease_process_identities.*columns/i);
    expectSchemaFailure(schemaFixture({ eventsExtraColumn: "request_id TEXT" }), /events.*columns/i);
    expectSchemaFailure(schemaFixture({ eventsSequence: "INTEGER PRIMARY KEY" }), /events.*definition/i);
  }, 15_000);

  it("rejects altered primary keys, nullability, and unique constraints", () => {
    expectSchemaFailure(schemaFixture({ turnRequestId: "TEXT NOT NULL" }), /turn_requests.*request_id/i);
    expectSchemaFailure(schemaFixture({ sessionId: "TEXT" }), /turn_requests.*session_id/i);
    expectSchemaFailure(schemaFixture({ leasesRequestId: "TEXT NOT NULL REFERENCES turn_requests(request_id)" }), /leases.*unique/i);
    expectSchemaFailure(schemaFixture({ sessionsSessionId: "TEXT PRIMARY KEY" }), /sessions.*session_id/i);
    expectSchemaFailure(schemaFixture({ sessionsMode: "TEXT" }), /sessions.*mode/i);
    expectSchemaFailure(
      schemaFixture({ processIdentityLeaseId: "TEXT PRIMARY KEY REFERENCES leases(lease_id)" }),
      /lease_process_identities.*foreign key/i
    );
  });

  it("rejects an altered foreign key definition", () => {
    expectSchemaFailure(
      schemaFixture({ payloadRequestId: "TEXT PRIMARY KEY REFERENCES turn_requests(request_id)" }),
      /turn_payloads.*foreign key/i
    );
  });

  it("rejects missing, malformed, and extra named indexes", () => {
    expectSchemaFailure(schemaFixture({ turnRequestsQueueIndex: "" }), /turn_requests.*indexes/i);
    expectSchemaFailure(
      schemaFixture({ turnRequestsQueueIndex: "CREATE INDEX turn_requests_queue ON turn_requests(enqueued_at, state);" }),
      /turn_requests.*index/i
    );
    expectSchemaFailure(schemaFixture({ sessionsUpdatedAtIndex: "" }), /sessions.*indexes/i);
    expectSchemaFailure(
      schemaFixture({ sessionsUpdatedAtIndex: "CREATE INDEX sessions_updated_at_session_id ON sessions(updated_at, session_id);" }),
      /sessions.*index/i
    );
    expectSchemaFailure(schemaFixture({ processIdentityRequestIndex: "" }), /lease_process_identities.*indexes/i);
    expectSchemaFailure(
      schemaFixture({ processIdentityRequestIndex: "CREATE INDEX lease_process_identities_request ON lease_process_identities(request_id);" }),
      /lease_process_identities.*index/i
    );
    expectSchemaFailure(schemaFixture({ deliveryClaimLeaseExpiryIndex: "" }), /delivery_claim_leases.*indexes/i);
    expectSchemaFailure(
      schemaFixture({ deliveryClaimLeaseExpiryIndex: "CREATE INDEX delivery_claim_leases_expiry ON delivery_claim_leases(lease_expires_at, state);" }),
      /delivery_claim_leases.*index/i
    );
    expectSchemaFailure(schemaFixture({ eventsOccurredIndex: "" }), /events.*indexes/i);
    expectSchemaFailure(
      schemaFixture({ eventsOccurredIndex: "CREATE INDEX events_occurred ON events(event_seq, occurred_at);" }),
      /events.*index/i
    );
    expectSchemaFailure(schemaFixture({ extraIndex: "CREATE INDEX unexpected_index ON cooldowns(updated_at);" }), /cooldowns.*indexes/i);
  });
});
