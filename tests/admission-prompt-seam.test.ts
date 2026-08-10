import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import { AcpAgent } from "../src/acp/agent.js";
import type { PromptV1Deps, PromptV2Deps } from "../src/acp/session/prompt.js";
import {
  handlePromptV1,
  handlePromptV2,
  notifyIdleAndDrainQueue
} from "../src/acp/session/prompt.js";
import { turnsOf, TurnClaim, type TurnKind } from "../src/acp/session/turn-scheduler.js";
import type { SessionState } from "../src/acp/session/types.js";
import { AdmissionController, type AdmissionPolicy } from "../src/admission/controller.js";
import { createRequestIdentity } from "../src/admission/identity.js";
import {
  AdmissionPromptDispatchIncompleteError,
  AdmissionPromptIdentityRequiredError,
  AdmissionPromptReplayBlockedError,
  AdmissionPromptSeam,
  type PromptAdmission
} from "../src/admission/prompt-seam.js";
import {
  ACP_REQUEST_IDENTITY_CAPABILITY_KEY,
  ACP_REQUEST_IDENTITY_CAPABILITY_VERSION,
  negotiateRequestIdentityCapability,
  validateRequestIdentityPromptMetadata
} from "../src/admission/request-identity-protocol.js";
import { AdmissionRuntime } from "../src/admission/runtime.js";
import * as installer from "../src/agy/installer.js";

const NOW = 1_000;
const POLICY: AdmissionPolicy = {
  maxActiveTurns: 1,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 60_000,
  capacityCooldownMs: 30_000
};

const stateDirs: string[] = [];

function createRuntime(): AdmissionRuntime {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "agy-acp-admission-seam-"));
  stateDirs.push(stateDir);
  return new AdmissionRuntime(new AdmissionController({
    databasePath: path.join(stateDir, "runtime.sqlite"),
    policy: POLICY,
    encryptionKey: Buffer.alloc(32, 7),
    contentFingerprintKey: Buffer.alloc(32, 8)
  }));
}

function session(sessionId: string): SessionState {
  return {
    sessionId,
    cwd: "/repo",
    additionalDirectories: [],
    promptQueue: [],
    v2UserMessageIdsByStep: {},
    catalog: { models: [], byBase: new Map() },
    selectedBaseModel: "claude-opus-4-6-thinking",
    selectedReasoningEffort: "",
    agy: {
      config: { mode: "default" },
      lastPromptUserStepIdxs: [],
      cancel: vi.fn(async () => {}),
      prompt: vi.fn(async () => ({ stopReason: "end_turn" }))
    }
  } as unknown as SessionState;
}

function v1Deps(current: SessionState, admission?: PromptAdmission): PromptV1Deps {
  return {
    requireSession: () => current,
    applyConfigOption: async () => {},
    persistSession: async () => {},
    notifyCurrentModeUpdate: async () => {},
    notifyConfigOptionUpdateV1: async () => {},
    clientFileSystemV1: () => undefined,
    admission
  };
}

function v2Deps(current: SessionState, admission?: PromptAdmission): PromptV2Deps {
  return {
    requireSession: () => current,
    applyConfigOption: async () => {},
    persistSession: async () => {},
    notifyConfigOptionUpdateV2: async () => {},
    admission
  };
}

function fakeAdmission(observed: TurnKind[]): PromptAdmission {
  return {
    requestIdentity: negotiateRequestIdentityCapability(undefined),
    seam: {
      admit: async ({ claim }: { claim: TurnClaim }) => {
        observed.push(claim.kind);
        return "cancelled";
      }
    }
  } as unknown as PromptAdmission;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const stateDir of stateDirs.splice(0)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

describe("admission prompt seam", () => {
  it("keeps disabled prompt execution on the legacy backend path", async () => {
    vi.stubEnv("PASEO_AGENT_ID", "");
    vi.stubEnv("PASEO_HOME", "");
    const current = session("legacy");
    const client = { notify: async () => {} } as any;

    await expect(handlePromptV1({
      sessionId: current.sessionId,
      prompt: [{ type: "text", text: "legacy prompt" }]
    } as any, client, undefined, v1Deps(current))).resolves.toEqual({ stopReason: "end_turn" });

    expect(current.agy.prompt).toHaveBeenCalledTimes(1);
    expect((current.agy.prompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe("legacy prompt");
  });

  it("persists the Paseo-expanded backend prompt through an enabled seam", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "agy-acp-admission-paseo-"));
    const agentId = "agent-admission-prompt";
    const statePath = path.join(home, "agents", "workspace", `${agentId}.json`);
    mkdirSync(path.dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({
      persistence: { metadata: { daemonAppendSystemPrompt: "PASEO_SEAM_CONTEXT" } }
    }));
    vi.stubEnv("PASEO_HOME", home);
    vi.stubEnv("PASEO_AGENT_ID", agentId);
    const current = session("expanded-payload");
    const admitted: string[] = [];
    const admission: PromptAdmission = {
      requestIdentity: negotiateRequestIdentityCapability(undefined),
      seam: {
        admit: async ({ promptText }: { promptText: string }) => {
          admitted.push(promptText);
          return "cancelled";
        }
      }
    } as unknown as PromptAdmission;

    try {
      await expect(handlePromptV1({
        sessionId: current.sessionId,
        prompt: [{ type: "text", text: "business prompt" }]
      } as any, { notify: async () => {} } as any, undefined, v1Deps(current, admission))).resolves.toEqual({
        stopReason: "cancelled"
      });

      expect(admitted).toEqual([
        "[Paseo daemon system context]\nPASEO_SEAM_CONTEXT\n[/Paseo daemon system context]\n\nbusiness prompt"
      ]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("negotiates request identity only when an explicit seam is injected", async () => {
    const runtime = createRuntime();
    const seam = new AdmissionPromptSeam({
      runtime,
      agentId: "agent-a",
      requestIdentityKey: Buffer.alloc(32, 9),
      dispatch: async (): Promise<"cancelled"> => "cancelled"
    });
    const request = {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      _meta: {
        [ACP_REQUEST_IDENTITY_CAPABILITY_KEY]: {
          versions: [ACP_REQUEST_IDENTITY_CAPABILITY_VERSION],
          required: false
        }
      }
    };
    const requestV2 = {
      protocolVersion: acpV2.PROTOCOL_VERSION,
      clientCapabilities: {},
      _meta: request._meta
    };
    const installed = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);

    try {
      const enabled = new AcpAgent({
        admission: seam,
        stateDir: "/tmp/agy-acp-admission-seam-enabled",
        modelCacheEnabled: false
      });
      const legacy = new AcpAgent({
        stateDir: "/tmp/agy-acp-admission-seam-disabled",
        modelCacheEnabled: false
      });

      await expect(enabled.initializeV1(request as any)).resolves.toMatchObject({
        _meta: { [ACP_REQUEST_IDENTITY_CAPABILITY_KEY]: { version: 1, delivery: "recoverable" } }
      });
      await expect(legacy.initializeV1(request as any)).resolves.not.toHaveProperty("_meta");
      await expect(enabled.initializeV2(requestV2 as any)).resolves.toMatchObject({
        _meta: { [ACP_REQUEST_IDENTITY_CAPABILITY_KEY]: { version: 1, delivery: "recoverable" } }
      });
      await expect(legacy.initializeV2(requestV2 as any)).resolves.not.toHaveProperty("_meta");
      expect(installed).toHaveBeenCalledTimes(2);
    } finally {
      seam.close();
      runtime.close();
      vi.restoreAllMocks();
    }
  });

  it("keeps curated slash commands local when the seam is enabled", async () => {
    const current = session("slash-local");
    let admitted = 0;
    const admission: PromptAdmission = {
      requestIdentity: negotiateRequestIdentityCapability(undefined),
      seam: {
        admit: async () => {
          admitted += 1;
          return "cancelled";
        }
      }
    } as unknown as PromptAdmission;
    const deps = v1Deps(current, admission);
    deps.applyConfigOption = async (_sessionId, _configId, value) => {
      (current.agy.config as { mode: string }).mode = String(value);
    };

    await expect(handlePromptV1({
      sessionId: current.sessionId,
      prompt: [{ type: "text", text: "/plan" }]
    } as any, { notify: async () => {} } as any, undefined, deps)).resolves.toEqual({ stopReason: "end_turn" });

    expect(admitted).toBe(0);
    expect(current.agy.prompt).not.toHaveBeenCalled();
  });

  it("persists an immutable recoverable request, reports unacknowledged queue progress, and keeps plaintext out of the dispatch hook", async () => {
    const runtime = createRuntime();
    const requestIdentityKey = Buffer.alloc(32, 3);
    const progress = vi.fn();
    const acknowledged = vi.spyOn(runtime.controller, "acknowledgeDelivery");
    const dispatched: Array<Record<string, unknown>> = [];
    const seam = new AdmissionPromptSeam({
      runtime,
      agentId: "agent-a",
      requestIdentityKey,
      now: () => NOW,
      reportQueueProgress: progress,
      dispatch: async (input): Promise<"cancelled"> => {
        dispatched.push(input as unknown as Record<string, unknown>);
        expect(runtime.controller.readPayload(input.requestId, NOW)).toBe("sensitive business prompt");
        runtime.controller.cancelQueued(input.requestId, NOW + 1);
        return "cancelled";
      }
    });
    const selected = negotiateRequestIdentityCapability({
      versions: [ACP_REQUEST_IDENTITY_CAPABILITY_VERSION],
      required: false
    });
    const requestIdentity = validateRequestIdentityPromptMetadata(selected, {
      v: ACP_REQUEST_IDENTITY_CAPABILITY_VERSION,
      clientMessageId: "client-message-1"
    });

    try {
      await expect(seam.admit({
        sessionId: "session-a",
        model: "claude-opus-4-6-thinking",
        promptText: "sensitive business prompt",
        claim: new TurnClaim("foreground"),
        requestIdentity
      })).resolves.toBe("cancelled");

      const requestId = createRequestIdentity(requestIdentityKey, {
        agentId: "agent-a",
        acpSessionId: "session-a",
        clientMessageId: "client-message-1"
      });
      expect(runtime.controller.getRequest(requestId)).toMatchObject({
        requestId,
        sessionId: "session-a",
        parentId: "agent-a",
        state: "cancelled"
      });
      expect(progress).toHaveBeenCalledWith(expect.objectContaining({
        requestId,
        sessionId: "session-a",
        state: "queued",
        delivery: "unacknowledged"
      }));
      expect(acknowledged).not.toHaveBeenCalled();
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).not.toHaveProperty("promptText");
    } finally {
      seam.close();
      runtime.close();
    }
  });

  it("rejects legacy ephemeral identity before enqueue or dispatch", async () => {
    const runtime = createRuntime();
    const dispatch = vi.fn(async (): Promise<"cancelled"> => "cancelled");
    const seam = new AdmissionPromptSeam({
      runtime,
      agentId: "agent-a",
      requestIdentityKey: Buffer.alloc(32, 12),
      now: () => NOW,
      dispatch
    });

    try {
      await expect(seam.admit({
        sessionId: "session-ephemeral",
        model: "claude-opus-4-6-thinking",
        promptText: "must not be persisted",
        claim: new TurnClaim("foreground"),
        requestIdentity: { kind: "legacy_ephemeral" }
      })).rejects.toBeInstanceOf(AdmissionPromptIdentityRequiredError);
      expect(dispatch).not.toHaveBeenCalled();
      expect(runtime.controller.admitNext(NOW + 1, "owner-a")).toBeNull();
    } finally {
      seam.close();
      runtime.close();
    }
  });

  it("never dispatches a recoverable request again after its first terminal record", async () => {
    const runtime = createRuntime();
    const requestIdentityKey = Buffer.alloc(32, 4);
    const dispatch = vi.fn(async (input: { requestId: string }) => {
      runtime.controller.cancelQueued(input.requestId, NOW + 1);
      return "cancelled" as const;
    });
    const seam = new AdmissionPromptSeam({
      runtime,
      agentId: "agent-a",
      requestIdentityKey,
      now: () => NOW,
      dispatch
    });
    const selected = negotiateRequestIdentityCapability({
      versions: [ACP_REQUEST_IDENTITY_CAPABILITY_VERSION],
      required: false
    });
    const requestIdentity = validateRequestIdentityPromptMetadata(selected, {
      v: ACP_REQUEST_IDENTITY_CAPABILITY_VERSION,
      clientMessageId: "client-message-2"
    });

    try {
      await seam.admit({
        sessionId: "session-a",
        model: "claude-opus-4-6-thinking",
        promptText: "do this once",
        claim: new TurnClaim("foreground"),
        requestIdentity
      });

      await expect(seam.admit({
        sessionId: "session-a",
        model: "claude-opus-4-6-thinking",
        promptText: "do this once",
        claim: new TurnClaim("foreground"),
        requestIdentity
      })).rejects.toBeInstanceOf(AdmissionPromptReplayBlockedError);
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      seam.close();
      runtime.close();
    }
  });

  it("never replays a request whose first dispatch became ambiguous", async () => {
    const runtime = createRuntime();
    const requestIdentityKey = Buffer.alloc(32, 5);
    const dispatch = vi.fn(async (input: { requestId: string }) => {
      const lease = runtime.controller.admitNext(NOW + 1, "connector-a");
      expect(lease?.requestId).toBe(input.requestId);
      runtime.controller.markStarting(lease!, NOW + 2);
      runtime.controller.markDispatchIntent(lease!, NOW + 3);
      runtime.controller.markDispatchAmbiguous(lease!, NOW + 4);
      return "end_turn" as const;
    });
    const seam = new AdmissionPromptSeam({
      runtime,
      agentId: "agent-a",
      requestIdentityKey,
      now: () => NOW,
      dispatch
    });
    const selected = negotiateRequestIdentityCapability({
      versions: [ACP_REQUEST_IDENTITY_CAPABILITY_VERSION],
      required: false
    });
    const requestIdentity = validateRequestIdentityPromptMetadata(selected, {
      v: ACP_REQUEST_IDENTITY_CAPABILITY_VERSION,
      clientMessageId: "client-message-3"
    });
    const input = {
      sessionId: "session-a",
      model: "claude-opus-4-6-thinking",
      promptText: "never replay this ambiguous request",
      requestIdentity
    };

    try {
      await expect(seam.admit({ ...input, claim: new TurnClaim("foreground") })).rejects.toBeInstanceOf(
        AdmissionPromptDispatchIncompleteError
      );
      await expect(seam.admit({ ...input, claim: new TurnClaim("foreground") })).rejects.toBeInstanceOf(
        AdmissionPromptReplayBlockedError
      );
      expect(dispatch).toHaveBeenCalledTimes(1);
    } finally {
      seam.close();
      runtime.close();
    }
  });

  it("enters the seam after local TurnClaim acquisition for v1 and v2 foreground, queued, and steer turns", async () => {
    const observed: TurnKind[] = [];
    const clientV1 = { notify: async () => {} } as any;
    const clientV2 = { notify: async () => {} } as any;

    const v1Foreground = session("v1-foreground");
    await handlePromptV1({
      sessionId: v1Foreground.sessionId,
      prompt: [{ type: "text", text: "foreground" }]
    } as any, clientV1, undefined, v1Deps(v1Foreground, fakeAdmission(observed)));

    const v1Queued = session("v1-queued");
    const v1QueuedTurns = turnsOf(v1Queued);
    const v1QueuedHeld = v1QueuedTurns.claimIdle("foreground");
    const queuedV1 = handlePromptV1({
      sessionId: v1Queued.sessionId,
      prompt: [{ type: "text", text: "queued" }],
      _meta: { "agy-acp/turnIntent": "queue" }
    } as any, clientV1, undefined, v1Deps(v1Queued, fakeAdmission(observed)));
    v1QueuedTurns.release(v1QueuedHeld);
    notifyIdleAndDrainQueue(v1Queued);
    await queuedV1;

    const v1Steer = session("v1-steer");
    const v1SteerTurns = turnsOf(v1Steer);
    const v1SteerHeld = v1SteerTurns.claimIdle("foreground");
    v1Steer.agy.cancel = async () => v1SteerTurns.release(v1SteerHeld);
    await handlePromptV1({
      sessionId: v1Steer.sessionId,
      prompt: [{ type: "text", text: "steer" }],
      _meta: { "agy-acp/turnIntent": "steer" }
    } as any, clientV1, undefined, v1Deps(v1Steer, fakeAdmission(observed)));

    const v2Foreground = session("v2-foreground");
    await handlePromptV2({
      sessionId: v2Foreground.sessionId,
      prompt: [{ type: "text", text: "foreground" }]
    } as any, clientV2, v2Deps(v2Foreground, fakeAdmission(observed)));
    await waitFor(() => observed.includes("foreground"));
    await waitFor(() => observed.filter((kind) => kind === "foreground").length === 2);

    const v2Queued = session("v2-queued");
    const v2QueuedTurns = turnsOf(v2Queued);
    const v2QueuedHeld = v2QueuedTurns.claimIdle("foreground");
    await handlePromptV2({
      sessionId: v2Queued.sessionId,
      prompt: [{ type: "text", text: "queued" }],
      _meta: { "agy-acp/turnIntent": "queue" }
    } as any, clientV2, v2Deps(v2Queued, fakeAdmission(observed)));
    v2QueuedTurns.release(v2QueuedHeld);
    notifyIdleAndDrainQueue(v2Queued);
    await waitFor(() => observed.filter((kind) => kind === "queued").length === 2);

    const v2Steer = session("v2-steer");
    const v2SteerTurns = turnsOf(v2Steer);
    const v2SteerHeld = v2SteerTurns.claimIdle("foreground");
    v2Steer.agy.cancel = async () => v2SteerTurns.release(v2SteerHeld);
    await handlePromptV2({
      sessionId: v2Steer.sessionId,
      prompt: [{ type: "text", text: "steer" }],
      _meta: { "agy-acp/turnIntent": "steer" }
    } as any, clientV2, v2Deps(v2Steer, fakeAdmission(observed)));
    await waitFor(() => observed.filter((kind) => kind === "steer").length === 2);

    expect(observed).toEqual([
      "foreground",
      "queued",
      "steer",
      "foreground",
      "queued",
      "steer"
    ]);
    for (const current of [v1Foreground, v1Queued, v1Steer, v2Foreground, v2Queued, v2Steer]) {
      expect(current.agy.prompt).not.toHaveBeenCalled();
    }
  });
});
