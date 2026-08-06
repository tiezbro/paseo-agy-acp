// Builds a throwaway agy-shaped conversation SQLite database for tests.

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

export function createConversationDb(dir: string, id: string): Database.Database {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, `${id}.db`));
  db.exec(
    "CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, status INTEGER, " +
      "step_payload BLOB, error_details BLOB, permissions BLOB, task_details BLOB)"
  );
  return db;
}

export function insertStep(
  db: Database.Database,
  row: {
    idx: number;
    stepType: number;
    status?: number;
    stepPayload: Uint8Array;
    permissions?: Uint8Array;
    errorDetails?: Uint8Array;
    task?: Uint8Array;
  }
): void {
  db.prepare(
    "INSERT INTO steps (idx, step_type, status, step_payload, permissions, error_details, task_details) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    row.idx,
    row.stepType,
    row.status ?? 3,
    Buffer.from(row.stepPayload),
    row.permissions ? Buffer.from(row.permissions) : null,
    row.errorDetails ? Buffer.from(row.errorDetails) : null,
    row.task ? Buffer.from(row.task) : null
  );
}

export function updateStepPayload(db: Database.Database, idx: number, stepPayload: Uint8Array): void {
  db.prepare("UPDATE steps SET step_payload = ? WHERE idx = ?").run(Buffer.from(stepPayload), idx);
}

export function updateStepStatus(db: Database.Database, idx: number, status: number): void {
  db.prepare("UPDATE steps SET status = ? WHERE idx = ?").run(status, idx);
}

export function updateStep(
  db: Database.Database,
  idx: number,
  patch: { status?: number; stepPayload?: Uint8Array }
): void {
  if (patch.status !== undefined && patch.stepPayload !== undefined) {
    db.prepare("UPDATE steps SET status = ?, step_payload = ? WHERE idx = ?").run(
      patch.status,
      Buffer.from(patch.stepPayload),
      idx
    );
    return;
  }
  if (patch.status !== undefined) updateStepStatus(db, idx, patch.status);
  if (patch.stepPayload !== undefined) updateStepPayload(db, idx, patch.stepPayload);
}
