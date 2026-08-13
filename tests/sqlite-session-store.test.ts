import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AdmissionController, type AdmissionPolicy } from "../src/admission/controller.js";
import { SQLiteSessionStore, SQLiteSessionStoreError } from "../src/agy/acp/session/sqlite-store.js";
import type { SessionStoreBackend, StoredSession } from "../src/agy/acp/session/store.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(repositoryRoot, "tests/helpers/sqlite-session-store-child.mjs");
const stateDirs: string[] = [];
const workerBuildDir = mkdtempSync(path.join(repositoryRoot, ".tmp-sqlite-session-build-"));
let workerStoreModule = "";
const DEFAULT_POLICY: AdmissionPolicy = {
  maxActiveTurns: 1,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

beforeAll(() => {
  execFileSync(
    process.execPath,
    [
      path.join(repositoryRoot, "node_modules/typescript/bin/tsc"),
      "--ignoreConfig",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--strict",
      "--skipLibCheck",
      "--declaration",
      "--sourceMap",
      "--rootDir",
      "src",
      "--outDir",
      workerBuildDir,
      "src/agy/acp/session/sqlite-store.ts"
    ],
    { cwd: repositoryRoot, stdio: "inherit" }
  );
  workerStoreModule = path.join(workerBuildDir, "agy/acp/session/sqlite-store.js");
});

afterAll(() => {
  rmSync(workerBuildDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const stateDir of stateDirs.splice(0)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

describe("SQLiteSessionStore", () => {
  it("round-trips the complete session cursor and configuration without writing sessions.json", async () => {
    const { databasePath, stateDir } = createSessionDatabase();
    const store = new SQLiteSessionStore(databasePath);
    acceptsSessionStoreBackend(store);

    const first = sessionRecord({
      conversationId: "conversation-first",
      lastStepIdx: 3,
      model: "gemini-3.5-flash",
      reasoningEffort: "medium",
      mode: "plan",
      cwd: "/workspace/first",
      additionalDirectories: ["/workspace/first/shared"],
      v2UserMessageIdsByStep: { "1": "message-first-1", "3": "message-first-3" },
      updatedAt: "2026-08-09T10:00:00.000Z"
    });
    const replacement = sessionRecord({
      conversationId: "conversation-replacement",
      lastStepIdx: 7,
      model: "claude-opus-4-6-thinking",
      reasoningEffort: "",
      mode: "accept-edits",
      cwd: "/workspace/replacement",
      additionalDirectories: ["/workspace/replacement/shared", "/workspace/replacement/tools"],
      v2UserMessageIdsByStep: { "7": "message-replacement-7" },
      updatedAt: "2026-08-09T10:01:00.000Z"
    });
    const other = sessionRecord({
      cwd: "/workspace/other",
      additionalDirectories: [],
      updatedAt: "2026-08-09T10:02:00.000Z"
    });

    await store.persist("session-1", first);
    await store.persist("session-1", replacement);
    await store.persist("session-2", other);

    expect(await store.restore("session-1")).toEqual(replacement);
    expect(await store.list()).toEqual([
      { sessionId: "session-2", ...other },
      { sessionId: "session-1", ...replacement }
    ]);
    expect(await store.list({ cwd: "/workspace/replacement" })).toEqual([
      { sessionId: "session-1", ...replacement }
    ]);
    expect(existsSync(path.join(stateDir, "sessions.json"))).toBe(false);

    const db = new Database(databasePath, { readonly: true });
    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("session-1") as Record<string, unknown>;
    db.close();
    expect(Object.keys(row)).toEqual([
      "session_id",
      "conversation_id",
      "conversation_cursor",
      "model",
      "effort",
      "mode",
      "cwd",
      "roots_json",
      "v2_user_message_ids_json",
      "updated_at"
    ]);
    expect(row).toMatchObject({
      session_id: "session-1",
      conversation_id: replacement.conversationId,
      conversation_cursor: replacement.lastStepIdx,
      model: replacement.model,
      effort: replacement.reasoningEffort,
      mode: replacement.mode,
      cwd: replacement.cwd,
      roots_json: JSON.stringify(replacement.additionalDirectories),
      v2_user_message_ids_json: JSON.stringify(replacement.v2UserMessageIdsByStep),
      updated_at: Date.parse(replacement.updatedAt)
    });
    expect(await store.delete("session-2")).toBe(true);
    expect(await store.restore("session-2")).toBeNull();
    expect(await store.delete("session-2")).toBe(false);
    store.close();
  });

  it("round-trips a canonical timestamp through INTEGER updated_at storage", async () => {
    const { databasePath } = createSessionDatabase();
    const store = new SQLiteSessionStore(databasePath);
    const session = sessionRecord({ updatedAt: "2026-08-09T10:03:04.005Z" });

    await store.persist("integer-timestamp", session);
    expect(await store.restore("integer-timestamp")).toEqual(session);

    const db = new Database(databasePath, { readonly: true });
    const row = db.prepare("SELECT updated_at FROM sessions WHERE session_id = ?").get("integer-timestamp") as {
      updated_at: number;
    };
    db.close();
    expect(row.updated_at).toBe(Date.parse(session.updatedAt));
    store.close();
  });

  it("does not serialize raw prompt-like fields into the sessions table", async () => {
    const { databasePath } = createSessionDatabase();
    const store = new SQLiteSessionStore(databasePath);
    const rawPrompt = "raw prompt must never be persisted";
    const session = Object.assign(sessionRecord(), {
      prompt: rawPrompt,
      credentials: "credential-value",
      headers: { authorization: "Bearer secret" },
      transcript: "full transcript",
      reasoning: "private reasoning"
    }) as StoredSession;

    await store.persist("safe-session", session);

    const db = new Database(databasePath, { readonly: true });
    const row = db.prepare("SELECT * FROM sessions WHERE session_id = ?").get("safe-session");
    db.close();
    const stored = JSON.stringify(row);
    for (const forbidden of [rawPrompt, "credential-value", "Bearer secret", "full transcript", "private reasoning"]) {
      expect(stored).not.toContain(forbidden);
    }
    store.close();
  });

  it("fails closed for a malformed existing row", async () => {
    const { databasePath } = createSessionDatabase();
    const db = new Database(databasePath);
    db.prepare(
      `INSERT INTO sessions
        (session_id, conversation_id, conversation_cursor, model, effort, mode, cwd, roots_json, v2_user_message_ids_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      "malformed-session",
      "conversation-malformed",
      2,
      "model",
      "high",
      "plan",
      "/workspace/malformed",
      "not-json",
      "{}",
      Date.parse("2026-08-09T10:00:00.000Z")
    );
    db.close();

    const store = new SQLiteSessionStore(databasePath);
    await expect(store.restore("malformed-session")).rejects.toThrow(SQLiteSessionStoreError);
    await expect(store.list()).rejects.toThrow(SQLiteSessionStoreError);
    store.close();
  });

  it("fails closed for a partial table, arbitrary metadata column, or missing session index", () => {
    const partial = createSessionDatabase();
    const partialDb = new Database(partial.databasePath);
    partialDb.exec("ALTER TABLE sessions DROP COLUMN mode");
    partialDb.close();
    expect(() => new SQLiteSessionStore(partial.databasePath)).toThrow(SQLiteSessionStoreError);

    const metadata = createSessionDatabase();
    const metadataDb = new Database(metadata.databasePath);
    metadataDb.exec("ALTER TABLE sessions ADD COLUMN prompt TEXT");
    metadataDb.close();
    expect(() => new SQLiteSessionStore(metadata.databasePath)).toThrow(SQLiteSessionStoreError);

    const missingIndex = createSessionDatabase();
    const indexDb = new Database(missingIndex.databasePath);
    indexDb.exec("DROP INDEX sessions_cwd_updated_at_session_id");
    indexDb.close();
    expect(() => new SQLiteSessionStore(missingIndex.databasePath)).toThrow(SQLiteSessionStoreError);
  });

  it("rejects a partial write before it can replace a valid session", async () => {
    const { databasePath } = createSessionDatabase();
    const store = new SQLiteSessionStore(databasePath);
    const saved = sessionRecord();
    await store.persist("stable-session", saved);

    const partial = { ...sessionRecord({ model: "changed" }), mode: undefined } as unknown as StoredSession;
    await expect(store.persist("stable-session", partial)).rejects.toThrow(SQLiteSessionStoreError);
    expect(await store.restore("stable-session")).toEqual(saved);
    store.close();
  });

  it("fails closed when the required sessions table is absent", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-sqlite-session-"));
    stateDirs.push(stateDir);
    const databasePath = path.join(stateDir, "runtime.sqlite");
    new Database(databasePath).close();

    expect(() => new SQLiteSessionStore(databasePath)).toThrow(/sessions table/i);
  });

  it("preserves independent session writes from two processes", async () => {
    const { databasePath } = createSessionDatabase();
    const left = spawnWorker(databasePath, "session-left");
    const right = spawnWorker(databasePath, "session-right");
    await Promise.all([waitForLine(left, "ready"), waitForLine(right, "ready")]);
    left.stdin.write("go\n");
    left.stdin.end();
    right.stdin.write("go\n");
    right.stdin.end();
    await Promise.all([waitForExit(left), waitForExit(right)]);

    const store = new SQLiteSessionStore(databasePath);
    expect(await store.restore("session-left")).toMatchObject({
      conversationId: "conversation-session-left",
      lastStepIdx: 79,
      model: "model-session-left",
      cwd: "/workers/session-left"
    });
    expect(await store.restore("session-right")).toMatchObject({
      conversationId: "conversation-session-right",
      lastStepIdx: 79,
      model: "model-session-right",
      cwd: "/workers/session-right"
    });
    expect(await store.list()).toHaveLength(2);
    store.close();
  });
});

function acceptsSessionStoreBackend(_store: SessionStoreBackend): void {}

function createSessionDatabase(): { stateDir: string; databasePath: string } {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-sqlite-session-"));
  stateDirs.push(stateDir);
  const databasePath = path.join(stateDir, "runtime.sqlite");
  const controller = new AdmissionController({ databasePath, policy: DEFAULT_POLICY });
  controller.close();
  return { stateDir, databasePath };
}

function sessionRecord(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    cwd: overrides.cwd ?? "/workspace/default",
    additionalDirectories: overrides.additionalDirectories ?? ["/workspace/default/shared"],
    conversationId: overrides.conversationId ?? "conversation-default",
    lastStepIdx: overrides.lastStepIdx ?? 5,
    model: overrides.model ?? "gemini-3.5-flash",
    reasoningEffort: overrides.reasoningEffort ?? "high",
    mode: overrides.mode ?? "plan",
    v2UserMessageIdsByStep: overrides.v2UserMessageIdsByStep ?? { "5": "message-default-5" },
    updatedAt: overrides.updatedAt ?? "2026-08-09T10:00:00.000Z"
  };
}

function spawnWorker(databasePath: string, sessionId: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [workerPath, databasePath, sessionId, workerStoreModule], {
    cwd: repositoryRoot,
    stdio: "pipe"
  });
}

function waitForLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes(`${expected}\n`)) resolve();
    });
    child.stderr.on("data", (chunk: string) => {
      errorOutput += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`session-store child exited before ${expected}: ${code}: ${errorOutput}`)));
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  const [code] = await once(child, "exit") as [number | null];
  if (code !== 0) {
    throw new Error(`session-store child exited with ${code}`);
  }
}
