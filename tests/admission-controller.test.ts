import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdmissionController,
  type AdmissionLease,
  type AdmissionPolicy
} from "../Admission Controller/controller.js";

const stateDirs: string[] = [];
const controllers: AdmissionController[] = [];

const POLICY: AdmissionPolicy = {
  maxActiveTurns: 3,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

function controller(): AdmissionController {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-controller-"));
  stateDirs.push(stateDir);
  const admission = new AdmissionController({
    databasePath: path.join(stateDir, "runtime.sqlite"),
    policy: POLICY,
    encryptionKey: Buffer.alloc(32, 31),
    contentFingerprintKey: Buffer.alloc(32, 32)
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
    model: "model-test",
    now
  }, `prompt-${requestId}`, now + POLICY.queueTimeoutMs);
}

function makeActive(admission: AdmissionController, requestId: string, owner: string, now: number): AdmissionLease {
  const lease = admission.admitRequest(requestId, now, owner);
  expect(lease).not.toBeNull();
  admission.markStarting(lease!, now + 1);
  admission.markDispatchIntent(lease!, now + 2);
  admission.markActive(lease!, now + 3);
  return lease!;
}

afterEach(() => {
  for (const admission of controllers.splice(0)) admission.close();
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

describe("AdmissionController final shared-queue policy", () => {
  it("never allocates more than three global Antigravity seats", () => {
    const admission = controller();
    enqueue(admission, "one", "parent-one", 1);
    enqueue(admission, "two", "parent-two", 2);
    enqueue(admission, "three", "parent-three", 3);
    enqueue(admission, "four", "parent-four", 4);

    makeActive(admission, "one", "owner-one", 10);
    makeActive(admission, "two", "owner-two", 20);
    makeActive(admission, "three", "owner-three", 30);
    expect(admission.admitNext(40, "owner-four")).toBeNull();
    expect(admission.getRequest("four")?.state).toBe("queued");
  });

  it("rejects non-positive or non-integer seat and start counts", () => {
    for (const maxActiveTurns of [0, -1, 1.5]) {
      const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-invalid-policy-"));
      stateDirs.push(stateDir);
      expect(() => new AdmissionController({
        databasePath: path.join(stateDir, "runtime.sqlite"),
        policy: { ...POLICY, maxActiveTurns },
        encryptionKey: Buffer.alloc(32, 31),
        contentFingerprintKey: Buffer.alloc(32, 32)
      })).toThrow(/maxActiveTurns/);
    }
    for (const maxConcurrentStarts of [0, -1, 1.5]) {
      const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-invalid-starts-"));
      stateDirs.push(stateDir);
      expect(() => new AdmissionController({
        databasePath: path.join(stateDir, "runtime.sqlite"),
        policy: { ...POLICY, maxConcurrentStarts },
        encryptionKey: Buffer.alloc(32, 31),
        contentFingerprintKey: Buffer.alloc(32, 32)
      })).toThrow(/maxConcurrentStarts/);
    }
  });

  it("prefers an idle agent without violating FIFO inside each agent", () => {
    const admission = controller();
    enqueue(admission, "active-a", "parent-a", 1);
    const active = makeActive(admission, "active-a", "owner-a", 10);

    enqueue(admission, "queued-a", "parent-a", 20);
    enqueue(admission, "queued-b", "parent-b", 21);

    expect(admission.admitNext(30, "owner-b")?.requestId).toBe("queued-b");
    expect(admission.getRequest("queued-a")?.state).toBe("queued");

    admission.completeLiveTurn(active, 31, { outcome: "completed" });
  });
});
