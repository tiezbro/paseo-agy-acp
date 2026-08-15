import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdmissionController,
  type AdmissionPolicy
} from "../Admission Controller/controller.js";
import {
  AdmissionQueueTimeoutError,
  AdmissionTurnCoordinator,
  type AdmissionTurnCoordinatorOptions
} from "../ACP Connector/admission/turn-coordinator.js";
import { TurnClaim } from "../ACP Connector/acp/session/turn-scheduler.js";
import { AgyCliError } from "../ACP Connector/agy/cli.js";

const stateDirs: string[] = [];
const controllers: AdmissionController[] = [];

const DEFAULT_POLICY: AdmissionPolicy = {
  maxActiveTurns: 3,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 2_000,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

function controller(policy: Partial<AdmissionPolicy> = {}): AdmissionController {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-turn-coordinator-"));
  stateDirs.push(stateDir);
  const admission = new AdmissionController({
    databasePath: path.join(stateDir, "runtime.sqlite"),
    policy: { ...DEFAULT_POLICY, ...policy },
    encryptionKey: Buffer.alloc(32, 11),
    contentFingerprintKey: Buffer.alloc(32, 12)
  });
  controllers.push(admission);
  return admission;
}

function coordinator(
  admission: AdmissionController,
  options: Partial<Omit<AdmissionTurnCoordinatorOptions, "controller" | "parentId">> = {}
): AdmissionTurnCoordinator {
  return new AdmissionTurnCoordinator({
    controller: admission,
    parentId: "parent-test",
    connectorPid: process.pid,
    ...options
  });
}

function enqueueHolder(admission: AdmissionController, now: number): void {
  admission.enqueueWithPayload({
    requestId: "holder",
    sessionId: "holder-session",
    parentId: "holder-parent",
    fingerprint: "holder",
    provider: "antigravity",
    model: "model-test",
    now
  }, "holder prompt", now + admission.policy.queueTimeoutMs);
  expect(admission.admitRequest("holder", now, "holder-owner")).not.toBeNull();
}

function countRows(admission: AdmissionController, table: string): number {
  const database = new Database(admission.databasePath, { readonly: true });
  try {
    return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  } finally {
    database.close();
  }
}

afterEach(() => {
  vi.useRealTimers();
  for (const admission of controllers.splice(0)) admission.close();
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

describe("AdmissionTurnCoordinator", () => {
  it("uses available seats while allowing only one new start every two seconds", async () => {
    const admission = controller();
    let now = 0;
    let waits = 0;
    const requestIds = ["turn-one", "turn-two"];
    const subject = coordinator(admission, {
      now: () => now,
      createRequestId: () => requestIds.shift()!,
      queuePollIntervalMs: 1,
      progressIntervalMs: 1,
      wait: async () => {
        waits += 1;
        now += 1_000;
      }
    });
    let firstActive!: () => void;
    const firstActivePromise = new Promise<void>((resolve) => { firstActive = resolve; });
    let finishFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { finishFirst = resolve; });

    const first = subject.admit({
      sessionId: "session-one",
      model: "model-test",
      promptText: "first prompt",
      claim: new TurnClaim("foreground"),
      execute: async (boundary) => {
        boundary.prepare(process.pid);
        boundary.beforePromptWrite();
        boundary.afterPromptWrite();
        firstActive();
        await firstGate;
        return { stopReason: "end_turn" };
      }
    });
    await firstActivePromise;

    await expect(subject.admit({
      sessionId: "session-two",
      model: "model-test",
      promptText: "second prompt",
      claim: new TurnClaim("foreground"),
      execute: async (boundary) => {
        boundary.prepare(process.pid);
        boundary.beforePromptWrite();
        boundary.afterPromptWrite();
        return { stopReason: "end_turn" };
      }
    })).resolves.toBe("end_turn");

    expect(waits).toBe(2);
    const database = new Database(admission.databasePath, { readonly: true });
    expect(database.prepare("SELECT started_at FROM start_history ORDER BY started_at").all()).toEqual([
      { started_at: 0 },
      { started_at: 2_000 }
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM leases WHERE phase = 'active'").get()).toEqual({ count: 1 });
    database.close();

    finishFirst();
    await expect(first).resolves.toBe("end_turn");
    expect(admission.getRequest("turn-one")?.state).toBe("completed");
    expect(admission.getRequest("turn-two")?.state).toBe("completed");
    expect(countRows(admission, "leases")).toBe(0);
  });

  it("reports durable queue progress and removes a cancelled queued payload", async () => {
    const admission = controller({ maxActiveTurns: 1, minStartIntervalMs: 0 });
    enqueueHolder(admission, 0);
    const claim = new TurnClaim("foreground");
    const progress: unknown[] = [];
    const subject = coordinator(admission, {
      now: () => 10,
      createRequestId: () => "queued-cancel",
      queuePollIntervalMs: 1,
      progressIntervalMs: 1,
      wait: async () => {
        claim.abort();
      }
    });

    await expect(subject.admit({
      sessionId: "queued-session",
      model: "model-test",
      promptText: "queued prompt",
      claim,
      reportProgress: (update) => { progress.push(update); },
      execute: async () => {
        throw new Error("a cancelled queued request must not execute");
      }
    })).resolves.toBe("cancelled");

    expect(progress).toEqual([{
      state: "queued",
      position: 1,
      eligiblePosition: 1,
      waitedMs: 0,
      cooldownUntil: null
    }]);
    expect(admission.getRequest("queued-cancel")?.state).toBe("cancelled");
    const database = new Database(admission.databasePath, { readonly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM turn_payloads WHERE request_id = ?").get("queued-cancel"))
      .toEqual({ count: 0 });
    database.close();
  });

  it("times out a queued turn at its deadline and deletes the encrypted prompt", async () => {
    const admission = controller({ maxActiveTurns: 1, minStartIntervalMs: 0, queueTimeoutMs: 5 });
    enqueueHolder(admission, 0);
    let now = 100;
    const subject = coordinator(admission, {
      now: () => now,
      createRequestId: () => "queued-timeout",
      queuePollIntervalMs: 1,
      progressIntervalMs: 1,
      wait: async () => {
        now += 5;
      }
    });

    await expect(subject.admit({
      sessionId: "timeout-session",
      model: "model-test",
      promptText: "timeout prompt",
      claim: new TurnClaim("foreground"),
      execute: async () => {
        throw new Error("a timed-out request must not execute");
      }
    })).rejects.toBeInstanceOf(AdmissionQueueTimeoutError);

    expect(admission.getRequest("queued-timeout")?.state).toBe("queue_timeout");
    const database = new Database(admission.databasePath, { readonly: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM turn_payloads WHERE request_id = ?").get("queued-timeout"))
      .toEqual({ count: 0 });
    database.close();
  });

  it("heartbeats an active turn and releases its seat immediately at success", async () => {
    vi.useFakeTimers();
    const admission = controller({ maxActiveTurns: 1, minStartIntervalMs: 0 });
    let now = 1_000;
    const subject = coordinator(admission, {
      now: () => ++now,
      createRequestId: () => "heartbeat-success",
      heartbeatIntervalMs: 10
    });
    let active!: () => void;
    const activePromise = new Promise<void>((resolve) => { active = resolve; });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });

    const pending = subject.admit({
      sessionId: "heartbeat-session",
      model: "model-test",
      promptText: "heartbeat prompt",
      claim: new TurnClaim("foreground"),
      execute: async (boundary) => {
        boundary.prepare(process.pid);
        boundary.beforePromptWrite();
        boundary.afterPromptWrite();
        active();
        await gate;
        return { stopReason: "end_turn" };
      }
    });
    await activePromise;

    const before = admission.listRecoverableDispatches()[0]!.heartbeatAt;
    await vi.advanceTimersByTimeAsync(10);
    const after = admission.listRecoverableDispatches()[0]!.heartbeatAt;
    expect(after).toBeGreaterThan(before);

    finish();
    await expect(pending).resolves.toBe("end_turn");
    expect(admission.getRequest("heartbeat-success")?.state).toBe("completed");
    expect(countRows(admission, "leases")).toBe(0);
    expect(countRows(admission, "turn_payloads")).toBe(0);
  });

  it("classifies a confirmed 503 capacity failure, starts cooldown, and releases the seat", async () => {
    const admission = controller({ maxActiveTurns: 1, minStartIntervalMs: 0 });
    const subject = coordinator(admission, {
      now: () => 1_000,
      createRequestId: () => "capacity-failure"
    });
    const failure = new AgyCliError(
      "provider returned 503 MODEL_CAPACITY_EXHAUSTED",
      ["agy"],
      1,
      "503 MODEL_CAPACITY_EXHAUSTED"
    );

    await expect(subject.admit({
      sessionId: "capacity-session",
      model: "model-test",
      promptText: "capacity prompt",
      claim: new TurnClaim("foreground"),
      execute: async (boundary) => {
        boundary.prepare(process.pid);
        boundary.beforePromptWrite();
        boundary.afterPromptWrite();
        throw failure;
      }
    })).rejects.toBe(failure);

    expect(admission.getRequest("capacity-failure")?.state).toBe("failed");
    expect(countRows(admission, "leases")).toBe(0);
    const database = new Database(admission.databasePath, { readonly: true });
    expect(database.prepare("SELECT provider, model, not_before FROM cooldowns").all()).toEqual([{
      provider: "antigravity",
      model: "model-test",
      not_before: 31_000
    }]);
    database.close();
  });

  it("retains an uncertain post-write failure as recovery debt without a replayable prompt", async () => {
    const admission = controller({ maxActiveTurns: 1, minStartIntervalMs: 0 });
    const subject = coordinator(admission, {
      now: () => 1_000,
      createRequestId: () => "uncertain-failure"
    });
    const failure = new Error("transport ended without a confirmed provider terminal");

    await expect(subject.admit({
      sessionId: "uncertain-session",
      model: "model-test",
      promptText: "must never replay",
      claim: new TurnClaim("foreground"),
      execute: async (boundary) => {
        boundary.prepare(process.pid);
        boundary.beforePromptWrite();
        boundary.afterPromptWrite();
        throw failure;
      }
    })).rejects.toBe(failure);

    expect(admission.getRequest("uncertain-failure")?.state).toBe("recovery_required");
    expect(admission.listRecoverableDispatches()).toHaveLength(1);
    const database = new Database(admission.databasePath, { readonly: true });
    expect(database.prepare("SELECT phase FROM leases").all()).toEqual([{ phase: "recovery_required" }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM turn_payloads").get()).toEqual({ count: 0 });
    database.close();
  });
});
