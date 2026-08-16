import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdmissionRuntime } from "../ACP Connector/admission/runtime.js";
import {
  AdmissionController,
  type AdmissionLease,
  type AdmissionRuntimeReaperReaders,
  type AdmissionPolicy
} from "../Admission Controller/controller.js";
import type { LinuxProcessIdentity } from "../Admission Controller/process-evidence.js";
import type { AdmissionStartupRecoveryReaders } from "../ACP Connector/admission/startup-recovery.js";

const BOOT_ID = "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f31";
const NAMESPACE_INODE = 4_026_531_836;
const OWNER_PREFIX = "11111111-1111-4111-8111-11111111111";
const CONNECTOR_CREATED_AT = "2026-08-14T00:00:00.000Z";
const stateDirs: string[] = [];
const controllers: AdmissionController[] = [];

const POLICY: AdmissionPolicy = {
  maxActiveTurns: 3,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

interface ReaperSummary {
  inspected: number;
  released: number;
  retained: number;
  markedRecoveryRequired: number;
  suspected?: number;
  missing?: true;
}

interface RuntimeReaperController {
  reapSuspects?(now: number, readers: AdmissionStartupRecoveryReaders): ReaperSummary;
}

type CreateAdmissionRuntimeWithReaper = (
  environment: NodeJS.ProcessEnv,
  options: {
    readonly reaperReaders: AdmissionRuntimeReaperReaders;
    readonly reaperIntervalMs: number;
  }
) => ReturnType<typeof createAdmissionRuntime>;

interface LeaseStorage {
  rows: number;
  phase: string | null;
  suspectSince: number | null;
  suspectReason: string | null;
  payloadRows: number;
}

function controller(): AdmissionController {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-reaper-"));
  stateDirs.push(stateDir);
  const admission = new AdmissionController({
    databasePath: path.join(stateDir, "runtime.sqlite"),
    policy: POLICY,
    encryptionKey: Buffer.alloc(32, 91),
    contentFingerprintKey: Buffer.alloc(32, 92)
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

function makeRecoveryRequired(
  admission: AdmissionController,
  requestId: string,
  slot: number,
  now = slot * 100
): AdmissionLease {
  const ownerInstanceId = `${OWNER_PREFIX}${slot}`;
  enqueue(admission, requestId, `agent-${slot}`, now);
  const lease = admission.admitRequest(requestId, now + 1, ownerInstanceId);
  expect(lease).not.toBeNull();
  admission.markStarting(lease!, now + 2);
  const processIdentity = identitiesForSlot(slot);
  expect(admission.recordProcessIdentity({
    requestId: lease!.requestId,
    leaseId: lease!.leaseId,
    generation: lease!.generation,
    ownerInstanceId: lease!.ownerInstanceId,
    processIdentity: {
      connector: {
        ownerInstanceId,
        createdAt: CONNECTOR_CREATED_AT,
        ...processIdentity.connector
      },
      child: processIdentity.child
    },
    promptChannel: "stdin"
  })).toEqual({ status: "recorded", idempotent: false });
  admission.markActive(lease!, now + 3);
  admission.markExecutionRecoveryRequired(lease!, now + 4);
  return lease!;
}

function makeExpiredActiveLease(admission: AdmissionController): AdmissionLease {
  return makeActiveLease(admission, "heartbeat-expired-owner", 9, 1_000);
}

function makeActiveLease(
  admission: AdmissionController,
  requestId: string,
  slot: number,
  now: number
): AdmissionLease {
  const ownerInstanceId = `${OWNER_PREFIX}${slot}`;
  enqueue(admission, requestId, `heartbeat-agent-${slot}`, now);
  const lease = admission.admitRequest(requestId, now + 1, ownerInstanceId);
  expect(lease).not.toBeNull();
  admission.markStarting(lease!, now + 2);
  const processIdentity = identitiesForSlot(slot);
  expect(admission.recordProcessIdentity({
    requestId: lease!.requestId,
    leaseId: lease!.leaseId,
    generation: lease!.generation,
    ownerInstanceId: lease!.ownerInstanceId,
    processIdentity: {
      connector: {
        ownerInstanceId,
        createdAt: CONNECTOR_CREATED_AT,
        ...processIdentity.connector
      },
      child: processIdentity.child
    },
    promptChannel: "stdin"
  })).toEqual({ status: "recorded", idempotent: false });
  admission.markActive(lease!, now + 3);
  return lease!;
}

function runReaperIfPresent(
  admission: AdmissionController,
  now: number,
  readers: AdmissionStartupRecoveryReaders
): ReaperSummary {
  const reaper = (admission as RuntimeReaperController).reapSuspects;
  if (typeof reaper !== "function") {
    return Object.freeze({
      inspected: 0,
      released: 0,
      retained: 0,
      markedRecoveryRequired: 0,
      missing: true
    });
  }
  return reaper.call(admission, now, readers);
}

function identitiesForSlot(slot: number): { connector: LinuxProcessIdentity; child: LinuxProcessIdentity } {
  const connectorPid = 3_700 + slot;
  const childPid = 4_100 + slot;
  return {
    connector: Object.freeze({
      bootId: BOOT_ID,
      pid: connectorPid,
      startTimeTicks: String(10_000 + slot),
      pidNamespaceInode: NAMESPACE_INODE,
      ppid: 1,
      pgrp: connectorPid,
      session: connectorPid
    }),
    child: Object.freeze({
      bootId: BOOT_ID,
      pid: childPid,
      startTimeTicks: String(20_000 + slot),
      pidNamespaceInode: NAMESPACE_INODE,
      ppid: connectorPid,
      pgrp: childPid,
      session: childPid
    })
  };
}

function readers(options: {
  processState: "same" | "gone" | "unverifiable";
  processIds?: readonly number[];
}): AdmissionStartupRecoveryReaders & AdmissionRuntimeReaperReaders {
  return {
    listProcessIds() {
      return options.processIds ?? [];
    },
    readFile(filePath) {
      if (filePath === "/proc/sys/kernel/random/boot_id") return `${BOOT_ID}\n`;
      const identity = identityForProcPath(filePath);
      if (identity === null) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      if (options.processState === "gone") throw Object.assign(new Error("gone"), { code: "ENOENT" });
      if (options.processState === "unverifiable") throw new Error("unreadable process stat");
      return processStat(identity);
    },
    readLink(filePath) {
      const identity = identityForNamespacePath(filePath);
      if (identity === null) throw Object.assign(new Error("gone"), { code: "ENOENT" });
      if (options.processState === "gone") throw Object.assign(new Error("gone"), { code: "ENOENT" });
      if (options.processState === "unverifiable") throw new Error("unreadable namespace");
      return `pid:[${identity.pidNamespaceInode}]`;
    }
  };
}

function identityForProcPath(filePath: string): LinuxProcessIdentity | null {
  const match = /^\/proc\/([1-9][0-9]*)\/stat$/.exec(filePath);
  if (match === null) return null;
  return identityForPid(Number(match[1]));
}

function identityForNamespacePath(filePath: string): LinuxProcessIdentity | null {
  const match = /^\/proc\/([1-9][0-9]*)\/ns\/pid$/.exec(filePath);
  if (match === null) return null;
  return identityForPid(Number(match[1]));
}

function identityForPid(pid: number): LinuxProcessIdentity | null {
  for (const slot of [1, 2, 3, 7, 8, 9]) {
    const identity = identitiesForSlot(slot);
    if (identity.connector.pid === pid) return identity.connector;
    if (identity.child.pid === pid) return identity.child;
  }
  return null;
}

function processStat(identity: LinuxProcessIdentity): string {
  const fields = [
    "S",
    String(identity.ppid),
    String(identity.pgrp),
    String(identity.session),
    "0",
    "-1",
    "4194560",
    "1",
    "0",
    "0",
    "0",
    "4",
    "2",
    "0",
    "0",
    "20",
    "0",
    "1",
    "0",
    identity.startTimeTicks,
    "0",
    "0"
  ];
  return `${identity.pid} (agy) ${fields.join(" ")}\n`;
}

function leaseStorage(admission: AdmissionController, requestId: string): LeaseStorage {
  const database = new Database(admission.databasePath, { readonly: true });
  try {
    const lease = database
      .prepare(
        `SELECT phase,
                suspect_since AS suspectSince,
                suspect_reason AS suspectReason
         FROM leases
         WHERE request_id = ?`
      )
      .get(requestId) as
      | { phase: string; suspectSince: number | null; suspectReason: string | null }
      | undefined;
    const rows = (database
      .prepare("SELECT COUNT(*) AS count FROM leases WHERE request_id = ?")
      .get(requestId) as { count: number }).count;
    const payloadRows = (database
      .prepare("SELECT COUNT(*) AS count FROM turn_payloads WHERE request_id = ?")
      .get(requestId) as { count: number }).count;
    return {
      rows,
      phase: lease?.phase ?? null,
      suspectSince: lease?.suspectSince ?? null,
      suspectReason: lease?.suspectReason ?? null,
      payloadRows
    };
  } finally {
    database.close();
  }
}

afterEach(() => {
  vi.useRealTimers();
  for (const admission of controllers.splice(0)) admission.close();
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

describe("S3-T14 heartbeat suspect and runtime reaper", () => {
  it("runs the reaper from the production admission runtime without connector restart", () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const directory = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-reaper-runtime-"));
    stateDirs.push(directory);
    const createRuntime = createAdmissionRuntime as unknown as CreateAdmissionRuntimeWithReaper;
    const runtime = createRuntime({
      AGY_ACP_ADMISSION_ENABLED: "1",
      AGY_ACP_STATE_DIR: directory,
      PASEO_AGENT_ID: "runtime-reaper-agent"
    }, {
      reaperReaders: readers({ processState: "gone", processIds: [] }),
      reaperIntervalMs: 1_000
    });
    expect(runtime).not.toBeNull();

    const admission = runtime!.controller;
    for (const slot of [1, 2, 3]) {
      makeRecoveryRequired(admission, `runtime-recovery-${slot}`, slot, 10_000 + slot * 3_000);
    }
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1_000);
    enqueue(admission, "after-runtime-reaper", "fresh-runtime-agent", 21_001);
    const admittedAfterReap = admission.admitNext(21_002, `${OWNER_PREFIX}8`);

    expect({
      admittedAfterReap: admittedAfterReap?.requestId ?? null,
      recoveryStates: [1, 2, 3].map((slot) => admission.getRequest(`runtime-recovery-${slot}`)?.state),
      recoveryPayloadRows: [1, 2, 3].map((slot) => leaseStorage(admission, `runtime-recovery-${slot}`).payloadRows),
      recoveryLeaseRows: [1, 2, 3].map((slot) => leaseStorage(admission, `runtime-recovery-${slot}`).rows)
    }).toMatchObject({
      admittedAfterReap: "after-runtime-reaper",
      recoveryStates: ["recovery_required", "recovery_required", "recovery_required"],
      recoveryPayloadRows: [0, 0, 0],
      recoveryLeaseRows: [0, 0, 0]
    });

    runtime!.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("releases verified exited recovery seats without replay or connector restart", () => {
    const admission = controller();
    for (const slot of [1, 2, 3]) makeRecoveryRequired(admission, `recovery-${slot}`, slot);

    const summary = runReaperIfPresent(admission, 5_000, readers({ processState: "gone", processIds: [] }));
    const repeatSummary = runReaperIfPresent(admission, 5_001, readers({ processState: "gone", processIds: [] }));
    enqueue(admission, "after-recovery", "fresh-agent", 5_002);
    const admittedAfterReap = admission.admitNext(5_003, `${OWNER_PREFIX}8`);

    expect({
      summary,
      repeatSummary,
      admittedAfterReap: admittedAfterReap?.requestId ?? null,
      recoveryStates: [1, 2, 3].map((slot) => admission.getRequest(`recovery-${slot}`)?.state),
      recoveryPayloadRows: [1, 2, 3].map((slot) => leaseStorage(admission, `recovery-${slot}`).payloadRows),
      recoveryLeaseRows: [1, 2, 3].map((slot) => leaseStorage(admission, `recovery-${slot}`).rows)
    }).toMatchObject({
      summary: { released: 3, retained: 0 },
      repeatSummary: { inspected: 0, released: 0, retained: 0 },
      admittedAfterReap: "after-recovery",
      recoveryStates: ["recovery_required", "recovery_required", "recovery_required"],
      recoveryPayloadRows: [0, 0, 0],
      recoveryLeaseRows: [0, 0, 0]
    });
  });

  it("marks heartbeat expiry suspect without releasing when process evidence is still live", () => {
    const admission = controller();
    const lease = makeExpiredActiveLease(admission);
    const child = identitiesForSlot(9).child;

    const summary = runReaperIfPresent(admission, 10_000, readers({
      processState: "same",
      processIds: [child.pid]
    }));
    const storage = leaseStorage(admission, lease.requestId);

    expect({
      summary,
      storage
    }).toMatchObject({
      summary: { released: 0, retained: 1 },
      storage: {
        rows: 1,
        phase: "active",
        suspectSince: 10_000,
        suspectReason: "heartbeat_expired"
      }
    });
  });

  it("marks heartbeat expiry only when heartbeat age is greater than four seconds", () => {
    const admission = controller();
    makeActiveLease(admission, "heartbeat-above-threshold", 9, 5_996);
    makeActiveLease(admission, "heartbeat-equal-threshold", 8, 5_997);
    makeActiveLease(admission, "heartbeat-below-threshold", 7, 5_998);

    const child7 = identitiesForSlot(7).child;
    const child8 = identitiesForSlot(8).child;
    const child9 = identitiesForSlot(9).child;
    const summary = runReaperIfPresent(admission, 10_000, readers({
      processState: "same",
      processIds: [child7.pid, child8.pid, child9.pid]
    }));

    expect({
      summary,
      below: leaseStorage(admission, "heartbeat-below-threshold"),
      equal: leaseStorage(admission, "heartbeat-equal-threshold"),
      above: leaseStorage(admission, "heartbeat-above-threshold")
    }).toMatchObject({
      summary: { released: 0, retained: 3 },
      below: { rows: 1, suspectSince: null, suspectReason: null },
      equal: { rows: 1, suspectSince: null, suspectReason: null },
      above: { rows: 1, suspectSince: 10_000, suspectReason: "heartbeat_expired" }
    });
  });

  it("keeps unverifiable process evidence suspect without releasing the seat", () => {
    const admission = controller();
    const lease = makeExpiredActiveLease(admission);

    const summary = runReaperIfPresent(admission, 10_000, readers({
      processState: "unverifiable",
      processIds: [identitiesForSlot(9).child.pid]
    }));
    const storage = leaseStorage(admission, lease.requestId);

    expect({
      summary,
      storage
    }).toMatchObject({
      summary: { released: 0, retained: 1 },
      storage: {
        rows: 1,
        phase: "active",
        suspectSince: 10_000,
        suspectReason: "identity_unverifiable"
      }
    });
  });
});
