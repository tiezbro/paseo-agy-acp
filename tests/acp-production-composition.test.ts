import { describe, expect, it, vi } from "vitest";
import {
  ACP_OUTBOX_CAPABILITY_KEY,
  ACP_OUTBOX_CAPABILITY_VERSION
} from "../ACP Connector/admission/outbox-protocol.js";
import { ACP_REQUEST_IDENTITY_CAPABILITY_KEY } from "../ACP Connector/admission/request-identity-protocol.js";
import {
  AcpProductionCompositionError,
  composeAcpProductionRuntime,
  type AcpProductionCompositionDependencies,
  type AcpProductionCompositionFactories
} from "../ACP Connector/acp/production-composition.js";
import type {
  StartupRecoveryBarrierSources,
  StartupRecoveryReadiness
} from "../Admission Controller/startup-recovery-barrier.js";

interface ProcessIdentity {
  readonly pid: number;
}

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const BOOT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const SECRET = "business prompt Authorization: Bearer private-token";

describe("ACP production composition", () => {
  it("assembles the complete fake graph only after ACK negotiation and readiness, without dispatching", async () => {
    const rig = createRig();

    const result = await composeAcpProductionRuntime(rig.dependencies);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error("expected ready composition");
    expect(result.runtime.sessionStore).toBe(rig.components.sessionStore);
    expect(result.runtime.activeSessions).toBe(rig.components.activeSessions);
    expect(result.runtime.startupLauncher).toBe(rig.components.startupLauncher);
    expect(result.runtime.clientRoutes).toBe(rig.components.clientRoutes);
    expect(result.runtime.recoveryCoordinator).toBe(rig.components.recoveryCoordinator);
    expect(result.runtime.outboxBridge).toBe(rig.components.outboxBridge);
    expect(result.runtime.protocolCapabilities.requestIdentity.status).toBe("selected");
    expect(result.runtime.protocolCapabilities.outbox.status).toBe("selected");
    expect(rig.calls.dispatch).toHaveLength(0);
    expect(rig.calls.admit).toHaveLength(0);
    expect(rig.calls.outboxSender).toHaveLength(0);
    expect(rig.calls.pump).toHaveLength(0);
    expect(rig.calls.acknowledgementHandlers).toHaveLength(1);
    expect(rig.calls.barrierSources).toHaveLength(1);
    expect(rig.calls.adapterOptions[0]).toMatchObject({
      agentId: "agent-production",
      connectorIdentity: { ownerInstanceId: OWNER_ID }
    });
    expect(rig.calls.dispatcherOptions[0]).toMatchObject({
      ownerInstanceId: OWNER_ID,
      startupLauncher: rig.components.startupLauncher,
      agy: rig.components.adapter,
      provider: rig.components.adapter
    });
    expect(rig.calls.startupLauncherOptions[0]).toEqual({
      databasePath: rig.dependencies.databasePath,
      ownerInstanceId: OWNER_ID,
      now: rig.dependencies.now
    });
    const barrierSources = rig.calls.barrierSources[0] as StartupRecoveryBarrierSources;
    expect(await barrierSources.listRecoverablePermits()).toBe(rig.components.startupPermits);
    expect(rig.calls.startupPermitInventories).toEqual(["list"]);
    expect(rig.calls.outboxOptions[0]).toMatchObject({
      admission: rig.controller,
      ownerInstanceId: OWNER_ID,
      sender: rig.dependencies.clientRoute.outboxSender
    });

    result.runtime.bindClientRoute("session-1", () => undefined);
    expect(rig.calls.routeBindings).toEqual([{
      sessionId: "session-1",
      protocol: "v1",
      connectionFence: "connection-production",
      sender: expect.any(Function)
    }]);

    await result.runtime.close();
    await result.runtime.close();
    expect(rig.closeOrder).toEqual([
      "ack-route",
      "dispatcher",
      "startup-launcher",
      "adapter",
      "pump",
      "outbox",
      "routes",
      "recovery",
      "active-sessions",
      "session-store",
      "runtime"
    ]);
  });

  it("fails closed for every required missing capability before constructing a dispatch graph", async () => {
    const required: ReadonlyArray<keyof AcpProductionCompositionDependencies<ProcessIdentity>> = [
      "runtime",
      "databasePath",
      "agentId",
      "ownerIdentity",
      "sessionLookup",
      "requestMetadata",
      "businessPrompts",
      "sqliteSnapshots",
      "captureProcessIdentity",
      "createTerminalDelivery",
      "lifecycle",
      "dispatcherRecovery",
      "clientRoute",
      "startupRecovery"
    ];

    for (const key of required) {
      const rig = createRig();
      const candidate = { ...rig.dependencies } as Record<string, unknown>;
      delete candidate[key];

      const result = await composeAcpProductionRuntime(candidate as never);

      expect(result).toEqual({ status: "blocked", reason: "missing_dependency" });
      expect(rig.calls.adapterOptions).toHaveLength(0);
      expect(rig.calls.dispatch).toHaveLength(0);
      expect(rig.calls.outboxSender).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  it("fails closed when the owned startup launcher is missing or invalid", async () => {
    const missing = createRig();
    const missingResult = await composeAcpProductionRuntime({
      ...missing.dependencies,
      factories: {
        ...missing.dependencies.factories!,
        createStartupLauncher: () => undefined as never
      }
    });
    expect(missingResult).toEqual({ status: "blocked", reason: "construction_failed" });
    expect(missing.calls.dispatcherOptions).toHaveLength(0);
    expect(missing.calls.adapterOptions).toHaveLength(0);

    const invalid = createRig();
    const invalidResult = await composeAcpProductionRuntime({
      ...invalid.dependencies,
      factories: {
        ...invalid.dependencies.factories!,
        createStartupLauncher: () => ({
          enabled: false,
          acquire: () => ({ release: () => {} }),
          listRecoverablePermits: () => [],
          close: () => {}
        }) as never
      }
    });
    expect(invalidResult).toEqual({ status: "blocked", reason: "construction_failed" });
    expect(invalid.calls.dispatcherOptions).toHaveLength(0);
    expect(invalid.calls.adapterOptions).toHaveLength(0);

    for (const result of [missingResult, invalidResult]) {
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  it("withholds a runtime when request identity, ACK, or fresh-PTY authentication is absent", async () => {
    const identity = createRig();
    const identityResult = await composeAcpProductionRuntime({
      ...identity.dependencies,
      initializationMeta: {
        [ACP_OUTBOX_CAPABILITY_KEY]: outboxOffer()
      }
    });
    expect(identityResult).toEqual({ status: "blocked", reason: "request_identity_not_negotiated" });

    const ack = createRig();
    const ackResult = await composeAcpProductionRuntime({
      ...ack.dependencies,
      initializationMeta: {
        [ACP_REQUEST_IDENTITY_CAPABILITY_KEY]: requestIdentityOffer()
      }
    });
    expect(ackResult).toEqual({ status: "blocked", reason: "ack_not_negotiated" });

    const pty = createRig();
    const ptyResult = await composeAcpProductionRuntime({
      ...pty.dependencies,
      freshPtyCanary: undefined as never
    });
    expect(ptyResult).toEqual({ status: "blocked", reason: "fresh_pty_not_authenticated" });

    for (const result of [identityResult, ackResult, ptyResult]) {
      expect("runtime" in result).toBe(false);
      expect(JSON.stringify(result)).not.toContain(SECRET);
    }
  });

  it("does not expose or dispatch a runtime while startup recovery is blocked", async () => {
    const rig = createRig({
      readiness: Object.freeze({
        status: "blocked" as const,
        reason: "recovery_pending" as const,
        counts: {
          dispatches: 1,
          activeSessions: 0,
          outboxClaims: 0,
          startupPermits: 0,
          processObservations: 0
        },
        issues: ["recoverable_dispatch_pending"] as const
      })
    });

    const result = await composeAcpProductionRuntime(rig.dependencies);

    expect(result).toEqual({ status: "blocked", reason: "startup_recovery_blocked" });
    expect(rig.calls.dispatch).toHaveLength(0);
    expect(rig.calls.admit).toHaveLength(0);
    expect(rig.calls.outboxSender).toHaveLength(0);
    expect(rig.calls.pump).toHaveLength(0);
    expect(rig.closeOrder).toEqual([
      "dispatcher",
      "startup-launcher",
      "adapter",
      "pump",
      "outbox",
      "routes",
      "recovery",
      "active-sessions",
      "session-store",
      "runtime"
    ]);
  });

  it("does not call the dispatcher or the pump before an asynchronous barrier becomes ready", async () => {
    let release!: (value: StartupRecoveryReadiness) => void;
    const waiting = new Promise<StartupRecoveryReadiness>((resolve) => {
      release = resolve;
    });
    const rig = createRig({ readiness: waiting });

    const composition = composeAcpProductionRuntime(rig.dependencies);
    await Promise.resolve();

    expect(rig.calls.dispatch).toHaveLength(0);
    expect(rig.calls.admit).toHaveLength(0);
    expect(rig.calls.pump).toHaveLength(0);
    expect(rig.calls.outboxSender).toHaveLength(0);
    expect(rig.calls.acknowledgementHandlers).toHaveLength(0);

    release(ready());
    const result = await composition;
    expect(result.status).toBe("ready");
    if (result.status === "ready") await result.runtime.close();
  });

  it("continues closing after a failure, seals dispatch, and reports only a fixed error", async () => {
    const rig = createRig({ closeFailures: new Set(["adapter"]) });
    const result = await composeAcpProductionRuntime(rig.dependencies);
    if (result.status !== "ready") throw new Error("expected ready composition");

    await expect(result.runtime.close()).rejects.toMatchObject({ code: "close_failed" });
    expect(rig.closeOrder).toEqual([
      "ack-route",
      "dispatcher",
      "startup-launcher",
      "adapter",
      "pump",
      "outbox",
      "routes",
      "recovery",
      "active-sessions",
      "session-store",
      "runtime"
    ]);
    await expect(result.runtime.pumpOutbox(1_000)).rejects.toMatchObject({ code: "runtime_closed" });
    expect(rig.calls.pump).toHaveLength(0);

    try {
      await result.runtime.close();
    } catch (error) {
      expect(error).toBeInstanceOf(AcpProductionCompositionError);
      expect(String(error)).not.toContain(SECRET);
    }
  });
});

interface RigOptions {
  readonly readiness?: StartupRecoveryReadiness | Promise<StartupRecoveryReadiness>;
  readonly closeFailures?: ReadonlySet<string>;
}

function createRig(options: RigOptions = {}) {
  const closeOrder: string[] = [];
  const calls = {
    adapterOptions: [] as unknown[],
    startupLauncherOptions: [] as unknown[],
    dispatcherOptions: [] as unknown[],
    outboxOptions: [] as unknown[],
    barrierSources: [] as unknown[],
    routeBindings: [] as unknown[],
    dispatch: [] as unknown[],
    admit: [] as unknown[],
    outboxSender: [] as unknown[],
    acknowledgementHandlers: [] as unknown[],
    startupPermitInventories: [] as string[],
    pump: [] as unknown[]
  };
  const close = (name: string) => () => {
    closeOrder.push(name);
    if (options.closeFailures?.has(name)) throw new Error(`${SECRET}: ${name}`);
  };
  const controller = fakeController();
  const startupPermits = Object.freeze([]);
  const components = {
    startupPermits,
    startupLauncher: {
      enabled: true,
      acquire: () => ({ release: () => {} }),
      listRecoverablePermits: () => {
        calls.startupPermitInventories.push("list");
        return startupPermits;
      },
      close: close("startup-launcher")
    },
    sessionStore: {
      restore: async () => null,
      list: async () => [],
      persist: async () => {},
      delete: async () => false,
      close: close("session-store")
    },
    activeSessions: {
      register: () => ({ requestId: "request-1", ownerInstanceId: OWNER_ID, leaseGeneration: 1 }),
      advance: () => {},
      markTerminal: () => {},
      archiveTerminal: () => false,
      listInFlight: () => [],
      close: close("active-sessions")
    },
    adapter: {
      spawnPromptFree: () => {
        throw new Error("composition must not start a provider turn");
      },
      observeProviderActivity: async () => ({ status: "observed" as const }),
      observeTerminal: async () => {
        throw new Error("composition must not observe a provider terminal");
      },
      discardPromptFree: () => {},
      close: close("adapter")
    },
    recoveryCoordinator: {
      observeHeartbeat: () => ({ outcome: "current" as const }),
      recoverPreDispatch: async () => ({ outcome: "recovery_required" as const, reason: "closed" as const }),
      close: close("recovery")
    },
    outboxBridge: {
      active: true,
      acknowledge: () => {},
      drainNextPendingDelivery: async () => null,
      sweepExpiredDeliveryClaims: () => [],
      close: close("outbox")
    },
    outboxPump: {
      poke: async () => {
        calls.pump.push("poke");
        return { status: "idle" as const, attempted: 0, swept: [], deliveries: [] };
      },
      drain: async () => ({ status: "idle" as const, attempted: 0, swept: [], deliveries: [] }),
      close: close("pump")
    },
    clientRoutes: {
      bind: (binding: unknown) => {
        calls.routeBindings.push(binding);
        return { send: async () => {} };
      },
      resolve: () => ({ send: async () => {} }),
      unbind: () => true,
      close: close("routes")
    }
  };
  const dispatcher = {
    dispatch: async (input: unknown) => {
      calls.dispatch.push(input);
      return "end_turn" as const;
    },
    close: close("dispatcher")
  };
  const admission = {
    admit: async (input: unknown) => {
      calls.admit.push(input);
      return "end_turn" as const;
    },
    close: () => {}
  };
  const runtime = {
    controller,
    createPromptDispatcher: (input: unknown) => {
      calls.dispatcherOptions.push(input);
      return dispatcher;
    },
    createPromptSeam: () => admission,
    createDeliveryBridge: (factory: (context: unknown) => unknown) => factory({
      createEventIdentity: () => "event-identity"
    }),
    createRecoveryBridge: (factory: (context: unknown) => unknown) => factory({
      createPreDispatchProofAuthority: () => ({ verifyPreDispatchProof: () => null, close: () => {} })
    }),
    close: close("runtime")
  };
  const factories: AcpProductionCompositionFactories<ProcessIdentity> = {
    createSessionStore: () => components.sessionStore as never,
    createActiveSessionRegistry: () => components.activeSessions as never,
    createStartupLauncher: (input) => {
      calls.startupLauncherOptions.push(input);
      return components.startupLauncher as never;
    },
    createSessionResolver: () => ({ resolve: () => ({ withAgy: () => undefined }) }),
    createDispatchAdapter: (input) => {
      calls.adapterOptions.push(input);
      return components.adapter as never;
    },
    createRecoveryCoordinator: () => components.recoveryCoordinator as never,
    createOutboxBridge: (input) => {
      calls.outboxOptions.push(input);
      return components.outboxBridge as never;
    },
    createOutboxPump: () => components.outboxPump as never,
    createClientRoutes: () => components.clientRoutes as never,
    createStartupRecoveryBarrier: (sources) => {
      calls.barrierSources.push(sources);
      return { waitUntilReady: async () => options.readiness ?? ready() };
    }
  };
  const dependencies: AcpProductionCompositionDependencies<ProcessIdentity> = {
    runtime: runtime as never,
    databasePath: "/tmp/production-composition.sqlite",
    agentId: "agent-production",
    ownerIdentity: {
      ownerInstanceId: OWNER_ID,
      createdAt: "2026-08-10T00:00:00.000Z",
      bootId: BOOT_ID,
      pid: 401,
      startTimeTicks: "101",
      pidNamespaceInode: 4_026_531_836,
      ppid: 1,
      pgrp: 401,
      session: 401
    },
    sessionLookup: new Map(),
    requestMetadata: { readRequestMetadata: () => undefined },
    businessPrompts: { readBusinessPrompt: () => SECRET },
    sqliteSnapshots: { readSnapshot: async () => null },
    captureProcessIdentity: () => ({ pid: 500 }),
    createTerminalDelivery: async () => ({
      eventId: "event-1",
      fingerprint: "fingerprint-1",
      payload: "{}",
      sequence: 1,
      expiresAt: 2_000,
      protocol: {
        key: "paseo-agy-acp/outbox",
        version: 1,
        semantics: "at-least-once",
        ackMethod: "_paseo-agy-acp/outbox/ack"
      }
    }),
    lifecycle: {
      recordProcessIdentity: () => ({ status: "recorded" as const }),
      revalidate: () => ({ generationMatches: true, ownerMatches: true, cancelled: false }),
      commitDispatchIntent: () => ({ status: "committed" as const }),
      observeHeartbeat: () => ({ state: "current" as const }),
      recoverPreDispatch: async () => ({ outcome: "not_proven" as const, reason: "owner_alive" as const })
    },
    dispatcherRecovery: {
      recoverPreDispatch: async () => ({ state: "recovery_required" as const }),
      recordRecoveryRequired: async () => {}
    },
    freshPtyCanary: {
      verifiedAgyBinary: {} as never,
      fakeChild: () => ({ exitCode: 0 })
    },
    clientRoute: {
      protocol: "v1",
      connectionFence: "connection-production",
      outboxSender: async (message) => {
        calls.outboxSender.push(message);
      },
      registerAcknowledgement: (handler) => {
        calls.acknowledgementHandlers.push(handler);
        return close("ack-route");
      }
    },
    startupRecovery: {
      inspectProcessResidue: () => ({ observations: [], untrackedResidue: "empty" as const })
    },
    initializationMeta: {
      [ACP_REQUEST_IDENTITY_CAPABILITY_KEY]: requestIdentityOffer(),
      [ACP_OUTBOX_CAPABILITY_KEY]: outboxOffer()
    },
    now: () => 1_000,
    factories
  };

  return { dependencies, controller, components, calls, closeOrder };
}

function fakeController(): Record<string, (...args: never[]) => unknown> {
  const controller: Record<string, (...args: never[]) => unknown> = {};
  for (const name of [
    "admitRequest",
    "getRequest",
    "getQueueSnapshot",
    "cancelQueued",
    "markStarting",
    "readPayload",
    "markActive",
    "markDispatchAmbiguous",
    "markProviderTerminal",
    "release",
    "recoverOwner",
    "createRecoveryResolutionAttestations",
    "resolveRecovery",
    "claimPendingDeliveryAtomically",
    "claimNextPendingDelivery",
    "heartbeatClaimedDelivery",
    "acknowledgeDelivery",
    "markDeliveryRecoveryRequired",
    "sweepExpiredDeliveryClaims"
  ]) {
    controller[name] = () => undefined;
  }
  controller.listRecoverableDispatches = () => [];
  controller.listRecoverableOutboxClaims = () => [];
  return controller;
}

function ready(): StartupRecoveryReadiness {
  return Object.freeze({
    status: "ready" as const,
    counts: {
      dispatches: 0,
      activeSessions: 0,
      outboxClaims: 0,
      startupPermits: 0,
      processObservations: 0
    },
    issues: [] as []
  });
}

function requestIdentityOffer() {
  return { versions: [1], required: true };
}

function outboxOffer() {
  return {
    versions: [ACP_OUTBOX_CAPABILITY_VERSION],
    required: true,
    ackRequests: true,
    durableEventIdDedupe: true
  };
}
