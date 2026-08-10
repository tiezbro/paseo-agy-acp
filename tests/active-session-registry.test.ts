import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ActiveSessionAdvanceError,
  ActiveSessionLeaseFenceError,
  ActiveSessionRegistry,
  ActiveSessionRegistryError,
  type ActiveConnectorIdentity,
  type ActiveSessionRegistration
} from "../src/acp/session/active-registry.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(repositoryRoot, "tests/helpers/active-session-registry-child.mjs");
const stateDirs: string[] = [];
const workerBuildDir = mkdtempSync(path.join(repositoryRoot, ".tmp-active-session-registry-build-"));
let workerRegistryModule = "";

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
      "src/acp/session/active-registry.ts"
    ],
    { cwd: repositoryRoot, stdio: "inherit" }
  );
  workerRegistryModule = path.join(workerBuildDir, "acp/session/active-registry.js");
});

afterAll(() => {
  rmSync(workerBuildDir, { recursive: true, force: true });
});

afterEach(() => {
  for (const stateDir of stateDirs.splice(0)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

describe("ActiveSessionRegistry", () => {
  it("persists the allowlisted in-flight inventory in WAL and restores it after restart", () => {
    const { databasePath } = createRegistryDatabase();
    const first = new ActiveSessionRegistry(databasePath);
    const input = registration({ conversationId: null, cursor: -1 });
    const lease = first.register(input);
    first.advance(lease, { conversationId: "conversation-next", cursor: 8 });
    first.close();

    const resumed = new ActiveSessionRegistry(databasePath);
    expect(resumed.listInFlight()).toEqual([
      inventoryRecord({ ...input, conversationId: "conversation-next", cursor: 8 }, 1)
    ]);

    const db = new Database(databasePath, { readonly: true });
    const journalMode = db.pragma("journal_mode", { simple: true });
    const row = db.prepare("SELECT * FROM active_antigravity_sessions WHERE request_id = ?").get(input.requestId) as Record<
      string,
      unknown
    >;
    db.close();

    expect(String(journalMode).toLowerCase()).toBe("wal");
    expect(Object.keys(row)).toEqual([
      "request_id",
      "agent_id",
      "session_id",
      "conversation_id",
      "conversation_cursor",
      "connector_owner_instance_id",
      "connector_created_at",
      "connector_boot_id",
      "connector_pid",
      "connector_start_time_ticks",
      "connector_pid_namespace_inode",
      "connector_ppid",
      "connector_pgrp",
      "connector_session",
      "lease_generation",
      "terminal_state",
      "archived_at",
      "created_at",
      "updated_at"
    ]);
    expect(row).toMatchObject({
      request_id: input.requestId,
      agent_id: input.agentId,
      session_id: input.sessionId,
      conversation_id: "conversation-next",
      conversation_cursor: 8,
      connector_owner_instance_id: input.connectorIdentity.ownerInstanceId,
      lease_generation: 1,
      terminal_state: null,
      archived_at: null
    });
    resumed.close();
  });

  it("uses a strict persistence allowlist and never accepts prompt, token, or header material", () => {
    const { databasePath } = createRegistryDatabase();
    const registry = new ActiveSessionRegistry(databasePath);
    const rawPrompt = "prompt must not reach sqlite";
    const rawToken = "token must not reach sqlite";
    const rawHeader = "Bearer must not reach sqlite";
    const unsafeRegistration = Object.assign(registration(), {
      prompt: rawPrompt,
      token: rawToken,
      headers: { authorization: rawHeader }
    });
    const unsafeConnector = Object.assign(connectorIdentity(), { authorization: rawHeader });

    expect(() => registry.register(unsafeRegistration as unknown as ActiveSessionRegistration)).toThrow(
      ActiveSessionRegistryError
    );
    expect(() =>
      registry.register({ ...registration({ requestId: "request-unsafe-connector" }), connectorIdentity: unsafeConnector })
    ).toThrow(ActiveSessionRegistryError);
    expect(registry.listInFlight()).toEqual([]);

    const valid = registration({ requestId: "request-safe" });
    registry.register(valid);
    const db = new Database(databasePath, { readonly: true });
    const stored = JSON.stringify(db.prepare("SELECT * FROM active_antigravity_sessions").all());
    db.close();
    expect(stored).not.toContain(rawPrompt);
    expect(stored).not.toContain(rawToken);
    expect(stored).not.toContain(rawHeader);
    expect(Object.keys(registry.listInFlight()[0] ?? {})).toEqual([
      "agentId",
      "sessionId",
      "requestId",
      "conversationId",
      "cursor",
      "connectorIdentity",
      "leaseGeneration",
      "terminalState"
    ]);
    registry.close();
  });

  it("fails closed for incompatible schema or corrupt database content", () => {
    const incompatible = createRegistryDatabase();
    const incompatibleDb = new Database(incompatible.databasePath);
    incompatibleDb.exec(`CREATE TABLE active_antigravity_sessions (request_id TEXT PRIMARY KEY NOT NULL)`);
    incompatibleDb.close();
    expect(() => new ActiveSessionRegistry(incompatible.databasePath)).toThrow(
      "active session registry error: SQLite registry table does not match the canonical schema"
    );

    const corrupt = createRegistryDatabase();
    writeFileSync(corrupt.databasePath, "not a SQLite database", { mode: 0o600 });
    expect(() => new ActiveSessionRegistry(corrupt.databasePath)).toThrow(
      "active session registry error: SQLite registry could not be configured"
    );
  });

  it("fences a stale owner before it can advance or terminalize a reclaimed session", () => {
    const { databasePath } = createRegistryDatabase();
    const registry = new ActiveSessionRegistry(databasePath);
    const input = registration();
    const firstLease = registry.register(input);
    const replacementIdentity = connectorIdentity({
      ownerInstanceId: "22222222-2222-4222-8222-222222222222",
      pid: 4222,
      startTimeTicks: "102"
    });
    const replacementLease = registry.takeOverStale(firstLease, replacementIdentity);

    expect(replacementLease).toEqual({
      requestId: input.requestId,
      ownerInstanceId: replacementIdentity.ownerInstanceId,
      leaseGeneration: 2
    });
    expect(() => registry.advance(firstLease, { conversationId: "conversation-stale", cursor: 9 })).toThrow(
      ActiveSessionLeaseFenceError
    );
    expect(() => registry.markTerminal(firstLease, "failed")).toThrow(ActiveSessionLeaseFenceError);

    registry.advance(replacementLease, { conversationId: input.conversationId, cursor: 9 });
    registry.markTerminal(replacementLease, "completed");
    expect(registry.listInFlight()).toEqual([]);
    registry.close();
  });

  it("binds a conversation exactly once, advances its cursor monotonically, and rejects invalid updates without mutation", () => {
    const { databasePath } = createRegistryDatabase();
    const registry = new ActiveSessionRegistry(databasePath);
    const input = registration({ conversationId: null, cursor: -1 });
    const lease = registry.register(input);
    const unbound = inventoryRecord(input, 1);

    expect(() => registry.advance(lease, { conversationId: null, cursor: 0 })).toThrow(ActiveSessionAdvanceError);
    expect(() => registry.advance(lease, { conversationId: "conversation-a", cursor: -1 })).toThrow(
      ActiveSessionAdvanceError
    );
    expect(registry.listInFlight()).toEqual([unbound]);

    registry.advance(lease, { conversationId: "conversation-a", cursor: 2 });
    registry.advance(lease, { conversationId: "conversation-a", cursor: 2 });
    const bound = inventoryRecord({ ...input, conversationId: "conversation-a", cursor: 2 }, 1);
    expect(registry.listInFlight()).toEqual([bound]);

    expect(() => registry.advance(lease, { conversationId: "conversation-a", cursor: 1 })).toThrow(
      ActiveSessionAdvanceError
    );
    expect(() => registry.advance(lease, { conversationId: "conversation-b", cursor: 3 })).toThrow(
      ActiveSessionAdvanceError
    );
    expect(() => registry.advance(lease, { conversationId: null, cursor: -1 })).toThrow(ActiveSessionAdvanceError);
    expect(registry.listInFlight()).toEqual([bound]);
    registry.close();
  });

  it("keeps terminal state durable while excluding it from restart inventory, then cleans archived state idempotently", () => {
    const { databasePath } = createRegistryDatabase();
    const registry = new ActiveSessionRegistry(databasePath);
    const input = registration();
    const lease = registry.register(input);
    registry.markTerminal(lease, "cancelled");

    expect(registry.listInFlight()).toEqual([]);
    const db = new Database(databasePath, { readonly: true });
    expect(
      db.prepare("SELECT terminal_state, archived_at FROM active_antigravity_sessions WHERE request_id = ?").get(input.requestId)
    ).toEqual({ terminal_state: "cancelled", archived_at: null });
    db.close();

    expect(registry.archiveTerminal(lease)).toBe(true);
    expect(registry.archiveTerminal(lease)).toBe(false);
    expect(registry.cleanupArchived()).toBe(1);
    expect(registry.cleanupArchived()).toBe(0);
    registry.close();
  });

  it("preserves independent active records from concurrent child processes", async () => {
    const { databasePath } = createRegistryDatabase();
    const left = spawnWriter(databasePath, "left", "11111111-1111-4111-8111-111111111111");
    const right = spawnWriter(databasePath, "right", "22222222-2222-4222-8222-222222222222");
    await Promise.all([waitForLine(left, "ready"), waitForLine(right, "ready")]);
    left.stdin.end("go\n");
    right.stdin.end("go\n");
    await Promise.all([waitForExit(left), waitForExit(right)]);

    const registry = new ActiveSessionRegistry(databasePath);
    expect(registry.listInFlight()).toEqual([
      expect.objectContaining({ requestId: "request-left", sessionId: "session-left", cursor: 79 }),
      expect.objectContaining({ requestId: "request-right", sessionId: "session-right", cursor: 79 })
    ]);
    registry.close();
  });

  it("retries bounded first-open contention before restoring the operational busy timeout", async () => {
    const { databasePath } = createRegistryDatabase();
    const blocker = new Database(databasePath);
    blocker.pragma("journal_mode = DELETE");
    blocker.exec("BEGIN EXCLUSIVE");

    const child = spawnWriter(databasePath, "left", "11111111-1111-4111-8111-111111111111");
    await waitForLine(child, "opening");
    const ready = waitForLine(child, "ready");
    await new Promise((resolve) => setTimeout(resolve, 250));
    blocker.exec("COMMIT");
    blocker.close();

    await ready;
    const writeBlocker = new Database(databasePath);
    writeBlocker.exec("BEGIN EXCLUSIVE");
    const exited = waitForExit(child);
    child.stdin.end("go\n");
    await new Promise((resolve) => setTimeout(resolve, 250));
    writeBlocker.exec("COMMIT");
    writeBlocker.close();
    await exited;

    const registry = new ActiveSessionRegistry(databasePath);
    expect(registry.listInFlight()).toEqual([
      expect.objectContaining({ requestId: "request-left", sessionId: "session-left", cursor: 79 })
    ]);
    registry.close();
  });

  it("permits exactly one cross-process stale takeover for one persisted fence", async () => {
    const { databasePath } = createRegistryDatabase();
    const registry = new ActiveSessionRegistry(databasePath);
    const input = registration();
    const originalLease = registry.register(input);
    registry.close();

    const left = spawnTakeover(
      databasePath,
      originalLease,
      "22222222-2222-4222-8222-222222222222"
    );
    const right = spawnTakeover(
      databasePath,
      originalLease,
      "33333333-3333-4333-8333-333333333333"
    );
    await Promise.all([waitForLine(left, "ready"), waitForLine(right, "ready")]);
    left.stdin.end("go\n");
    right.stdin.end("go\n");
    await Promise.all([waitForExit(left), waitForExit(right)]);

    const resumed = new ActiveSessionRegistry(databasePath);
    const [record] = resumed.listInFlight();
    expect(record).toMatchObject({ requestId: input.requestId, leaseGeneration: 2 });
    expect([
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333"
    ]).toContain(record?.connectorIdentity.ownerInstanceId);
    expect(() => resumed.advance(originalLease, { conversationId: "conversation-stale", cursor: 10 })).toThrow(
      ActiveSessionLeaseFenceError
    );
    resumed.close();
  });

  it("keeps the maximum legal concurrent cursor and rejects both older progress and an old owner from child processes", async () => {
    const { databasePath } = createRegistryDatabase();
    const registry = new ActiveSessionRegistry(databasePath);
    const input = registration({ conversationId: "conversation-concurrent", cursor: 5 });
    const fence = registry.register(input);
    registry.close();

    const lower = spawnAdvance(databasePath, fence, "conversation-concurrent", 6);
    const higher = spawnAdvance(databasePath, fence, "conversation-concurrent", 11);
    await Promise.all([waitForLine(lower, "ready"), waitForLine(higher, "ready")]);
    lower.stdin.end("go\n");
    higher.stdin.end("go\n");
    await Promise.all([waitForExit(lower), waitForExit(higher)]);

    const afterConcurrent = new ActiveSessionRegistry(databasePath);
    expect(afterConcurrent.listInFlight()).toEqual([
      inventoryRecord({ ...input, cursor: 11 }, 1)
    ]);
    afterConcurrent.close();

    const older = spawnAdvance(databasePath, fence, "conversation-concurrent", 6);
    await waitForLine(older, "ready");
    const invalid = waitForLine(older, "invalid");
    older.stdin.end("go\n");
    await invalid;
    await waitForExit(older);

    const replacement = new ActiveSessionRegistry(databasePath);
    const replacementLease = replacement.takeOverStale(
      fence,
      connectorIdentity({
        ownerInstanceId: "22222222-2222-4222-8222-222222222222",
        pid: 4222,
        startTimeTicks: "102"
      })
    );
    replacement.close();

    const staleOwner = spawnAdvance(databasePath, fence, "conversation-concurrent", 12);
    await waitForLine(staleOwner, "ready");
    const fenced = waitForLine(staleOwner, "fenced");
    staleOwner.stdin.end("go\n");
    await fenced;
    await waitForExit(staleOwner);

    const resumed = new ActiveSessionRegistry(databasePath);
    expect(resumed.listInFlight()).toEqual([
      inventoryRecord(
        {
          ...input,
          cursor: 11,
          connectorIdentity: connectorIdentity({
            ownerInstanceId: replacementLease.ownerInstanceId,
            pid: 4222,
            startTimeTicks: "102"
          })
        },
        2
      )
    ]);
    resumed.close();
  });
});

function createRegistryDatabase(): { stateDir: string; databasePath: string } {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-active-session-"));
  stateDirs.push(stateDir);
  return { stateDir, databasePath: path.join(stateDir, "active-sessions.sqlite") };
}

function registration(overrides: Partial<ActiveSessionRegistration> = {}): ActiveSessionRegistration {
  return {
    agentId: overrides.agentId ?? "agent-default",
    sessionId: overrides.sessionId ?? "session-default",
    requestId: overrides.requestId ?? "request-default",
    conversationId: Object.hasOwn(overrides, "conversationId") ? overrides.conversationId ?? null : "conversation-default",
    cursor: overrides.cursor ?? 7,
    connectorIdentity: overrides.connectorIdentity ?? connectorIdentity()
  };
}

function connectorIdentity(overrides: Partial<ActiveConnectorIdentity> = {}): ActiveConnectorIdentity {
  return {
    ownerInstanceId: overrides.ownerInstanceId ?? "11111111-1111-4111-8111-111111111111",
    createdAt: overrides.createdAt ?? "2026-08-09T12:00:00.000Z",
    bootId: overrides.bootId ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pid: overrides.pid ?? 4121,
    startTimeTicks: overrides.startTimeTicks ?? "101",
    pidNamespaceInode: overrides.pidNamespaceInode ?? 4026531836,
    ppid: overrides.ppid ?? 4000,
    pgrp: overrides.pgrp ?? 4000,
    session: overrides.session ?? 4000
  };
}

function inventoryRecord(input: ActiveSessionRegistration, leaseGeneration: number) {
  return {
    agentId: input.agentId,
    sessionId: input.sessionId,
    requestId: input.requestId,
    conversationId: input.conversationId,
    cursor: input.cursor,
    connectorIdentity: input.connectorIdentity,
    leaseGeneration,
    terminalState: null
  };
}

function spawnWriter(
  databasePath: string,
  suffix: string,
  ownerInstanceId: string
): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [workerPath, "writer", databasePath, workerRegistryModule, suffix, ownerInstanceId],
    { cwd: repositoryRoot, stdio: "pipe" }
  );
}

function spawnTakeover(
  databasePath: string,
  fence: { requestId: string; ownerInstanceId: string; leaseGeneration: number },
  ownerInstanceId: string
): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [
      workerPath,
      "takeover",
      databasePath,
      workerRegistryModule,
      fence.requestId,
      fence.ownerInstanceId,
      String(fence.leaseGeneration),
      ownerInstanceId
    ],
    { cwd: repositoryRoot, stdio: "pipe" }
  );
}

function spawnAdvance(
  databasePath: string,
  fence: { requestId: string; ownerInstanceId: string; leaseGeneration: number },
  conversationId: string,
  cursor: number
): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    [
      workerPath,
      "advance",
      databasePath,
      workerRegistryModule,
      fence.requestId,
      fence.ownerInstanceId,
      String(fence.leaseGeneration),
      conversationId,
      String(cursor)
    ],
    { cwd: repositoryRoot, stdio: "pipe" }
  );
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
    child.once("exit", (code) => reject(new Error(`active-session child exited before ${expected}: ${code}: ${errorOutput}`)));
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  const [code] = (await once(child, "exit")) as [number | null];
  if (code !== 0) throw new Error(`active-session child exited with ${code}`);
}
