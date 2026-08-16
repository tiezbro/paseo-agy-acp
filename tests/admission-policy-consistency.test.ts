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
  AdmissionRuntimeError,
  type AdmissionPolicy
} from "../Admission Controller/controller.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDirs: string[] = [];
const controllers: AdmissionController[] = [];

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

function databasePath(): string {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-policy-consistency-"));
  stateDirs.push(stateDir);
  return path.join(stateDir, "runtime.sqlite");
}

function openController(file: string, policy: AdmissionPolicy): AdmissionController {
  const admission = new AdmissionController({
    databasePath: file,
    policy,
    encryptionKey: Buffer.alloc(32, 91),
    contentFingerprintKey: Buffer.alloc(32, 92)
  });
  controllers.push(admission);
  return admission;
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
      encryptionKey: Buffer.alloc(32, 91),
      contentFingerprintKey: Buffer.alloc(32, 92)
    });
    admission.assertDurablePolicyMatch(policy, "owner-b", 2_000);
    admission.close();
  `;

  return spawnSync(process.execPath, ["--input-type=module", "-e", script, repositoryRoot, file, JSON.stringify(policy)], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
}

function readPolicyState(file: string): Record<string, unknown> | undefined {
  const database = new Database(file, { readonly: true });
  try {
    return database
      .prepare(
        `SELECT max_active_turns, max_concurrent_starts, min_start_interval_ms,
                queue_timeout_ms, capacity_cooldown_ms, drain_state,
                policy_fingerprint, updated_at, updated_by_owner_instance_id
         FROM policy_state WHERE id = 1`
      )
      .get() as Record<string, unknown> | undefined;
  } finally {
    database.close();
  }
}

function expectedPolicyFingerprint(policy: AdmissionPolicy): string {
  return createHmac("sha256", Buffer.alloc(32, 92))
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

describe("AdmissionController durable policy consistency", () => {
  it("rejects a second opener when the shared durable policy fingerprint differs", () => {
    const file = databasePath();
    const openerA = openController(file, POLICY3);
    openerA.claimDurablePolicy(POLICY3, "owner-a", 1_000);

    expect(readPolicyState(file)).toMatchObject({
      max_active_turns: 3,
      max_concurrent_starts: 1,
      min_start_interval_ms: 2_000,
      queue_timeout_ms: 30 * 60_000,
      capacity_cooldown_ms: 30_000,
      drain_state: "steady",
      policy_fingerprint: expectedPolicyFingerprint(POLICY3),
      updated_at: 1_000,
      updated_by_owner_instance_id: "owner-a"
    });

    const openerB = runPolicyAssertChild(file, POLICY1);

    expect(openerB.status).not.toBe(0);
    expect(openerB.stderr).toContain("AdmissionRuntimeError");
    expect(openerB.stderr).toContain("durable policy does not match shared runtime policy");
  });

  it("accepts a later opener with the same durable policy tuple", () => {
    const file = databasePath();
    const openerA = openController(file, POLICY3);
    openerA.claimDurablePolicy(POLICY3, "owner-a", 1_000);

    const openerB = runPolicyAssertChild(file, POLICY3);

    expect(openerB.status).toBe(0);
    expect(openerB.stderr).toBe("");
  });

  it("throws a typed runtime error when assertion observes a mismatched tuple in-process", () => {
    const file = databasePath();
    const openerA = openController(file, POLICY3);
    openerA.claimDurablePolicy(POLICY3, "owner-a", 1_000);
    const openerB = openController(file, POLICY1);

    expect(() => openerB.assertDurablePolicyMatch(POLICY1, "owner-b", 2_000)).toThrow(AdmissionRuntimeError);
  });
});
