import type {
  AdmissionPromptDispatcher,
  AdmissionPromptProcessLifecycleOwner,
  AdmissionPromptRecoveryOwner,
  AdmissionRuntimeFreshPtyCanaryOptions
} from "../admission/dispatcher.js";
import {
  AdmissionRecoveryCoordinator,
  type AdmissionRecoveryCoordinatorOptions,
  type RecoveryLifecycleObserver
} from "../admission/recovery-coordinator.js";
import type { AdmissionPromptSeam } from "../admission/prompt-seam.js";
import type { AdmissionRuntime } from "../admission/runtime.js";
import type { AdmissionPromptSeamFactoryOptions } from "../admission/runtime-composition.js";
import {
  SqlitePrimaryDispatchAdapter,
  type SqlitePrimaryBusinessPromptSource,
  type SqlitePrimaryDispatchAdapterOptions,
  type SqlitePrimaryRequestMetadataSource,
  type SqlitePrimaryTerminalDelivery,
  type SqlitePrimaryTerminalDeliveryInput
} from "../admission/sqlite-primary-dispatch-adapter.js";
import {
  SqliteAgyStartupLauncher,
  type SqliteStartupLauncherOptions
} from "../admission/sqlite-startup-launcher.js";
import {
  StartupRecoveryBarrier,
  type StartupRecoveryBarrierSources,
  type StartupRecoveryReadiness
} from "../admission/startup-recovery-barrier.js";
import type { AgyExactConversationTurn } from "../agy/cli.js";
import type { SqliteProviderSnapshotReader } from "../agy/db/provider-observer.js";
import { AcpOutboxDeliveryBridge, type AcpOutboxDeliveryBridgeOptions, type OutboxDeliverySender } from "./outbox-delivery.js";
import { AcpOutboxPump, type AcpOutboxPumpOptions, type OutboxPumpReport } from "./outbox-pump.js";
import {
  negotiateAcpInitializationProtocolCapabilities,
  type AcpInitializationProtocolCapabilities
} from "./protocol-capabilities.js";
import {
  ActiveSessionRegistry,
  type ActiveConnectorIdentity,
  type ActiveSessionRecord
} from "./session/active-registry.js";
import type { ActiveSessionTurnRegistry } from "./session/active-turn-binding.js";
import {
  AdmissionSessionScopeResolver,
  type AdmissionSessionScopeSource
} from "./session/admission-scope-resolver.js";
import {
  AcpSessionClientRouteRegistry,
  type AcpSessionClientProtocol,
  type AcpSessionUpdateSender
} from "./session/client-route-registry.js";
import { SQLiteSessionStore } from "./session/sqlite-store.js";
import type { SessionStoreBackend } from "./session/store.js";

type MaybePromise<T> = T | Promise<T>;

type ProductionAdmissionRuntime = Pick<
  AdmissionRuntime,
  "controller" | "createPromptDispatcher" | "createPromptSeam" | "createDeliveryBridge" | "createRecoveryBridge" | "close"
>;

/**
 * Reasons intentionally carry no operating-system, provider, prompt, token,
 * header, or underlying exception detail.
 */
export type AcpProductionCompositionBlockReason =
  | "invalid_configuration"
  | "missing_dependency"
  | "request_identity_not_negotiated"
  | "ack_not_negotiated"
  | "fresh_pty_not_authenticated"
  | "construction_failed"
  | "startup_recovery_blocked"
  | "close_failed";

export type AcpProductionCompositionErrorCode =
  | "runtime_closed"
  | "dispatch_unavailable"
  | "outbox_unavailable"
  | "close_failed";

/** Detail-free public error for a composition that cannot safely operate. */
export class AcpProductionCompositionError extends Error {
  readonly code: AcpProductionCompositionErrorCode;

  constructor(code: AcpProductionCompositionErrorCode) {
    super(`ACP production composition error: ${code}`);
    this.name = "AcpProductionCompositionError";
    this.code = code;
  }
}

export interface AcpProductionSessionStore extends SessionStoreBackend {
  close(): void;
}

export interface AcpProductionActiveSessionRegistry extends ActiveSessionTurnRegistry {
  listInFlight(): readonly ActiveSessionRecord[];
  close(): void;
}

export interface AcpProductionSessionResolver {
  resolve(sessionId: string): unknown;
}

export interface AcpProductionDispatchAdapter<TProcessIdentity>
extends Pick<
  SqlitePrimaryDispatchAdapter<TProcessIdentity>,
  "spawnPromptFree" | "observeProviderActivity" | "observeTerminal" | "discardPromptFree" | "close"
> {}

export interface AcpProductionRecoveryCoordinator extends Pick<
  AdmissionRecoveryCoordinator,
  "observeHeartbeat" | "recoverPreDispatch" | "close"
> {}

export interface AcpProductionOutboxBridge extends Pick<
  AcpOutboxDeliveryBridge,
  "active" | "acknowledge" | "drainNextPendingDelivery" | "sweepExpiredDeliveryClaims" | "close"
> {}

export interface AcpProductionOutboxPump extends Pick<AcpOutboxPump, "poke" | "drain" | "close"> {}

export interface AcpProductionClientRoutes extends Pick<
  AcpSessionClientRouteRegistry,
  "bind" | "resolve" | "unbind" | "close"
> {}

/**
 * The production graph owns one durable launcher for every repository-owned
 * agy start path. Future ACP host wiring receives this exact capability.
 */
export interface AcpProductionStartupLauncher extends Pick<
  SqliteAgyStartupLauncher,
  "enabled" | "acquire" | "listRecoverablePermits" | "close"
> {}

export type AcpProductionStartupLauncherOptions = Required<Pick<
  SqliteStartupLauncherOptions,
  "databasePath" | "ownerInstanceId" | "now"
>>;

export interface AcpProductionStartupBarrier {
  waitUntilReady(): Promise<StartupRecoveryReadiness>;
}

/** Recovery and cancellation only; provider startup belongs to the dispatcher. */
export type AcpProductionLifecycle<TProcessIdentity> =
  & AdmissionPromptProcessLifecycleOwner<TProcessIdentity>
  & RecoveryLifecycleObserver;

/** One exact ACP connection supplies its wire sender, protocol, and fence. */
export interface AcpProductionClientRouteCapability {
  readonly protocol: AcpSessionClientProtocol;
  readonly connectionFence: string;
  /**
   * This sends a complete durable message, including ACK metadata. It is
   * intentionally not reconstructed from a generic session/update sender.
   */
  readonly outboxSender: OutboxDeliverySender;
  /**
   * The embedding ACP host owns route registration. Returning an exact
   * unregister function proves the ACK route can be torn down before its
   * bridge and controller disappear.
   */
  registerAcknowledgement(handler: (input: unknown) => void): () => void;
}

/** The caller supplies only observation-only process residue inventory. */
export interface AcpProductionStartupRecoveryCapability {
  readonly inspectProcessResidue: StartupRecoveryBarrierSources["inspectProcessResidue"];
}

/**
 * Explicit factories make the graph testable without a database, process, or
 * ACP connection. Production defaults are the concrete source-only classes.
 */
export interface AcpProductionCompositionFactories<TProcessIdentity> {
  readonly createSessionStore?: (databasePath: string) => AcpProductionSessionStore;
  readonly createActiveSessionRegistry?: (databasePath: string) => AcpProductionActiveSessionRegistry;
  readonly createStartupLauncher?: (
    options: AcpProductionStartupLauncherOptions
  ) => AcpProductionStartupLauncher;
  readonly createSessionResolver?: (source: AdmissionSessionScopeSource) => AcpProductionSessionResolver;
  readonly createDispatchAdapter?: (
    options: SqlitePrimaryDispatchAdapterOptions<TProcessIdentity>
  ) => AcpProductionDispatchAdapter<TProcessIdentity>;
  readonly createRecoveryCoordinator?: (
    options: AdmissionRecoveryCoordinatorOptions
  ) => AcpProductionRecoveryCoordinator;
  readonly createOutboxBridge?: (options: AcpOutboxDeliveryBridgeOptions) => AcpProductionOutboxBridge;
  readonly createOutboxPump?: (options: AcpOutboxPumpOptions) => AcpProductionOutboxPump;
  readonly createClientRoutes?: () => AcpProductionClientRoutes;
  readonly createStartupRecoveryBarrier?: (
    sources: StartupRecoveryBarrierSources
  ) => AcpProductionStartupBarrier;
}

/**
 * Inputs intentionally contain only narrow capabilities. In particular,
 * controller payload access and terminal delivery construction are supplied
 * by their owning implementation; this module never reads SQLite rows itself.
 */
export interface AcpProductionCompositionDependencies<TProcessIdentity> {
  readonly runtime: ProductionAdmissionRuntime;
  readonly databasePath: string;
  readonly agentId: string;
  readonly ownerIdentity: ActiveConnectorIdentity;
  readonly sessionLookup: AdmissionSessionScopeSource;
  readonly requestMetadata: SqlitePrimaryRequestMetadataSource;
  readonly businessPrompts: SqlitePrimaryBusinessPromptSource;
  readonly sqliteSnapshots: SqliteProviderSnapshotReader;
  readonly captureProcessIdentity: SqlitePrimaryDispatchAdapterOptions<TProcessIdentity>["captureProcessIdentity"];
  readonly createTerminalDelivery: (
    input: SqlitePrimaryTerminalDeliveryInput
  ) => MaybePromise<SqlitePrimaryTerminalDelivery>;
  readonly lifecycle: AcpProductionLifecycle<TProcessIdentity>;
  readonly dispatcherRecovery: AdmissionPromptRecoveryOwner<TProcessIdentity>;
  /** Required even though the current SQLite-primary adapter starts stdin-only turns. */
  readonly freshPtyCanary: AdmissionRuntimeFreshPtyCanaryOptions;
  readonly clientRoute: AcpProductionClientRouteCapability;
  readonly startupRecovery: AcpProductionStartupRecoveryCapability;
  /** Raw initialize `_meta`; selection is performed inside this module. */
  readonly initializationMeta: unknown;
  readonly now?: () => number;
  readonly factories?: AcpProductionCompositionFactories<TProcessIdentity>;
}

export interface AcpProductionCompositionBlocked {
  readonly status: "blocked";
  readonly reason: AcpProductionCompositionBlockReason;
}

/** The only prompt-facing surface is the owned AdmissionPromptSeam. */
export interface AcpProductionDispatchRuntime<TProcessIdentity> {
  readonly sessionStore: AcpProductionSessionStore;
  readonly activeSessions: AcpProductionActiveSessionRegistry;
  readonly startupLauncher: AcpProductionStartupLauncher;
  readonly clientRoutes: AcpProductionClientRoutes;
  readonly recoveryCoordinator: AcpProductionRecoveryCoordinator;
  readonly outboxBridge: AcpProductionOutboxBridge;
  readonly protocolCapabilities: AcpInitializationProtocolCapabilities;
  /** Dispatcher is exposed only as its dispatch hook, never as a second writer. */
  readonly dispatcher: Readonly<Pick<AdmissionPromptDispatcher<AgyExactConversationTurn, TProcessIdentity>, "dispatch">>;
  readonly admission: Readonly<Pick<AdmissionPromptSeam, "admit">>;
  bindClientRoute(sessionId: string, sender: AcpSessionUpdateSender): void;
  unbindClientRoute(sessionId: string): void;
  acknowledgeOutbox(input: unknown): void;
  pumpOutbox(now: number): Promise<OutboxPumpReport>;
  close(): Promise<void>;
}

export interface AcpProductionCompositionReady<TProcessIdentity> {
  readonly status: "ready";
  readonly runtime: AcpProductionDispatchRuntime<TProcessIdentity>;
}

export type AcpProductionCompositionResult<TProcessIdentity> =
  | AcpProductionCompositionReady<TProcessIdentity>
  | AcpProductionCompositionBlocked;

interface NormalizedDependencies<TProcessIdentity> extends AcpProductionCompositionDependencies<TProcessIdentity> {
  readonly factories: AcpProductionCompositionFactories<TProcessIdentity>;
  readonly now: () => number;
}

interface CreatedResources<TProcessIdentity> {
  readonly runtime: ProductionAdmissionRuntime;
  startupLauncher?: AcpProductionStartupLauncher;
  sessionStore?: AcpProductionSessionStore;
  activeSessions?: AcpProductionActiveSessionRegistry;
  clientRoutes?: AcpProductionClientRoutes;
  adapter?: AcpProductionDispatchAdapter<TProcessIdentity>;
  recoveryCoordinator?: AcpProductionRecoveryCoordinator;
  outboxBridge?: AcpProductionOutboxBridge;
  outboxPump?: AcpProductionOutboxPump;
  dispatcher?: AdmissionPromptDispatcher<AgyExactConversationTurn, TProcessIdentity>;
  admission?: AdmissionPromptSeam;
  acknowledgementRoute?: { close(): void };
}

/**
 * Build but do not install the v2 production graph. This module has no
 * dependency on AcpAgent, runtime configuration flags, daemon state, or agy
 * process startup. It returns a dispatch-capable surface only after the
 * startup barrier reports ready.
 */
export async function composeAcpProductionRuntime<TProcessIdentity>(
  value: AcpProductionCompositionDependencies<TProcessIdentity>
): Promise<AcpProductionCompositionResult<TProcessIdentity>> {
  const dependencies = normalizeDependencies(value);
  if (dependencies === null) return blocked("missing_dependency");

  const protocolCapabilities = negotiateCapabilities(dependencies.initializationMeta);
  if (protocolCapabilities === null) return blocked("ack_not_negotiated");
  if (protocolCapabilities.requestIdentity.status !== "selected") {
    return blocked("request_identity_not_negotiated");
  }
  if (protocolCapabilities.outbox.status !== "selected") return blocked("ack_not_negotiated");
  if (!hasFreshPtyCanary(dependencies.freshPtyCanary)) return blocked("fresh_pty_not_authenticated");

  const resources: CreatedResources<TProcessIdentity> = { runtime: dependencies.runtime };
  try {
    const factories = dependencies.factories;
    const startupLauncher = createStartupLauncher(factories, {
      databasePath: dependencies.databasePath,
      ownerInstanceId: dependencies.ownerIdentity.ownerInstanceId,
      now: dependencies.now
    });
    resources.startupLauncher = startupLauncher;
    resources.sessionStore = createSessionStore(factories, dependencies.databasePath);
    resources.activeSessions = createActiveSessionRegistry(factories, dependencies.databasePath);
    resources.clientRoutes = createClientRoutes(factories);
    const resolver = createSessionResolver(factories, dependencies.sessionLookup);
    resources.adapter = createDispatchAdapter(factories, {
      agentId: dependencies.agentId,
      connectorIdentity: dependencies.ownerIdentity,
      requestMetadata: dependencies.requestMetadata,
      businessPrompts: dependencies.businessPrompts,
      sessions: resolver as AdmissionSessionScopeResolver,
      activeSessions: resources.activeSessions,
      sqliteSnapshots: dependencies.sqliteSnapshots,
      captureProcessIdentity: dependencies.captureProcessIdentity,
      createTerminalDelivery: dependencies.createTerminalDelivery
    });

    resources.recoveryCoordinator = dependencies.runtime.createRecoveryBridge((context) => {
      const coordinator = createRecoveryCoordinator(factories, {
        controller: dependencies.runtime.controller,
        lifecycle: dependencies.lifecycle,
        claimantInstanceId: dependencies.ownerIdentity.ownerInstanceId,
        preDispatchProofVerifier: context.createPreDispatchProofAuthority()
      });
      return coordinator;
    });
    if (!hasMethods(resources.recoveryCoordinator, ["observeHeartbeat", "recoverPreDispatch", "close"])) {
      throw new Error("invalid recovery bridge");
    }

    resources.outboxBridge = dependencies.runtime.createDeliveryBridge(() => createOutboxBridge(factories, {
      admission: dependencies.runtime.controller,
      ownerInstanceId: dependencies.ownerIdentity.ownerInstanceId,
      sender: dependencies.clientRoute.outboxSender
    }));
    if (
      !hasMethods(resources.outboxBridge, ["acknowledge", "drainNextPendingDelivery", "sweepExpiredDeliveryClaims", "close"]) ||
      resources.outboxBridge.active !== true
    ) {
      const closedCleanly = await closeResources(resources);
      return blocked(closedCleanly ? "construction_failed" : "close_failed");
    }

    resources.outboxPump = createOutboxPump(factories, { bridge: resources.outboxBridge });
    resources.dispatcher = dependencies.runtime.createPromptDispatcher<AgyExactConversationTurn, TProcessIdentity>({
      ownerInstanceId: dependencies.ownerIdentity.ownerInstanceId,
      startupLauncher,
      lifecycle: dependencies.lifecycle,
      agy: resources.adapter,
      provider: resources.adapter,
      recovery: dependencies.dispatcherRecovery,
      freshPtyCanary: dependencies.freshPtyCanary,
      now: dependencies.now
    });
    if (!hasMethods(resources.dispatcher, ["dispatch", "close"])) throw new Error("invalid prompt dispatcher");
    resources.admission = dependencies.runtime.createPromptSeam({
      dispatch: resources.dispatcher.dispatch,
      now: dependencies.now
    } satisfies AdmissionPromptSeamFactoryOptions);
    if (!hasMethods(resources.admission, ["admit", "close"])) throw new Error("invalid prompt seam");

    const barrier = createStartupRecoveryBarrier(factories, {
      listRecoverableDispatches: () => dependencies.runtime.controller.listRecoverableDispatches(),
      listActiveSessions: () => resources.activeSessions!.listInFlight(),
      listRecoverableOutboxClaims: () => dependencies.runtime.controller.listRecoverableOutboxClaims(),
      listRecoverablePermits: () => startupLauncher.listRecoverablePermits(),
      inspectProcessResidue: dependencies.startupRecovery.inspectProcessResidue
    });
    const readiness = await barrier.waitUntilReady();
    if (!isReady(readiness)) {
      const closedCleanly = await closeResources(resources);
      return blocked(closedCleanly ? "startup_recovery_blocked" : "close_failed");
    }
    resources.acknowledgementRoute = createAcknowledgementRoute(
      dependencies.clientRoute,
      resources.outboxBridge,
      dependencies.now
    );

    return Object.freeze({
      status: "ready" as const,
      runtime: new AcpProductionDispatchRuntimeImpl({
        resources: requireCompleteResources(resources),
        protocolCapabilities,
        clientRoute: dependencies.clientRoute,
        now: dependencies.now
      })
    });
  } catch {
    const closedCleanly = await closeResources(resources);
    return blocked(closedCleanly ? "construction_failed" : "close_failed");
  }
}

/** Alias kept next to the existing `composeAcpRuntime` naming family. */
export const createAcpProductionComposition = composeAcpProductionRuntime;

class AcpProductionDispatchRuntimeImpl<TProcessIdentity> implements AcpProductionDispatchRuntime<TProcessIdentity> {
  readonly sessionStore: AcpProductionSessionStore;
  readonly activeSessions: AcpProductionActiveSessionRegistry;
  readonly startupLauncher: AcpProductionStartupLauncher;
  readonly clientRoutes: AcpProductionClientRoutes;
  readonly recoveryCoordinator: AcpProductionRecoveryCoordinator;
  readonly outboxBridge: AcpProductionOutboxBridge;
  readonly protocolCapabilities: AcpInitializationProtocolCapabilities;
  readonly dispatcher: Readonly<Pick<AdmissionPromptDispatcher<AgyExactConversationTurn, TProcessIdentity>, "dispatch">>;
  readonly admission: Readonly<Pick<AdmissionPromptSeam, "admit">>;
  readonly #resources: Required<CreatedResources<TProcessIdentity>>;
  readonly #clientRoute: AcpProductionClientRouteCapability;
  readonly #now: () => number;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: {
    readonly resources: Required<CreatedResources<TProcessIdentity>>;
    readonly protocolCapabilities: AcpInitializationProtocolCapabilities;
    readonly clientRoute: AcpProductionClientRouteCapability;
    readonly now: () => number;
  }) {
    this.#resources = options.resources;
    this.sessionStore = options.resources.sessionStore;
    this.activeSessions = options.resources.activeSessions;
    this.startupLauncher = options.resources.startupLauncher;
    this.clientRoutes = options.resources.clientRoutes;
    this.recoveryCoordinator = options.resources.recoveryCoordinator;
    this.outboxBridge = options.resources.outboxBridge;
    this.protocolCapabilities = options.protocolCapabilities;
    this.#clientRoute = options.clientRoute;
    this.#now = options.now;
    this.dispatcher = Object.freeze({
      dispatch: async (input) => {
        this.assertOpen();
        try {
          return await options.resources.dispatcher.dispatch(input);
        } catch {
          throw new AcpProductionCompositionError("dispatch_unavailable");
        }
      }
    });
    this.admission = Object.freeze({
      admit: async (input) => {
        this.assertOpen();
        try {
          return await options.resources.admission.admit(input);
        } catch {
          throw new AcpProductionCompositionError("dispatch_unavailable");
        }
      }
    });
  }

  bindClientRoute(sessionId: string, sender: AcpSessionUpdateSender): void {
    this.assertOpen();
    try {
      this.clientRoutes.bind({
        sessionId,
        protocol: this.#clientRoute.protocol,
        connectionFence: this.#clientRoute.connectionFence,
        sender
      });
    } catch {
      throw new AcpProductionCompositionError("outbox_unavailable");
    }
  }

  unbindClientRoute(sessionId: string): void {
    this.assertOpen();
    try {
      this.clientRoutes.unbind({
        sessionId,
        protocol: this.#clientRoute.protocol,
        connectionFence: this.#clientRoute.connectionFence
      });
    } catch {
      throw new AcpProductionCompositionError("outbox_unavailable");
    }
  }

  acknowledgeOutbox(input: unknown): void {
    this.assertOpen();
    const now = readNow(this.#now);
    if (now === null) throw new AcpProductionCompositionError("outbox_unavailable");
    try {
      this.outboxBridge.acknowledge(input, now);
    } catch {
      throw new AcpProductionCompositionError("outbox_unavailable");
    }
  }

  async pumpOutbox(now: number): Promise<OutboxPumpReport> {
    this.assertOpen();
    if (!isTimestamp(now)) throw new AcpProductionCompositionError("outbox_unavailable");
    try {
      return await this.#resources.outboxPump.poke(now);
    } catch {
      throw new AcpProductionCompositionError("outbox_unavailable");
    }
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.closeOnce();
    return this.#closePromise;
  }

  private async closeOnce(): Promise<void> {
    const closedCleanly = await closeResources(this.#resources);
    if (!closedCleanly) throw new AcpProductionCompositionError("close_failed");
  }

  private assertOpen(): void {
    if (this.#closed) throw new AcpProductionCompositionError("runtime_closed");
  }
}

function normalizeDependencies<TProcessIdentity>(
  value: AcpProductionCompositionDependencies<TProcessIdentity>
): NormalizedDependencies<TProcessIdentity> | null {
  try {
    if (!isRecord(value)) return null;
    if (!hasMethods(value.runtime, [
      "createPromptDispatcher",
      "createPromptSeam",
      "createDeliveryBridge",
      "createRecoveryBridge",
      "close"
    ])) return null;
    if (!hasMethods(value.runtime.controller, CONTROLLER_METHODS)) return null;
    if (!isAbsolutePath(value.databasePath) || !isIdentifier(value.agentId) || !isConnectorIdentity(value.ownerIdentity)) {
      return null;
    }
    if (!isSessionLookup(value.sessionLookup) || !hasMethods(value.requestMetadata, ["readRequestMetadata"])) return null;
    if (!hasMethods(value.businessPrompts, ["readBusinessPrompt"]) || !hasMethods(value.sqliteSnapshots, ["readSnapshot"])) {
      return null;
    }
    if (typeof value.captureProcessIdentity !== "function" || typeof value.createTerminalDelivery !== "function") {
      return null;
    }
    if (!hasMethods(value.lifecycle, [
      "recordProcessIdentity",
      "revalidate",
      "commitDispatchIntent",
      "observeHeartbeat",
      "recoverPreDispatch"
    ])) return null;
    if (!hasMethods(value.dispatcherRecovery, ["recoverPreDispatch", "recordRecoveryRequired"])) return null;
    if (!isClientRoute(value.clientRoute) || !hasMethods(value.startupRecovery, ["inspectProcessResidue"])) return null;
    if (value.now !== undefined && typeof value.now !== "function") return null;
    const factories = normalizeFactories(value.factories);
    if (factories === null) return null;
    return Object.freeze({ ...value, factories, now: value.now ?? Date.now });
  } catch {
    return null;
  }
}

const CONTROLLER_METHODS = [
  "admitRequest",
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
  "reserveTerminalReplay",
  "readClaimedDelivery",
  "acknowledgeDelivery",
  "markDeliveryRecoveryRequired",
  "sweepExpiredDeliveryClaims",
  "listRecoverableDispatches",
  "listRecoverableOutboxClaims"
] as const;

function normalizeFactories<TProcessIdentity>(
  value: AcpProductionCompositionFactories<TProcessIdentity> | undefined
): AcpProductionCompositionFactories<TProcessIdentity> | null {
  if (value === undefined) return Object.freeze({});
  if (!isRecord(value)) return null;
  const names = [
    "createSessionStore",
    "createActiveSessionRegistry",
    "createStartupLauncher",
    "createSessionResolver",
    "createDispatchAdapter",
    "createRecoveryCoordinator",
    "createOutboxBridge",
    "createOutboxPump",
    "createClientRoutes",
    "createStartupRecoveryBarrier"
  ] as const;
  for (const name of names) {
    const candidate = value[name];
    if (candidate !== undefined && typeof candidate !== "function") return null;
  }
  return value;
}

function negotiateCapabilities(meta: unknown): AcpInitializationProtocolCapabilities | null {
  try {
    return negotiateAcpInitializationProtocolCapabilities(meta, {
      requestIdentityAvailable: true,
      outboxAvailable: true
    });
  } catch {
    return null;
  }
}

function createSessionStore<TProcessIdentity>(
  factories: AcpProductionCompositionFactories<TProcessIdentity>,
  databasePath: string
): AcpProductionSessionStore {
  const store = factories.createSessionStore === undefined
    ? new SQLiteSessionStore(databasePath)
    : factories.createSessionStore(databasePath);
  if (!hasMethods(store, ["restore", "list", "persist", "delete", "close"])) throw new Error("invalid store");
  return store;
}

function createActiveSessionRegistry<TProcessIdentity>(
  factories: AcpProductionCompositionFactories<TProcessIdentity>,
  databasePath: string
): AcpProductionActiveSessionRegistry {
  const registry = factories.createActiveSessionRegistry === undefined
    ? new ActiveSessionRegistry(databasePath)
    : factories.createActiveSessionRegistry(databasePath);
  if (!hasMethods(registry, ["register", "advance", "markTerminal", "archiveTerminal", "listInFlight", "close"])) {
    throw new Error("invalid active-session registry");
  }
  return registry;
}

function createStartupLauncher<TProcessIdentity>(
  factories: AcpProductionCompositionFactories<TProcessIdentity>,
  options: AcpProductionStartupLauncherOptions
): AcpProductionStartupLauncher {
  const launcher = factories.createStartupLauncher === undefined
    ? new SqliteAgyStartupLauncher({
      databasePath: options.databasePath,
      ownerInstanceId: options.ownerInstanceId,
      now: options.now
    })
    : factories.createStartupLauncher(options);
  if (!isStartupLauncher(launcher)) throw new Error("invalid startup launcher");
  return launcher;
}

function createClientRoutes<TProcessIdentity>(
  factories: AcpProductionCompositionFactories<TProcessIdentity>
): AcpProductionClientRoutes {
  const routes = factories.createClientRoutes === undefined
    ? new AcpSessionClientRouteRegistry()
    : factories.createClientRoutes();
  if (!hasMethods(routes, ["bind", "resolve", "unbind", "close"])) throw new Error("invalid client routes");
  return routes;
}

function createSessionResolver<TProcessIdentity>(
  factories: AcpProductionCompositionFactories<TProcessIdentity>,
  source: AdmissionSessionScopeSource
): AcpProductionSessionResolver {
  const resolver = factories.createSessionResolver === undefined
    ? new AdmissionSessionScopeResolver(source)
    : factories.createSessionResolver(source);
  if (!hasMethods(resolver, ["resolve"])) throw new Error("invalid session resolver");
  return resolver;
}

function createDispatchAdapter<TProcessIdentity>(
  factories: AcpProductionCompositionFactories<TProcessIdentity>,
  options: SqlitePrimaryDispatchAdapterOptions<TProcessIdentity>
): AcpProductionDispatchAdapter<TProcessIdentity> {
  const adapter = factories.createDispatchAdapter === undefined
    ? new SqlitePrimaryDispatchAdapter(options)
    : factories.createDispatchAdapter(options);
  if (!hasMethods(adapter, ["spawnPromptFree", "observeProviderActivity", "observeTerminal", "close"])) {
    throw new Error("invalid dispatch adapter");
  }
  return adapter;
}

function createRecoveryCoordinator<TProcessIdentity>(
  factories: AcpProductionCompositionFactories<TProcessIdentity>,
  options: AdmissionRecoveryCoordinatorOptions
): AcpProductionRecoveryCoordinator {
  const coordinator = factories.createRecoveryCoordinator === undefined
    ? new AdmissionRecoveryCoordinator(options)
    : factories.createRecoveryCoordinator(options);
  if (!hasMethods(coordinator, ["observeHeartbeat", "recoverPreDispatch", "close"])) {
    throw new Error("invalid recovery coordinator");
  }
  return coordinator;
}

function createOutboxBridge<TProcessIdentity>(
  factories: AcpProductionCompositionFactories<TProcessIdentity>,
  options: AcpOutboxDeliveryBridgeOptions
): AcpProductionOutboxBridge {
  const bridge = factories.createOutboxBridge === undefined
    ? new AcpOutboxDeliveryBridge(options)
    : factories.createOutboxBridge(options);
  if (!hasMethods(bridge, ["acknowledge", "drainNextPendingDelivery", "sweepExpiredDeliveryClaims", "close"])) {
    throw new Error("invalid outbox bridge");
  }
  return bridge;
}

function createOutboxPump<TProcessIdentity>(
  factories: AcpProductionCompositionFactories<TProcessIdentity>,
  options: AcpOutboxPumpOptions
): AcpProductionOutboxPump {
  // Deliberately omit schedule: no delivery may be triggered before readiness.
  const pump = factories.createOutboxPump === undefined
    ? new AcpOutboxPump(options)
    : factories.createOutboxPump(options);
  if (!hasMethods(pump, ["poke", "drain", "close"])) throw new Error("invalid outbox pump");
  return pump;
}

function createStartupRecoveryBarrier<TProcessIdentity>(
  factories: AcpProductionCompositionFactories<TProcessIdentity>,
  sources: StartupRecoveryBarrierSources
): AcpProductionStartupBarrier {
  const barrier = factories.createStartupRecoveryBarrier === undefined
    ? new StartupRecoveryBarrier(sources)
    : factories.createStartupRecoveryBarrier(sources);
  if (!hasMethods(barrier, ["waitUntilReady"])) throw new Error("invalid startup barrier");
  return barrier;
}

function requireCompleteResources<TProcessIdentity>(
  resources: CreatedResources<TProcessIdentity>
): Required<CreatedResources<TProcessIdentity>> {
  if (
    resources.sessionStore === undefined ||
    resources.activeSessions === undefined ||
    resources.startupLauncher === undefined ||
    resources.clientRoutes === undefined ||
    resources.adapter === undefined ||
    resources.recoveryCoordinator === undefined ||
    resources.outboxBridge === undefined ||
    resources.outboxPump === undefined ||
    resources.dispatcher === undefined ||
    resources.admission === undefined ||
    resources.acknowledgementRoute === undefined
  ) {
    throw new Error("incomplete production composition");
  }
  return resources as Required<CreatedResources<TProcessIdentity>>;
}

/** Close every acquired resource even if an earlier close fails. */
async function closeResources<TProcessIdentity>(resources: CreatedResources<TProcessIdentity>): Promise<boolean> {
  const ordered: Array<unknown> = [
    resources.acknowledgementRoute,
    resources.dispatcher,
    resources.startupLauncher,
    resources.adapter,
    resources.outboxPump,
    resources.outboxBridge,
    resources.clientRoutes,
    resources.recoveryCoordinator,
    resources.activeSessions,
    resources.sessionStore,
    resources.runtime
  ];
  let clean = true;
  const seen = new Set<object>();
  for (const resource of ordered) {
    if (typeof resource !== "object" || resource === null || seen.has(resource)) continue;
    seen.add(resource);
    try {
      const close = (resource as { close?: unknown }).close;
      if (typeof close !== "function") {
        clean = false;
        continue;
      }
      await close.call(resource);
    } catch {
      clean = false;
    }
  }
  return clean;
}

function hasFreshPtyCanary(value: unknown): value is AdmissionRuntimeFreshPtyCanaryOptions {
  if (!isRecord(value)) return false;
  try {
    const maxAgeMs = value.maxAgeMs;
    return (
      typeof value.fakeChild === "function" &&
      typeof value.verifiedAgyBinary === "object" &&
      value.verifiedAgyBinary !== null &&
      (maxAgeMs === undefined || (typeof maxAgeMs === "number" && Number.isSafeInteger(maxAgeMs) && maxAgeMs > 0))
    );
  } catch {
    return false;
  }
}

function isStartupLauncher(value: unknown): value is AcpProductionStartupLauncher {
  if (!hasMethods(value, ["acquire", "listRecoverablePermits", "close"])) return false;
  try {
    return (value as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

function isClientRoute(value: unknown): value is AcpProductionClientRouteCapability {
  if (!isRecord(value)) return false;
  try {
    return (
      (value.protocol === "v1" || value.protocol === "v2") &&
      isIdentifier(value.connectionFence) &&
      typeof value.outboxSender === "function" &&
      typeof value.registerAcknowledgement === "function"
    );
  } catch {
    return false;
  }
}

function createAcknowledgementRoute(
  route: AcpProductionClientRouteCapability,
  bridge: AcpProductionOutboxBridge,
  now: () => number
): { close(): void } {
  let active = false;
  let unregister: unknown;
  try {
    unregister = route.registerAcknowledgement((input) => {
      if (!active) throw new AcpProductionCompositionError("outbox_unavailable");
      const timestamp = readNow(now);
      if (timestamp === null) throw new AcpProductionCompositionError("outbox_unavailable");
      try {
        bridge.acknowledge(input, timestamp);
      } catch {
        throw new AcpProductionCompositionError("outbox_unavailable");
      }
    });
  } catch {
    throw new Error("acknowledgement route is unavailable");
  }
  if (typeof unregister !== "function") throw new Error("acknowledgement route is unavailable");
  active = true;
  return Object.freeze({
    close(): void {
      if (!active) return;
      active = false;
      try {
        unregister();
      } catch {
        throw new AcpProductionCompositionError("close_failed");
      }
    }
  });
}

function isSessionLookup(value: unknown): value is AdmissionSessionScopeSource {
  if (typeof value === "function") return true;
  return hasMethods(value, ["get"]);
}

function isConnectorIdentity(value: unknown): value is ActiveConnectorIdentity {
  if (!isRecord(value)) return false;
  try {
    return (
      isUuidV4(value.ownerInstanceId) &&
      isIsoTimestamp(value.createdAt) &&
      isUuid(value.bootId) &&
      isPositiveInteger(value.pid) &&
      isDecimal(value.startTimeTicks) &&
      isPositiveInteger(value.pidNamespaceInode) &&
      isPositiveInteger(value.ppid) &&
      isPositiveInteger(value.pgrp) &&
      isPositiveInteger(value.session)
    );
  } catch {
    return false;
  }
}

function isReady(value: unknown): value is Readonly<{ status: "ready" }> {
  try {
    if (!hasExactKeys(value, ["status", "counts", "issues"])) return false;
    const record = value as Record<string, unknown>;
    if (record.status !== "ready" || !hasExactKeys(record.counts, [
      "dispatches",
      "activeSessions",
      "outboxClaims",
      "startupPermits",
      "processObservations"
    ])) return false;
    const counts = record.counts as Record<string, unknown>;
    if (!Object.values(counts).every((count) => isNonNegativeInteger(count))) return false;
    return Array.isArray(record.issues) && record.issues.length === 0;
  } catch {
    return false;
  }
}

function readNow(now: () => number): number | null {
  try {
    const value = now();
    return isTimestamp(value) ? value : null;
  } catch {
    return null;
  }
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.startsWith("/") && !value.includes("\0");
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

function isUuidV4(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function hasMethods(value: unknown, names: readonly string[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  try {
    return names.every((name) => typeof (value as Record<string, unknown>)[name] === "function");
  } catch {
    return false;
  }
}

function hasExactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!isRecord(value)) return false;
  try {
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== expected.length || Object.getOwnPropertySymbols(value).length !== 0) return false;
    return expected.every((name) => {
      if (!names.includes(name)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return true;
}

function blocked(reason: AcpProductionCompositionBlockReason): AcpProductionCompositionBlocked {
  return Object.freeze({ status: "blocked" as const, reason });
}
