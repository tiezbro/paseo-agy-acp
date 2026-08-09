import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdmissionConflictError,
  AdmissionController,
  DeliveryConflictError,
  type AdmissionPolicy
} from "../src/admission/controller.js";

const stateDirs: string[] = [];

function controller(policy: Partial<AdmissionPolicy> = {}, encryptionKey?: Buffer) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-admission-"));
  stateDirs.push(stateDir);
  return new AdmissionController({
    databasePath: path.join(stateDir, "runtime.sqlite"),
    policy: {
      maxActiveTurns: 1,
      maxConcurrentStarts: 1,
      minStartIntervalMs: 0,
      queueTimeoutMs: 30 * 60_000,
      capacityCooldownMs: 30_000,
      ...policy
    },
    encryptionKey
  });
}

function request(overrides: Partial<Parameters<AdmissionController["enqueue"]>[0]> = {}) {
  return {
    requestId: overrides.requestId ?? crypto.randomUUID(),
    sessionId: overrides.sessionId ?? "session-a",
    parentId: overrides.parentId ?? "parent-a",
    fingerprint: overrides.fingerprint ?? "fingerprint-a",
    provider: overrides.provider ?? "antigravity",
    model: overrides.model ?? "claude-opus-4-6-thinking",
    now: overrides.now ?? 1_000
  };
}

afterEach(() => {
  for (const stateDir of stateDirs.splice(0)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

describe("AdmissionController", () => {
  it("is idempotent for a stable request identity and rejects an identity conflict", () => {
    const admission = controller();
    const first = request({ requestId: "request-1" });

    expect(admission.enqueue(first)).toEqual({ requestId: "request-1", existed: false });
    expect(admission.enqueue(first)).toEqual({ requestId: "request-1", existed: true });
    expect(() => admission.enqueue({ ...first, fingerprint: "different" })).toThrow(AdmissionConflictError);
  });

  it("shares active capacity across controller processes", () => {
    const first = controller();
    const second = new AdmissionController({ databasePath: first.databasePath, policy: first.policy });
    first.enqueue(request({ requestId: "one", now: 1_000 }));
    first.enqueue(request({ requestId: "two", now: 1_001, sessionId: "session-b", parentId: "parent-b" }));

    const lease = first.admitNext(1_002, "connector-a");
    expect(lease?.requestId).toBe("one");
    expect(second.admitNext(1_003, "connector-b")).toBeNull();

    first.release(lease!.leaseId, 1_004, "completed");
    expect(second.admitNext(1_005, "connector-b")?.requestId).toBe("two");
  });

  it("prefers an eligible parent with no active turn over a parent that already owns capacity", () => {
    const admission = controller({ maxActiveTurns: 2 });
    admission.enqueue(request({ requestId: "a-1", parentId: "parent-a", now: 1_000 }));
    admission.enqueue(request({ requestId: "a-2", parentId: "parent-a", sessionId: "session-a-2", now: 1_001 }));
    admission.enqueue(request({ requestId: "b-1", parentId: "parent-b", sessionId: "session-b", now: 1_002 }));

    expect(admission.admitNext(1_003, "connector-a")?.requestId).toBe("a-1");
    expect(admission.admitNext(1_004, "connector-b")?.requestId).toBe("b-1");
  });

  it("does not admit a provider/model held in capacity cooldown", () => {
    const admission = controller();
    admission.enqueue(request({ requestId: "blocked" }));
    admission.setCapacityCooldown("antigravity", "claude-opus-4-6-thinking", 31_000, 1_000);

    expect(admission.admitNext(1_001, "connector-a")).toBeNull();
    expect(admission.admitNext(31_001, "connector-a")?.requestId).toBe("blocked");
  });

  it("turns an unobserved dispatch into recovery_required and never requeues it", () => {
    const admission = controller();
    admission.enqueue(request({ requestId: "ambiguous" }));
    const lease = admission.admitNext(1_001, "connector-a")!;

    admission.markStarting(lease.leaseId, 1_002);
    admission.markDispatchIntent(lease.leaseId, 1_003);
    admission.recoverOwner(lease.leaseId, 1_004, false);

    expect(admission.getRequest("ambiguous")?.state).toBe("recovery_required");
    expect(admission.admitNext(1_005, "connector-b")).toBeNull();
  });

  it("only requeues a pre-dispatch start after the owner is proven gone", () => {
    const admission = controller();
    admission.enqueue(request({ requestId: "safe-retry" }));
    const lease = admission.admitNext(1_001, "connector-a")!;

    admission.markStarting(lease.leaseId, 1_002);
    admission.recoverOwner(lease.leaseId, 1_003, true);
    expect(admission.getRequest("safe-retry")?.state).toBe("starting");

    admission.recoverOwner(lease.leaseId, 1_004, false);
    expect(admission.getRequest("safe-retry")?.state).toBe("queued");
    const retried = admission.admitNext(1_005, "connector-b")!;
    expect(retried.requestId).toBe("safe-retry");
    expect(retried.generation).toBe(2);
  });

  it("globally spaces cold starts even when capacity permits concurrent turns", () => {
    const admission = controller({ maxActiveTurns: 2, maxConcurrentStarts: 2, minStartIntervalMs: 100 });
    admission.enqueue(request({ requestId: "first", now: 1_000 }));
    admission.enqueue(request({ requestId: "second", sessionId: "session-b", parentId: "parent-b", now: 1_001 }));
    const first = admission.admitNext(1_002, "connector-a")!;
    const second = admission.admitNext(1_003, "connector-b")!;

    admission.markStarting(first.leaseId, 1_010);
    expect(() => admission.markStarting(second.leaseId, 1_109)).toThrow(/start interval/);
    admission.markStarting(second.leaseId, 1_110);
  });

  it("encrypts durable payloads and refuses an expired payload", () => {
    const secret = "the prompt must not be readable from sqlite";
    const admission = controller({}, Buffer.alloc(32, 7));
    const stored = request({ requestId: "payload", now: 1_000 });
    admission.enqueue(stored);

    admission.persistPayload("payload", secret, 1_001, 2_000);
    expect(admission.readPayload("payload", 1_002)).toBe(secret);
    expect(readFileSync(admission.databasePath, "utf8")).not.toContain(secret);
    const walPath = `${admission.databasePath}-wal`;
    if (existsSync(walPath)) expect(readFileSync(walPath, "utf8")).not.toContain(secret);
    expect(() => admission.readPayload("payload", 2_000)).toThrow(/expired/);
    expect(() => admission.readPayload("payload", 2_001)).toThrow(/no payload/);
  });

  it("persists a stable encrypted outbox event until an explicit acknowledgement", () => {
    const secret = "the terminal answer must not be readable from sqlite";
    const admission = controller({}, Buffer.alloc(32, 9));
    admission.enqueue(request({ requestId: "delivery-request", now: 1_000 }));
    const event = {
      eventId: "event-1",
      requestId: "delivery-request",
      fingerprint: "hmac-derived-event-fingerprint",
      payload: secret,
      now: 1_001,
      expiresAt: 2_000
    };

    expect(admission.enqueueDelivery(event)).toEqual({ eventId: "event-1", existed: false });
    expect(admission.enqueueDelivery(event)).toEqual({ eventId: "event-1", existed: true });
    expect(admission.readPendingDelivery("event-1", 1_002)).toEqual({
      eventId: "event-1",
      requestId: "delivery-request",
      payload: secret
    });
    expect(readFileSync(admission.databasePath, "utf8")).not.toContain(secret);
    expect(() => admission.enqueueDelivery({ ...event, fingerprint: "different" })).toThrow(DeliveryConflictError);

    admission.acknowledgeDelivery("event-1", 1_003);
    expect(admission.readPendingDelivery("event-1", 1_004)).toBeNull();
    expect(admission.enqueueDelivery(event)).toEqual({ eventId: "event-1", existed: true });
  });
});
