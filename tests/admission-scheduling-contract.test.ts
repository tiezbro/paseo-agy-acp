import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdmissionController,
  type AdmissionLease,
  type AdmissionPolicy
} from "../Admission Controller/controller.js";

const POLICY: AdmissionPolicy = {
  maxActiveTurns: 3,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 2_000,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

const stateDirs: string[] = [];
const controllers: AdmissionController[] = [];

function temporaryDatabasePath(): string {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-scheduling-"));
  stateDirs.push(stateDir);
  return path.join(stateDir, "runtime.sqlite");
}

function openController(policy: AdmissionPolicy = POLICY, databasePath = temporaryDatabasePath()): AdmissionController {
  const admission = new AdmissionController({
    databasePath,
    policy,
    encryptionKey: Buffer.alloc(32, 41),
    contentFingerprintKey: Buffer.alloc(32, 42)
  });
  controllers.push(admission);
  return admission;
}

function closeController(admission: AdmissionController): void {
  const index = controllers.indexOf(admission);
  if (index >= 0) controllers.splice(index, 1);
  admission.close();
}

function enqueue(admission: AdmissionController, requestId: string, agentKey: string, now: number): void {
  admission.enqueueWithPayload({
    requestId,
    sessionId: `session-${requestId}`,
    agentId: agentKey,
    fingerprint: `fingerprint-${requestId}`,
    provider: "antigravity",
    model: "gemini-test",
    now
  }, `prompt-${requestId}`, now + POLICY.queueTimeoutMs);
}

function admitAndMarkActive(
  admission: AdmissionController,
  expectedRequestId: string,
  ownerInstanceId: string,
  now: number
): AdmissionLease {
  const lease = admission.admitNext(now, ownerInstanceId);
  expect(lease?.requestId).toBe(expectedRequestId);
  if (lease === null) throw new Error(`expected ${expectedRequestId} to be admitted`);
  admission.markStarting(lease, now + 1);
  admission.markDispatchIntent(lease, now + 2);
  admission.markActive(lease, now + 3);
  return lease;
}

afterEach(() => {
  for (const admission of controllers.splice(0)) admission.close();
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

describe("S3-T04 admission scheduling contract", () => {
  it("rejects a second start less than two seconds after the previous start", () => {
    const databasePath = temporaryDatabasePath();
    const setup = openController({ ...POLICY, minStartIntervalMs: 0 }, databasePath);
    enqueue(setup, "turn-a", "agent-a", 1);
    enqueue(setup, "turn-b", "agent-b", 2);

    const first = setup.admitRequest("turn-a", 1_000, "owner-a");
    expect(first).not.toBeNull();
    setup.markStarting(first!, 1_000);
    setup.markDispatchIntent(first!, 1_001);
    setup.markActive(first!, 1_002);

    const second = setup.admitRequest("turn-b", 1_500, "owner-b");
    expect(second).not.toBeNull();
    closeController(setup);

    const admission = openController(POLICY, databasePath);
    expect(() => admission.markStarting(second!, 1_500)).toThrow("start interval has not elapsed");
  });

  it("admits an idle agent before another queued turn for an active agent", () => {
    const admission = openController();
    enqueue(admission, "active-a", "agent-a", 1);
    const active = admitAndMarkActive(admission, "active-a", "owner-active-a", 10);

    enqueue(admission, "queued-a", "agent-a", 20);
    enqueue(admission, "queued-b", "agent-b", 21);

    expect(admission.admitNext(2_050, "owner-b")?.requestId).toBe("queued-b");
    expect(admission.getRequest("queued-a")?.state).toBe("queued");

    admission.completeLiveTurn(active, 2_051, { outcome: "completed" });
  });

  it("orders queued turns for the same agent by enqueue time then request id", () => {
    const admission = openController();
    enqueue(admission, "request-z", "agent-a", 10);
    enqueue(admission, "request-b", "agent-a", 20);
    enqueue(admission, "request-a", "agent-a", 20);

    expect(admission.getQueueSnapshot("request-z", 30)?.position).toBe(1);
    expect(admission.getQueueSnapshot("request-a", 30)?.position).toBe(2);
    expect(admission.getQueueSnapshot("request-b", 30)?.position).toBe(3);
  });
});
