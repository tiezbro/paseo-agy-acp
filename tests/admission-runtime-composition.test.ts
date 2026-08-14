import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdmissionRuntimeComposition } from "../ACP Connector/admission/runtime-composition.js";
import { createDeliveryEventIdentity, createRequestIdentity } from "../ACP Connector/admission/identity.js";
import { deriveAdmissionKeyBundle, zeroAdmissionKeyBundle } from "../Admission Controller/key-derivation.js";
import { AdmissionRuntime } from "../ACP Connector/admission/runtime.js";
import {
  issueLinuxPreDispatchTerminationProof,
  verifyLinuxPreDispatchTerminationProof
} from "../Admission Controller/process-evidence.js";
import type {
  AdmissionPromptAgyContract,
  AdmissionPromptProcessLifecycleOwner,
  AdmissionPromptProviderObserver,
  AdmissionPromptRecoveryOwner
} from "../ACP Connector/admission/dispatcher.js";
import {
  ACP_REQUEST_IDENTITY_CAPABILITY_VERSION,
  negotiateRequestIdentityCapability,
  validateRequestIdentityPromptMetadata
} from "../ACP Connector/admission/request-identity-protocol.js";
import { TurnClaim } from "../ACP Connector/acp/session/turn-scheduler.js";
import { probeExactAgyBinaryVersion } from "../ACP Connector/agy/launch-spec.js";

const stateDirs: string[] = [];

function stateDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-runtime-composition-"));
  stateDirs.push(dir);
  return dir;
}

function probeFakeAgyVersion() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-runtime-composition-canary-"));
  const executable = path.join(dir, "fake-agy");
  try {
    writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' 'agy version 2.0.0.0'\n", "utf8");
    chmodSync(executable, 0o700);
    return probeExactAgyBinaryVersion({ executable, cwd: os.tmpdir() });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

afterEach(() => {
  for (const dir of stateDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Admission runtime composition", () => {
  it("copies derived subkeys before the caller clears its bundle", () => {
    const keys = deriveAdmissionKeyBundle(Buffer.alloc(32, 23));
    const startupCanaryKey = keys.startupCanary.toString("hex");
    const input = {
      conversationId: "conversation-1",
      cursor: "cursor-1",
      eventType: "assistant_message",
      toolId: "tool-1",
      state: "delta"
    };
    const expectedIdentity = createDeliveryEventIdentity(keys.deliveryIdentity, input);
    const composition = new AdmissionRuntimeComposition(keys);
    const controller = composition.createController({
      databasePath: path.join(stateDir(), "runtime.sqlite"),
      policy: {
        maxActiveTurns: 1,
        maxConcurrentStarts: 1,
        minStartIntervalMs: 0,
        queueTimeoutMs: 60_000,
        capacityCooldownMs: 30_000
      }
    });

    zeroAdmissionKeyBundle(keys);
    expect(keys.startupCanary.equals(Buffer.alloc(32))).toBe(true);

    try {
      expect(composition.createDeliveryEventIdentity(input)).toBe(expectedIdentity);
      expect(Object.keys(composition)).not.toContain("startupCanaryKey");
      expect(JSON.stringify(composition)).not.toContain(startupCanaryKey);
      expect(() => controller.enqueueWithPayload({
        requestId: "request-1",
        sessionId: "session-1",
        parentId: "agent-1",
        fingerprint: "fingerprint-1",
        provider: "provider-1",
        model: "model-1",
        now: 1_000
      }, "sensitive prompt", 61_000)).not.toThrow();
      expect(controller.readPayload("request-1", 1_000)).toBe("sensitive prompt");
    } finally {
      controller.close();
      composition.close();
    }
  });

  it("zeroes its private subkeys and rejects use after an idempotent close", () => {
    const composition = new AdmissionRuntimeComposition(deriveAdmissionKeyBundle(Buffer.alloc(32, 31)));
    const input = {
      conversationId: "conversation-1",
      cursor: "cursor-1",
      eventType: "assistant_message",
      toolId: "tool-1",
      state: "delta"
    };

    composition.close();

    expect(() => composition.close()).not.toThrow();
    expect(() => composition.createDeliveryEventIdentity(input)).toThrow(/closed/);
  });

  it("builds prompt seams from a copied request-identity subkey", async () => {
    const keys = deriveAdmissionKeyBundle(Buffer.alloc(32, 41));
    const composition = new AdmissionRuntimeComposition(keys);
    const controller = composition.createController({
      databasePath: path.join(stateDir(), "runtime.sqlite"),
      policy: {
        maxActiveTurns: 1,
        maxConcurrentStarts: 1,
        minStartIntervalMs: 0,
        queueTimeoutMs: 60_000,
        capacityCooldownMs: 30_000
      }
    });
    const runtime = new AdmissionRuntime(controller);
    const requestIdentity = validateRequestIdentityPromptMetadata(negotiateRequestIdentityCapability({
      versions: [ACP_REQUEST_IDENTITY_CAPABILITY_VERSION],
      required: false
    }), {
      v: ACP_REQUEST_IDENTITY_CAPABILITY_VERSION,
      clientMessageId: "client-message-1"
    });
    const expectedRequestId = createRequestIdentity(keys.requestIdentity, {
      agentId: "agent-1",
      acpSessionId: "session-1",
      clientMessageId: "client-message-1"
    });
    const seam = composition.createPromptSeam(runtime, "agent-1", {
      now: () => 1_000,
      dispatch: (input) => {
        runtime.controller.cancelQueued(input.requestId, 1_001);
        return "cancelled";
      }
    });

    for (const key of Object.values(keys)) key.fill(0);

    try {
      await expect(seam.admit({
        sessionId: "session-1",
        model: "model-1",
        promptText: "sensitive prompt",
        claim: new TurnClaim("foreground"),
        requestIdentity
      })).resolves.toBe("cancelled");
      expect(runtime.controller.getRequest(expectedRequestId)).toMatchObject({
        requestId: expectedRequestId,
        state: "cancelled"
      });
    } finally {
      composition.close();
      runtime.close();
    }
  });

  it("owns runtime-bound dispatchers and closes them before they can start new provider work", async () => {
    interface FakeProcess {
      readonly pid: number;
    }
    interface ProcessIdentity {
      readonly pid: number;
    }

    const composition = new AdmissionRuntimeComposition(deriveAdmissionKeyBundle(Buffer.alloc(32, 57)));
    const runtime = new AdmissionRuntime({
      close() {}
    } as never, composition);
    let starts = 0;
    let canaryLaunches = 0;
    const lifecycle: AdmissionPromptProcessLifecycleOwner<ProcessIdentity> = {
      recordProcessIdentity: () => ({ status: "recorded" }),
      revalidate: () => ({ generationMatches: true, ownerMatches: true, cancelled: false }),
      commitDispatchIntent: () => ({ status: "committed" })
    };
    const agy: AdmissionPromptAgyContract<FakeProcess, ProcessIdentity> = {
      spawnPromptFree: () => {
        starts += 1;
        throw new Error("a closed dispatcher must not reach provider startup");
      }
    };
    const provider: AdmissionPromptProviderObserver = {
      observeProviderActivity: () => {
        throw new Error("a closed dispatcher must not observe provider activity");
      },
      observeTerminal: () => {
        throw new Error("a closed dispatcher must not observe a provider terminal");
      }
    };
    const recovery: AdmissionPromptRecoveryOwner<ProcessIdentity> = {
      recoverPreDispatch: () => ({ state: "recovery_required" }),
      recordRecoveryRequired: () => {}
    };
    const dispatcher = runtime.createPromptDispatcher({
      ownerInstanceId: "owner-composition",
      lifecycle,
      agy,
      provider,
      recovery,
      freshPtyCanary: {
        verifiedAgyBinary: probeFakeAgyVersion(),
        fakeChild: () => {
          canaryLaunches += 1;
          throw new Error("closed dispatcher must not launch a canary");
        }
      },
      now: () => 1_000
    });

    runtime.close();

    await expect(dispatcher.run({
      runtime,
      requestId: "request-composition",
      sessionId: "session-composition",
      parentId: "parent-composition",
      provider: "antigravity",
      model: "model-composition",
      claim: new TurnClaim("foreground")
    })).resolves.toEqual({ state: "recovery_required", reason: "unexpected_fault" });
    expect(starts).toBe(0);
    expect(canaryLaunches).toBe(0);
  });

  it("gives recovery bridges matching owned proof authorities without exposing their subkey", () => {
    const keys = deriveAdmissionKeyBundle(Buffer.alloc(32, 73));
    const proofKey = keys.preDispatchProof.toString("hex");
    const composition = new AdmissionRuntimeComposition(keys);
    const controller = composition.createController({
      databasePath: path.join(stateDir(), "runtime.sqlite"),
      policy: {
        maxActiveTurns: 1,
        maxConcurrentStarts: 1,
        minStartIntervalMs: 0,
        queueTimeoutMs: 60_000,
        capacityCooldownMs: 30_000
      }
    });
    const runtime = new AdmissionRuntime(controller, composition);
    zeroAdmissionKeyBundle(keys);
    let signerAuthority: ReturnType<typeof composition.createPreDispatchProofAuthority> | undefined;
    let verifierAuthority: ReturnType<typeof composition.createPreDispatchProofAuthority> | undefined;

    runtime.createRecoveryBridge(({ createPreDispatchProofAuthority }) => {
      signerAuthority = createPreDispatchProofAuthority();
      verifierAuthority = createPreDispatchProofAuthority();
      return { close() {} };
    });
    if (signerAuthority === undefined || verifierAuthority === undefined) {
      throw new Error("expected matching recovery proof authorities");
    }

    const proof = issueLinuxPreDispatchTerminationProof({
      binding: {
        requestId: "request-42",
        leaseId: "lease-42",
        leaseGeneration: 7,
        recoveryGeneration: 1,
        claimantInstanceId: "recovery-a"
      },
      subject: {
        ownerInstanceId: "4d6f4908-8b36-4d63-bcc0-3d690fcfb9ce",
        connectorCreatedAt: "2026-08-09T12:34:56.789Z",
        connector: {
          bootId: "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f31",
          pid: 4182,
          startTimeTicks: "1234567890123",
          pidNamespaceInode: 4_026_531_836,
          ppid: 1,
          pgrp: 4182,
          session: 4182
        },
        child: {
          bootId: "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f31",
          pid: 4183,
          startTimeTicks: "1234567890124",
          pidNamespaceInode: 4_026_531_836,
          ppid: 4182,
          pgrp: 4183,
          session: 4183
        },
        promptChannel: "stdin"
      },
      observedAt: 1_011,
      owner: "gone",
      root: "gone",
      residue: "empty"
    }, signerAuthority);

    expect(verifyLinuxPreDispatchTerminationProof(proof, verifierAuthority)).toEqual(proof);
    expect(JSON.stringify(composition)).not.toContain(proofKey);

    runtime.close();

    expect(verifyLinuxPreDispatchTerminationProof(proof, verifierAuthority)).toBeNull();
  });
});
