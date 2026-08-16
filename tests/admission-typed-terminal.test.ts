import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AdmissionController,
  type AdmissionPolicy
} from "../Admission Controller/controller.js";
import {
  AdmissionTurnCoordinator,
  type AdmissionTurnCoordinatorOptions
} from "../ACP Connector/admission/turn-coordinator.js";
import {
  handlePromptV1,
  handlePromptV2,
  type PromptV1Deps,
  type PromptV2Deps
} from "../ACP Connector/acp/session/prompt.js";
import { turnsOf } from "../ACP Connector/acp/session/turn-scheduler.js";
import type { SessionState } from "../ACP Connector/acp/session/types.js";
import {
  AgyCliError,
  type AgyAdmissionDispatchBoundary,
  type SpawnFactory
} from "../ACP Connector/agy/cli.js";
import { composeAcpRuntime, type AcpRuntimeComposition } from "../ACP Connector/acp/agent.js";

type TypedTerminalCode =
  | "queue_timeout"
  | "provider_failure"
  | "recovery_required";

type PromptBehavior = (
  promptText: string,
  onUpdate: (update: unknown) => Promise<void>,
  requestPermission: (...args: never[]) => Promise<unknown>,
  clientFileSystem: unknown,
  elicitation: unknown,
  boundary?: AgyAdmissionDispatchBoundary
) => Promise<{ stopReason: "end_turn" | "cancelled" }>;

const DEFAULT_POLICY: AdmissionPolicy = {
  maxActiveTurns: 3,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 2_000,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

const stateDirs: string[] = [];
const controllers: AdmissionController[] = [];
const compositions: AcpRuntimeComposition[] = [];

const ORIGINAL_PASEO_HOME = process.env.PASEO_HOME;
const ORIGINAL_PASEO_AGENT_ID = process.env.PASEO_AGENT_ID;
const ORIGINAL_HOME = process.env.HOME;

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

beforeEach(() => {
  setEnv("PASEO_HOME", undefined);
  setEnv("PASEO_AGENT_ID", undefined);
});

afterEach(() => {
  for (const composition of compositions.splice(0)) composition.close();
  for (const admission of controllers.splice(0)) admission.close();
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
  setEnv("PASEO_HOME", ORIGINAL_PASEO_HOME);
  setEnv("PASEO_AGENT_ID", ORIGINAL_PASEO_AGENT_ID);
  setEnv("HOME", ORIGINAL_HOME);
});

function stateDir(prefix = "paseo-agy-typed-terminal-"): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  stateDirs.push(directory);
  return directory;
}

function controller(policy: Partial<AdmissionPolicy> = {}): AdmissionController {
  const directory = stateDir();
  const admission = new AdmissionController({
    databasePath: path.join(directory, "runtime.sqlite"),
    policy: { ...DEFAULT_POLICY, ...policy },
    encryptionKey: Buffer.alloc(32, 21),
    contentFingerprintKey: Buffer.alloc(32, 22)
  });
  controllers.push(admission);
  return admission;
}

function coordinator(
  admission: AdmissionController,
  options: Partial<Omit<AdmissionTurnCoordinatorOptions, "controller" | "agentId" | "parentId">> = {}
): AdmissionTurnCoordinator {
  return new AdmissionTurnCoordinator({
    controller: admission,
    agentId: "agent-typed-terminal",
    connectorPid: process.pid,
    ...options
  });
}

function countRows(databasePath: string, table: string): number {
  const database = new Database(databasePath, { readonly: true });
  try {
    return (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
  } finally {
    database.close();
  }
}

function leaseCount(admission: AdmissionController): number {
  return countRows(admission.databasePath, "leases");
}

function leaseCountForRequest(admission: AdmissionController, requestId: string): number {
  const database = new Database(admission.databasePath, { readonly: true });
  try {
    return (database.prepare("SELECT COUNT(*) AS count FROM leases WHERE request_id = ?").get(requestId) as { count: number }).count;
  } finally {
    database.close();
  }
}

function makeSession(
  behavior: PromptBehavior,
  cancel: () => Promise<void> = async () => {}
): SessionState {
  return {
    sessionId: "typed-terminal-session",
    cwd: "/repo",
    additionalDirectories: [],
    promptQueue: [],
    v2UserMessageIdsByStep: {},
    catalog: { models: [], byBase: new Map() },
    selectedBaseModel: "model-test",
    selectedReasoningEffort: "",
    agy: {
      config: { mode: "default" },
      lastPromptUserStepIdxs: [],
      prompt: behavior,
      cancel
    }
  } as unknown as SessionState;
}

function promptParams(sessionId = "typed-terminal-session") {
  return {
    sessionId,
    prompt: [{ type: "text", text: "typed terminal prompt" }]
  } as never;
}

function v1Deps(session: SessionState, turnAdmission: AdmissionTurnCoordinator): PromptV1Deps {
  return {
    requireSession: () => session,
    applyConfigOption: async () => {},
    persistSession: async () => {},
    notifyCurrentModeUpdate: async () => {},
    notifyConfigOptionUpdateV1: async () => {},
    clientFileSystemV1: () => undefined,
    turnAdmission
  };
}

function v2Deps(session: SessionState, turnAdmission: AdmissionTurnCoordinator): PromptV2Deps {
  return {
    requireSession: () => session,
    applyConfigOption: async () => {},
    persistSession: async () => {},
    notifyConfigOptionUpdateV2: async () => {},
    turnAdmission
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function terminalUpdates(updates: Record<string, unknown>[]): Record<string, unknown>[] {
  return updates.filter((update) =>
    update.sessionUpdate === "state_update" &&
    update.state === "idle" &&
    "stopReason" in update
  );
}

function provider429Failure(): AgyCliError {
  return new AgyCliError(
    "provider returned 429 QUOTA_EXHAUSTED",
    ["agy"],
    1,
    "429 QUOTA_EXHAUSTED"
  );
}

function afterPromptWriteThenThrow(error: Error): PromptBehavior {
  return async (_promptText, _onUpdate, _requestPermission, _clientFileSystem, _elicitation, boundary) => {
    if (!boundary) throw new Error("admission boundary was not provided");
    boundary.prepare(process.pid);
    boundary.beforePromptWrite();
    boundary.afterPromptWrite();
    throw error;
  };
}

function enqueueHolder(admission: AdmissionController, now: number): void {
  admission.enqueueWithPayload({
    requestId: "holder",
    sessionId: "holder-session",
    agentId: "holder-agent",
    fingerprint: "holder",
    provider: "antigravity",
    model: "model-test",
    now
  }, "holder prompt", now + admission.policy.queueTimeoutMs);
  expect(admission.admitRequest("holder", now, "holder-owner")).not.toBeNull();
}

function timeoutCoordinator(admission: AdmissionController): AdmissionTurnCoordinator {
  enqueueHolder(admission, 0);
  let now = 0;
  return coordinator(admission, {
    now: () => now,
    createRequestId: () => "queue-timeout-terminal",
    queuePollIntervalMs: 1,
    progressIntervalMs: 1,
    wait: async () => {
      now += 1;
    }
  });
}

function terminalMeta(code: TypedTerminalCode | "cancelled") {
  return {
    "agy-acp/turnTerminal": {
      version: 1,
      code
    }
  };
}

async function runV2Failure(
  code: TypedTerminalCode
): Promise<{ updates: Record<string, unknown>[]; admission: AdmissionController; session: SessionState }> {
  const admission = controller({
    maxActiveTurns: 1,
    minStartIntervalMs: 0,
    queueTimeoutMs: 1
  });
  const subject = code === "queue_timeout"
    ? timeoutCoordinator(admission)
    : coordinator(admission, {
      now: () => 1_000,
      createRequestId: () => `${code}-terminal`
    });
  const behavior = code === "provider_failure"
    ? afterPromptWriteThenThrow(provider429Failure())
    : code === "recovery_required"
      ? afterPromptWriteThenThrow(new Error("transport ended without a confirmed provider terminal"))
      : async () => {
        throw new Error("a timed-out request must not execute");
      };
  const session = makeSession(behavior);
  const updates: Record<string, unknown>[] = [];
  const client = {
    notify: async (_method: unknown, params: { update: Record<string, unknown> }) => {
      updates.push(params.update);
    }
  } as never;

  await expect(handlePromptV2(promptParams(), client, v2Deps(session, subject))).resolves.toEqual({});
  await waitFor(() => terminalUpdates(updates).length > 0);
  return { updates, admission, session };
}

async function runV1Failure(
  code: TypedTerminalCode
): Promise<{ response: unknown; admission: AdmissionController; session: SessionState }> {
  const admission = controller({
    maxActiveTurns: 1,
    minStartIntervalMs: 0,
    queueTimeoutMs: 1
  });
  const subject = code === "queue_timeout"
    ? timeoutCoordinator(admission)
    : coordinator(admission, {
      now: () => 1_000,
      createRequestId: () => `${code}-terminal`
    });
  const behavior = code === "provider_failure"
    ? afterPromptWriteThenThrow(provider429Failure())
    : code === "recovery_required"
      ? afterPromptWriteThenThrow(new Error("transport ended without a confirmed provider terminal"))
      : async () => {
        throw new Error("a timed-out request must not execute");
      };
  const session = makeSession(behavior);
  const response = await handlePromptV1(
    promptParams(),
    { notify: async () => {} } as never,
    undefined,
    v1Deps(session, subject)
  );
  return { response, admission, session };
}

describe("S3-T16 v2 typed terminal", () => {
  it.each([
    "queue_timeout",
    "provider_failure",
    "recovery_required"
  ] as const)("emits exactly one non-end_turn idle terminal for %s", async (code) => {
    const { updates, admission, session } = await runV2Failure(code);
    const terminals = terminalUpdates(updates);

    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      sessionUpdate: "state_update",
      state: "idle",
      stopReason: code
    });
    expect(terminals[0].stopReason).not.toBe("end_turn");
    if (code === "queue_timeout") {
      expect(leaseCountForRequest(admission, "queue-timeout-terminal")).toBe(0);
    } else if (code === "provider_failure") {
      expect(leaseCount(admission)).toBe(0);
    }
    expect(turnsOf(session).busy()).toBe(false);
  });
});

describe("S3-T16 v1 typed terminal", () => {
  it.each([
    "queue_timeout",
    "provider_failure",
    "recovery_required"
  ] as const)("returns one typed PromptResponse for %s instead of throwing RPC errors", async (code) => {
    const { response, admission, session } = await runV1Failure(code);

    expect(response).toEqual({
      stopReason: "refusal",
      _meta: terminalMeta(code)
    });
    if (code === "queue_timeout") {
      expect(leaseCountForRequest(admission, "queue-timeout-terminal")).toBe(0);
    } else if (code === "provider_failure") {
      expect(leaseCount(admission)).toBe(0);
    }
    expect(turnsOf(session).busy()).toBe(false);
  });
});

describe("S3-T16 terminal regressions", () => {
  it("keeps v1 and v2 cancel terminals exactly once", async () => {
    let v1PromptCalls = 0;
    const v1Session = makeSession(async () => {
      v1PromptCalls++;
      return { stopReason: "end_turn" };
    });
    const v1Admission = controller({ minStartIntervalMs: 0 });
    const v1Controller = new AbortController();
    const v1Response = handlePromptV1(
      promptParams(),
      { notify: async () => {} } as never,
      v1Controller.signal,
      v1Deps(v1Session, coordinator(v1Admission))
    );
    expect(turnsOf(v1Session).activeClaim).toBeDefined();
    v1Controller.abort();
    await expect(v1Response).resolves.toMatchObject({ stopReason: "cancelled" });
    expect(v1PromptCalls).toBe(0);
    expect(turnsOf(v1Session).busy()).toBe(false);

    let v2PromptCalls = 0;
    const v2Session = makeSession(async () => {
      v2PromptCalls++;
      return { stopReason: "end_turn" };
    });
    const v2Admission = controller({ minStartIntervalMs: 0 });
    const updates: Record<string, unknown>[] = [];
    const client = {
      notify: async (_method: unknown, params: { update: Record<string, unknown> }) => {
        updates.push(params.update);
      }
    } as never;
    await expect(handlePromptV2(
      promptParams(),
      client,
      v2Deps(v2Session, coordinator(v2Admission))
    )).resolves.toEqual({});
    expect(turnsOf(v2Session).activeClaim).toBeDefined();
    turnsOf(v2Session).activeClaim!.abort();
    await waitFor(() => terminalUpdates(updates).length === 1);

    expect(terminalUpdates(updates)).toEqual([
      expect.objectContaining({
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled"
      })
    ]);
    expect(v2PromptCalls).toBe(0);
    expect(turnsOf(v2Session).busy()).toBe(false);
  });

  it("keeps an idle enabled runtime at zero seats and zero resident turn processes", () => {
    const directory = stateDir("paseo-agy-typed-terminal-idle-");
    let spawnCalls = 0;
    const spawnProcess: SpawnFactory = (() => {
      spawnCalls++;
      throw new Error("idle runtime must not spawn a turn process");
    }) as unknown as SpawnFactory;
    const composition = composeAcpRuntime({
      env: {
        AGY_ACP_ADMISSION_ENABLED: "1",
        AGY_ACP_STATE_DIR: directory,
        PASEO_AGENT_ID: "agent-typed-terminal-idle",
        NODE_ENV: "test"
      },
      modelCacheEnabled: false,
      spawnProcess
    });
    compositions.push(composition);

    expect(countRows(path.join(directory, "runtime.sqlite"), "leases")).toBe(0);
    expect(countRows(path.join(directory, "runtime.sqlite"), "turn_requests")).toBe(0);
    expect(spawnCalls).toBe(0);
  });
});
