import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdmissionController,
  type AdmissionPolicy
} from "../Admission Controller/controller.js";

const THIRTY_MINUTES_MS = 30 * 60_000;

const timeoutPolicy: AdmissionPolicy = {
  maxActiveTurns: 3,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: THIRTY_MINUTES_MS,
  capacityCooldownMs: 30_000
};

const stateDirs: string[] = [];
const controllers: AdmissionController[] = [];

function openController(): AdmissionController {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-timeout-"));
  stateDirs.push(stateDir);
  const admission = new AdmissionController({
    databasePath: path.join(stateDir, "runtime.sqlite"),
    policy: timeoutPolicy,
    encryptionKey: Buffer.alloc(32, 21),
    contentFingerprintKey: Buffer.alloc(32, 22)
  });
  controllers.push(admission);
  return admission;
}

function enqueue(
  admission: AdmissionController,
  requestId: string,
  agentId: string,
  enqueuedAt: number,
  provider = "antigravity",
  model = "gemini-test"
): void {
  admission.enqueueWithPayload({
    requestId,
    sessionId: `session-${requestId}`,
    agentId,
    fingerprint: `fingerprint-${requestId}`,
    provider,
    model,
    now: enqueuedAt
  }, `prompt-${requestId}`, enqueuedAt + timeoutPolicy.queueTimeoutMs);
}

function payloadCount(admission: AdmissionController, requestId: string): number {
  const database = new Database(admission.databasePath, { readonly: true });
  try {
    return (database
      .prepare("SELECT COUNT(*) AS count FROM turn_payloads WHERE request_id = ?")
      .get(requestId) as { count: number }).count;
  } finally {
    database.close();
  }
}

function requestDeadline(admission: AdmissionController, requestId: string): number {
  const database = new Database(admission.databasePath, { readonly: true });
  try {
    return (database
      .prepare("SELECT deadline_at FROM turn_requests WHERE request_id = ?")
      .get(requestId) as { deadline_at: number }).deadline_at;
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const admission of controllers.splice(0)) admission.close();
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

describe("S3-T05 admission timeout contract", () => {
  it("times out a queued request after thirty minutes and deletes its payload", () => {
    const admission = openController();
    enqueue(admission, "timeout-request", "agent-timeout", 0);

    expect(requestDeadline(admission, "timeout-request")).toBe(THIRTY_MINUTES_MS);
    expect(admission.admitNext(31 * 60_000, "owner-timeout")).toBeNull();
    expect(admission.getRequest("timeout-request")?.state).toBe("queue_timeout");
    expect(payloadCount(admission, "timeout-request")).toBe(0);
  });

  it("skips cooldown, cancelled, and timed-out queued requests while admitting later eligible work", () => {
    const admission = openController();
    const admitAt = 31 * 60_000;

    enqueue(admission, "timeout-old", "agent-timeout", 0);
    enqueue(admission, "cooldown-old", "agent-cooldown", 60_001, "antigravity", "cooldown-model");
    enqueue(admission, "cancelled-old", "agent-cancelled", 70_000);
    enqueue(admission, "eligible-later", "agent-eligible", 80_000);
    admission.setCapacityCooldown("antigravity", "cooldown-model", admitAt + 30_000, 60_002);
    admission.cancelQueued("cancelled-old", 70_001);

    const lease = admission.admitNext(admitAt, "owner-eligible");

    expect(lease?.requestId).toBe("eligible-later");
    expect(admission.getRequest("timeout-old")?.state).toBe("queue_timeout");
    expect(admission.getRequest("cooldown-old")?.state).toBe("queued");
    expect(admission.getRequest("cancelled-old")?.state).toBe("cancelled");
    expect(admission.getRequest("eligible-later")?.state).toBe("admitted");
    expect(payloadCount(admission, "timeout-old")).toBe(0);
    expect(payloadCount(admission, "cancelled-old")).toBe(0);
  });
});
