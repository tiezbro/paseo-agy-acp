import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { AdmissionController, type AdmissionPolicy } from "../Admission Controller/controller.js";
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

function createController(): AdmissionController {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-schema-"));
  stateDirs.push(stateDir);
  const admission = new AdmissionController({
    databasePath: path.join(stateDir, "runtime.sqlite"),
    policy: POLICY,
    encryptionKey: Buffer.alloc(32, 41),
    contentFingerprintKey: Buffer.alloc(32, 42)
  });
  controllers.push(admission);
  return admission;
}

afterEach(() => {
  for (const admission of controllers.splice(0)) admission.close();
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

describe("AdmissionController schema v1", () => {
  it("contains only the shared queue tables and the migration ledger", () => {
    const admission = createController();
    const db = new Database(admission.databasePath, { readonly: true });
    try {
      const tables = (db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>).map((row) => row.name);
      expect(tables).toEqual([
        "cooldowns",
        "events",
        "lease_process_identities",
        "leases",
        "schema_migrations",
        "sessions",
        "start_history",
        "turn_payloads",
        "turn_requests"
      ]);
      expect(tables).not.toContain("delivery_outbox");
      expect(tables).not.toContain("delivery_claim_leases");
      expect(tables).not.toContain("recovery_claims");
      expect(admission.schemaVersion).toBe(ADMISSION_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("rejects an old-scheme table instead of silently accepting mixed ownership", () => {
    const admission = createController();
    admission.close();
    controllers.splice(controllers.indexOf(admission), 1);

    const db = new Database(admission.databasePath);
    db.pragma("foreign_keys = ON");
    try {
      db.exec("CREATE TABLE delivery_outbox (event_id TEXT PRIMARY KEY)");
      expect(() => assertAdmissionSchemaIntegrity(db)).toThrow(SchemaIntegrityError);
      expect(() => assertAdmissionSchemaIntegrity(db)).toThrow(/unexpected table delivery_outbox/i);
    } finally {
      db.close();
    }
  });
});
