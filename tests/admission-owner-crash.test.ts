import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdmissionController,
  type AdmissionLease,
  type AdmissionPolicy
} from "../Admission Controller/controller.js";
import { recoverExitedAdmissionSeats } from "../ACP Connector/admission/startup-recovery.js";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEAD_REQUEST_ID = "dead-owner-request";
const LIVE_REQUEST_ID = "live-after-dead-owner";
const HOLDER_REQUEST_ID = "seat-holder";
const LIVE_OWNER_ID = "22222222-2222-4222-8222-222222222222";
const HOLDER_OWNER_ID = "33333333-3333-4333-8333-333333333333";

const POLICY: AdmissionPolicy = {
  maxActiveTurns: 1,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

const stateDirs: string[] = [];
const controllers: AdmissionController[] = [];
const children: ChildProcess[] = [];

interface RequestStorage {
  state: string | null;
  queuedOwnerInstanceId: string | null;
  queuedOwnerRecordedAt: number | null;
  ownerRecordCount: number;
  payloadRows: number;
  leaseRows: number;
}

function controller(): AdmissionController {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-owner-crash-"));
  stateDirs.push(stateDir);
  const admission = new AdmissionController({
    databasePath: path.join(stateDir, "runtime.sqlite"),
    policy: POLICY,
    encryptionKey: Buffer.alloc(32, 61),
    contentFingerprintKey: Buffer.alloc(32, 62)
  });
  controllers.push(admission);
  return admission;
}

function enqueue(
  admission: AdmissionController,
  requestId: string,
  agentId: string,
  now: number,
  prompt = `prompt-${requestId}`
): void {
  admission.enqueueWithPayload({
    requestId,
    sessionId: `session-${requestId}`,
    agentId,
    fingerprint: `fingerprint-${requestId}`,
    provider: "antigravity",
    model: "model-test",
    now
  }, prompt, now + POLICY.queueTimeoutMs);
}

function occupyOnlySeat(admission: AdmissionController): AdmissionLease {
  enqueue(admission, HOLDER_REQUEST_ID, "holder-agent", 100, "holder prompt");
  const lease = admission.admitRequest(HOLDER_REQUEST_ID, 101, HOLDER_OWNER_ID);
  expect(lease).not.toBeNull();
  admission.markStarting(lease!, 102);
  admission.markDispatchIntent(lease!, 103);
  admission.markActive(lease!, 104);
  return lease!;
}

function spawnQueuedOwnerChild(databasePath: string, markerPath: string): ChildProcess {
  const scriptPath = path.join(path.dirname(databasePath), "queued-owner-child.mjs");
  writeFileSync(scriptPath, childScript(), { mode: 0o600 });
  const child = spawn(process.execPath, [scriptPath, databasePath, REPOSITORY_ROOT, markerPath], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  return child;
}

function childScript(): string {
  return `
import { writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [databasePath, repositoryRoot, markerPath] = process.argv.slice(2);
const { AdmissionController } = await import(
  pathToFileURL(path.join(repositoryRoot, "dist/Admission Controller/controller.js")).href
);
const { AdmissionTurnCoordinator } = await import(
  pathToFileURL(path.join(repositoryRoot, "dist/ACP Connector/admission/turn-coordinator.js")).href
);
const { TurnClaim } = await import(
  pathToFileURL(path.join(repositoryRoot, "dist/ACP Connector/acp/session/turn-scheduler.js")).href
);

const policy = {
  maxActiveTurns: 1,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};
const controller = new AdmissionController({
  databasePath,
  policy,
  encryptionKey: Buffer.alloc(32, 61),
  contentFingerprintKey: Buffer.alloc(32, 62)
});
const claim = new TurnClaim("queued");
let reported = false;
const coordinator = new AdmissionTurnCoordinator({
  controller,
  agentId: "dead-owner-agent",
  createRequestId: () => "${DEAD_REQUEST_ID}",
  now: () => 2_000,
  queuePollIntervalMs: 25,
  progressIntervalMs: 1,
  wait: () => new Promise(() => {})
});

await coordinator.admit({
  sessionId: "dead-owner-session",
  model: "model-test",
  promptText: "dead owner prompt must not replay",
  claim,
  reportProgress() {
    if (!reported) {
      reported = true;
      process.stdout.write("queued\\n");
    }
  },
  async execute() {
    writeFileSync(markerPath, "business prompt executed");
    return { stopReason: "end_turn" };
  }
});
`;
}

async function waitForStdoutLine(
  child: ChildProcess,
  expected: string,
  timeoutMs: number,
  stderr: () => string
): Promise<void> {
  let stdout = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for child stdout ${expected}; stdout=${stdout}; stderr=${stderr()}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`child exited before ${expected}; code=${code}; signal=${signal}; stdout=${stdout}; stderr=${stderr()}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

async function killAndWait(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGKILL");
  await once(child, "exit");
}

function requestStorage(databasePath: string, requestId: string): RequestStorage {
  const db = new Database(databasePath, { readonly: true });
  try {
    const request = db
      .prepare(
        `SELECT state,
                queued_owner_instance_id AS queuedOwnerInstanceId,
                queued_owner_recorded_at AS queuedOwnerRecordedAt
         FROM turn_requests
         WHERE request_id = ?`
      )
      .get(requestId) as
      | { state: string; queuedOwnerInstanceId: string | null; queuedOwnerRecordedAt: number | null }
      | undefined;
    const ownerRecordCount = request?.queuedOwnerInstanceId === undefined || request.queuedOwnerInstanceId === null
      ? 0
      : (db
        .prepare("SELECT COUNT(*) AS count FROM queued_owner_instances WHERE owner_instance_id = ?")
        .get(request.queuedOwnerInstanceId) as { count: number }).count;
    const payloadRows = (db
      .prepare("SELECT COUNT(*) AS count FROM turn_payloads WHERE request_id = ?")
      .get(requestId) as { count: number }).count;
    const leaseRows = (db
      .prepare("SELECT COUNT(*) AS count FROM leases WHERE request_id = ?")
      .get(requestId) as { count: number }).count;
    return {
      state: request?.state ?? null,
      queuedOwnerInstanceId: request?.queuedOwnerInstanceId ?? null,
      queuedOwnerRecordedAt: request?.queuedOwnerRecordedAt ?? null,
      ownerRecordCount,
      payloadRows,
      leaseRows
    };
  } finally {
    db.close();
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    await killAndWait(child);
  }
  for (const admission of controllers.splice(0)) admission.close();
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

describe("queued owner crash recovery", () => {
  it("cancels a killed queued owner before later eligible work can admit", async () => {
    const admission = controller();
    const markerPath = path.join(path.dirname(admission.databasePath), "dead-owner-executed.txt");
    const holder = occupyOnlySeat(admission);

    let stderr = "";
    const child = spawnQueuedOwnerChild(admission.databasePath, markerPath);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    await waitForStdoutLine(child, "queued", 5_000, () => stderr);

    const queuedBeforeDeath = requestStorage(admission.databasePath, DEAD_REQUEST_ID);
    expect(queuedBeforeDeath.state).toBe("queued");
    expect(queuedBeforeDeath.leaseRows).toBe(0);

    await killAndWait(child);
    admission.completeLiveTurn(holder, 2_300, { outcome: "completed" });

    recoverExitedAdmissionSeats(admission, { now: () => 2_400 });
    const deadAfterRecovery = requestStorage(admission.databasePath, DEAD_REQUEST_ID);
    const queuedOwnerDeadEvents = admission
      .readSanitizedEvents({ afterEventSeq: 0, limit: 50 })
      .filter((event) => String(event.kind) === "queued_owner_dead");

    expect.soft(deadAfterRecovery.queuedOwnerInstanceId).toEqual(
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    );
    expect.soft(deadAfterRecovery.queuedOwnerRecordedAt).toEqual(expect.any(Number));
    expect.soft(deadAfterRecovery.ownerRecordCount).toBe(1);
    expect.soft(deadAfterRecovery.state).toBe("cancelled");
    expect.soft(deadAfterRecovery.payloadRows).toBe(0);
    expect.soft(deadAfterRecovery.leaseRows).toBe(0);
    expect.soft(queuedOwnerDeadEvents).toHaveLength(1);
    expect.soft(existsSync(markerPath)).toBe(false);

    recoverExitedAdmissionSeats(admission, { now: () => 2_401 });
    const deadAfterRepeatRecovery = requestStorage(admission.databasePath, DEAD_REQUEST_ID);
    const queuedOwnerDeadEventsAfterRepeat = admission
      .readSanitizedEvents({ afterEventSeq: 0, limit: 50 })
      .filter((event) => String(event.kind) === "queued_owner_dead");
    expect.soft(deadAfterRepeatRecovery.state).toBe("cancelled");
    expect.soft(deadAfterRepeatRecovery.payloadRows).toBe(0);
    expect.soft(queuedOwnerDeadEventsAfterRepeat).toHaveLength(1);

    enqueue(admission, LIVE_REQUEST_ID, "live-agent", 2_500, "live prompt");
    const admitted = admission.admitNext(2_501, LIVE_OWNER_ID);
    expect.soft(admitted?.requestId).toBe(LIVE_REQUEST_ID);
    expect.soft(admitted?.requestId).not.toBe(DEAD_REQUEST_ID);
  });
});
