import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdmissionController,
  type AdmissionControllerFaultInjection,
  type AdmissionLease,
  type AdmissionPolicy,
  type VerifiedLinuxProcessRecord
} from "../Admission Controller/controller.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "11111111-1111-4111-8111-111111111111";
const BOOT = "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f31";
const NAMESPACE_INODE = 4_026_531_836;
const stateDirs: string[] = [];
const controllers: AdmissionController[] = [];

const POLICY: AdmissionPolicy = {
  maxActiveTurns: 1,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

const CONTENTION_WINNER_SCRIPT = `
import path from "node:path";
import { pathToFileURL } from "node:url";

const [repositoryRoot, databasePath, recordJson] = process.argv.slice(1);
if (!repositoryRoot || !databasePath || !recordJson) {
  throw new Error("usage: contention-winner <repositoryRoot> <databasePath> <recordJson>");
}
const { AdmissionController } = await import(
  pathToFileURL(path.join(repositoryRoot, "dist/Admission Controller/controller.js")).href
);
const record = JSON.parse(recordJson);
const waitBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
const waitSignal = new Int32Array(waitBuffer);
let lockAnnounced = false;
const admission = new AdmissionController({
  databasePath,
  policy: {
    maxActiveTurns: 1,
    maxConcurrentStarts: 1,
    minStartIntervalMs: 0,
    queueTimeoutMs: 30 * 60_000,
    capacityCooldownMs: 30_000
  },
  encryptionKey: Buffer.alloc(32, 81),
  contentFingerprintKey: Buffer.alloc(32, 82),
  faultInjection: {
    afterProcessIdentityPersisted() {
      if (!lockAnnounced) {
        lockAnnounced = true;
        process.stdout.write("locked\\n");
      }
      Atomics.wait(waitSignal, 0, 0, 500);
    }
  }
});
const result = admission.recordProcessIdentity(record);
admission.close();
process.stdout.write(\`\${JSON.stringify(result)}\\n\`);
if (result.status !== "recorded") process.exitCode = 2;
`;

function databasePath(): string {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-sqlite-contention-"));
  stateDirs.push(stateDir);
  return path.join(stateDir, "runtime.sqlite");
}

function controller(file: string, faultInjection?: AdmissionControllerFaultInjection): AdmissionController {
  const admission = new AdmissionController({
    databasePath: file,
    policy: POLICY,
    encryptionKey: Buffer.alloc(32, 81),
    contentFingerprintKey: Buffer.alloc(32, 82),
    faultInjection
  });
  controllers.push(admission);
  return admission;
}

function starting(admission: AdmissionController, requestId: string): AdmissionLease {
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
        pid: 7_101,
        startTimeTicks: "100",
        pidNamespaceInode: NAMESPACE_INODE,
        ppid: 1,
        pgrp: 7_101,
        session: 7_101
      },
      child: {
        bootId: BOOT,
        pid: 7_102,
        startTimeTicks: "200",
        pidNamespaceInode: NAMESPACE_INODE,
        ppid: 7_101,
        pgrp: 7_102,
        session: 7_102
      }
    }
  };
}

function rowCounts(file: string): { identities: number; requestState: string; leasePhase: string } {
  const db = new Database(file, { readonly: true });
  try {
    return {
      identities: (db.prepare("SELECT COUNT(*) AS count FROM lease_process_identities").get() as { count: number }).count,
      requestState: (db.prepare("SELECT state FROM turn_requests").get() as { state: string }).state,
      leasePhase: (db.prepare("SELECT phase FROM leases").get() as { phase: string }).phase
    };
  } finally {
    db.close();
  }
}

function waitForLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes(`${expected}\n`)) resolve();
    });
    child.stderr.setEncoding("utf8");
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`contention child exited before ${expected}: ${code}`)));
  });
}

afterEach(() => {
  for (const admission of controllers.splice(0)) admission.close();
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

describe("Admission SQLite contention and rollback contract", () => {
  it("rechecks a committed dispatch identity after a child process holds the SQLite writer lock", async () => {
    const file = databasePath();
    const admission = controller(file);
    const lease = starting(admission, "contention-request");
    const record = processRecord(lease);
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", CONTENTION_WINNER_SCRIPT, repositoryRoot, file, JSON.stringify(record)],
      { cwd: repositoryRoot, stdio: "pipe" }
    );

    await waitForLine(child, "locked");
    const startedAt = Date.now();
    const result = admission.recordProcessIdentity(record);
    const elapsedMs = Date.now() - startedAt;
    const [exitCode] = await once(child, "exit") as [number | null];
    const rows = rowCounts(file);

    expect(exitCode).toBe(0);
    expect(result).toEqual({ status: "recorded", idempotent: true });
    expect(elapsedMs).toBeGreaterThanOrEqual(250);
    expect(elapsedMs).toBeLessThan(2_000);
    expect(rows).toEqual({
      identities: 1,
      requestState: "dispatch_intent",
      leasePhase: "dispatch_intent"
    });
  }, 5_000);

  it("rolls back identity, lease phase, and request state after an injected transaction fault", () => {
    const file = databasePath();
    const admission = controller(file, {
      afterProcessIdentityPersisted() {
        throw new Error("injected transaction fault");
      }
    });
    const lease = starting(admission, "rollback-request");
    const record = processRecord(lease);

    expect(admission.recordProcessIdentity(record)).toEqual({
      status: "not_recorded",
      reason: "transaction_fault"
    });
    expect(rowCounts(file)).toEqual({
      identities: 0,
      requestState: "starting",
      leasePhase: "starting"
    });
  });
});
