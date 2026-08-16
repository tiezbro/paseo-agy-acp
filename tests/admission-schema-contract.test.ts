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
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-schema-contract-"));
  stateDirs.push(stateDir);
  const admission = new AdmissionController({
    databasePath: path.join(stateDir, "runtime.sqlite"),
    policy: POLICY,
    encryptionKey: Buffer.alloc(32, 71),
    contentFingerprintKey: Buffer.alloc(32, 72)
  });
  controllers.push(admission);
  return admission;
}

function closeController(admission: AdmissionController): void {
  admission.close();
  const index = controllers.indexOf(admission);
  if (index >= 0) controllers.splice(index, 1);
}

function openDatabase(admission: AdmissionController): Database.Database {
  closeController(admission);
  const db = new Database(admission.databasePath);
  db.pragma("foreign_keys = ON");
  return db;
}

afterEach(() => {
  for (const admission of controllers.splice(0)) admission.close();
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

describe("Admission schema integrity contract v1", () => {
  it("accepts the legal v1 schema and migration ledger", () => {
    const admission = createController();
    const db = new Database(admission.databasePath, { readonly: true });
    try {
      db.pragma("foreign_keys = ON");
      expect(() => assertAdmissionSchemaIntegrity(db)).not.toThrow();
      expect(admission.schemaVersion).toBe(ADMISSION_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("rejects unexpected tables instead of accepting a second delivery authority", () => {
    const admission = createController();
    const db = openDatabase(admission);
    try {
      db.exec("CREATE TABLE outbox (event_id TEXT PRIMARY KEY)");
      expect(() => assertAdmissionSchemaIntegrity(db)).toThrow(SchemaIntegrityError);
      expect(() => assertAdmissionSchemaIntegrity(db)).toThrow(/unexpected table outbox/i);
    } finally {
      db.close();
    }
  });

  it("rejects a deleted v1 column instead of repairing the database", () => {
    const admission = createController();
    const db = openDatabase(admission);
    try {
      db.exec("ALTER TABLE turn_requests DROP COLUMN model");
      expect(() => assertAdmissionSchemaIntegrity(db)).toThrow(SchemaIntegrityError);
      expect(() => assertAdmissionSchemaIntegrity(db)).toThrow(/turn_requests columns do not match/i);
    } finally {
      db.close();
    }
  });

  it("rejects a connection that has foreign key enforcement disabled", () => {
    const admission = createController();
    const db = openDatabase(admission);
    try {
      db.pragma("foreign_keys = OFF");
      expect(() => assertAdmissionSchemaIntegrity(db)).toThrow(SchemaIntegrityError);
      expect(() => assertAdmissionSchemaIntegrity(db)).toThrow(/foreign_keys=ON/i);
    } finally {
      db.close();
    }
  });
});
