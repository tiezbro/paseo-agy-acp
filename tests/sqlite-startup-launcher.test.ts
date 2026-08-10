import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  SQLITE_STARTUP_GLOBAL_START_RATE_STATUS,
  SqliteAgyStartupLauncher,
  SqliteStartupCapacityError,
  SqliteStartupClockError,
  SqliteStartupLauncherError,
  SqliteStartupPermitFenceError,
  type HeldAgyStartupPermit,
  type SqliteStartupLauncherOptions
} from "../src/admission/sqlite-startup-launcher.js";

const OWNER_A = "11111111-1111-4111-8111-111111111111";
const OWNER_B = "22222222-2222-4222-8222-222222222222";
const OWNER_C = "33333333-3333-4333-8333-333333333333";
const PERMIT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PERMIT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(repositoryRoot, "tests/helpers/sqlite-startup-launcher-child.mjs");
const buildDir = mkdtempSync(path.join(repositoryRoot, ".tmp-sqlite-startup-launcher-"));
const stateDirs: string[] = [];
let workerModule = "";

beforeAll(() => {
  execFileSync(process.execPath, [
    path.join(repositoryRoot, "node_modules/typescript/bin/tsc"),
    "--ignoreConfig",
    "--target", "ES2022",
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--strict",
    "--skipLibCheck",
    "--rootDir", "src",
    "--outDir", buildDir,
    "src/admission/sqlite-startup-launcher.ts"
  ], { cwd: repositoryRoot, stdio: "inherit" });
  workerModule = path.join(buildDir, "admission/sqlite-startup-launcher.js");
});

afterAll(() => rmSync(buildDir, { recursive: true, force: true }));

afterEach(() => {
  for (const directory of stateDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SqliteAgyStartupLauncher", () => {
  it("does not create a second model-turn active owner", () => {
    const { databasePath } = stateDatabase();
    const launcher = createLauncher(databasePath);
    const permit = launcher.acquire("model_turn");
    permit.release();
    permit.release();
    expect(launcher.listRecoverablePermits()).toEqual([]);
    expect(rowCount(databasePath)).toBe(0);
    launcher.close();
  });

  it("enforces independent max-one auxiliary and resident PTY quotas", () => {
    const { databasePath } = stateDatabase();
    const launcher = createLauncher(databasePath, { ids: [PERMIT_A, PERMIT_B] });
    const auxiliary = launcher.acquire("auxiliary") as HeldAgyStartupPermit;
    const resident = launcher.acquire("resident_pty") as HeldAgyStartupPermit;
    expect(() => launcher.acquire("auxiliary")).toThrow(SqliteStartupCapacityError);
    expect(() => launcher.acquire("resident_pty")).toThrow(SqliteStartupCapacityError);
    expect(launcher.listRecoverablePermits().map((entry) => entry.classification)).toEqual([
      "auxiliary",
      "resident_pty"
    ]);
    auxiliary.release();
    resident.release();
    launcher.close();
  });

  it("releases exactly once and increments the persistent fence generation", () => {
    const { databasePath } = stateDatabase();
    const launcher = createLauncher(databasePath, { ids: [PERMIT_A, PERMIT_B] });
    const first = launcher.acquire("auxiliary") as HeldAgyStartupPermit;
    first.release();
    first.release();
    const second = launcher.acquire("auxiliary") as HeldAgyStartupPermit;
    expect(first.fence.generation).toBe(1);
    expect(second.fence.generation).toBe(2);
    expect(second.fence.permitId).toBe(PERMIT_B);
    expect(() => launcher.releasePermit(first.fence)).toThrow(SqliteStartupPermitFenceError);
    second.release();
    launcher.close();
  });

  it("records heartbeat observations but never auto-reclaims an expired permit", () => {
    const { databasePath } = stateDatabase();
    let currentTime = 1_000;
    const first = createLauncher(databasePath, { now: () => currentTime, heartbeatTtlMs: 100 });
    const permit = first.acquire("auxiliary") as HeldAgyStartupPermit;
    currentTime = 1_101;
    expect(first.listRecoverablePermits()).toEqual([
      expect.objectContaining({ heartbeatAt: 1_000, heartbeatExpired: true })
    ]);
    const second = createLauncher(databasePath, { ownerInstanceId: OWNER_B, now: () => currentTime });
    expect(() => second.acquire("auxiliary")).toThrow(SqliteStartupCapacityError);
    permit.heartbeat();
    expect(first.listRecoverablePermits()[0]).toMatchObject({ heartbeatAt: 1_101, heartbeatExpired: false });
    permit.release();
    second.close();
    first.close();
  });

  it("retains crash residue across reopen and lists only payload-free fields", () => {
    const { databasePath } = stateDatabase();
    const first = createLauncher(databasePath, { now: () => 1_000 });
    first.acquire("resident_pty");
    first.close();

    const reopened = createLauncher(databasePath, { ownerInstanceId: OWNER_B, now: () => 100_000 });
    expect(reopened.listRecoverablePermits()).toEqual([{
      classification: "resident_pty",
      permitId: PERMIT_A,
      ownerInstanceId: OWNER_A,
      generation: 1,
      acquiredAt: 1_000,
      heartbeatAt: 1_000,
      heartbeatExpired: true
    }]);
    expect(() => reopened.acquire("resident_pty")).toThrow(SqliteStartupCapacityError);
    expect(Object.keys(reopened.listRecoverablePermits()[0]!)).toEqual([
      "classification", "permitId", "ownerInstanceId", "generation",
      "acquiredAt", "heartbeatAt", "heartbeatExpired"
    ]);
    reopened.close();
  });

  it("fences a stale owner without mutating the replacement row", () => {
    const { databasePath } = stateDatabase();
    const launcher = createLauncher(databasePath);
    const permit = launcher.acquire("auxiliary") as HeldAgyStartupPermit;
    const db = new Database(databasePath);
    db.prepare(
      "UPDATE agy_startup_permits SET owner_instance_id = ?, generation = generation + 1 WHERE classification = ?"
    ).run(OWNER_B, "auxiliary");
    db.close();
    expect(() => permit.heartbeat()).toThrow(SqliteStartupPermitFenceError);
    expect(() => permit.release()).toThrow(SqliteStartupPermitFenceError);
    expect(launcher.listRecoverablePermits()[0]).toMatchObject({ ownerInstanceId: OWNER_B, generation: 2 });
    launcher.close();
  });

  it("does not grant mutation authority to a foreign owner through recovery inventory", () => {
    const { databasePath } = stateDatabase();
    let currentTime = 1_000;
    const owner = createLauncher(databasePath, { now: () => currentTime });
    const permit = owner.acquire("auxiliary") as HeldAgyStartupPermit;
    const observer = createLauncher(databasePath, {
      ownerInstanceId: OWNER_B,
      now: () => currentTime
    });
    const exposedFence = observer.listRecoverablePermits()[0]!;

    currentTime = 1_001;
    expect(() => observer.heartbeatPermit(exposedFence)).toThrow(SqliteStartupPermitFenceError);
    expect(() => observer.releasePermit(exposedFence)).toThrow(SqliteStartupPermitFenceError);
    expect(observer.listRecoverablePermits()[0]).toMatchObject({
      ownerInstanceId: OWNER_A,
      heartbeatAt: 1_000
    });
    expect(() => observer.acquire("auxiliary")).toThrow(SqliteStartupCapacityError);

    permit.release();
    observer.close();
    owner.close();
  });

  it("fails closed on invalid or backwards clocks and retains active capacity", () => {
    const { databasePath } = stateDatabase();
    let currentTime = 1_000;
    let throwClock = false;
    const launcher = createLauncher(databasePath, {
      now: () => {
        if (throwClock) throw new Error("private clock diagnostic");
        return currentTime;
      }
    });
    const permit = launcher.acquire("auxiliary") as HeldAgyStartupPermit;
    currentTime = 999;
    expect(() => permit.heartbeat()).toThrow(SqliteStartupClockError);
    throwClock = true;
    expect(() => permit.release()).toThrow(SqliteStartupClockError);
    const observer = createLauncher(databasePath, { ownerInstanceId: OWNER_B, now: () => 1_001 });
    expect(observer.listRecoverablePermits()).toHaveLength(1);
    expect(() => observer.acquire("auxiliary")).toThrow(SqliteStartupCapacityError);
    observer.close();
    launcher.close();
  });

  it("rejects secrets and stores only the canonical structural allowlist", () => {
    const { databasePath } = stateDatabase();
    for (const field of ["prompt", "argv", "environment", "headers", "token"]) {
      expect(() => new SqliteAgyStartupLauncher({
        ...options(databasePath),
        [field]: "Authorization: Bearer secret business prompt"
      } as never)).toThrow(SqliteStartupLauncherError);
    }
    const launcher = createLauncher(databasePath);
    launcher.acquire("auxiliary");
    const db = new Database(databasePath, { readonly: true });
    const row = db.prepare("SELECT * FROM agy_startup_permits").get() as Record<string, unknown>;
    db.close();
    expect(Object.keys(row)).toEqual([
      "classification", "permit_id", "owner_instance_id", "generation",
      "state", "acquired_at", "heartbeat_at", "released_at"
    ]);
    expect(JSON.stringify(row)).not.toMatch(/prompt|argv|environment|header|token|authorization|bearer/i);
    launcher.close();
  });

  it("rejects non-canonical pre-existing tables and SQLite write faults", () => {
    const { databasePath } = stateDatabase();
    const db = new Database(databasePath);
    db.exec("CREATE TABLE agy_startup_permits (classification TEXT PRIMARY KEY)");
    db.close();
    expect(() => createLauncher(databasePath)).toThrow(/canonical/);

    const healthy = stateDatabase().databasePath;
    const launcher = createLauncher(healthy);
    launcher.close();
    expect(() => launcher.acquire("auxiliary")).toThrow(/closed/);
  });

  it("fails closed when another connection holds the SQLite writer lock", () => {
    const { databasePath } = stateDatabase();
    const launcher = createLauncher(databasePath, { busyTimeoutMs: 1 });
    const blocker = new Database(databasePath);
    blocker.exec("BEGIN IMMEDIATE");
    expect(() => launcher.acquire("auxiliary")).toThrow(/acquire failed/);
    blocker.exec("ROLLBACK");
    expect(launcher.listRecoverablePermits()).toEqual([]);
    blocker.close();
    launcher.close();
  });

  it("allows exactly one cross-process contender to acquire a shared quota", async () => {
    const { databasePath } = stateDatabase();
    const owners = [OWNER_A, OWNER_B, OWNER_C];
    const results = await Promise.all(owners.map((ownerInstanceId, index) =>
      runWorker({ databasePath, ownerInstanceId, permitId: [PERMIT_A, PERMIT_B, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"][index]! })
    ));
    expect(results.filter((result) => result.status === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.status === "capacity")).toHaveLength(2);
    const observer = createLauncher(databasePath, { ownerInstanceId: "44444444-4444-4444-8444-444444444444" });
    expect(observer.listRecoverablePermits()).toHaveLength(1);
    observer.close();
  });

  it("states the global start-rate blocker instead of claiming shared start history", () => {
    const { databasePath } = stateDatabase();
    const launcher = createLauncher(databasePath);
    expect(SQLITE_STARTUP_GLOBAL_START_RATE_STATUS).toBe("not_implemented");
    expect(launcher.globalStartRateStatus).toBe("not_implemented");
    launcher.close();
  });
});

function stateDatabase(): { databasePath: string } {
  const directory = mkdtempSync(path.join(os.tmpdir(), "agy-startup-permits-"));
  stateDirs.push(directory);
  const databasePath = path.join(directory, "runtime.sqlite");
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE controller_core_marker (version INTEGER NOT NULL)");
  db.close();
  return { databasePath };
}

function options(databasePath: string, overrides: Partial<SqliteStartupLauncherOptions> = {}): SqliteStartupLauncherOptions {
  return {
    databasePath,
    ownerInstanceId: OWNER_A,
    now: () => 1_000,
    createPermitId: () => PERMIT_A,
    ...overrides
  };
}

function createLauncher(
  databasePath: string,
  overrides: Partial<SqliteStartupLauncherOptions> & { ids?: string[] } = {}
): SqliteAgyStartupLauncher {
  const ids = overrides.ids ?? [PERMIT_A];
  let index = 0;
  const { ids: _ids, ...rest } = overrides;
  return new SqliteAgyStartupLauncher(options(databasePath, {
    createPermitId: () => ids[index++] ?? "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    ...rest
  }));
}

function rowCount(databasePath: string): number {
  const db = new Database(databasePath, { readonly: true });
  const row = db.prepare("SELECT COUNT(*) AS count FROM agy_startup_permits").get() as { count: number };
  db.close();
  return row.count;
}

function runWorker(input: {
  databasePath: string;
  ownerInstanceId: string;
  permitId: string;
}): Promise<{ status: "acquired" | "capacity" | "error" }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, workerModule, JSON.stringify(input)], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    void once(child, "close").then(([code]) => {
      if (code !== 0) {
        reject(new Error(`startup permit worker failed: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as { status: "acquired" | "capacity" | "error" });
    }, reject);
  });
}
