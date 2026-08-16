import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdmissionController,
  LeaseFenceError,
  type AdmissionPolicy,
  type SanitizedAdmissionEvent
} from "../Admission Controller/controller.js";
import {
  AdmissionTurnCoordinator,
  type AdmissionTurnCoordinatorOptions
} from "../ACP Connector/admission/turn-coordinator.js";
import { handleCloseSession } from "../ACP Connector/acp/session/close.js";
import {
  handlePromptV2,
  type PromptV2Deps
} from "../ACP Connector/acp/session/prompt.js";
import {
  TurnClaim,
  turnsOf
} from "../ACP Connector/acp/session/turn-scheduler.js";
import type { SessionState } from "../ACP Connector/acp/session/types.js";
import type { AgyAdmissionDispatchBoundary } from "../ACP Connector/agy/cli.js";

const POLICY: AdmissionPolicy = {
  maxActiveTurns: 1,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

const stateDirs: string[] = [];
const controllers: AdmissionController[] = [];

function openController(policy: AdmissionPolicy = POLICY): AdmissionController {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-race-contract-"));
  stateDirs.push(stateDir);
  const admission = new AdmissionController({
    databasePath: path.join(stateDir, "runtime.sqlite"),
    policy,
    encryptionKey: Buffer.alloc(32, 71),
    contentFingerprintKey: Buffer.alloc(32, 72)
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
    agentId: "race-agent",
    connectorPid: process.pid,
    queuePollIntervalMs: 1,
    progressIntervalMs: 1,
    ...options
  });
}

function enqueue(admission: AdmissionController, requestId: string, now: number): void {
  admission.enqueueWithPayload({
    requestId,
    sessionId: `${requestId}-session`,
    agentId: `${requestId}-agent`,
    fingerprint: `${requestId}-fingerprint`,
    provider: "antigravity",
    model: "model-test",
    now
  }, `${requestId} prompt`, now + admission.policy.queueTimeoutMs);
}

function countRows(admission: AdmissionController, table: string, requestId?: string): number {
  const database = new Database(admission.databasePath, { readonly: true });
  try {
    const suffix = requestId === undefined ? "" : " WHERE request_id = ?";
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}${suffix}`).get(...(
      requestId === undefined ? [] : [requestId]
    )) as { count: number };
    return row.count;
  } finally {
    database.close();
  }
}

function terminalEvents(events: readonly SanitizedAdmissionEvent[]): SanitizedAdmissionEvent[] {
  return events.filter((event) =>
    event.toState === "cancelled" ||
    event.toState === "completed" ||
    event.toState === "failed" ||
    event.toState === "queue_timeout" ||
    event.toState === "recovery_required"
  );
}

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error("waitFor timed out"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const admission of controllers.splice(0)) admission.close();
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

describe("S3-T15 admission race contract", () => {
  it("marks execution recovery when a fenced heartbeat fails before provider terminal", async () => {
    vi.useFakeTimers();
    const admission = openController();
    let now = 1_000;
    const subject = coordinator(admission, {
      now: () => ++now,
      createRequestId: () => "heartbeat-fence-race",
      heartbeatIntervalMs: 10
    });
    const heartbeat = vi.spyOn(admission, "heartbeat").mockImplementation(() => {
      throw new LeaseFenceError("heartbeat-fence-race");
    });
    const markRecovery = vi.spyOn(admission, "markExecutionRecoveryRequired");
    let active!: () => void;
    const activePromise = new Promise<void>((resolve) => { active = resolve; });
    let finish!: () => void;
    const finishPromise = new Promise<void>((resolve) => { finish = resolve; });

    const pending = subject.admit({
      sessionId: "heartbeat-session",
      model: "model-test",
      promptText: "heartbeat prompt",
      claim: new TurnClaim("foreground"),
      execute: async (boundary) => {
        boundary.prepare(process.pid);
        boundary.beforePromptWrite();
        boundary.afterPromptWrite();
        active();
        await finishPromise;
        return { stopReason: "end_turn" };
      }
    });
    await activePromise;

    await vi.advanceTimersByTimeAsync(10);
    finish();

    await expect(pending).rejects.toMatchObject({
      name: "AdmissionTurnRecoveryRequiredError"
    });
    expect(heartbeat).toHaveBeenCalledTimes(1);
    expect(markRecovery).toHaveBeenCalledTimes(1);
    expect(admission.getRequest("heartbeat-fence-race")?.state).toBe("recovery_required");
    expect(admission.listRecoverableDispatches()).toHaveLength(1);
    expect(countRows(admission, "turn_payloads", "heartbeat-fence-race")).toBe(0);
  });

  it("settles queued cancel racing admission with one terminal and no queued payload", async () => {
    const admission = openController();
    enqueue(admission, "holder", 1);
    const holder = admission.admitRequest("holder", 2, "holder-owner");
    expect(holder).not.toBeNull();
    enqueue(admission, "queued-race", 3);

    const [cancelled, admitted] = await Promise.all([
      Promise.resolve().then(() => admission.cancelQueued("queued-race", 4)),
      Promise.resolve().then(() => admission.admitRequest("queued-race", 4, "queued-owner"))
    ]);

    expect(cancelled).toBeUndefined();
    expect(admitted).toBeNull();
    expect(admission.getRequest("queued-race")?.state).toBe("cancelled");
    expect(admission.getQueueSnapshot("queued-race", 5)).toBeNull();
    expect(countRows(admission, "turn_payloads", "queued-race")).toBe(0);
    expect(countRows(admission, "leases", "queued-race")).toBe(0);
    const events = admission.readSanitizedEvents({ afterEventSeq: 0, limit: 100 });
    expect(events.filter((event) => event.kind === "request_cancelled")).toHaveLength(1);
    expect(terminalEvents(events)).toHaveLength(1);
  });

  it("does not duplicate dispatch or retain a seat when steer and disconnect race", async () => {
    const admission = openController();
    let now = 10_000;
    const subject = coordinator(admission, {
      now: () => ++now,
      createRequestId: (() => {
        const ids = ["steer-close-active", "steer-close-replacement"];
        return () => ids.shift() ?? "unexpected-extra-dispatch";
      })()
    });
    let promptDispatches = 0;
    let boundaryCommits = 0;
    let closeCalls = 0;
    let cancelCalls = 0;
    let finishPrompt!: (value: { stopReason: "end_turn" | "cancelled" }) => void;
    const promptFinished = new Promise<{ stopReason: "end_turn" | "cancelled" }>((resolve) => {
      finishPrompt = resolve;
    });
    const session = {
      sessionId: "steer-close-session",
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
        prompt: async (
          _promptText: string,
          _onUpdate: unknown,
          _onPermission: unknown,
          _fsBridge: unknown,
          _elicitationCap: unknown,
          boundary?: AgyAdmissionDispatchBoundary
        ) => {
          promptDispatches++;
          boundary?.prepare(process.pid);
          boundary?.beforePromptWrite();
          boundaryCommits++;
          boundary?.afterPromptWrite();
          return promptFinished;
        },
        cancel: async () => {
          cancelCalls++;
          finishPrompt({ stopReason: "cancelled" });
        },
        close: async () => {
          closeCalls++;
          finishPrompt({ stopReason: "cancelled" });
        }
      }
    } as unknown as SessionState;
    const deps = {
      requireSession: () => session,
      applyConfigOption: async () => {},
      persistSession: async () => {},
      notifyConfigOptionUpdateV2: async () => {},
      turnAdmission: subject
    } satisfies PromptV2Deps;
    const updates: Array<Record<string, unknown>> = [];
    const client = {
      notify: async (_method: unknown, params: { update: Record<string, unknown> }) => {
        updates.push(params.update);
      }
    } as never;
    const sessions = new Map<string, SessionState>([[session.sessionId, session]]);

    await expect(handlePromptV2({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "active prompt" }]
    } as never, client, deps)).resolves.toEqual({});
    await waitFor(() => promptDispatches === 1);

    const steer = handlePromptV2({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "steer replacement" }],
      _meta: { "agy-acp/turnIntent": "steer" }
    } as never, client, deps);
    const close = handleCloseSession({ sessionId: session.sessionId }, sessions as never);

    await expect(steer).resolves.toEqual({});
    await close;
    await waitFor(() => !turnsOf(session).busy());

    expect(promptDispatches).toBe(1);
    expect(boundaryCommits).toBe(1);
    expect(cancelCalls + closeCalls).toBeGreaterThanOrEqual(1);
    expect(admission.getRequest("steer-close-active")?.state).toBe("cancelled");
    expect(admission.getRequest("steer-close-replacement")).toBeNull();
    expect(countRows(admission, "leases")).toBe(0);
    expect(turnsOf(session).activeClaim).toBeUndefined();
    const terminalUpdates = updates.filter((update) =>
      update.sessionUpdate === "state_update" &&
      update.state === "idle"
    );
    expect(terminalUpdates).toHaveLength(2);
    expect(terminalUpdates.every((update) => update.stopReason === "cancelled")).toBe(true);
  });
});
