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

function databasePath(): string {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-fault-"));
  stateDirs.push(stateDir);
  return path.join(stateDir, "runtime.sqlite");
}

function controller(file: string, faultInjection?: AdmissionControllerFaultInjection): AdmissionController {
  const admission = new AdmissionController({
    databasePath: file,
    policy: POLICY,
    encryptionKey: Buffer.alloc(32, 51),
    contentFingerprintKey: Buffer.alloc(32, 52),
    faultInjection
  });
  controllers.push(admission);
  return admission;
}

function starting(admission: AdmissionController): AdmissionLease {
  admission.enqueueWithPayload({
    requestId: "atomic-request",
    sessionId: "atomic-session",
    agentId: "atomic-agent",
    fingerprint: "atomic-fingerprint",
    provider: "antigravity",
    model: "model-test",
    now: 1_000
  }, "private prompt", 61_000);
  const lease = admission.admitNext(1_001, OWNER)!;
  admission.markStarting(lease, 1_002);
  return lease;
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

afterEach(() => {
  for (const admission of controllers.splice(0)) admission.close();
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

describe("Admission dispatch fault boundaries", () => {
  it("commits process identity and dispatch intent atomically", () => {
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
    expect(admission.getRequest(lease.requestId)?.state).toBe("starting");

    const db = new Database(file, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM lease_process_identities").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT phase FROM leases").get()).toEqual({ phase: "starting" });
    db.close();
  });

  it("never retries an uncertain business-prompt write", () => {
    let spawns = 0;
    let writes = 0;
    const boundary = new AgyPromptFreeDispatchBoundary(
      "business prompt",
      { requestId: "request", leaseId: "lease", generation: 1, ownerInstanceId: OWNER },
      {
        spawnPromptFree: () => {
          spawns += 1;
          return {
            process: { pid: 7_002 },
            identity: { pid: 7_002 },
            promptChannel: "stdin" as const,
            writeInitialPrompt: () => {
              writes += 1;
              return undefined;
            }
          };
        },
        persistProcessIdentity: () => ({ status: "recorded" }),
        recheckCancellation: () => ({ generationMatches: true, ownerMatches: true, cancelled: false }),
        commitDispatchIntent: () => ({ status: "committed" })
      }
    );

    const first = boundary.run();
    expect(first).toMatchObject({ state: "dispatch_ambiguous", writeAttempts: 1 });
    expect(boundary.run()).toBe(first);
    expect(spawns).toBe(1);
    expect(writes).toBe(1);
  });
});
