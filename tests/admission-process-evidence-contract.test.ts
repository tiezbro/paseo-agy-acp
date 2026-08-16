import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdmissionController,
  type AdmissionLease,
  type AdmissionPolicy
} from "../Admission Controller/controller.js";
import {
  captureLinuxProcessIdentity,
  observeLinuxProcessIdentity,
  type LinuxProcessEvidenceReaders,
  type LinuxProcessIdentity
} from "../Admission Controller/process-evidence.js";
import {
  recoverExitedAdmissionSeats,
  type AdmissionStartupRecoveryReaders
} from "../ACP Connector/admission/startup-recovery.js";

const BOOT_ID = "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f31";
const REUSED_BOOT_ID = "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f32";
const NAMESPACE_INODE = 4_026_531_836;
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const CONNECTOR_CREATED_AT = "2026-08-14T00:00:00.000Z";
const stateDirs: string[] = [];
const controllers: AdmissionController[] = [];

const POLICY: AdmissionPolicy = {
  maxActiveTurns: 1,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

const CONNECTOR: LinuxProcessIdentity = Object.freeze({
  bootId: BOOT_ID,
  pid: 3_711,
  startTimeTicks: "100",
  pidNamespaceInode: NAMESPACE_INODE,
  ppid: 1,
  pgrp: 3_711,
  session: 3_711
});

const CHILD: LinuxProcessIdentity = Object.freeze({
  bootId: BOOT_ID,
  pid: 4_182,
  startTimeTicks: "200",
  pidNamespaceInode: NAMESPACE_INODE,
  ppid: CONNECTOR.pid,
  pgrp: 4_182,
  session: 4_182
});

function controller(): AdmissionController {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-process-evidence-contract-"));
  stateDirs.push(stateDir);
  const admission = new AdmissionController({
    databasePath: path.join(stateDir, "runtime.sqlite"),
    policy: POLICY,
    encryptionKey: Buffer.alloc(32, 21),
    contentFingerprintKey: Buffer.alloc(32, 22)
  });
  controllers.push(admission);
  return admission;
}

function dispatch(admission: AdmissionController): AdmissionLease {
  admission.enqueueWithPayload({
    requestId: "process-evidence-request",
    sessionId: "process-evidence-session",
    agentId: "process-evidence-agent",
    fingerprint: "process-evidence-fingerprint",
    provider: "antigravity",
    model: "model-test",
    now: 1_000
  }, "must never replay after process exit", 61_000);
  const lease = admission.admitNext(1_001, OWNER_ID)!;
  admission.markStarting(lease, 1_002);
  expect(admission.recordProcessIdentity({
    requestId: lease.requestId,
    leaseId: lease.leaseId,
    generation: lease.generation,
    ownerInstanceId: lease.ownerInstanceId,
    processIdentity: {
      connector: {
        ownerInstanceId: OWNER_ID,
        createdAt: CONNECTOR_CREATED_AT,
        ...CONNECTOR
      },
      child: CHILD
    },
    promptChannel: "stdin"
  })).toEqual({ status: "recorded", idempotent: false });
  return lease;
}

function processEvidenceReaders(
  identity: LinuxProcessIdentity,
  overrides: Partial<{
    bootId: string;
    stat: string;
  }> = {}
): LinuxProcessEvidenceReaders {
  return {
    readFile(filePath) {
      if (filePath === "/proc/sys/kernel/random/boot_id") return `${overrides.bootId ?? identity.bootId}\n`;
      if (filePath === `/proc/${identity.pid}/stat`) return overrides.stat ?? processStat(identity);
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    },
    readLink(filePath) {
      if (filePath === `/proc/${identity.pid}/ns/pid`) return `pid:[${identity.pidNamespaceInode}]`;
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    }
  };
}

function recoveryReaders(options: {
  connector: "same" | "gone";
  child: "same" | "gone";
  processIds: readonly number[];
}): AdmissionStartupRecoveryReaders {
  return {
    listProcessIds() {
      return options.processIds;
    },
    readFile(filePath) {
      if (filePath === "/proc/sys/kernel/random/boot_id") return `${BOOT_ID}\n`;
      if (filePath === `/proc/${CONNECTOR.pid}/stat`) return processStatOrGone(CONNECTOR, options.connector);
      if (filePath === `/proc/${CHILD.pid}/stat`) return processStatOrGone(CHILD, options.child);
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    },
    readLink(filePath) {
      if (filePath === `/proc/${CONNECTOR.pid}/ns/pid`) return namespaceOrGone(CONNECTOR, options.connector);
      if (filePath === `/proc/${CHILD.pid}/ns/pid`) return namespaceOrGone(CHILD, options.child);
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    }
  };
}

function processStatOrGone(identity: LinuxProcessIdentity, state: "same" | "gone"): string {
  if (state === "gone") throw Object.assign(new Error("gone"), { code: "ENOENT" });
  return processStat(identity);
}

function namespaceOrGone(identity: LinuxProcessIdentity, state: "same" | "gone"): string {
  if (state === "gone") throw Object.assign(new Error("gone"), { code: "ENOENT" });
  return `pid:[${identity.pidNamespaceInode}]`;
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

function leaseCount(admission: AdmissionController): number {
  const database = new Database(admission.databasePath, { readonly: true });
  try {
    return (database.prepare("SELECT COUNT(*) AS count FROM leases").get() as { count: number }).count;
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const admission of controllers.splice(0)) admission.close();
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

describe("S3-T13 process evidence contract", () => {
  it("treats the same PID and start ticks on a different boot as PID reuse", () => {
    const expected = captureLinuxProcessIdentity(CHILD.pid, processEvidenceReaders(CHILD));
    const reusedProcess = processEvidenceReaders(CHILD, { bootId: REUSED_BOOT_ID });

    expect(observeLinuxProcessIdentity(expected, reusedProcess)).toBe("pid_reused");
  });

  it("releases a startup recovery seat only after connector gone, child gone, and empty process group", () => {
    const admission = controller();
    dispatch(admission);

    expect(recoverExitedAdmissionSeats(admission, {
      readers: recoveryReaders({ connector: "gone", child: "gone", processIds: [] }),
      now: () => 2_000
    })).toEqual({ inspected: 1, released: 1, retained: 0, markedRecoveryRequired: 0 });

    expect(admission.getRequest("process-evidence-request")?.state).toBe("recovery_required");
    expect(leaseCount(admission)).toBe(0);
    expect(() => admission.readPayload("process-evidence-request", 2_000)).toThrow(/no payload/i);
    expect(admission.readSanitizedEvents({ afterEventSeq: 0, limit: 20 }).at(-1)).toMatchObject({
      kind: "request_recovery_seat_released",
      toState: "recovery_required"
    });
  });
});
