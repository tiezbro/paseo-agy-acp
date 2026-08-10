import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  commitLegacySessionCutover,
  defaultLegacySessionBackupPath,
  LEGACY_MAX_FILE_BYTES,
  LEGACY_MAX_MESSAGE_IDS_PER_SESSION,
  LEGACY_MAX_ROOTS_PER_SESSION,
  LEGACY_MAX_SESSIONS,
  inspectLegacySessionStore,
  inspectLegacySessionMigration,
  LegacyStatePreflightError,
  migrateLegacySessions,
  rollbackLegacySessionMigration
} from "../src/admission/migration.js";

const stateDirs: string[] = [];

function stateFile(): string {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-migration-"));
  stateDirs.push(stateDir);
  return path.join(stateDir, "sessions.json");
}

function validSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cwd: "/work/project",
    conversationId: "conversation-1",
    lastStepIdx: 42,
    model: "claude-opus-4-6-thinking",
    reasoningEffort: "high",
    mode: "accept-edits",
    v2UserMessageIdsByStep: { "42": "message-42" },
    updatedAt: "2026-08-09T00:00:00.000Z",
    ...overrides
  };
}

function writeStore(file: string, sessions: Record<string, unknown>, extra: Record<string, unknown> = {}): void {
  writeFileSync(file, JSON.stringify({ sessions, ...extra }));
}

function expectPreflightFailure(file: string, matcher: RegExp): void {
  expect(() => inspectLegacySessionStore(file)).toThrow(matcher);
}

interface MigrationFixture {
  stateDir: string;
  legacyFile: string;
  databasePath: string;
  backupFile: string;
}

function migrationFixture(): MigrationFixture {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-migration-runtime-"));
  stateDirs.push(stateDir);
  const legacyFile = path.join(stateDir, "sessions.json");
  const databasePath = path.join(stateDir, "runtime.sqlite");
  createSessionsDatabase(databasePath);
  return {
    stateDir,
    legacyFile,
    databasePath,
    backupFile: defaultLegacySessionBackupPath(legacyFile)
  };
}

function createSessionsDatabase(databasePath: string): void {
  const db = new Database(databasePath);
  db.exec(`
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
    CREATE INDEX sessions_updated_at_session_id ON sessions(updated_at DESC, session_id ASC);
    CREATE INDEX sessions_cwd_updated_at_session_id ON sessions(cwd, updated_at DESC, session_id ASC);
  `);
  db.close();
}

function migrationOptions(fixture: MigrationFixture) {
  return {
    legacyFile: fixture.legacyFile,
    databasePath: fixture.databasePath,
    backupFile: fixture.backupFile
  };
}

function databaseRows(databasePath: string): Record<string, unknown>[] {
  const db = new Database(databasePath, { readonly: true });
  const rows = db.prepare("SELECT * FROM sessions ORDER BY session_id ASC").all() as Record<string, unknown>[];
  db.close();
  return rows;
}

function migrationLedger(databasePath: string): Record<string, unknown> | undefined {
  const db = new Database(databasePath, { readonly: true });
  const row = db
    .prepare("SELECT * FROM legacy_session_migration WHERE singleton = 1")
    .get() as Record<string, unknown> | undefined;
  db.close();
  return row;
}

afterEach(() => {
  for (const stateDir of stateDirs.splice(0)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

describe("legacy session preflight", () => {
  it("accepts a missing legacy store without inventing sessions", () => {
    expect(inspectLegacySessionStore(stateFile())).toEqual({ status: "absent", sessions: [] });
  });

  it("retains the defaults genuinely supplied by SessionStore for an incomplete legacy session", () => {
    const file = stateFile();
    writeStore(file, { "session-1": { cwd: "/work/project" } });

    expect(inspectLegacySessionStore(file)).toEqual({
      status: "valid",
      sessions: [
        {
          sessionId: "session-1",
          cwd: "/work/project",
          additionalDirectories: [],
          conversationId: null,
          lastStepIdx: -1,
          model: "",
          reasoningEffort: "",
          v2UserMessageIdsByStep: {},
          updatedAt: "1970-01-01T00:00:00.000Z"
        }
      ]
    });
  });

  it("accepts a present root without sessions because SessionStore defaults it to an empty map", () => {
    const file = stateFile();
    writeFileSync(file, "{}");

    expect(inspectLegacySessionStore(file)).toEqual({ status: "valid", sessions: [] });
  });

  it("normalizes a valid legacy session without retaining the raw disk object", () => {
    const file = stateFile();
    writeFileSync(
      file,
      JSON.stringify({
        sessions: {
          "session-1": {
            cwd: "/work/project",
            workspaces: ["/work/project", "/work/shared"],
            conversationId: "conversation-1",
            lastStepIdx: 42,
            modelId: "claude-opus-4-6-thinking",
            reasoningEffect: "high",
            mode: "dangerously-skip-permissions",
            v2UserMessageIdsByStep: { "42": "message-42" },
            updatedAt: "2026-08-09T00:00:00.000Z"
          }
        }
      })
    );

    expect(inspectLegacySessionStore(file)).toEqual({
      status: "valid",
      sessions: [
        {
          sessionId: "session-1",
          cwd: "/work/project",
          additionalDirectories: ["/work/shared"],
          conversationId: "conversation-1",
          lastStepIdx: 42,
          model: "claude-opus-4-6-thinking",
          reasoningEffort: "high",
          mode: "dangerously-skip-permissions",
          v2UserMessageIdsByStep: { "42": "message-42" },
          updatedAt: "2026-08-09T00:00:00.000Z"
        }
      ]
    });
  });

  it("rejects malformed or structurally invalid legacy state instead of treating it as empty", () => {
    const malformed = stateFile();
    writeFileSync(malformed, "{not json");
    expect(() => inspectLegacySessionStore(malformed)).toThrow(LegacyStatePreflightError);

    const invalid = stateFile();
    writeFileSync(invalid, JSON.stringify({ sessions: { "session-1": { cwd: 42 } } }));
    expect(() => inspectLegacySessionStore(invalid)).toThrow(/cwd/);
  });

  it("rejects resolvable and broken sessions.json symlinks instead of treating either as absent", () => {
    const resolvable = stateFile();
    writeFileSync(path.join(path.dirname(resolvable), "target.json"), "{}");
    symlinkSync("target.json", resolvable);
    expect(() => inspectLegacySessionStore(resolvable)).toThrow(/regular file/);

    const file = stateFile();
    symlinkSync("missing-target.json", file);

    expect(() => inspectLegacySessionStore(file)).toThrow(/regular file/);
  });

  it("rejects non-regular files and non-ENOENT metadata failures instead of treating them as absent", () => {
    const directory = stateFile();
    mkdirSync(directory);
    expectPreflightFailure(directory, /regular file/);

    const file = stateFile();
    writeFileSync(file, "{}");
    expectPreflightFailure(path.join(file, "nested"), /metadata is unreadable/);
  });

  it("rejects invalid UTF-8 before attempting JSON parsing", () => {
    const file = stateFile();
    writeFileSync(file, Buffer.from([0x7b, 0xc3, 0x28, 0x7d]));

    expectPreflightFailure(file, /invalid UTF-8/);
  });

  it("rejects duplicate JSON object keys at every level", () => {
    const rootDuplicate = stateFile();
    writeFileSync(rootDuplicate, '{"sessions":{},"sessions":{}}');
    expectPreflightFailure(rootDuplicate, /duplicate JSON key/);

    const escapedRootDuplicate = stateFile();
    writeFileSync(escapedRootDuplicate, '{"sessions":{},"s\\u0065ssions":{}}');
    expectPreflightFailure(escapedRootDuplicate, /duplicate JSON key/);

    const sessionDuplicate = stateFile();
    writeFileSync(
      sessionDuplicate,
      '{"sessions":{"session-1":{"cwd":"/work/project","cwd":"/work/other"}}}'
    );
    expectPreflightFailure(sessionDuplicate, /duplicate JSON key/);
  });

  it("rejects unknown top-level and session fields", () => {
    const topLevel = stateFile();
    writeStore(topLevel, {}, { unexpected: true });
    expectPreflightFailure(topLevel, /unknown top-level field/);

    const session = stateFile();
    writeStore(session, { "session-1": validSession({ unexpected: true }) });
    expectPreflightFailure(session, /unknown field/);
  });

  it("rejects conflicting aliases but accepts equivalent legacy aliases", () => {
    const modelConflict = stateFile();
    writeStore(modelConflict, { "session-1": validSession({ modelId: "other-model" }) });
    expectPreflightFailure(modelConflict, /conflicting aliases/);

    const rootsConflict = stateFile();
    writeStore(
      rootsConflict,
      { "session-1": validSession({ additionalDirectories: ["/work/shared"], workspaces: ["/work/project", "/work/other"] }) }
    );
    expectPreflightFailure(rootsConflict, /conflicting aliases/);

    const equivalent = stateFile();
    writeStore(
      equivalent,
      {
        "session-1": validSession({
          modelId: "claude-opus-4-6-thinking",
          reasoningEffect: "high",
          additionalDirectories: ["/work/shared"],
          workspaces: ["/work/project", "/work/shared"]
        })
      }
    );
    expect(inspectLegacySessionStore(equivalent).sessions[0]?.additionalDirectories).toEqual(["/work/shared"]);
  });

  it("rejects empty or NUL-bearing session, conversation, and message identities", () => {
    const emptySession = stateFile();
    writeStore(emptySession, { "": validSession() });
    expectPreflightFailure(emptySession, /session id/);

    const nulSession = stateFile();
    writeStore(nulSession, { "session\u0000-1": validSession() });
    expectPreflightFailure(nulSession, /session id/);

    const emptyConversation = stateFile();
    writeStore(emptyConversation, { "session-1": validSession({ conversationId: "" }) });
    expectPreflightFailure(emptyConversation, /conversationId/);

    const nulMessage = stateFile();
    writeStore(nulMessage, { "session-1": validSession({ v2UserMessageIdsByStep: { "42": "message\u0000-42" } }) });
    expectPreflightFailure(nulMessage, /v2UserMessageIdsByStep/);
  });

  it("rejects relative, NUL-bearing, and duplicate workspace roots", () => {
    const relativeCwd = stateFile();
    writeStore(relativeCwd, { "session-1": validSession({ cwd: "project" }) });
    expectPreflightFailure(relativeCwd, /absolute path/);

    const relativeRoot = stateFile();
    writeStore(relativeRoot, { "session-1": validSession({ additionalDirectories: ["shared"] }) });
    expectPreflightFailure(relativeRoot, /absolute path/);

    const nulRoot = stateFile();
    writeStore(nulRoot, { "session-1": validSession({ additionalDirectories: ["/work/\u0000shared"] }) });
    expectPreflightFailure(nulRoot, /must not contain NUL/);

    const duplicateRoot = stateFile();
    writeStore(
      duplicateRoot,
      { "session-1": validSession({ additionalDirectories: ["/work/shared", "/work/other/../shared"] }) }
    );
    expectPreflightFailure(duplicateRoot, /duplicate root/);
  });

  it("rejects unsafe cursors and message step indexes", () => {
    const unsafeCursor = stateFile();
    writeStore(unsafeCursor, { "session-1": validSession({ lastStepIdx: Number.MAX_SAFE_INTEGER + 1 }) });
    expectPreflightFailure(unsafeCursor, /safe integer/);

    const unsafeMessageIndex = stateFile();
    writeStore(
      unsafeMessageIndex,
      { "session-1": validSession({ lastStepIdx: Number.MAX_SAFE_INTEGER, v2UserMessageIdsByStep: { "9007199254740992": "message" } }) }
    );
    expectPreflightFailure(unsafeMessageIndex, /v2UserMessageIdsByStep/);
  });

  it("rejects unsupported modes and invalid timestamps", () => {
    const mode = stateFile();
    writeStore(mode, { "session-1": validSession({ mode: "unsafe" }) });
    expectPreflightFailure(mode, /mode/);

    const time = stateFile();
    writeStore(time, { "session-1": validSession({ updatedAt: "2026-02-30T00:00:00.000Z" }) });
    expectPreflightFailure(time, /updatedAt/);
  });

  it("rejects message maps that are detached from a conversation or advance beyond its cursor", () => {
    const noConversation = stateFile();
    writeStore(
      noConversation,
      { "session-1": validSession({ conversationId: null, v2UserMessageIdsByStep: { "42": "message-42" } }) }
    );
    expectPreflightFailure(noConversation, /conversationId/);

    const beyondCursor = stateFile();
    writeStore(
      beyondCursor,
      { "session-1": validSession({ lastStepIdx: 41, v2UserMessageIdsByStep: { "42": "message-42" } }) }
    );
    expectPreflightFailure(beyondCursor, /beyond lastStepIdx/);
  });

  it("bounds legacy file, session, root, and message-map cardinality", () => {
    const largeFile = stateFile();
    writeFileSync(largeFile, Buffer.alloc(LEGACY_MAX_FILE_BYTES + 1, 0x20));
    expectPreflightFailure(largeFile, /too large/);

    const sessions = stateFile();
    writeStore(
      sessions,
      Object.fromEntries(Array.from({ length: LEGACY_MAX_SESSIONS + 1 }, (_, index) => [`session-${index}`, { cwd: "/work/project" }]))
    );
    expectPreflightFailure(sessions, /too many sessions/);

    const roots = stateFile();
    writeStore(
      roots,
      {
        "session-1": validSession({
          additionalDirectories: Array.from({ length: LEGACY_MAX_ROOTS_PER_SESSION }, (_, index) => `/work/root-${index}`)
        })
      }
    );
    expectPreflightFailure(roots, /too many roots/);

    const messages = stateFile();
    writeStore(
      messages,
      {
        "session-1": validSession({
          lastStepIdx: LEGACY_MAX_MESSAGE_IDS_PER_SESSION,
          v2UserMessageIdsByStep: Object.fromEntries(
            Array.from({ length: LEGACY_MAX_MESSAGE_IDS_PER_SESSION + 1 }, (_, index) => [String(index), `message-${index}`])
          )
        })
      }
    );
    expectPreflightFailure(messages, /too many message ids/);
  });
});

describe("legacy session migration", () => {
  it("imports every session field deterministically, verifies an exact backup, and persists a prepared cutover", () => {
    const fixture = migrationFixture();
    const source = JSON.stringify({
      sessions: {
        "session-z": validSession({
          cwd: "/work/z",
          additionalDirectories: ["/work/z/shared"],
          conversationId: "conversation-z",
          lastStepIdx: 7,
          model: "model-z",
          reasoningEffort: "medium",
          mode: "plan",
          v2UserMessageIdsByStep: { "7": "message-z-7", "1": "message-z-1" },
          updatedAt: "2026-08-09T00:00:07.000Z"
        }),
        "session-a": {
          cwd: "/work/a",
          workspaces: ["/work/a", "/work/a/shared"],
          conversationId: "conversation-a",
          lastStepIdx: 3,
          modelId: "model-a",
          reasoningEffect: "high",
          v2UserMessageIdsByStep: { "3": "message-a-3" },
          updatedAt: "2026-08-09T00:00:03.000Z"
        }
      }
    });
    writeFileSync(fixture.legacyFile, source);

    expect(migrateLegacySessions(migrationOptions(fixture))).toMatchObject({
      status: "prepared",
      cutoverCommitted: false,
      importedSessionCount: 2,
      backupFile: fixture.backupFile
    });

    expect(readFileSync(fixture.legacyFile, "utf8")).toBe(source);
    expect(readFileSync(fixture.backupFile, "utf8")).toBe(source);
    expect(lstatSync(fixture.backupFile).mode & 0o777).toBe(0o600);
    expect(databaseRows(fixture.databasePath)).toEqual([
      {
        session_id: "session-a",
        conversation_id: "conversation-a",
        conversation_cursor: 3,
        model: "model-a",
        effort: "high",
        mode: "default",
        cwd: "/work/a",
        roots_json: '["/work/a/shared"]',
        v2_user_message_ids_json: '{"3":"message-a-3"}',
        updated_at: Date.parse("2026-08-09T00:00:03.000Z")
      },
      {
        session_id: "session-z",
        conversation_id: "conversation-z",
        conversation_cursor: 7,
        model: "model-z",
        effort: "medium",
        mode: "plan",
        cwd: "/work/z",
        roots_json: '["/work/z/shared"]',
        v2_user_message_ids_json: '{"1":"message-z-1","7":"message-z-7"}',
        updated_at: Date.parse("2026-08-09T00:00:07.000Z")
      }
    ]);
    expect(migrationLedger(fixture.databasePath)).toMatchObject({
      singleton: 1,
      state: "prepared",
      cutover_committed: 0,
      source_path: fixture.legacyFile,
      backup_path: fixture.backupFile,
      session_count: 2
    });
  });

  it("recovers from a completed backup or prepared transaction and remains idempotent across reopen", () => {
    const fixture = migrationFixture();
    const source = JSON.stringify({ sessions: { "session-1": validSession() } });
    writeFileSync(fixture.legacyFile, source);
    writeFileSync(fixture.backupFile, source, { mode: 0o600 });

    const first = migrateLegacySessions(migrationOptions(fixture));
    const backupStat = lstatSync(fixture.backupFile);
    const second = migrateLegacySessions(migrationOptions(fixture));

    expect(first).toEqual(second);
    expect(second).toMatchObject({ status: "prepared", cutoverCommitted: false, importedSessionCount: 1 });
    expect(lstatSync(fixture.backupFile).ino).toBe(backupStat.ino);
    expect(databaseRows(fixture.databasePath)).toHaveLength(1);
    expect(inspectLegacySessionMigration(fixture.databasePath)).toEqual(second);
  });

  it("persists cutover_committed and makes commit idempotent without removing the legacy source", () => {
    const fixture = migrationFixture();
    const source = JSON.stringify({ sessions: { "session-1": validSession() } });
    writeFileSync(fixture.legacyFile, source);
    migrateLegacySessions(migrationOptions(fixture));

    const committed = commitLegacySessionCutover(migrationOptions(fixture));
    expect(committed).toMatchObject({ status: "committed", cutoverCommitted: true, importedSessionCount: 1 });
    expect(commitLegacySessionCutover(migrationOptions(fixture))).toEqual(committed);
    expect(migrateLegacySessions(migrationOptions(fixture))).toEqual(committed);
    expect(inspectLegacySessionMigration(fixture.databasePath)).toEqual(committed);
    expect(migrationLedger(fixture.databasePath)).toMatchObject({ state: "committed", cutover_committed: 1 });
    expect(readFileSync(fixture.legacyFile, "utf8")).toBe(source);
    expect(readFileSync(fixture.backupFile, "utf8")).toBe(source);
  });

  it("rolls back only a prepared import, records the rollback, and never deletes source or backup", () => {
    const fixture = migrationFixture();
    const source = JSON.stringify({ sessions: { "session-1": validSession() } });
    writeFileSync(fixture.legacyFile, source);
    migrateLegacySessions(migrationOptions(fixture));

    const rolledBack = rollbackLegacySessionMigration(migrationOptions(fixture));
    expect(rolledBack).toMatchObject({ status: "rolled_back", cutoverCommitted: false, importedSessionCount: 1 });
    expect(rollbackLegacySessionMigration(migrationOptions(fixture))).toEqual(rolledBack);
    expect(migrateLegacySessions(migrationOptions(fixture))).toEqual(rolledBack);
    expect(databaseRows(fixture.databasePath)).toEqual([]);
    expect(migrationLedger(fixture.databasePath)).toMatchObject({ state: "rolled_back", cutover_committed: 0 });
    expect(readFileSync(fixture.legacyFile, "utf8")).toBe(source);
    expect(readFileSync(fixture.backupFile, "utf8")).toBe(source);
    expect(() => commitLegacySessionCutover(migrationOptions(fixture))).toThrow(/rolled back/);
  });

  it("forbids rollback after cutover and leaves all imported state intact", () => {
    const fixture = migrationFixture();
    writeStore(fixture.legacyFile, { "session-1": validSession() });
    migrateLegacySessions(migrationOptions(fixture));
    commitLegacySessionCutover(migrationOptions(fixture));

    expect(() => rollbackLegacySessionMigration(migrationOptions(fixture))).toThrow(/cutover is committed/);
    expect(databaseRows(fixture.databasePath)).toHaveLength(1);
    expect(existsSync(fixture.legacyFile)).toBe(true);
  });

  it("fails closed on target conflicts, backup ambiguity, or source drift", () => {
    const targetConflict = migrationFixture();
    writeStore(targetConflict.legacyFile, { "session-1": validSession() });
    const db = new Database(targetConflict.databasePath);
    db.prepare(
      `INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("existing", null, -1, "", "", "default", "/existing", "[]", "{}", 0);
    db.close();
    expect(() => migrateLegacySessions(migrationOptions(targetConflict))).toThrow(/target sessions table is not empty/);
    expect(existsSync(targetConflict.backupFile)).toBe(false);
    expect(databaseRows(targetConflict.databasePath)).toHaveLength(1);

    const backupConflict = migrationFixture();
    writeStore(backupConflict.legacyFile, { "session-1": validSession() });
    writeFileSync(backupConflict.backupFile, "different", { mode: 0o600 });
    expect(() => migrateLegacySessions(migrationOptions(backupConflict))).toThrow(/backup does not match/);
    expect(databaseRows(backupConflict.databasePath)).toEqual([]);

    const sourceDrift = migrationFixture();
    writeStore(sourceDrift.legacyFile, { "session-1": validSession() });
    migrateLegacySessions(migrationOptions(sourceDrift));
    writeStore(sourceDrift.legacyFile, { "session-1": validSession({ lastStepIdx: 43, v2UserMessageIdsByStep: { "43": "message-43" } }) });
    expect(() => migrateLegacySessions(migrationOptions(sourceDrift))).toThrow(/source changed after migration/);
    expect(() => commitLegacySessionCutover(migrationOptions(sourceDrift))).toThrow(/source changed after migration/);
  });

  it("refuses rollback when imported rows changed and does not partially delete data", () => {
    const fixture = migrationFixture();
    writeStore(fixture.legacyFile, {
      "session-1": validSession(),
      "session-2": validSession({ conversationId: "conversation-2" })
    });
    migrateLegacySessions(migrationOptions(fixture));
    const db = new Database(fixture.databasePath);
    db.prepare("UPDATE sessions SET conversation_cursor = ? WHERE session_id = ?").run(99, "session-1");
    db.close();

    expect(() => rollbackLegacySessionMigration(migrationOptions(fixture))).toThrow(/imported sessions no longer match/);
    expect(databaseRows(fixture.databasePath)).toHaveLength(2);
    expect(migrationLedger(fixture.databasePath)).toMatchObject({ state: "prepared", cutover_committed: 0 });
  });

  it("does not create a backup or migration record for absent, damaged, or ambiguous legacy input", () => {
    const absent = migrationFixture();
    expect(migrateLegacySessions(migrationOptions(absent))).toEqual({
      status: "absent",
      cutoverCommitted: false,
      importedSessionCount: 0,
      backupFile: absent.backupFile
    });
    expect(existsSync(absent.backupFile)).toBe(false);
    expect(inspectLegacySessionMigration(absent.databasePath)).toEqual({ status: "not_started" });

    const damaged = migrationFixture();
    writeFileSync(damaged.legacyFile, "{not-json");
    expect(() => migrateLegacySessions(migrationOptions(damaged))).toThrow(LegacyStatePreflightError);
    expect(existsSync(damaged.backupFile)).toBe(false);
    expect(inspectLegacySessionMigration(damaged.databasePath)).toEqual({ status: "not_started" });

    const ambiguous = migrationFixture();
    writeFileSync(ambiguous.legacyFile, '{"sessions":{},"sessions":{}}');
    expect(() => migrateLegacySessions(migrationOptions(ambiguous))).toThrow(LegacyStatePreflightError);
    expect(existsSync(ambiguous.backupFile)).toBe(false);
    expect(() => commitLegacySessionCutover(migrationOptions(ambiguous))).toThrow(LegacyStatePreflightError);
  });
});
