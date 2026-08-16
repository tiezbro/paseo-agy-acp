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
  classifyProviderFailure,
  type ProviderFailureCategory,
  type ProviderFailureInput
} from "../ACP Connector/admission/errors.js";

const POLICY: AdmissionPolicy = {
  maxActiveTurns: 3,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

const stateDirs: string[] = [];
const controllers: AdmissionController[] = [];

type StructuredCase = {
  readonly name: string;
  readonly caseId: string;
  readonly input: ProviderFailureInput;
  readonly category: ProviderFailureCategory;
};

type CooldownRow = {
  readonly provider: string;
  readonly model: string;
  readonly not_before: number;
  readonly updated_at: number;
};

const capacityCases: StructuredCase[] = [
  {
    name: "503 UNAVAILABLE code",
    caseId: "capacity-unavailable",
    input: { httpStatus: 503, code: "UNAVAILABLE" },
    category: "provider_capacity"
  },
  {
    name: "503 MODEL_CAPACITY_EXHAUSTED reason",
    caseId: "capacity-model-exhausted",
    input: { httpStatus: 503, reason: "MODEL_CAPACITY_EXHAUSTED" },
    category: "provider_capacity"
  }
];

const nonCapacityCases: StructuredCase[] = [
  {
    name: "503 QUOTA_EXHAUSTED is not capacity",
    caseId: "quota-on-503",
    input: { httpStatus: 503, code: "QUOTA_EXHAUSTED" },
    category: "transport"
  },
  {
    name: "429 without quota code is not capacity",
    caseId: "status-429",
    input: { httpStatus: 429 },
    category: "transport"
  },
  {
    name: "429 QUOTA_EXHAUSTED quota",
    caseId: "quota-on-429",
    input: { httpStatus: 429, code: "QUOTA_EXHAUSTED" },
    category: "quota"
  },
  {
    name: "401 auth",
    caseId: "status-401",
    input: { httpStatus: 401 },
    category: "auth"
  },
  {
    name: "403 permission",
    caseId: "status-403",
    input: { httpStatus: 403 },
    category: "permission"
  },
  {
    name: "local timeout",
    caseId: "timeout",
    input: { timeout: true },
    category: "timeout"
  },
  {
    name: "502 transport",
    caseId: "status-502",
    input: { httpStatus: 502 },
    category: "transport"
  },
  {
    name: "empty structured outcome unknown",
    caseId: "unknown",
    input: {},
    category: "unknown"
  }
];

function openController(): AdmissionController {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-503-classifier-"));
  stateDirs.push(stateDir);
  const admission = new AdmissionController({
    databasePath: path.join(stateDir, "runtime.sqlite"),
    policy: POLICY,
    encryptionKey: Buffer.alloc(32, 41),
    contentFingerprintKey: Buffer.alloc(32, 42)
  });
  controllers.push(admission);
  return admission;
}

function enqueue(admission: AdmissionController, requestId: string, now: number): void {
  admission.enqueueWithPayload({
    requestId,
    sessionId: `session-${requestId}`,
    agentId: `agent-${requestId}`,
    fingerprint: `fingerprint-${requestId}`,
    provider: "antigravity",
    model: "model-test",
    now
  }, `prompt-${requestId}`, now + POLICY.queueTimeoutMs);
}

function activate(admission: AdmissionController, requestId: string, ownerInstanceId: string, now: number): AdmissionLease {
  const lease = admission.admitRequest(requestId, now, ownerInstanceId);
  expect(lease).not.toBeNull();
  if (lease === null) throw new Error(`expected ${requestId} to be admitted`);
  admission.markStarting(lease, now + 1);
  admission.markDispatchIntent(lease, now + 2);
  admission.markActive(lease, now + 3);
  return lease;
}

function readCooldowns(admission: AdmissionController): CooldownRow[] {
  const database = new Database(admission.databasePath, { readonly: true });
  try {
    return database
      .prepare("SELECT provider, model, not_before, updated_at FROM cooldowns ORDER BY provider, model")
      .all() as CooldownRow[];
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const admission of controllers.splice(0)) admission.close();
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

describe("S3-T07 structured provider failure classifier", () => {
  it.each([...capacityCases, ...nonCapacityCases])("classifies $name from structured fields only", ({ input, category }) => {
    expect(classifyProviderFailure(input).category).toBe(category);
  });

  it.each(capacityCases)("$name opens provider capacity", ({ input }) => {
    expect(classifyProviderFailure(input)).toMatchObject({
      category: "provider_capacity",
      httpStatus: 503
    });
  });

  it.each(nonCapacityCases)("$name does not write a capacity cooldown", ({ caseId, input, category }) => {
    const admission = openController();
    const requestId = `non-capacity-${caseId}`;
    enqueue(admission, requestId, 1_000);
    const lease = activate(admission, requestId, `owner-${caseId}`, 1_000);
    const failure = classifyProviderFailure(input);

    expect(failure.category).toBe(category);
    expect(failure.category).not.toBe("provider_capacity");

    admission.completeLiveTurn(lease, 2_000, {
      outcome: "failed",
      failure
    });

    expect(readCooldowns(admission)).toEqual([]);
    expect(admission.getRequest(requestId)?.state).toBe("failed");
  });
});
