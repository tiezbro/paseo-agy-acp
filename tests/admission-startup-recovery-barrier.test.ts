import { describe, expect, it, vi } from "vitest";
import {
  StartupRecoveryBarrier,
  StartupRecoveryBarrierConfigurationError,
  type StartupRecoveryBarrierSources,
  type StartupRecoveryProcessInventory
} from "../src/admission/startup-recovery-barrier.js";
import type { RecoverableDispatch, DeliveryClaimLease } from "../src/admission/controller.js";
import type { ActiveSessionRecord } from "../src/agy/acp/session/active-registry.js";
import type { RecoverableStartupPermit } from "../src/admission/sqlite-startup-launcher.js";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER_ID = "22222222-2222-4222-8222-222222222222";
const BOOT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SECOND_PERMIT_ID = "33333333-3333-4333-8333-333333333333";

describe("StartupRecoveryBarrier", () => {
  it("becomes ready only after every payload-free inventory and the Linux residue scan are empty", async () => {
    const sources = sourceFixture();
    const barrier = new StartupRecoveryBarrier(sources);

    await expect(barrier.waitUntilReady()).resolves.toEqual({
      status: "ready",
      counts: {
        dispatches: 0,
        activeSessions: 0,
        outboxClaims: 0,
        startupPermits: 0,
        processObservations: 0
      },
      issues: []
    });
    expect(sources.listRecoverableDispatches).toHaveBeenCalledTimes(1);
    expect(sources.listActiveSessions).toHaveBeenCalledTimes(1);
    expect(sources.listRecoverableOutboxClaims).toHaveBeenCalledTimes(1);
    expect(sources.listRecoverablePermits).toHaveBeenCalledTimes(1);
    expect(sources.inspectProcessResidue).toHaveBeenCalledWith([]);
  });

  it("blocks a fully consistent in-flight turn without reclaiming or replaying it", async () => {
    const dispatch = recoverableDispatch();
    const activeSession = activeSessionRecord();
    const sources = sourceFixture({
      dispatches: [dispatch],
      activeSessions: [activeSession],
      processInventory: {
        observations: [processObservation()],
        untrackedResidue: "empty"
      }
    });
    const barrier = new StartupRecoveryBarrier(sources);

    await expect(barrier.waitUntilReady()).resolves.toEqual({
      status: "blocked",
      reason: "recovery_pending",
      counts: {
        dispatches: 1,
        activeSessions: 1,
        outboxClaims: 0,
        startupPermits: 0,
        processObservations: 1
      },
      issues: ["recoverable_dispatch_pending", "active_session_pending"]
    });
    expect(sources.inspectProcessResidue).toHaveBeenCalledWith([
      {
        requestId: dispatch.requestId,
        fence: dispatch.fence,
        processIdentity: dispatch.processIdentity
      }
    ]);
    expect(Object.keys(sources)).toEqual([
      "listRecoverableDispatches",
      "listActiveSessions",
      "listRecoverableOutboxClaims",
      "listRecoverablePermits",
      "inspectProcessResidue"
    ]);
  });

  it("blocks controller-owned outbox claims without reading or replaying their encrypted payload", async () => {
    const claim = outboxClaim();
    const sources = sourceFixture({ outboxClaims: [claim] });
    const barrier = new StartupRecoveryBarrier(sources);

    await expect(barrier.waitUntilReady()).resolves.toEqual({
      status: "blocked",
      reason: "recovery_pending",
      counts: {
        dispatches: 0,
        activeSessions: 0,
        outboxClaims: 1,
        startupPermits: 0,
        processObservations: 0
      },
      issues: ["outbox_claim_pending"]
    });
  });

  it("blocks each expired auxiliary or resident PTY permit without TTL recovery or release authority", async () => {
    for (const [classification, permitId] of [
      ["auxiliary", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      ["resident_pty", SECOND_PERMIT_ID]
    ] as const) {
      const permit = startupPermit({ classification, permitId, heartbeatExpired: true });
      const sources = sourceFixture({ startupPermits: [permit] });

      await expect(new StartupRecoveryBarrier(sources).waitUntilReady()).resolves.toEqual({
        status: "blocked",
        reason: "recovery_pending",
        counts: {
          dispatches: 0,
          activeSessions: 0,
          outboxClaims: 0,
          startupPermits: 1,
          processObservations: 0
        },
        issues: ["startup_permit_pending"]
      });
      expect(sources.listRecoverablePermits).toHaveBeenCalledTimes(1);
      expect(sources.inspectProcessResidue).toHaveBeenCalledWith([]);
    }
  });

  it("adds an expressible permit process identity to the Linux scanner under its exact owner fence", async () => {
    const permit = startupPermit({ processIdentity: permitProcessIdentity() });
    const sources = sourceFixture({
      startupPermits: [permit],
      processInventory: {
        observations: [permitProcessObservation(permit)],
        untrackedResidue: "empty"
      }
    });

    await expect(new StartupRecoveryBarrier(sources).waitUntilReady()).resolves.toMatchObject({
      status: "blocked",
      reason: "recovery_pending",
      counts: { startupPermits: 1, processObservations: 1 },
      issues: ["startup_permit_pending"]
    });
    expect(sources.inspectProcessResidue).toHaveBeenCalledWith([{
      requestId: `startup-permit:${permit.classification}:${permit.permitId}`,
      fence: {
        leaseId: permit.permitId,
        generation: permit.generation,
        ownerInstanceId: permit.ownerInstanceId
      },
      processIdentity: permit.processIdentity
    }]);
  });

  it("fails closed when an inventory is unavailable and never exposes the thrown payload", async () => {
    const secret = "Authorization: Bearer private-token and business prompt";
    const sources = sourceFixture();
    sources.listRecoverableDispatches.mockRejectedValue(new Error(secret));
    const barrier = new StartupRecoveryBarrier(sources);

    const result = await barrier.waitUntilReady();
    expect(result).toEqual({
      status: "blocked",
      reason: "inventory_unavailable",
      counts: {
        dispatches: null,
        activeSessions: 0,
        outboxClaims: 0,
        startupPermits: 0,
        processObservations: null
      },
      issues: ["dispatch_inventory_unavailable"]
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(sources.inspectProcessResidue).not.toHaveBeenCalled();
  });

  it("fails closed when the startup permit inventory is unavailable or has an invalid payload-free shape", async () => {
    const secret = "Authorization: Bearer permit inventory must not leak";
    const unavailable = sourceFixture();
    unavailable.listRecoverablePermits.mockRejectedValue(new Error(secret));

    const unavailableResult = await new StartupRecoveryBarrier(unavailable).waitUntilReady();
    expect(unavailableResult).toEqual({
      status: "blocked",
      reason: "inventory_unavailable",
      counts: {
        dispatches: 0,
        activeSessions: 0,
        outboxClaims: 0,
        startupPermits: null,
        processObservations: null
      },
      issues: ["startup_permit_inventory_unavailable"]
    });
    expect(JSON.stringify(unavailableResult)).not.toContain(secret);

    const malformed = sourceFixture({
      startupPermits: [Object.assign(startupPermit(), { payload: secret }) as RecoverableStartupPermit]
    });
    const malformedResult = await new StartupRecoveryBarrier(malformed).waitUntilReady();
    expect(malformedResult).toEqual({
      status: "blocked",
      reason: "inventory_invalid",
      counts: {
        dispatches: 0,
        activeSessions: 0,
        outboxClaims: 0,
        startupPermits: null,
        processObservations: null
      },
      issues: ["startup_permit_inventory_invalid"]
    });
    expect(JSON.stringify(malformedResult)).not.toContain(secret);
    expect(malformed.inspectProcessResidue).not.toHaveBeenCalled();
  });

  it("fails the full permit batch closed for duplicate classification or permit IDs and owner-fence mismatches", async () => {
    const duplicateBatches: readonly (readonly RecoverableStartupPermit[])[] = [
      [startupPermit(), startupPermit({ permitId: SECOND_PERMIT_ID })],
      [startupPermit(), startupPermit({ classification: "resident_pty" })]
    ];
    for (const startupPermits of duplicateBatches) {
      const sources = sourceFixture({ startupPermits });
      const result = await new StartupRecoveryBarrier(sources).waitUntilReady();
      expect(result).toMatchObject({
        status: "blocked",
        reason: "inventory_inconsistent",
        issues: ["duplicate_startup_permit"]
      });
      expect(sources.inspectProcessResidue).not.toHaveBeenCalled();
    }

    const ownerMismatch = sourceFixture({
      startupPermits: [startupPermit({
        processIdentity: permitProcessIdentity({ ownerInstanceId: OTHER_OWNER_ID })
      })]
    });
    const mismatchResult = await new StartupRecoveryBarrier(ownerMismatch).waitUntilReady();
    expect(mismatchResult).toMatchObject({
      status: "blocked",
      reason: "inventory_inconsistent",
      issues: ["startup_permit_owner_fence_mismatch"]
    });
    expect(ownerMismatch.inspectProcessResidue).not.toHaveBeenCalled();
  });

  it("rejects extra fields before a caller can smuggle payload data through an inventory", async () => {
    const secret = "raw business prompt must never enter readiness output";
    const sources = sourceFixture({
      dispatches: [Object.assign({}, recoverableDispatch(), { payload: secret }) as RecoverableDispatch]
    });
    const barrier = new StartupRecoveryBarrier(sources);

    const result = await barrier.waitUntilReady();
    expect(result).toEqual({
      status: "blocked",
      reason: "inventory_invalid",
      counts: {
        dispatches: null,
        activeSessions: 0,
        outboxClaims: 0,
        startupPermits: 0,
        processObservations: null
      },
      issues: ["dispatch_inventory_invalid"]
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(sources.inspectProcessResidue).not.toHaveBeenCalled();
  });

  it("detects cross-store session, lease-generation, and connector mismatches", async () => {
    const mismatches: ActiveSessionRecord[] = [
      activeSessionRecord({ sessionId: "wrong-session" }),
      activeSessionRecord({ leaseGeneration: 8 }),
      activeSessionRecord({
        connectorIdentity: { ...activeSessionRecord().connectorIdentity, pid: 999 }
      })
    ];

    for (const activeSession of mismatches) {
      const sources = sourceFixture({
        dispatches: [recoverableDispatch()],
        activeSessions: [activeSession],
        processInventory: { observations: [processObservation()], untrackedResidue: "empty" }
      });
      const result = await new StartupRecoveryBarrier(sources).waitUntilReady();
      expect(result).toMatchObject({ status: "blocked", reason: "inventory_inconsistent" });
      expect(result.issues).toContain("active_session_dispatch_mismatch");
      expect(sources.inspectProcessResidue).not.toHaveBeenCalled();
    }
  });

  it("requires exact process observations and independently blocks untracked residue", async () => {
    const missingProof = sourceFixture({
      dispatches: [{ ...recoverableDispatch(), phase: "dispatch_intent" }]
    });
    const missingResult = await new StartupRecoveryBarrier(missingProof).waitUntilReady();
    expect(missingResult).toMatchObject({
      status: "blocked",
      reason: "inventory_inconsistent",
      issues: ["process_observation_missing"]
    });

    const untracked = sourceFixture({
      processInventory: { observations: [], untrackedResidue: "present" }
    });
    const untrackedResult = await new StartupRecoveryBarrier(untracked).waitUntilReady();
    expect(untrackedResult).toMatchObject({
      status: "blocked",
      reason: "process_residue_present",
      issues: ["untracked_process_residue"]
    });

    const unverifiable = sourceFixture({
      processInventory: { observations: [], untrackedResidue: "unverifiable" }
    });
    const unverifiableResult = await new StartupRecoveryBarrier(unverifiable).waitUntilReady();
    expect(unverifiableResult).toMatchObject({
      status: "blocked",
      reason: "process_evidence_unavailable",
      issues: ["untracked_process_residue_unverifiable"]
    });
  });

  it("sanitizes Linux inspection failures and never treats a missing proof source as ready", async () => {
    const secret = "process diagnostic accidentally contains Authorization and prompt text";
    const sources = sourceFixture();
    sources.inspectProcessResidue.mockRejectedValue(new Error(secret));

    const result = await new StartupRecoveryBarrier(sources).waitUntilReady();
    expect(result).toEqual({
      status: "blocked",
      reason: "process_evidence_unavailable",
      counts: {
        dispatches: 0,
        activeSessions: 0,
        outboxClaims: 0,
        startupPermits: 0,
        processObservations: null
      },
      issues: ["process_inventory_unavailable"]
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("caches one asynchronous decision so concurrent callers cannot duplicate recovery scans", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sources = sourceFixture();
    sources.listRecoverableDispatches.mockImplementation(async () => {
      await blocked;
      return [];
    });
    const barrier = new StartupRecoveryBarrier(sources);

    const first = barrier.waitUntilReady();
    const second = barrier.waitUntilReady();
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: "ready" }),
      expect.objectContaining({ status: "ready" })
    ]);
    expect(sources.listRecoverableDispatches).toHaveBeenCalledTimes(1);
    expect(sources.inspectProcessResidue).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing permit inventory or non-allowlisted source capabilities with a constant non-sensitive configuration error", () => {
    const secret = "private prompt accidentally used as a property";
    expect(() => new StartupRecoveryBarrier({
      listRecoverableDispatches: () => [],
      listActiveSessions: () => [],
      listRecoverableOutboxClaims: () => [],
      inspectProcessResidue: () => ({ observations: [], untrackedResidue: "empty" })
    })).toThrow(StartupRecoveryBarrierConfigurationError);
    expect(() => new StartupRecoveryBarrier({ [secret]: () => [] } as never)).toThrow(
      StartupRecoveryBarrierConfigurationError
    );
    try {
      new StartupRecoveryBarrier({ [secret]: () => [] } as never);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

interface SourceFixtureOptions {
  readonly dispatches?: readonly RecoverableDispatch[];
  readonly activeSessions?: readonly ActiveSessionRecord[];
  readonly outboxClaims?: readonly DeliveryClaimLease[];
  readonly startupPermits?: readonly RecoverableStartupPermit[];
  readonly processInventory?: StartupRecoveryProcessInventory;
}

function sourceFixture(options: SourceFixtureOptions = {}): {
  [K in keyof StartupRecoveryBarrierSources]: ReturnType<typeof vi.fn>;
} & { listRecoverablePermits: ReturnType<typeof vi.fn> } {
  return {
    listRecoverableDispatches: vi.fn(async () => options.dispatches ?? []),
    listActiveSessions: vi.fn(async () => options.activeSessions ?? []),
    listRecoverableOutboxClaims: vi.fn(async () => options.outboxClaims ?? []),
    listRecoverablePermits: vi.fn(async () => options.startupPermits ?? []),
    inspectProcessResidue: vi.fn(async () => options.processInventory ?? {
      observations: [],
      untrackedResidue: "empty"
    })
  };
}

function recoverableDispatch(): RecoverableDispatch {
  return {
    requestId: "request-1",
    sessionId: "session-1",
    provider: "antigravity",
    model: "claude-opus-4-6-thinking",
    fence: { leaseId: "lease-1", generation: 7, ownerInstanceId: OWNER_ID },
    phase: "active",
    heartbeatAt: 1_000,
    processIdentity: {
      promptChannel: "stdin",
      connector: connectorIdentity(),
      child: {
        bootId: BOOT_ID,
        pid: 501,
        startTimeTicks: "1001",
        pidNamespaceInode: 4026531836,
        ppid: 500,
        pgrp: 501,
        session: 500
      }
    }
  };
}

function activeSessionRecord(overrides: Partial<ActiveSessionRecord> = {}): ActiveSessionRecord {
  return {
    agentId: "agent-1",
    sessionId: "session-1",
    requestId: "request-1",
    conversationId: "conversation-1",
    cursor: 9,
    connectorIdentity: connectorIdentity(),
    leaseGeneration: 7,
    terminalState: null,
    ...overrides
  };
}

function connectorIdentity() {
  return {
    ownerInstanceId: OWNER_ID,
    createdAt: "2026-08-10T00:00:00.000Z",
    bootId: BOOT_ID,
    pid: 500,
    startTimeTicks: "1000",
    pidNamespaceInode: 4026531836,
    ppid: 1,
    pgrp: 500,
    session: 500
  };
}

function processObservation() {
  return {
    requestId: "request-1",
    leaseId: "lease-1",
    generation: 7,
    ownerInstanceId: OWNER_ID,
    connector: "same" as const,
    child: "same" as const,
    residue: "present" as const
  };
}

function outboxClaim(): DeliveryClaimLease {
  return {
    eventId: "event-1",
    requestId: "request-terminal",
    ownerInstanceId: OWNER_ID,
    claimGeneration: 2,
    state: "claimed",
    heartbeatAt: 1_000,
    leaseExpiresAt: 31_000,
    terminalReplayCount: 0
  };
}

type StartupPermitFixture = RecoverableStartupPermit & {
  readonly processIdentity?: unknown;
};

function startupPermit(overrides: Partial<StartupPermitFixture> = {}): StartupPermitFixture {
  return {
    classification: "auxiliary",
    permitId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ownerInstanceId: OWNER_ID,
    generation: 3,
    acquiredAt: 1_000,
    heartbeatAt: 1_000,
    heartbeatExpired: false,
    ...overrides
  };
}

function permitProcessIdentity(overrides: Partial<ReturnType<typeof connectorIdentity>> = {}) {
  return {
    connector: { ...connectorIdentity(), ...overrides },
    child: { ...recoverableDispatch().processIdentity!.child }
  };
}

function permitProcessObservation(permit: StartupPermitFixture) {
  return {
    requestId: `startup-permit:${permit.classification}:${permit.permitId}`,
    leaseId: permit.permitId,
    generation: permit.generation,
    ownerInstanceId: permit.ownerInstanceId,
    connector: "gone" as const,
    child: "gone" as const,
    residue: "empty" as const
  };
}
