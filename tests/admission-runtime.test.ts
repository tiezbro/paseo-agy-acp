import { chmodSync, existsSync, linkSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAdmissionRuntime,
  AdmissionRuntimeError
} from "../src/admission/runtime.js";
import { deriveAdmissionKeyBundle, zeroAdmissionKeyBundle } from "../src/admission/key-derivation.js";
import { ADMISSION_SCHEMA_VERSION } from "../src/admission/schema.js";
import type {
  AdmissionPromptAgyContract,
  AdmissionPromptProcessLifecycleOwner,
  AdmissionPromptProviderObserver,
  AdmissionPromptRecoveryOwner
} from "../src/admission/dispatcher.js";
import { ACP_OUTBOX_CAPABILITY } from "../src/admission/outbox-protocol.js";
import {
  ACP_REQUEST_IDENTITY_CAPABILITY_VERSION,
  negotiateRequestIdentityCapability,
  validateRequestIdentityPromptMetadata
} from "../src/admission/request-identity-protocol.js";
import { TurnClaim } from "../src/agy/acp/session/turn-scheduler.js";
import type { AgyStartupLauncher } from "../src/agy/startup-launcher.js";
import {
  createAgyLaunchSpecification,
  probeExactAgyBinaryVersion,
  type AgyLaunchSpecification,
  type VerifiedAgyBinary
} from "../src/agy/launch-spec.js";
import type {
  AdmissionDeliveryBridgeContext,
  AdmissionRecoveryBridgeContext
} from "../src/admission/runtime-composition.js";

const stateDirs: string[] = [];
const RUNTIME_AGENT_ID = "paseo-admission-runtime-test";
const fakePtyCanarySources = vi.hoisted(() => new WeakMap<object, AgyLaunchSpecification>());

vi.mock("../src/agy/startup-launcher.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/agy/startup-launcher.js")>();
  return {
    ...actual,
    runRepositoryOwnedPromptFreePtyCanary<TChild>(
      binary: unknown,
      fakeChild: (launch: AgyLaunchSpecification) => TChild,
      forbiddenTexts: readonly string[]
    ) {
      const launch = typeof binary === "object" && binary !== null
        ? fakePtyCanarySources.get(binary)
        : undefined;
      if (launch === undefined) return undefined;
      const serialized = JSON.stringify(launch);
      if (forbiddenTexts.some((text) => serialized.includes(text))) {
        throw new Error("test prompt-free PTY source leaked forbidden text");
      }
      return Object.freeze({ child: fakeChild(launch), launch });
    },
    isRepositoryOwnedPromptFreePtyLaunch(binary: unknown, launch: unknown) {
      return typeof binary === "object" && binary !== null && fakePtyCanarySources.get(binary) === launch;
    }
  };
});

function stateDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-runtime-"));
  stateDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of stateDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

type FreshPtyCanaryMode = "verified" | "failed" | "stale" | "mismatched" | "missing" | "unregistered";

function probeFakeAgyVersion(registerSource = false): VerifiedAgyBinary {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-runtime-canary-"));
  const executable = path.join(dir, "fake-agy");
  try {
    writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' 'agy version 2.0.0.0'\n", "utf8");
    chmodSync(executable, 0o700);
    const binary = probeExactAgyBinaryVersion({ executable, cwd: os.tmpdir() });
    if (registerSource) {
      fakePtyCanarySources.set(binary, createAgyLaunchSpecification({
        agyVersion: binary.version,
        launcherFingerprint: binary.launcherFingerprint,
        transport: "pty",
        argv: [binary.executable, "--prompt-free-canary"],
        environment: { TERM: "xterm-256color", SAFE_VALUE: "kept" },
        cwd: os.tmpdir(),
        processTitle: "paseo-agy-acp:fake-prompt-free-pty-canary",
        temporaryFilePath: path.join(os.tmpdir(), "paseo-agy-acp-fake-pty-canary"),
        launcherDiagnostics: ["source=vitest", "transport=pty"]
      }));
    }
    return binary;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runtimeDispatchRig(options: {
  readonly promptChannel: "stdin" | "pty";
  readonly canary: FreshPtyCanaryMode;
  readonly callerSuppliedVerifier?: boolean;
  readonly callerSuppliedLaunchSpecification?: boolean;
  readonly masterKey?: Buffer;
}) {
  const dir = stateDir();
  if (options.masterKey !== undefined) {
    writeFileSync(path.join(dir, "admission.key"), options.masterKey, { mode: 0o600 });
  }
  const runtime = createAdmissionRuntime({
    AGY_ACP_ADMISSION_ENABLED: "true",
    AGY_ACP_STATE_DIR: dir,
    PASEO_AGENT_ID: RUNTIME_AGENT_ID
  });
  if (runtime === null) throw new Error("expected enabled admission runtime");

  const now = 10_000;
  let canaryNow = now;
  const requestId = "request-pty";
  const prompt = `private PTY prompt ${requestId}`;
  const writes: string[] = [];
  const spawnFences: unknown[] = [];
  const canaryLaunches: AgyLaunchSpecification[] = [];
  const recoveryReasons: string[] = [];
  let canaryCalls = 0;
  let callerVerifierCalls = 0;
  let callerLaunchSpecificationReads = 0;
  let providerCalls = 0;
  let spawnCalls = 0;

  runtime.controller.enqueueWithPayload({
    requestId,
    sessionId: "session-pty",
    parentId: "parent-pty",
    fingerprint: "fingerprint-pty",
    provider: "antigravity",
    model: "model-pty",
    now
  }, prompt, now + 60_000);

  const lifecycle: AdmissionPromptProcessLifecycleOwner<{ pid: number }> = {
    recordProcessIdentity: () => ({ status: "recorded" }),
    revalidate: () => ({ generationMatches: true, ownerMatches: true, cancelled: false }),
    commitDispatchIntent(record) {
      runtime.controller.markDispatchIntent(record, now);
      return { status: "committed" };
    }
  };
  const agy: AdmissionPromptAgyContract<{ pid: number }, { pid: number }> = {
    spawnPromptFree(fence) {
      spawnCalls += 1;
      spawnFences.push(fence);
      return {
        process: { pid: 7 },
        identity: { pid: 7 },
        promptChannel: options.promptChannel,
        writeInitialPrompt(value) {
          writes.push(value);
          return { status: "accepted" };
        }
      };
    }
  };
  const provider: AdmissionPromptProviderObserver = {
    observeProviderActivity: () => {
      providerCalls += 1;
      return { status: "observed" };
    },
    observeTerminal: () => {
      providerCalls += 1;
      return {
        observations: {
          streamJson: {
            source: "stream_json",
            conversationId: "conversation-pty",
            observedAt: now,
            status: "SUCCESS"
          },
          sqliteReconciliation: {
            source: "sqlite_reconciliation",
            conversationId: "conversation-pty",
            observedAt: now + 1,
            status: "SUCCESS"
          }
        },
        delivery: {
          eventId: `terminal-${requestId}`,
          fingerprint: `terminal-${requestId}`,
          payload: "fake provider terminal",
          sequence: 1,
          expiresAt: now + 60_000,
          protocol: ACP_OUTBOX_CAPABILITY
        }
      };
    }
  };
  const recovery: AdmissionPromptRecoveryOwner<{ pid: number }> = {
    recoverPreDispatch(context) {
      recoveryReasons.push(context.reason);
      return { state: "queued" };
    },
    recordRecoveryRequired(context) {
      recoveryReasons.push(context.reason);
    }
  };
  const freshPtyCanary = options.canary === "missing" ? undefined : {
    verifiedAgyBinary: options.canary === "mismatched"
      ? Object.freeze({ ...probeFakeAgyVersion() }) as VerifiedAgyBinary
      : probeFakeAgyVersion(options.canary !== "unregistered"),
    maxAgeMs: 10,
    fakeChild(launch: AgyLaunchSpecification) {
      canaryCalls += 1;
      canaryLaunches.push(launch);
      switch (options.canary) {
        case "failed":
          throw new Error("injected fake canary failure");
        case "stale":
          canaryNow += 10;
          return { exitCode: 0 };
        case "mismatched":
        case "verified":
          return { exitCode: 0 };
        case "missing":
          throw new Error("missing canary must not receive a fake launch");
        case "unregistered":
          throw new Error("unregistered canary source must not receive a fake launch");
      }
    }
  };
  if (options.callerSuppliedLaunchSpecification && freshPtyCanary !== undefined) {
    Object.defineProperty(freshPtyCanary, "launchSpecification", {
      enumerable: true,
      get() {
        callerLaunchSpecificationReads += 1;
        throw new Error("runtime composition must not read caller launch specifications");
      }
    });
  }
  const dispatcherOptions = {
    ownerInstanceId: "owner-pty",
    lifecycle,
    agy,
    provider,
    recovery,
    ...(freshPtyCanary === undefined ? {} : { freshPtyCanary }),
    now: () => canaryNow
  };
  if (options.callerSuppliedVerifier) {
    (dispatcherOptions as unknown as Record<string, unknown>).verifyFreshPtyCanary = () => {
      callerVerifierCalls += 1;
      return { status: "verified" };
    };
  }
  const dispatcher = runtime.createPromptDispatcher(dispatcherOptions);

  return {
    runtime,
    prompt,
    writes,
    spawnFences,
    canaryLaunches,
    recoveryReasons,
    canaryCalls: () => canaryCalls,
    callerVerifierCalls: () => callerVerifierCalls,
    callerLaunchSpecificationReads: () => callerLaunchSpecificationReads,
    providerCalls: () => providerCalls,
    spawnCalls: () => spawnCalls,
    run: () => dispatcher.run({
      runtime,
      requestId,
      sessionId: "session-pty",
      parentId: "parent-pty",
      provider: "antigravity",
      model: "model-pty",
      claim: new TurnClaim("foreground")
    })
  };
}

describe("Admission Controller runtime factory", () => {
  it("does not create state while admission is absent or explicitly disabled", () => {
    const root = stateDir();
    const absentStateDir = path.join(root, "absent");
    const disabledStateDir = path.join(root, "disabled");

    expect(createAdmissionRuntime({ AGY_ACP_STATE_DIR: absentStateDir })).toBeNull();
    expect(createAdmissionRuntime({
      AGY_ACP_ADMISSION_ENABLED: "false",
      AGY_ACP_STATE_DIR: disabledStateDir
    })).toBeNull();

    expect(existsSync(absentStateDir)).toBe(false);
    expect(existsSync(disabledStateDir)).toBe(false);
  });

  it("materializes a secure enabled runtime in an explicit state directory", () => {
    const dir = path.join(stateDir(), "admission");
    const runtime = createAdmissionRuntime({
      AGY_ACP_ADMISSION_ENABLED: "1",
      AGY_ACP_STATE_DIR: dir,
      PASEO_AGENT_ID: RUNTIME_AGENT_ID
    });

    expect(runtime).not.toBeNull();
    expect(runtime?.controller.schemaVersion).toBe(ADMISSION_SCHEMA_VERSION);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, "admission.key")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dir, "runtime.sqlite")).mode & 0o777).toBe(0o600);
    runtime?.close();
  });

  it("owns narrow prompt, delivery, and recovery factories until close", async () => {
    const dir = path.join(stateDir(), "admission");
    const runtime = createAdmissionRuntime({
      AGY_ACP_ADMISSION_ENABLED: "true",
      AGY_ACP_STATE_DIR: dir,
      PASEO_AGENT_ID: RUNTIME_AGENT_ID
    });
    if (runtime === null) throw new Error("expected enabled admission runtime");

    let delivery: AdmissionDeliveryBridgeContext | undefined;
    let recovery: AdmissionRecoveryBridgeContext | undefined;
    let deliveryCloseCount = 0;
    let recoveryCloseCount = 0;
    const queueProgress: Array<{ readonly parentId: string; readonly state: string }> = [];

    const prompt = runtime.createPromptSeam({
      now: () => 1_000,
      dispatch: (input) => {
        runtime.controller.cancelQueued(input.requestId, 1_001);
        return "cancelled";
      },
      reportQueueProgress: (progress) => {
        queueProgress.push(progress);
      }
    });
    runtime.createDeliveryBridge((context) => {
      delivery = context;
      return { close: () => { deliveryCloseCount += 1; } };
    });
    runtime.createRecoveryBridge((context) => {
      recovery = context;
      return { close: () => { recoveryCloseCount += 1; } };
    });

    expect(prompt).toBeDefined();
    expect(delivery).toBeDefined();
    expect(recovery).toBeDefined();
    expect(delivery).not.toHaveProperty("key");
    expect(recovery).not.toHaveProperty("key");
    expect(delivery?.createEventIdentity({
      conversationId: "conversation-1",
      cursor: "cursor-1",
      eventType: "assistant_message",
      toolId: "tool-1",
      state: "delta"
    })).toMatch(/^[0-9a-f]{64}$/);
    await expect(prompt.admit({
      sessionId: "session-runtime",
      model: "model-runtime",
      promptText: "sensitive prompt",
      claim: new TurnClaim("foreground"),
      requestIdentity: validateRequestIdentityPromptMetadata(negotiateRequestIdentityCapability({
        versions: [ACP_REQUEST_IDENTITY_CAPABILITY_VERSION],
        required: false
      }), {
        v: ACP_REQUEST_IDENTITY_CAPABILITY_VERSION,
        clientMessageId: "client-message-runtime"
      })
    })).resolves.toBe("cancelled");
    expect(queueProgress).toEqual([
      expect.objectContaining({ parentId: RUNTIME_AGENT_ID, state: "queued" })
    ]);

    runtime.close();
    expect(deliveryCloseCount).toBe(1);
    expect(recoveryCloseCount).toBe(1);
    expect(() => runtime.close()).not.toThrow();
    expect(deliveryCloseCount).toBe(1);
    expect(recoveryCloseCount).toBe(1);
    expect(() => runtime.controller).toThrow(AdmissionRuntimeError);
    expect(() => runtime.createPromptSeam({ dispatch: () => "cancelled" })).toThrow(
      AdmissionRuntimeError
    );
    expect(() => delivery?.createEventIdentity({
      conversationId: "conversation-1",
      cursor: "cursor-1",
      eventType: "assistant_message",
      toolId: "tool-1",
      state: "delta"
    })).toThrow(AdmissionRuntimeError);
  });

  it("binds an enabled runtime to the prompt-free CLI boundary with a fenced atomic dispatch before one fake write", async () => {
    const dir = path.join(stateDir(), "admission");
    const runtime = createAdmissionRuntime({
      AGY_ACP_ADMISSION_ENABLED: "true",
      AGY_ACP_STATE_DIR: dir,
      PASEO_AGENT_ID: RUNTIME_AGENT_ID
    });
    if (runtime === null) throw new Error("expected enabled admission runtime");

    try {
      const cases = [
        { status: "SUCCESS" as const, requestState: "completed", stopReason: "end_turn" },
        { status: "ERROR" as const, requestState: "failed", stopReason: "end_turn" },
        { status: "CANCELED" as const, requestState: "cancelled", stopReason: "cancelled" }
      ] as const;

      for (const [index, expected] of cases.entries()) {
        const now = 1_000 + index * 2_000;
        const requestId = `request-runtime-${index}`;
        const prompt = `private prompt ${index}`;
        const events: string[] = [];
        const writes: string[] = [];
        const spawnFences: unknown[] = [];
        let recoveryCalls = 0;

        runtime.controller.enqueueWithPayload({
          requestId,
          sessionId: `session-runtime-${index}`,
          parentId: "parent-runtime",
          fingerprint: `fingerprint-runtime-${index}`,
          provider: "antigravity",
          model: "model-runtime",
          now
        }, prompt, now + 60_000);

        const startupLauncher: AgyStartupLauncher = {
          enabled: true,
          acquire(classification) {
            events.push(`startup:acquire:${classification}`);
            return {
              release() {
                events.push(`startup:release:${classification}`);
              }
            };
          }
        };
        const lifecycle: AdmissionPromptProcessLifecycleOwner<{ pid: number }> = {
          recordProcessIdentity() {
            events.push("lifecycle:record");
            return { status: "recorded" };
          },
          revalidate() {
            events.push("lifecycle:revalidate");
            return { generationMatches: true, ownerMatches: true, cancelled: false };
          },
          commitDispatchIntent(record) {
            events.push("lifecycle:commit");
            runtime.controller.markDispatchIntent(record, now);
            return { status: "committed" };
          }
        };
        const agy: AdmissionPromptAgyContract<{ pid: number }, { pid: number }> = {
          spawnPromptFree(fence) {
            events.push("agy:spawn");
            spawnFences.push(fence);
            return {
              process: { pid: 42 + index },
              identity: { pid: 42 + index },
              promptChannel: "stdin",
              writeInitialPrompt(value) {
                events.push("agy:write");
                writes.push(value);
                expect(runtime.controller.getRequest(requestId)?.state).toBe("dispatch_intent");
                return { status: "accepted" };
              }
            };
          }
        };
        const provider: AdmissionPromptProviderObserver = {
          observeProviderActivity() {
            events.push("provider:activity");
            return { status: "observed" };
          },
          observeTerminal() {
            events.push("provider:terminal");
            return {
              observations: {
                streamJson: {
                  source: "stream_json",
                  conversationId: `conversation-runtime-${index}`,
                  observedAt: now,
                  status: expected.status
                },
                sqliteReconciliation: {
                  source: "sqlite_reconciliation",
                  conversationId: `conversation-runtime-${index}`,
                  observedAt: now + 1,
                  status: expected.status
                }
              },
              delivery: {
                eventId: `terminal-runtime-${index}`,
                fingerprint: `terminal-fingerprint-${index}`,
                payload: "provider terminal closed",
                sequence: 1,
                expiresAt: now + 60_000,
                protocol: ACP_OUTBOX_CAPABILITY
              }
            };
          }
        };
        const recovery: AdmissionPromptRecoveryOwner<{ pid: number }> = {
          recoverPreDispatch() {
            recoveryCalls += 1;
            return { state: "recovery_required" };
          },
          recordRecoveryRequired() {
            recoveryCalls += 1;
          }
        };

        const dispatcher = runtime.createPromptDispatcher({
          ownerInstanceId: "owner-runtime",
          startupLauncher,
          lifecycle,
          agy,
          provider,
          recovery,
          now: () => now
        });
        const outcome = await dispatcher.run({
          runtime,
          requestId,
          sessionId: `session-runtime-${index}`,
          parentId: "parent-runtime",
          provider: "antigravity",
          model: "model-runtime",
          claim: new TurnClaim("foreground")
        });

        expect(outcome).toEqual({ state: expected.requestState, stopReason: expected.stopReason });
        expect(runtime.controller.getRequest(requestId)?.state).toBe(expected.requestState);
        expect(events).toEqual([
          "startup:acquire:model_turn",
          "agy:spawn",
          "startup:release:model_turn",
          "lifecycle:record",
          "lifecycle:revalidate",
          "lifecycle:commit",
          "agy:write",
          "provider:activity",
          "provider:terminal"
        ]);
        expect(writes).toEqual([prompt]);
        expect(JSON.stringify(spawnFences)).not.toContain(prompt);
        expect(recoveryCalls).toBe(0);
      }
    } finally {
      runtime.close();
    }
  });

  it("certifies a fresh PTY with a runtime-owned HMAC before exactly one fake prompt write", async () => {
    const masterKey = Buffer.alloc(32, 0x6d);
    const derived = deriveAdmissionKeyBundle(masterKey);
    const startupCanaryKey = derived.startupCanary.toString("hex");
    zeroAdmissionKeyBundle(derived);
    const subject = runtimeDispatchRig({
      promptChannel: "pty",
      canary: "verified",
      masterKey
    });

    try {
      await expect(subject.run()).resolves.toEqual({ state: "completed", stopReason: "end_turn" });

      expect(subject.writes).toEqual([subject.prompt]);
      expect(subject.spawnCalls()).toBe(1);
      expect(subject.canaryCalls()).toBe(1);
      expect(subject.canaryLaunches).toHaveLength(1);
      expect(subject.providerCalls()).toBe(2);
      expect(subject.recoveryReasons).toEqual([]);
      expect(JSON.stringify({
        canaryLaunches: subject.canaryLaunches,
        spawnFences: subject.spawnFences
      })).not.toContain(subject.prompt);
      expect(JSON.stringify(subject.canaryLaunches)).not.toContain(masterKey.toString("hex"));
      expect(JSON.stringify(subject.canaryLaunches)).not.toContain(startupCanaryKey);
      expect(Object.keys(subject.runtime)).not.toContain("startupCanaryKey");
    } finally {
      subject.runtime.close();
      masterKey.fill(0);
    }
  });

  it("fails PTY closed for missing, stale, failing, mismatched, or unregistered canary evidence", async () => {
    const cases: Array<{ readonly canary: FreshPtyCanaryMode; readonly launches: number }> = [
      { canary: "missing", launches: 0 },
      { canary: "stale", launches: 1 },
      { canary: "failed", launches: 1 },
      { canary: "mismatched", launches: 0 },
      { canary: "unregistered", launches: 0 }
    ];

    for (const current of cases) {
      const subject = runtimeDispatchRig({
        promptChannel: "pty",
        canary: current.canary,
        callerSuppliedVerifier: current.canary === "missing",
        callerSuppliedLaunchSpecification: current.canary === "unregistered"
      });
      try {
        await expect(subject.run(), current.canary).resolves.toEqual({
          state: "queued",
          reason: "fresh_pty_uncertified"
        });

        expect(subject.writes, current.canary).toEqual([]);
        expect(subject.spawnCalls(), current.canary).toBe(1);
        expect(subject.canaryCalls(), current.canary).toBe(current.launches);
        expect(subject.providerCalls(), current.canary).toBe(0);
        expect(subject.recoveryReasons, current.canary).toEqual(["fresh_pty_uncertified"]);
        expect(subject.callerVerifierCalls(), current.canary).toBe(0);
        expect(subject.callerLaunchSpecificationReads(), current.canary).toBe(0);
      } finally {
        subject.runtime.close();
      }
    }
  });

  it("keeps stdin dispatch unchanged when no PTY canary is configured", async () => {
    const subject = runtimeDispatchRig({ promptChannel: "stdin", canary: "missing" });

    try {
      await expect(subject.run()).resolves.toEqual({ state: "completed", stopReason: "end_turn" });

      expect(subject.writes).toEqual([subject.prompt]);
      expect(subject.canaryCalls()).toBe(0);
      expect(subject.providerCalls()).toBe(2);
      expect(subject.recoveryReasons).toEqual([]);
    } finally {
      subject.runtime.close();
    }
  });

  it("rejects an unsafe existing database instead of silently changing its permissions", () => {
    const dir = stateDir();
    const databasePath = path.join(dir, "runtime.sqlite");
    writeFileSync(databasePath, "", { mode: 0o600 });
    chmodSync(databasePath, 0o640);

    expect(() =>
      createAdmissionRuntime({
        AGY_ACP_ADMISSION_ENABLED: "true",
        AGY_ACP_STATE_DIR: dir,
        PASEO_AGENT_ID: RUNTIME_AGENT_ID
      })
    ).toThrow(AdmissionRuntimeError);
    expect(statSync(databasePath).mode & 0o777).toBe(0o640);
  });

  it("rejects a multiply-linked database file", () => {
    const dir = stateDir();
    const databasePath = path.join(dir, "runtime.sqlite");
    writeFileSync(databasePath, "", { mode: 0o600 });
    linkSync(databasePath, path.join(dir, "runtime-copy.sqlite"));

    expect(() =>
      createAdmissionRuntime({
        AGY_ACP_ADMISSION_ENABLED: "true",
        AGY_ACP_STATE_DIR: dir,
        PASEO_AGENT_ID: RUNTIME_AGENT_ID
      })
    ).toThrow(/exactly one link/);
  });
});
