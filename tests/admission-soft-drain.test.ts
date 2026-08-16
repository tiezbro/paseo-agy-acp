import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdmissionController,
  type AdmissionLease,
  type AdmissionPolicy
} from "../Admission Controller/controller.js";

type SoftDrainAdmissionController = AdmissionController & {
  beginSoftDrainTo1(ownerInstanceId: string, now: number): void;
};

interface PolicyState {
  max_active_turns: number;
  max_concurrent_starts: number;
  min_start_interval_ms: number;
  queue_timeout_ms: number;
  capacity_cooldown_ms: number;
  drain_state: string;
  policy_fingerprint: string;
  updated_at: number;
  updated_by_owner_instance_id: string;
}

const POLICY3: AdmissionPolicy = {
  maxActiveTurns: 3,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 2_000,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

const POLICY1: AdmissionPolicy = {
  ...POLICY3,
  maxActiveTurns: 1
};

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDirs: string[] = [];
const controllers: AdmissionController[] = [];

function databasePath(): string {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-soft-drain-"));
  stateDirs.push(stateDir);
  return path.join(stateDir, "runtime.sqlite");
}

function openController(file: string, policy: AdmissionPolicy = POLICY3): AdmissionController {
  const admission = new AdmissionController({
    databasePath: file,
    policy,
    encryptionKey: Buffer.alloc(32, 41),
    contentFingerprintKey: Buffer.alloc(32, 42)
  });
  controllers.push(admission);
  return admission;
}

function enqueue(admission: AdmissionController, requestId: string, agentId: string, now: number): void {
  admission.enqueueWithPayload({
    requestId,
    sessionId: `session-${requestId}`,
    agentId,
    fingerprint: `fingerprint-${requestId}`,
    provider: "antigravity",
    model: "gemini-test",
    now
  }, `prompt-${requestId}`, now + POLICY3.queueTimeoutMs);
}

function admitAndMarkActive(
  admission: AdmissionController,
  requestId: string,
  ownerInstanceId: string,
  now: number
): AdmissionLease {
  const lease = admission.admitNext(now, ownerInstanceId);
  expect(lease?.requestId).toBe(requestId);
  if (lease === null) throw new Error(`expected ${requestId} to be admitted`);
  admission.markStarting(lease, now + 1);
  admission.markDispatchIntent(lease, now + 2);
  admission.markActive(lease, now + 3);
  return lease;
}

function beginSoftDrainTo1(admission: AdmissionController, ownerInstanceId: string, now: number): void {
  (admission as SoftDrainAdmissionController).beginSoftDrainTo1(ownerInstanceId, now);
}

function readPolicyState(file: string): PolicyState {
  const database = new Database(file, { readonly: true });
  try {
    const row = database
      .prepare(
        `SELECT max_active_turns, max_concurrent_starts, min_start_interval_ms,
                queue_timeout_ms, capacity_cooldown_ms, drain_state, policy_fingerprint,
                updated_at, updated_by_owner_instance_id
         FROM policy_state WHERE id = 1`
      )
      .get() as PolicyState | undefined;
    if (row === undefined) throw new Error("missing durable policy state");
    return row;
  } finally {
    database.close();
  }
}

function readActiveLeaseCount(file: string): number {
  const database = new Database(file, { readonly: true });
  try {
    const row = database
      .prepare(
        `SELECT COUNT(*) AS count FROM leases
         WHERE phase IN ('admitted', 'starting', 'dispatch_intent', 'dispatch_ambiguous', 'active', 'recovery_required')`
      )
      .get() as { count: number };
    return row.count;
  } finally {
    database.close();
  }
}

function readEventKinds(file: string): string[] {
  const database = new Database(file, { readonly: true });
  try {
    return (database.prepare("SELECT kind FROM events ORDER BY event_seq ASC").all() as Array<{ kind: string }>)
      .map((row) => row.kind);
  } finally {
    database.close();
  }
}

function runPolicyAssertChild(file: string, policy: AdmissionPolicy): SpawnSyncReturns<string> {
  const script = `
    import path from "node:path";
    import { pathToFileURL } from "node:url";

    const [repositoryRoot, databasePath, serializedPolicy] = process.argv.slice(1);
    const { AdmissionController } = await import(
      pathToFileURL(path.join(repositoryRoot, "dist/Admission Controller/controller.js")).href
    );
    const policy = JSON.parse(serializedPolicy);
    const admission = new AdmissionController({
      databasePath,
      policy,
      encryptionKey: Buffer.alloc(32, 41),
      contentFingerprintKey: Buffer.alloc(32, 42)
    });
    admission.assertDurablePolicyMatch(policy, "owner-b", 13_500);
    admission.close();
  `;

  return spawnSync(process.execPath, ["--input-type=module", "-e", script, repositoryRoot, file, JSON.stringify(policy)], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
}

function expectedPolicyFingerprint(policy: AdmissionPolicy): string {
  return createHmac("sha256", Buffer.alloc(32, 42))
    .update(JSON.stringify(["paseo-agy-acp", "admission-policy", 1]), "utf8")
    .update(Buffer.from([0]))
    .update(JSON.stringify([
      policy.maxActiveTurns,
      policy.maxConcurrentStarts,
      policy.minStartIntervalMs,
      policy.queueTimeoutMs,
      policy.capacityCooldownMs
    ]), "utf8")
    .digest("hex");
}

afterEach(() => {
  for (const admission of controllers.splice(0)) admission.close();
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

describe("S3-T03 AdmissionController soft drain", () => {
  it("soft drains from three seats to one without killing active turns or admitting new work", () => {
    const file = databasePath();
    const admission = openController(file, POLICY3);
    admission.claimDurablePolicy(POLICY3, "owner-a", 1_000);

    enqueue(admission, "active-one", "agent-one", 1_100);
    enqueue(admission, "active-two", "agent-two", 1_200);
    enqueue(admission, "active-three", "agent-three", 1_300);
    enqueue(admission, "queued-four", "agent-four", 1_400);
    enqueue(admission, "queued-five", "agent-five", 1_500);

    const first = admitAndMarkActive(admission, "active-one", "owner-a", 5_000);
    const second = admitAndMarkActive(admission, "active-two", "owner-a", 7_100);
    const third = admitAndMarkActive(admission, "active-three", "owner-a", 9_200);

    beginSoftDrainTo1(admission, "owner-a", 12_000);

    expect(readPolicyState(file)).toMatchObject({
      max_active_turns: 3,
      drain_state: "soft_draining_to_1",
      updated_at: 12_000,
      updated_by_owner_instance_id: "owner-a"
    });
    expect(readActiveLeaseCount(file)).toBe(3);
    expect(admission.admitNext(12_100, "owner-new")).toBeNull();
    expect(admission.getRequest("queued-four")?.state).toBe("queued");
    expect(admission.getRequest("queued-five")?.state).toBe("queued");

    admission.completeLiveTurn(first, 13_000, { outcome: "completed" });
    admission.completeLiveTurn(second, 13_100, { outcome: "completed" });
    expect(readPolicyState(file)).toMatchObject({
      max_active_turns: 3,
      drain_state: "soft_draining_to_1"
    });
    expect(admission.admitNext(13_200, "owner-new")).toBeNull();

    admission.completeLiveTurn(third, 13_300, { outcome: "completed" });

    expect(readActiveLeaseCount(file)).toBe(0);
    expect(readPolicyState(file)).toMatchObject({
      max_active_turns: 1,
      max_concurrent_starts: POLICY1.maxConcurrentStarts,
      min_start_interval_ms: POLICY1.minStartIntervalMs,
      queue_timeout_ms: POLICY1.queueTimeoutMs,
      capacity_cooldown_ms: POLICY1.capacityCooldownMs,
      drain_state: "steady",
      policy_fingerprint: expectedPolicyFingerprint(POLICY1),
      updated_at: 13_300
    });
    expect(readEventKinds(file)).toContain("policy_drain_completed");

    beginSoftDrainTo1(admission, "owner-a", 13_400);
    expect(readPolicyState(file)).toMatchObject({
      max_active_turns: 1,
      drain_state: "steady"
    });

    const secondOpener = runPolicyAssertChild(file, POLICY1);
    expect(secondOpener.status).toBe(0);
    expect(secondOpener.stderr).toBe("");

    const admittedAfterDrain = admission.admitNext(16_000, "owner-after-drain");
    expect(admittedAfterDrain?.requestId).toBe("queued-four");
    if (admittedAfterDrain === null) throw new Error("expected one queued request after drain");
    admission.markStarting(admittedAfterDrain, 16_001);
    admission.markDispatchIntent(admittedAfterDrain, 16_002);
    admission.markActive(admittedAfterDrain, 16_003);

    expect(admission.admitNext(18_100, "owner-over-capacity")).toBeNull();
    expect(admission.getRequest("queued-five")?.state).toBe("queued");
  });
});
