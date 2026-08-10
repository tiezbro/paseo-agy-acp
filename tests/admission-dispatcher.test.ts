import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdmissionPromptDispatchError,
  AdmissionPromptDispatcher,
  isAdmissionPromptAgySpawnContext,
  type AdmissionPromptAgyContract,
  type AdmissionPromptDispatchController,
  type AdmissionPromptDispatcherOptions,
  type AdmissionPromptProcessLifecycleOwner,
  type AdmissionPromptProviderObserver,
  type AdmissionPromptRecoveryOwner,
  type AdmissionPromptTerminalObservation
} from "../src/admission/dispatcher.js";
import {
  AdmissionController,
  type AdmissionLease,
  type AdmissionPolicy,
  type EnqueueDelivery,
  type LeaseFence,
  type ProviderTerminalObservations
} from "../src/admission/controller.js";
import { ACP_OUTBOX_CAPABILITY } from "../src/admission/outbox-protocol.js";
import type { AdmissionPromptDispatchInput } from "../src/admission/prompt-seam.js";
import type {
  AgyDispatchCancellationRecheck,
  AgyDispatchIdentityPersistenceResult,
  AgyDispatchIntentCommitResult,
  AgyDispatchProcess,
  AgyDispatchWriteResult
} from "../src/agy/dispatch-boundary.js";
import type { AgyStartupLauncher } from "../src/agy/startup-launcher.js";

const NOW = 1_000;
const DURABLE_OWNER_INSTANCE_ID = "11111111-1111-4111-8111-111111111111";
const DURABLE_POLICY: AdmissionPolicy = {
  maxActiveTurns: 1,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};
const durableStateDirs: string[] = [];
const durableControllers: AdmissionController[] = [];
const LEASE: AdmissionLease = Object.freeze({
  requestId: "request-1",
  leaseId: "lease-1",
  generation: 7,
  ownerInstanceId: "owner-1"
});

interface FakeProcess {
  readonly pid: number;
}

interface ProcessIdentity {
  readonly pid: number;
  readonly startToken: string;
}

interface RigOptions {
  readonly lease?: AdmissionLease | null;
  readonly promptChannel?: "stdin" | "pty";
  readonly callerSuppliedVerifier?: boolean;
  readonly payloadError?: boolean;
  readonly markStartingError?: boolean;
  readonly launcher?: "throws" | "release_throws";
  readonly record?: AgyDispatchIdentityPersistenceResult;
  readonly revalidations?: readonly AgyDispatchCancellationRecheck[];
  readonly commit?: AgyDispatchIntentCommitResult | "throws";
  readonly write?: AgyDispatchWriteResult | "throws";
  readonly activity?: "observed" | "throws" | "invalid";
  readonly terminal?: AdmissionPromptTerminalObservation | "throws";
  readonly terminalPersistenceError?: boolean;
  readonly releaseError?: boolean;
  readonly preDispatchResolution?: "queued" | "recovery_required";
  readonly observeDiscard?: boolean;
}

interface Rig {
  readonly controller: AdmissionPromptDispatchController;
  readonly dispatcher: AdmissionPromptDispatcher<FakeProcess, ProcessIdentity>;
  readonly events: string[];
  readonly writes: string[];
  readonly spawnArguments: unknown[][];
  readonly deliveries: EnqueueDelivery[];
  readonly admitCalls: () => number;
}

type DurablePostRecordFailure = "cancelled" | "stale_owner" | "stale_generation" | "commit_replay_fault";

interface DurableRig {
  readonly controller: AdmissionController;
  readonly dispatcher: AdmissionPromptDispatcher<FakeProcess, unknown>;
  readonly requestId: string;
  readonly durableStates: string[];
  readonly recoveryCalls: string[];
  readonly writes: string[];
  run(): Promise<ReturnType<AdmissionPromptDispatcher<FakeProcess, unknown>["run"]> extends Promise<infer T> ? T : never>;
}

function durableLinuxIdentity(ownerInstanceId: string) {
  return {
    connector: {
      ownerInstanceId,
      createdAt: "2026-08-09T00:00:00.000Z",
      bootId: "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f31",
      pid: 3711,
      startTimeTicks: "1234567890123",
      pidNamespaceInode: 4_026_531_836,
      ppid: 1,
      pgrp: 3711,
      session: 3711
    },
    child: {
      bootId: "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f31",
      pid: 4182,
      startTimeTicks: "1234567890999",
      pidNamespaceInode: 4_026_531_836,
      ppid: 3711,
      pgrp: 4182,
      session: 3711
    }
  };
}

function durableRig(failure: DurablePostRecordFailure): DurableRig {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-dispatcher-durable-"));
  durableStateDirs.push(stateDir);
  const controller = new AdmissionController({
    databasePath: path.join(stateDir, "runtime.sqlite"),
    policy: DURABLE_POLICY,
    encryptionKey: Buffer.alloc(32, 11),
    contentFingerprintKey: Buffer.alloc(32, 12),
    claimTokenKey: Buffer.alloc(32, 13)
  });
  durableControllers.push(controller);

  const requestId = `durable-${failure}`;
  const prompt = `durable prompt ${failure}`;
  controller.enqueueWithPayload({
    requestId,
    sessionId: "session-durable",
    parentId: "parent-durable",
    fingerprint: `fingerprint-${failure}`,
    provider: "antigravity",
    model: "model-durable",
    now: NOW
  }, prompt, NOW + 60_000);

  const abort = new AbortController();
  const durableStates: string[] = [];
  const recoveryCalls: string[] = [];
  const writes: string[] = [];
  const lifecycle: AdmissionPromptProcessLifecycleOwner<unknown> = {
    recordProcessIdentity(record) {
      const result = controller.recordProcessIdentity(record);
      if (result.status === "recorded") {
        durableStates.push(controller.getRequest(record.requestId)?.state ?? "missing");
        if (failure === "cancelled") abort.abort();
      }
      return result;
    },
    revalidate() {
      return {
        generationMatches: failure !== "stale_generation",
        ownerMatches: failure !== "stale_owner",
        cancelled: false
      };
    },
    commitDispatchIntent(record) {
      const replay = controller.commitDispatchIntent(record);
      if (failure === "commit_replay_fault") {
        if (replay.status !== "committed") throw new Error("exact replay was not durable");
        throw new Error("injected post-record commit replay fault");
      }
      return replay;
    }
  };
  const agy: AdmissionPromptAgyContract<FakeProcess, unknown> = {
    spawnPromptFree(fence) {
      return {
        process: { pid: 42 },
        identity: durableLinuxIdentity(fence.ownerInstanceId),
        promptChannel: "stdin",
        writeInitialPrompt(value) {
          writes.push(value);
          return { status: "accepted" };
        }
      };
    }
  };
  const provider: AdmissionPromptProviderObserver = {
    observeProviderActivity() {
      throw new Error("provider observation must not run after a post-record fault");
    },
    observeTerminal() {
      throw new Error("terminal observation must not run after a post-record fault");
    }
  };
  const recovery: AdmissionPromptRecoveryOwner<unknown> = {
    recoverPreDispatch(context) {
      recoveryCalls.push(`pre:${context.reason}`);
      return { state: "queued" };
    },
    recordRecoveryRequired(context) {
      recoveryCalls.push(`required:${context.reason}`);
    }
  };
  const dispatcher = new AdmissionPromptDispatcher({
    controller,
    ownerInstanceId: DURABLE_OWNER_INSTANCE_ID,
    lifecycle,
    agy,
    provider,
    recovery,
    now: () => NOW
  });

  return {
    controller,
    dispatcher,
    requestId,
    durableStates,
    recoveryCalls,
    writes,
    run: () => dispatcher.run({
      runtime: { controller } as AdmissionPromptDispatchInput["runtime"],
      requestId,
      sessionId: "session-durable",
      parentId: "parent-durable",
      provider: "antigravity",
      model: "model-durable",
      claim: { signal: abort.signal } as AdmissionPromptDispatchInput["claim"]
    })
  };
}

afterEach(() => {
  for (const controller of durableControllers.splice(0)) controller.close();
  for (const stateDir of durableStateDirs.splice(0)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

function sqlitePrimaryTerminal(
  status: "SUCCESS" | "ERROR" | "CANCELED" | "INTERRUPTED" = "SUCCESS"
): AdmissionPromptTerminalObservation {
  return {
    observations: {
      mode: "sqlite_primary" as const,
      sqliteReconciliation: {
        source: "sqlite_reconciliation" as const,
        conversationId: "conversation-1",
        observedAt: NOW + 1,
        status
      }
    },
    delivery: {
      eventId: "event-1",
      fingerprint: "terminal-1",
      payload: "encrypted by the controller",
      sequence: 3,
      expiresAt: NOW + 60_000,
      protocol: ACP_OUTBOX_CAPABILITY
    }
  };
}

function dualSourceTerminal(
  status: "SUCCESS" | "ERROR" | "CANCELED" | "INTERRUPTED" = "SUCCESS",
  sameConversation = true
): AdmissionPromptTerminalObservation {
  return {
    observations: {
      mode: "dual_source",
      streamJson: {
        source: "stream_json",
        conversationId: "conversation-1",
        observedAt: NOW,
        status
      },
      sqliteReconciliation: {
        source: "sqlite_reconciliation",
        conversationId: sameConversation ? "conversation-1" : "conversation-2",
        observedAt: NOW + 1,
        status
      }
    },
    delivery: {
      eventId: "event-1",
      fingerprint: "terminal-1",
      payload: "encrypted by the controller",
      sequence: 3,
      expiresAt: NOW + 60_000,
      protocol: ACP_OUTBOX_CAPABILITY
    }
  };
}

function input(
  controller: AdmissionPromptDispatchController,
  signal: AbortSignal = new AbortController().signal
): AdmissionPromptDispatchInput {
  return {
    runtime: { controller } as AdmissionPromptDispatchInput["runtime"],
    requestId: LEASE.requestId,
    sessionId: "session-1",
    parentId: "parent-1",
    provider: "antigravity",
    model: "model-1",
    claim: { signal } as AdmissionPromptDispatchInput["claim"]
  };
}

function rig(options: RigOptions = {}): Rig {
  const events: string[] = [];
  const writes: string[] = [];
  const spawnArguments: unknown[][] = [];
  const deliveries: EnqueueDelivery[] = [];
  let admits = 0;
  let revalidationIndex = 0;
  const revalidations = options.revalidations ?? [
    { generationMatches: true, ownerMatches: true, cancelled: false },
    { generationMatches: true, ownerMatches: true, cancelled: false }
  ];

  const controller: AdmissionPromptDispatchController = {
    admitRequest(requestId, now, ownerInstanceId) {
      events.push(`controller:admit:${requestId}:${now}:${ownerInstanceId}`);
      admits += 1;
      return options.lease === undefined ? LEASE : options.lease;
    },
    markStarting(fence, now) {
      events.push(`controller:starting:${fence.leaseId}:${now}`);
      if (options.markStartingError) throw new Error("start persistence failed");
    },
    readPayload(requestId, now) {
      events.push(`controller:payload:${requestId}:${now}`);
      if (options.payloadError) throw new Error("payload unavailable");
      return "secret business prompt";
    },
    markActive(fence, now) {
      events.push(`controller:active:${fence.leaseId}:${now}`);
    },
    markDispatchAmbiguous(fence, now) {
      events.push(`controller:ambiguous:${fence.leaseId}:${now}`);
    },
    markProviderTerminal(fence, now, _observations, delivery) {
      events.push(`controller:terminal:${fence.leaseId}:${now}`);
      if (options.terminalPersistenceError) throw new Error("terminal persistence failed");
      deliveries.push(delivery);
      return { eventId: delivery.eventId, existed: false };
    },
    release(fence, now) {
      events.push(`controller:release:${fence.leaseId}:${now}`);
      if (options.releaseError) throw new Error("lease release failed");
    }
  };

  const startupLauncher: AgyStartupLauncher = {
    enabled: true,
    acquire(classification) {
      events.push(`launcher:acquire:${classification}`);
      if (options.launcher === "throws") throw new Error("startup launcher unavailable");
      return {
        release() {
          events.push(`launcher:release:${classification}`);
          if (options.launcher === "release_throws") throw new Error("startup launcher release failed");
        }
      };
    }
  };

  const lifecycle: AdmissionPromptProcessLifecycleOwner<ProcessIdentity> = {
    recordProcessIdentity(record) {
      events.push(`lifecycle:record:${record.leaseId}`);
      return options.record ?? { status: "recorded" };
    },
    revalidate(record) {
      events.push(`lifecycle:revalidate:${record.leaseId}`);
      return revalidations[revalidationIndex++] ?? { generationMatches: true, ownerMatches: true, cancelled: false };
    },
    commitDispatchIntent(record) {
      events.push(`lifecycle:commit:${record.leaseId}`);
      if (options.commit === "throws") throw new Error("intent fsync failed");
      return options.commit ?? { status: "committed" };
    }
  };

  const agy: AdmissionPromptAgyContract<FakeProcess, ProcessIdentity> = {
    spawnPromptFree(...args) {
      spawnArguments.push(args);
      events.push(`agy:spawn:${args[0].leaseId}`);
      return {
        process: { pid: 42 },
        identity: { pid: 42, startToken: "boot-1:42" },
        promptChannel: options.promptChannel ?? "stdin",
        writeInitialPrompt(prompt) {
          events.push("agy:write");
          writes.push(prompt);
          if (options.write === "throws") throw new Error("write may be partial");
          return options.write ?? { status: "accepted" };
        }
      } satisfies AgyDispatchProcess<FakeProcess, ProcessIdentity>;
    },
    ...(options.observeDiscard
      ? {
        discardPromptFree(context) {
          events.push(`agy:discard:${context.leaseId}`);
        }
      }
      : {})
  };

  const provider: AdmissionPromptProviderObserver = {
    async observeProviderActivity(context) {
      events.push(`provider:activity:${context.leaseId}`);
      if (options.activity === "throws") throw new Error("activity stream lost");
      return options.activity === "invalid" ? { status: "unknown" } as any : { status: "observed" };
    },
    async observeTerminal(context) {
      events.push(`provider:terminal:${context.leaseId}`);
      if (options.terminal === "throws") throw new Error("terminal observation lost");
      return options.terminal ?? sqlitePrimaryTerminal();
    }
  };

  const recovery: AdmissionPromptRecoveryOwner<ProcessIdentity> = {
    async recoverPreDispatch(context) {
      events.push(`recovery:pre:${context.reason}`);
      return { state: options.preDispatchResolution ?? "queued" };
    },
    async recordRecoveryRequired(context) {
      events.push(`recovery:required:${context.reason}`);
    }
  };

  const dispatcherOptions = {
    controller,
    ownerInstanceId: LEASE.ownerInstanceId,
    startupLauncher,
    lifecycle,
    agy,
    provider,
    recovery,
    now: () => NOW
  } satisfies AdmissionPromptDispatcherOptions<FakeProcess, ProcessIdentity>;
  if (options.callerSuppliedVerifier) {
    (dispatcherOptions as unknown as Record<string, unknown>).verifyFreshPtyCanary = () => {
      events.push("caller:verifier");
      return { status: "verified" };
    };
  }
  const dispatcher = new AdmissionPromptDispatcher(dispatcherOptions);

  return { controller, dispatcher, events, writes, spawnArguments, deliveries, admitCalls: () => admits };
}

describe("AdmissionPromptDispatcher", () => {
  it("admits the selected oldest request and completes the prompt-free durable dispatch lifecycle", async () => {
    const subject = rig();
    const dispatchInput = input(subject.controller);

    await expect(subject.dispatcher.run(dispatchInput)).resolves.toEqual({
      state: "completed",
      stopReason: "end_turn"
    });

    expect(subject.events).toEqual([
      "controller:admit:request-1:1000:owner-1",
      "controller:starting:lease-1:1000",
      "controller:payload:request-1:1000",
      "launcher:acquire:model_turn",
      "agy:spawn:lease-1",
      "launcher:release:model_turn",
      "lifecycle:record:lease-1",
      "lifecycle:revalidate:lease-1",
      "lifecycle:commit:lease-1",
      "agy:write",
      "provider:activity:lease-1",
      "controller:active:lease-1:1000",
      "provider:terminal:lease-1",
      "controller:terminal:lease-1:1000",
      "controller:release:lease-1:1000"
    ]);
    expect(subject.writes).toEqual(["secret business prompt"]);
    expect(subject.spawnArguments).toHaveLength(1);
    expect(subject.spawnArguments[0]).toHaveLength(1);
    expect(subject.spawnArguments[0]?.[0]).toMatchObject({
      requestId: "request-1",
      leaseId: "lease-1",
      generation: 7,
      ownerInstanceId: "owner-1"
    });
    expect((subject.spawnArguments[0]?.[0] as { signal: AbortSignal }).signal).toBe(dispatchInput.claim.signal);
    expect(isAdmissionPromptAgySpawnContext(subject.spawnArguments[0]?.[0])).toBe(true);
    expect(isAdmissionPromptAgySpawnContext({
      requestId: "request-1",
      leaseId: "lease-1",
      generation: 7,
      ownerInstanceId: "owner-1",
      signal: dispatchInput.claim.signal
    })).toBe(false);
    expect(JSON.stringify(subject.spawnArguments)).not.toContain("secret business prompt");
    expect(subject.deliveries).toEqual([{
      ...sqlitePrimaryTerminal().delivery,
      requestId: "request-1",
      now: NOW
    }]);
  });

  it("does not start or recover any other request when targeted admission has no lease", async () => {
    const subject = rig({ lease: null });

    await expect(subject.dispatcher.run(input(subject.controller))).resolves.toEqual({
      state: "queued",
      reason: "no_eligible_request"
    });

    expect(subject.events).toEqual([
      "controller:admit:request-1:1000:owner-1"
    ]);
    expect(subject.admitCalls()).toBe(1);
    expect(subject.writes).toEqual([]);
  });

  it("does not route a post-record intent replay fault through pre-dispatch recovery", async () => {
    const subject = rig({ commit: { status: "not_committed" } });

    await expect(subject.dispatcher.run(input(subject.controller))).resolves.toEqual({
      state: "dispatch_ambiguous",
      reason: "dispatch_ambiguous"
    });

    expect(subject.events).toEqual([
      "controller:admit:request-1:1000:owner-1",
      "controller:starting:lease-1:1000",
      "controller:payload:request-1:1000",
      "launcher:acquire:model_turn",
      "agy:spawn:lease-1",
      "launcher:release:model_turn",
      "lifecycle:record:lease-1",
      "lifecycle:revalidate:lease-1",
      "lifecycle:commit:lease-1",
      "controller:ambiguous:lease-1:1000"
    ]);
    expect(subject.writes).toEqual([]);
    expect(subject.admitCalls()).toBe(1);
  });

  it("always notifies the agy adapter when an issued turn becomes unrecoverable", async () => {
    const subject = rig({ commit: { status: "not_committed" }, observeDiscard: true });

    await expect(subject.dispatcher.run(input(subject.controller))).resolves.toEqual({
      state: "dispatch_ambiguous",
      reason: "dispatch_ambiguous"
    });
    expect(subject.events.filter((event) => event === "agy:discard:lease-1")).toHaveLength(1);
    expect(subject.events.indexOf("controller:ambiguous:lease-1:1000")).toBeLessThan(
      subject.events.indexOf("agy:discard:lease-1")
    );
  });

  it("keeps post-record cancellation ambiguous, so it cannot reach the prompt writer or safe replay", async () => {
    const subject = rig({
      revalidations: [{ generationMatches: true, ownerMatches: true, cancelled: true }]
    });

    await expect(subject.dispatcher.run(input(subject.controller))).resolves.toEqual({
      state: "dispatch_ambiguous",
      reason: "dispatch_ambiguous"
    });

    expect(subject.events).toContain("lifecycle:revalidate:lease-1");
    expect(subject.events).not.toContain("lifecycle:commit:lease-1");
    expect(subject.events).not.toContain("agy:write");
    expect(subject.events).toContain("controller:ambiguous:lease-1:1000");
    expect(subject.events).not.toContain("recovery:pre:cancelled");
  });

  it("accepts a post-write cancellation only with an official cancelled terminal", async () => {
    const abort = new AbortController();
    const subject = rig({ terminal: sqlitePrimaryTerminal("CANCELED") });
    const running = subject.dispatcher.run(input(subject.controller, abort.signal));

    expect(subject.writes).toEqual(["secret business prompt"]);
    abort.abort();

    await expect(running).resolves.toEqual({ state: "cancelled", stopReason: "cancelled" });
    expect(subject.events).toContain("controller:terminal:lease-1:1000");
    expect(subject.events).toContain("controller:release:lease-1:1000");
    expect(subject.events).not.toContain("recovery:required:cancel_terminal_unobserved");
  });

  it("requires recovery when a post-write cancellation has no cancelled SQLite terminal", async () => {
    const abort = new AbortController();
    const subject = rig({ terminal: sqlitePrimaryTerminal("SUCCESS") });
    const running = subject.dispatcher.run(input(subject.controller, abort.signal));

    expect(subject.writes).toEqual(["secret business prompt"]);
    abort.abort();

    await expect(running).resolves.toEqual({
      state: "recovery_required",
      reason: "cancel_terminal_unobserved"
    });
    expect(subject.events).toContain("recovery:required:cancel_terminal_unobserved");
    expect(subject.events).not.toContain("controller:terminal:lease-1:1000");
    expect(subject.events).not.toContain("controller:release:lease-1:1000");
  });

  it("routes missing post-write cancellation activity to recovery, never ambiguous replay", async () => {
    const abort = new AbortController();
    const subject = rig({ activity: "throws" });
    const running = subject.dispatcher.run(input(subject.controller, abort.signal));

    expect(subject.writes).toEqual(["secret business prompt"]);
    abort.abort();

    await expect(running).resolves.toEqual({
      state: "recovery_required",
      reason: "cancel_terminal_unobserved"
    });
    expect(subject.events).toContain("recovery:required:cancel_terminal_unobserved");
    expect(subject.events).not.toContain("controller:ambiguous:lease-1:1000");
  });

  it("does not let a caller-supplied PTY verifier bypass runtime-owned certification", async () => {
    const subject = rig({ promptChannel: "pty", callerSuppliedVerifier: true });

    await expect(subject.dispatcher.run(input(subject.controller))).resolves.toEqual({
      state: "queued",
      reason: "fresh_pty_uncertified"
    });

    expect(subject.events).toContain("agy:spawn:lease-1");
    expect(subject.events).toContain("recovery:pre:fresh_pty_uncertified");
    expect(subject.events).not.toContain("caller:verifier");
    expect(subject.events).not.toContain("lifecycle:record:lease-1");
    expect(subject.writes).toEqual([]);
  });

  it("keeps a post-record stale fence ambiguous and never reaches the writer", async () => {
    const subject = rig({
      revalidations: [
        { generationMatches: false, ownerMatches: true, cancelled: false }
      ]
    });

    await expect(subject.dispatcher.run(input(subject.controller))).resolves.toEqual({
      state: "dispatch_ambiguous",
      reason: "dispatch_ambiguous"
    });

    expect(subject.events).not.toContain("lifecycle:commit:lease-1");
    expect(subject.events).toContain("controller:ambiguous:lease-1:1000");
    expect(subject.events).not.toContain("recovery:pre:revalidation_failed");
    expect(subject.writes).toEqual([]);
  });

  it("never uses the safe queued path once a real AdmissionController has durably recorded dispatch intent", async () => {
    for (const failure of [
      "cancelled",
      "stale_owner",
      "stale_generation",
      "commit_replay_fault"
    ] as const) {
      const subject = durableRig(failure);

      await expect(subject.run()).resolves.toMatchObject({ state: "dispatch_ambiguous" });
      expect(subject.durableStates).toEqual(["dispatch_intent"]);
      expect(subject.controller.getRequest(subject.requestId)?.state).toBe("dispatch_ambiguous");
      expect(subject.recoveryCalls).toEqual([]);
      expect(subject.writes).toEqual([]);
    }
  });

  it("turns an ambiguous initial write into durable dispatch_ambiguous without replay", async () => {
    const subject = rig({ write: { status: "ambiguous" } });

    await expect(subject.dispatcher.dispatch(input(subject.controller))).rejects.toMatchObject({
      name: "AdmissionPromptDispatchError",
      outcome: { state: "dispatch_ambiguous", reason: "dispatch_ambiguous" }
    });

    expect(subject.events).toContain("controller:ambiguous:lease-1:1000");
    expect(subject.events).toContain("launcher:release:model_turn");
    expect(subject.events).not.toContain("provider:activity:lease-1");
    expect(subject.writes).toEqual(["secret business prompt"]);
  });

  it("keeps a post-intent activity fault ambiguous rather than requeuing it", async () => {
    const subject = rig({ activity: "throws" });

    await expect(subject.dispatcher.run(input(subject.controller))).resolves.toEqual({
      state: "dispatch_ambiguous",
      reason: "provider_activity_unobserved"
    });

    expect(subject.events).toContain("controller:ambiguous:lease-1:1000");
    expect(subject.events).not.toContain("recovery:pre:provider_activity_unobserved");
    expect(subject.events).not.toContain("controller:active:lease-1:1000");
  });

  it("accepts a strict SQLite-primary terminal without requiring stream-json evidence", async () => {
    const existingTerminal = sqlitePrimaryTerminal();
    const subject = rig({
      terminal: {
        observations: {
          mode: "sqlite_primary",
          sqliteReconciliation: {
            source: "sqlite_reconciliation",
            conversationId: "conversation-sqlite-primary",
            observedAt: NOW + 1,
            status: "SUCCESS"
          }
        },
        delivery: existingTerminal.delivery
      }
    });

    await expect(subject.dispatcher.run(input(subject.controller))).resolves.toEqual({
      state: "completed",
      stopReason: "end_turn"
    });

    expect(subject.events).toContain("controller:terminal:lease-1:1000");
    expect(subject.events).toContain("controller:release:lease-1:1000");
    expect(subject.events).not.toContain("recovery:required:terminal_evidence_unreconciled");
  });

  it("rejects a provider-supplied terminal delivery request ID without replaying business work", async () => {
    const observed = sqlitePrimaryTerminal();
    const subject = rig({
      terminal: {
        observations: {
          mode: "sqlite_primary",
          sqliteReconciliation: {
            source: "sqlite_reconciliation",
            conversationId: "conversation-sqlite-primary",
            observedAt: NOW + 1,
            status: "SUCCESS"
          }
        },
        delivery: {
          ...observed.delivery,
          requestId: "other-request"
        }
      } as never
    });

    await expect(subject.dispatcher.run(input(subject.controller))).resolves.toEqual({
      state: "recovery_required",
      reason: "terminal_observation_failed"
    });

    expect(subject.events).toContain("recovery:required:terminal_observation_failed");
    expect(subject.events).not.toContain("controller:terminal:lease-1:1000");
    expect(subject.events).not.toContain("controller:release:lease-1:1000");
    expect(subject.events.filter((event) => event.startsWith("recovery:pre:"))).toEqual([]);
    expect(subject.writes).toEqual(["secret business prompt"]);
  });

  it("fails closed when a terminal wrapper carries raw provider data outside the evidence contract", async () => {
    const rawTerminalText = "private provider stdout";
    const observed = sqlitePrimaryTerminal();
    const subject = rig({
      terminal: {
        ...observed,
        rawStdout: rawTerminalText
      } as never
    });

    await expect(subject.dispatcher.run(input(subject.controller))).resolves.toEqual({
      state: "recovery_required",
      reason: "terminal_observation_failed"
    });

    expect(subject.events).toContain("recovery:required:terminal_observation_failed");
    expect(subject.events).not.toContain("controller:terminal:lease-1:1000");
    expect(subject.events).not.toContain("controller:release:lease-1:1000");
    expect(JSON.stringify(subject.events)).not.toContain(rawTerminalText);
  });

  it("requires v2.1 dual-source reconciliation before atomic terminal delivery and capacity release", async () => {
    const subject = rig({ terminal: dualSourceTerminal("SUCCESS", false) });

    await expect(subject.dispatcher.run(input(subject.controller))).resolves.toEqual({
      state: "recovery_required",
      reason: "terminal_evidence_unreconciled"
    });

    expect(subject.events).toContain("recovery:required:terminal_evidence_unreconciled");
    expect(subject.events).not.toContain("controller:terminal:lease-1:1000");
    expect(subject.events).not.toContain("controller:release:lease-1:1000");
    expect(subject.events.filter((event) => event.startsWith("recovery:pre:"))).toEqual([]);
    expect(subject.writes).toEqual(["secret business prompt"]);
    expect(subject.events).toContain("launcher:release:model_turn");
  });

  it("records recovery when terminal persistence or subsequent lease release faults", async () => {
    const terminalFailure = rig({ terminalPersistenceError: true });
    await expect(terminalFailure.dispatcher.run(input(terminalFailure.controller))).resolves.toEqual({
      state: "recovery_required",
      reason: "terminal_finalize_failed"
    });
    expect(terminalFailure.events).toContain("recovery:required:terminal_finalize_failed");
    expect(terminalFailure.events).not.toContain("controller:release:lease-1:1000");

    const releaseFailure = rig({ releaseError: true });
    await expect(releaseFailure.dispatcher.run(input(releaseFailure.controller))).resolves.toEqual({
      state: "recovery_required",
      reason: "lease_release_failed"
    });
    expect(releaseFailure.events).toContain("controller:terminal:lease-1:1000");
    expect(releaseFailure.events).toContain("controller:release:lease-1:1000");
    expect(releaseFailure.events).toContain("recovery:required:lease_release_failed");
  });

  it("keeps a failed startup-launcher proof in recovery_required and never treats it as a queued replay", async () => {
    const subject = rig({
      launcher: "throws",
      preDispatchResolution: "recovery_required"
    });

    await expect(subject.dispatcher.run(input(subject.controller))).resolves.toEqual({
      state: "recovery_required",
      reason: "process_start_failed"
    });

    expect(subject.events).toEqual([
      "controller:admit:request-1:1000:owner-1",
      "controller:starting:lease-1:1000",
      "controller:payload:request-1:1000",
      "launcher:acquire:model_turn",
      "recovery:pre:process_start_failed"
    ]);
    expect(subject.writes).toEqual([]);
  });

  it("fails closed when the launcher release faults after an unprompted process starts", async () => {
    const subject = rig({ launcher: "release_throws", preDispatchResolution: "recovery_required" });

    await expect(subject.dispatcher.run(input(subject.controller))).resolves.toEqual({
      state: "recovery_required",
      reason: "process_start_failed"
    });

    expect(subject.events).toContain("agy:spawn:lease-1");
    expect(subject.events).toContain("launcher:release:model_turn");
    expect(subject.events).toContain("recovery:pre:process_start_failed");
    expect(subject.events).not.toContain("agy:write");
    expect(subject.events).not.toContain("provider:activity:lease-1");
  });
});
