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
import type { LinuxProcessIdentity } from "../Admission Controller/process-evidence.js";
import {
  recoverExitedAdmissionSeats,
  type AdmissionStartupRecoveryReaders
} from "../ACP Connector/admission/startup-recovery.js";

const BOOT_ID = "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f31";
const NAMESPACE_INODE = 4_026_531_836;
const OWNER_ID = "11111111-1111-4111-8111-111111111111";
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
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-startup-recovery-"));
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
    requestId: "startup-recovery-request",
    sessionId: "startup-recovery-session",
    agentId: "startup-recovery-agent",
    fingerprint: "startup-recovery-fingerprint",
    provider: "antigravity",
    model: "model-test",
    now: 1_000
  }, "must never replay", 61_000);
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
        createdAt: "2026-08-14T00:00:00.000Z",
        ...CONNECTOR
      },
      child: CHILD
    },
    promptChannel: "stdin"
  })).toEqual({ status: "recorded", idempotent: false });
  return lease;
}

function readers(options: {
  connector: "same" | "gone" | "unverifiable";
  child: "same" | "gone" | "unverifiable";
  processIds?: readonly number[];
  listUnavailable?: boolean;
}): AdmissionStartupRecoveryReaders {
  return {
    listProcessIds() {
      if (options.listUnavailable) throw new Error("process inventory unavailable");
      return options.processIds ?? [];
    },
    readFile(filePath) {
      if (filePath === "/proc/sys/kernel/random/boot_id") return `${BOOT_ID}\n`;
      if (filePath === `/proc/${CONNECTOR.pid}/stat`) return processStat(CONNECTOR, options.connector);
      if (filePath === `/proc/${CHILD.pid}/stat`) return processStat(CHILD, options.child);
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    },
    readLink(filePath) {
      if (filePath === `/proc/${CONNECTOR.pid}/ns/pid`) return namespace(options.connector);
      if (filePath === `/proc/${CHILD.pid}/ns/pid`) return namespace(options.child);
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    }
  };
}

function processStat(identity: LinuxProcessIdentity, state: "same" | "gone" | "unverifiable"): string {
  if (state === "gone") throw Object.assign(new Error("gone"), { code: "ENOENT" });
  if (state === "unverifiable") throw new Error("unreadable process stat");
  const fields = [
    "S",
    String(identity.ppid),
    String(identity.pgrp),
    String(identity.session),
    "0", "-1", "4194560", "1", "0", "0", "0", "4", "2", "0", "0", "20", "0", "1", "0",
    identity.startTimeTicks,
    "0", "0"
  ];
  return `${identity.pid} (agy) ${fields.join(" ")}\n`;
}

function namespace(state: "same" | "gone" | "unverifiable"): string {
  if (state === "gone") throw Object.assign(new Error("gone"), { code: "ENOENT" });
  if (state === "unverifiable") throw new Error("unreadable namespace");
  return `pid:[${NAMESPACE_INODE}]`;
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

describe("admission startup recovery", () => {
  it("releases a proven exited local process tree but keeps the request recovery-required", () => {
    const admission = controller();
    dispatch(admission);

    expect(recoverExitedAdmissionSeats(admission, {
      readers: readers({ connector: "gone", child: "gone", processIds: [] }),
      now: () => 2_000
    })).toEqual({ inspected: 1, released: 1, retained: 0, markedRecoveryRequired: 0 });

    expect(admission.getRequest("startup-recovery-request")?.state).toBe("recovery_required");
    expect(leaseCount(admission)).toBe(0);
    expect(() => admission.readPayload("startup-recovery-request", 2_000)).toThrow(/no payload/i);
    expect(admission.readSanitizedEvents({ afterEventSeq: 0, limit: 20 }).at(-1)).toMatchObject({
      kind: "request_recovery_seat_released",
      toState: "recovery_required"
    });
  });

  it("retains the seat when the old connector is gone but the child process group remains", () => {
    const admission = controller();
    dispatch(admission);

    expect(recoverExitedAdmissionSeats(admission, {
      readers: readers({ connector: "gone", child: "same", processIds: [CHILD.pid] }),
      now: () => 2_000
    })).toEqual({ inspected: 1, released: 0, retained: 1, markedRecoveryRequired: 1 });

    expect(admission.getRequest("startup-recovery-request")?.state).toBe("recovery_required");
    expect(leaseCount(admission)).toBe(1);
    expect(admission.listRecoverableDispatches()[0]?.phase).toBe("recovery_required");
  });

  it("fails closed without mutating the lease when process inventory is unavailable", () => {
    const admission = controller();
    dispatch(admission);

    expect(recoverExitedAdmissionSeats(admission, {
      readers: readers({ connector: "gone", child: "gone", listUnavailable: true }),
      now: () => 2_000
    })).toEqual({ inspected: 1, released: 0, retained: 1, markedRecoveryRequired: 0 });

    expect(admission.getRequest("startup-recovery-request")?.state).toBe("dispatch_intent");
    expect(leaseCount(admission)).toBe(1);
    expect(admission.readPayload("startup-recovery-request", 2_000)).toBe("must never replay");
  });
});
