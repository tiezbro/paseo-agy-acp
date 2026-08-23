import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdmissionController,
  type AdmissionLease,
  type AdmissionPolicy
} from "../Admission Controller/controller.js";
import {
  AdmissionRuntimeConfigError,
  DEFAULT_ADMISSION_POLICY,
  parseAdmissionRuntimeConfig
} from "../Admission Controller/runtime-config.js";

const enabledEnvironment = Object.freeze({
  AGY_ACP_ADMISSION_ENABLED: "1",
  AGY_ACP_STATE_DIR: "/var/lib/paseo-agy-acp",
  PASEO_AGENT_ID: "s3-t01-seat-contract"
});

const seatPolicy: AdmissionPolicy = {
  maxActiveTurns: 3,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

const stateDirs: string[] = [];
const controllers: AdmissionController[] = [];

function temporaryDatabasePath(prefix: string): string {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  stateDirs.push(stateDir);
  return path.join(stateDir, "runtime.sqlite");
}

function openController(policy: AdmissionPolicy = seatPolicy): AdmissionController {
  const admission = new AdmissionController({
    databasePath: temporaryDatabasePath("paseo-agy-seats-"),
    policy,
    encryptionKey: Buffer.alloc(32, 11),
    contentFingerprintKey: Buffer.alloc(32, 12)
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
    model: "gemini-test",
    now
  }, `prompt-${requestId}`, now + seatPolicy.queueTimeoutMs);
}

function admitAndMarkActive(
  admission: AdmissionController,
  expectedRequestId: string,
  ownerInstanceId: string,
  now: number
): AdmissionLease {
  const lease = admission.admitNext(now, ownerInstanceId);
  expect(lease?.requestId).toBe(expectedRequestId);
  if (lease === null) throw new Error(`expected ${expectedRequestId} to be admitted`);
  admission.markStarting(lease, now + 1);
  admission.markDispatchIntent(lease, now + 2);
  admission.markActive(lease, now + 3);
  return lease;
}

afterEach(() => {
  for (const admission of controllers.splice(0)) admission.close();
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

describe("S3-T01 admission seat contract", () => {
  it("defaults the shared Antigravity pool to eight seats and still accepts explicit three", () => {
    const defaultConfig = parseAdmissionRuntimeConfig(enabledEnvironment);
    const explicitThree = parseAdmissionRuntimeConfig({
      ...enabledEnvironment,
      AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS: "3"
    });
    const explicitEight = parseAdmissionRuntimeConfig({
      ...enabledEnvironment,
      AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS: "8",
      AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS: "8"
    });

    expect(defaultConfig.enabled && defaultConfig.policy.maxActiveTurns).toBe(8);
    expect(defaultConfig.enabled && defaultConfig.policy.maxConcurrentStarts).toBe(8);
    expect(explicitThree.enabled && explicitThree.policy.maxActiveTurns).toBe(3);
    expect(explicitEight.enabled && explicitEight.policy.maxActiveTurns).toBe(8);
    expect(DEFAULT_ADMISSION_POLICY.maxActiveTurns).toBe(8);
    expect(DEFAULT_ADMISSION_POLICY.maxConcurrentStarts).toBe(8);
  });

  it("fails closed for unsupported seat policies from env and direct controller policy", () => {
    for (const rawMaxActiveTurns of ["0", "-1", "1.5"]) {
      expect(() => parseAdmissionRuntimeConfig({
        ...enabledEnvironment,
        AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS: rawMaxActiveTurns
      })).toThrow(AdmissionRuntimeConfigError);
    }

    const raised = parseAdmissionRuntimeConfig({
      ...enabledEnvironment,
      AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS: "9",
      AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS: "9"
    });
    expect(raised.enabled && raised.policy.maxActiveTurns).toBe(9);
    expect(raised.enabled && raised.policy.maxConcurrentStarts).toBe(9);
    expect(() => openController({ ...seatPolicy, maxActiveTurns: 9, maxConcurrentStarts: 9 })).not.toThrow();

    for (const maxActiveTurns of [0, -1, 1.5]) {
      expect(() => openController({ ...seatPolicy, maxActiveTurns })).toThrow(/maxActiveTurns/);
    }
  });

  it("keeps the fourth request queued while three turns are active", () => {
    const admission = openController();
    enqueue(admission, "turn-one", "parent-one", 1);
    enqueue(admission, "turn-two", "parent-two", 2);
    enqueue(admission, "turn-three", "parent-three", 3);
    enqueue(admission, "turn-four", "parent-four", 4);

    admitAndMarkActive(admission, "turn-one", "owner-one", 10);
    admitAndMarkActive(admission, "turn-two", "owner-two", 20);
    admitAndMarkActive(admission, "turn-three", "owner-three", 30);

    expect(admission.admitNext(40, "owner-four")).toBeNull();
    expect(admission.getRequest("turn-four")?.state).toBe("queued");
  });
});
