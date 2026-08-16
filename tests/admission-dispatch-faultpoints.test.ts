import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdmissionController,
  type AdmissionControllerFaultInjection,
  type AdmissionLease,
  type AdmissionPolicy,
  type VerifiedLinuxProcessRecord
} from "../Admission Controller/controller.js";
import { AdmissionTurnCoordinator } from "../ACP Connector/admission/turn-coordinator.js";
import { TurnClaim } from "../ACP Connector/acp/session/turn-scheduler.js";
import { AgyPromptFreeDispatchBoundary } from "../ACP Connector/agy/dispatch-boundary.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const BOOT = "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f31";
const stateDirs: string[] = [];
const controllers: AdmissionController[] = [];

const POLICY: AdmissionPolicy = {
  maxActiveTurns: 1,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

function databasePath(prefix = "paseo-agy-dispatch-fault-"): string {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  stateDirs.push(stateDir);
  return path.join(stateDir, "runtime.sqlite");
}

function controller(file: string, faultInjection?: AdmissionControllerFaultInjection): AdmissionController {
  const admission = new AdmissionController({
    databasePath: file,
    policy: POLICY,
    encryptionKey: Buffer.alloc(32, 61),
    contentFingerprintKey: Buffer.alloc(32, 62),
    faultInjection
  });
  controllers.push(admission);
  return admission;
}

function starting(admission: AdmissionController, requestId = "atomic-request"): AdmissionLease {
  admission.enqueueWithPayload({
    requestId,
    sessionId: `${requestId}-session`,
    agentId: `${requestId}-agent`,
    fingerprint: `${requestId}-fingerprint`,
    provider: "antigravity",
    model: "model-test",
    now: 1_000
  }, "private prompt", 61_000);
  const lease = admission.admitNext(1_001, OWNER);
  expect(lease).not.toBeNull();
  admission.markStarting(lease!, 1_002);
  return lease!;
}

function processRecord(lease: AdmissionLease): VerifiedLinuxProcessRecord {
  return {
    requestId: lease.requestId,
    leaseId: lease.leaseId,
    generation: lease.generation,
    ownerInstanceId: lease.ownerInstanceId,
    promptChannel: "stdin",
    processIdentity: {
      connector: {
        ownerInstanceId: OWNER,
        createdAt: "2026-08-14T00:00:00.000Z",
        bootId: BOOT,
        pid: 7_001,
        startTimeTicks: "100",
        pidNamespaceInode: 4_026_531_836,
        ppid: 1,
        pgrp: 7_001,
        session: 7_001
      },
      child: {
        bootId: BOOT,
        pid: 7_002,
        startTimeTicks: "200",
        pidNamespaceInode: 4_026_531_836,
        ppid: 7_001,
        pgrp: 7_002,
        session: 7_002
      }
    }
  };
}

function queryOne<T>(file: string, sql: string, ...params: unknown[]): T {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare(sql).get(...params) as T;
  } finally {
    db.close();
  }
}

function readLease(file: string, requestId: string): AdmissionLease {
  const lease = queryOne<AdmissionLease | undefined>(
    file,
    `SELECT lease_id AS leaseId, request_id AS requestId,
            generation, owner_instance_id AS ownerInstanceId
     FROM leases
     WHERE request_id = ?`,
    requestId
  );
  if (lease === undefined) throw new Error(`missing lease for ${requestId}`);
  return lease;
}

function requestSnapshot(file: string, requestId: string): {
  readonly state: string;
  readonly payloadCount: number;
  readonly leaseCount: number;
  readonly leasePhase: string | null;
  readonly identityCount: number;
} {
  const db = new Database(file, { readonly: true });
  try {
    const request = db.prepare("SELECT state FROM turn_requests WHERE request_id = ?").get(requestId) as {
      state: string;
    };
    const payload = db.prepare("SELECT COUNT(*) AS count FROM turn_payloads WHERE request_id = ?")
      .get(requestId) as { count: number };
    const leaseCount = db.prepare("SELECT COUNT(*) AS count FROM leases WHERE request_id = ?")
      .get(requestId) as { count: number };
    const lease = db.prepare("SELECT phase FROM leases WHERE request_id = ?")
      .get(requestId) as { phase: string } | undefined;
    const identities = db.prepare("SELECT COUNT(*) AS count FROM lease_process_identities WHERE request_id = ?")
      .get(requestId) as { count: number };
    return {
      state: request.state,
      payloadCount: payload.count,
      leaseCount: leaseCount.count,
      leasePhase: lease?.phase ?? null,
      identityCount: identities.count
    };
  } finally {
    db.close();
  }
}

function coordinator(
  admission: AdmissionController,
  requestId: string,
  now: () => number
): AdmissionTurnCoordinator {
  return new AdmissionTurnCoordinator({
    controller: admission,
    agentId: `${requestId}-agent`,
    connectorPid: process.pid,
    now,
    createRequestId: () => requestId,
    queuePollIntervalMs: 1,
    progressIntervalMs: 1,
    wait: async () => {
      throw new Error("dispatch fault tests should admit immediately");
    }
  });
}

afterEach(() => {
  for (const admission of controllers.splice(0)) admission.close();
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

describe("Admission dispatch fault-point regression", () => {
  it("rolls back identity and intent when a transaction fault follows identity persistence", () => {
    const file = databasePath();
    const admission = controller(file, {
      afterProcessIdentityPersisted() {
        throw new Error("injected transaction fault");
      }
    });
    const lease = starting(admission);
    const record = processRecord(lease);

    expect(admission.recordProcessIdentity(record)).toEqual({
      status: "not_recorded",
      reason: "transaction_fault"
    });
    expect(requestSnapshot(file, lease.requestId)).toMatchObject({
      state: "starting",
      leaseCount: 1,
      leasePhase: "starting",
      identityCount: 0
    });
  });

  it("throws at a stale TurnDispatchBoundary beforePromptWrite without issuing a prompt", async () => {
    const file = databasePath();
    const admission = controller(file);
    let now = 2_000;
    let promptWrites = 0;
    const subject = coordinator(admission, "stale-before-prompt", () => now);

    await expect(subject.admit({
      sessionId: "stale-session",
      model: "model-test",
      promptText: "must not be written",
      claim: new TurnClaim("foreground"),
      execute: async (boundary) => {
        boundary.prepare(process.pid);
        const lease = readLease(file, "stale-before-prompt");
        now += 1;
        admission.abandonBeforePrompt(lease, now, "cancelled");
        boundary.beforePromptWrite();
        promptWrites += 1;
        boundary.afterPromptWrite();
        return { stopReason: "end_turn" };
      }
    })).rejects.toThrow("admission dispatch fence is stale");

    expect(promptWrites).toBe(0);
    expect(requestSnapshot(file, "stale-before-prompt")).toMatchObject({
      state: "cancelled",
      payloadCount: 0,
      leaseCount: 0
    });
  });

  it("deletes payload on afterPromptWrite and keeps prompt-free dispatch once-only", async () => {
    const file = databasePath();
    const admission = controller(file);
    let now = 3_000;
    let promptWrites = 0;
    let activeSnapshot: ReturnType<typeof requestSnapshot> | undefined;
    const subject = coordinator(admission, "after-prompt-write", () => now);

    await expect(subject.admit({
      sessionId: "after-session",
      model: "model-test",
      promptText: "write exactly once",
      claim: new TurnClaim("foreground"),
      execute: async (boundary) => {
        boundary.prepare(process.pid);
        boundary.beforePromptWrite();
        promptWrites += 1;
        now += 1;
        boundary.afterPromptWrite();
        activeSnapshot = requestSnapshot(file, "after-prompt-write");
        expect(() => boundary.afterPromptWrite()).toThrow("admission prompt boundary is invalid");
        return { stopReason: "end_turn" };
      }
    })).resolves.toBe("end_turn");

    expect(promptWrites).toBe(1);
    expect(activeSnapshot).toEqual({
      state: "active",
      payloadCount: 0,
      leaseCount: 1,
      leasePhase: "active",
      identityCount: 1
    });
    expect(admission.getRequest("after-prompt-write")?.state).toBe("completed");

    let spawns = 0;
    let writes = 0;
    const boundary = new AgyPromptFreeDispatchBoundary(
      "prompt-free business prompt",
      { requestId: "prompt-free-request", leaseId: "prompt-free-lease", generation: 1, ownerInstanceId: OWNER },
      {
        spawnPromptFree: () => {
          spawns += 1;
          return {
            process: { pid: 7_101 },
            identity: { pid: 7_101, startToken: "boot-1:300" },
            promptChannel: "stdin" as const,
            writeInitialPrompt: (prompt) => {
              expect(prompt).toBe("prompt-free business prompt");
              writes += 1;
              return { status: "accepted" as const };
            }
          };
        },
        persistProcessIdentity: () => ({ status: "recorded" }),
        recheckCancellation: () => ({ generationMatches: true, ownerMatches: true, cancelled: false }),
        commitDispatchIntent: () => ({ status: "committed" })
      }
    );

    const first = boundary.run();
    expect(first).toMatchObject({ state: "active", writeAttempts: 1 });
    expect(boundary.run()).toBe(first);
    expect(spawns).toBe(1);
    expect(writes).toBe(1);
  });
});
