import type {
  AdmissionLease,
  EnqueueDelivery,
  LeaseFence,
  ProviderTerminalObservations
} from "./controller.js";
import type { AdmissionPromptDispatchHook, AdmissionPromptDispatchInput, AdmissionPromptStopReason } from "./prompt-seam.js";
import type { AdmissionRuntime } from "./runtime.js";
import { confirmTerminalEvidence, parseTerminalEvidenceInput } from "./terminal-evidence.js";
import {
  AgyPromptFreeDispatchBoundary,
  type AgyDispatchBoundaryBlockReason,
  type AgyDispatchCancellationRecheck,
  type AgyDispatchFence,
  type AgyFreshPtyCanaryResult,
  type AgyDispatchIdentityPersistenceResult,
  type AgyDispatchIntentCommitResult,
  type AgyDispatchProcess,
  type AgyDispatchProcessRecord
} from "../agy/dispatch-boundary.js";
import type {
  PromptFreePtyCanaryFakeChild
} from "../agy/prompt-free-canary.js";
import type { VerifiedAgyBinary } from "../agy/launch-spec.js";
import { launchAgyProcess, type AgyStartupLauncher } from "../agy/startup-launcher.js";

type MaybePromise<T> = T | Promise<T>;

/** The narrow durable-controller surface needed by the prompt dispatch hook. */
export interface AdmissionPromptDispatchController {
  admitRequest(requestId: string, now: number, ownerInstanceId: string): AdmissionLease | null;
  markStarting(fence: LeaseFence, now: number): void;
  readPayload(requestId: string, now: number): string;
  markActive(fence: LeaseFence, now: number): void;
  markDispatchAmbiguous(fence: LeaseFence, now: number): void;
  /** Must atomically persist confirmed terminal evidence and its outbox delivery. */
  markProviderTerminal(
    fence: LeaseFence,
    now: number,
    observations: ProviderTerminalObservations,
    delivery: EnqueueDelivery
  ): { eventId: string; existed: boolean };
  release(fence: LeaseFence, now: number): void;
}

/**
 * The prompt-free process contract receives only a dispatcher-issued context:
 * the durable fence and the current TurnClaim cancellation signal. Business
 * prompt content reaches the child exclusively via `writeInitialPrompt` inside
 * the CLI's dispatch boundary.
 */
export interface AdmissionPromptAgyContract<TProcess, TProcessIdentity> {
  spawnPromptFree(context: AdmissionPromptAgySpawnContext): AgyDispatchProcess<TProcess, TProcessIdentity>;
  /** Dispatcher calls this after every terminal or unrecoverable local path. */
  discardPromptFree?(context: AdmissionPromptAgySpawnContext): void;
}

export interface AdmissionPromptAgySpawnContext extends Readonly<AgyDispatchFence> {
  readonly signal: AbortSignal;
}

const DISPATCHER_ISSUED_AGY_SPAWN_CONTEXTS = new WeakSet<object>();

/** Plain caller objects cannot impersonate a context issued by this dispatcher module. */
export function isAdmissionPromptAgySpawnContext(value: unknown): value is AdmissionPromptAgySpawnContext {
  return typeof value === "object" && value !== null && DISPATCHER_ISSUED_AGY_SPAWN_CONTEXTS.has(value);
}

/**
 * Fake-only certification input for a fresh PTY. The runtime composition
 * owns the HMAC key and produces the verifier; callers cannot supply one.
 */
export interface AdmissionRuntimeFreshPtyCanaryOptions {
  /** Opaque exact-binary capability issued only by probeExactAgyBinaryVersion. */
  readonly verifiedAgyBinary: VerifiedAgyBinary;
  /** Injected fake child; it can report only the canary child exit code. */
  readonly fakeChild: PromptFreePtyCanaryFakeChild;
  readonly maxAgeMs?: number;
}

/**
 * Bridge the process lifecycle evidence to the durable admission state.
 *
 * `recordProcessIdentity` is the critical bridge point: before it returns
 * `recorded`, it must atomically persist the process record and move the
 * matching AdmissionController lease to `dispatch_intent` under the same
 * owner/generation fence. `commitDispatchIntent` is the exact replay check
 * immediately before the prompt write; neither a failed revalidation nor a
 * failed replay can make a recorded request safe to requeue.
 */
export interface AdmissionPromptProcessLifecycleOwner<TProcessIdentity> {
  recordProcessIdentity(record: AgyDispatchProcessRecord<TProcessIdentity>): AgyDispatchIdentityPersistenceResult;
  revalidate(record: AgyDispatchProcessRecord<TProcessIdentity>): AgyDispatchCancellationRecheck;
  commitDispatchIntent(record: AgyDispatchProcessRecord<TProcessIdentity>): AgyDispatchIntentCommitResult;
}

export type AdmissionPromptDispatchPhase =
  | "admitted"
  | "starting"
  | "dispatch_intent"
  | "active"
  | "provider_terminal"
  | "released";

export type AdmissionPromptDispatchFault =
  | "admission_failed"
  | "mark_start_failed"
  | "payload_unavailable"
  | "process_start_failed"
  | "process_identity_unrecorded"
  | "fresh_pty_uncertified"
  | "revalidation_failed"
  | "cancelled"
  | "dispatch_intent_uncommitted"
  | "dispatch_ambiguous"
  | "provider_activity_unobserved"
  | "cancel_terminal_unobserved"
  | "active_unpersisted"
  | "terminal_observation_failed"
  | "terminal_evidence_unreconciled"
  | "terminal_finalize_failed"
  | "lease_release_failed"
  | "unexpected_fault";

export interface AdmissionPromptRecoveryContext<TProcessIdentity> {
  readonly fence: LeaseFence;
  readonly phase: AdmissionPromptDispatchPhase;
  readonly reason: AdmissionPromptDispatchFault;
  readonly processRecord?: AgyDispatchProcessRecord<TProcessIdentity>;
}

export type AdmissionPromptPreDispatchResolution =
  | Readonly<{ state: "queued" }>
  | Readonly<{ state: "recovery_required" }>;

/**
 * This owner is the only route back to `queued`. It may return `queued` only
 * after durable, fenced proof that neither dispatch intent nor a prompt write
 * occurred. Any missing proof must produce `recovery_required`.
 */
export interface AdmissionPromptRecoveryOwner<TProcessIdentity> {
  recoverPreDispatch(
    context: AdmissionPromptRecoveryContext<TProcessIdentity>
  ): MaybePromise<AdmissionPromptPreDispatchResolution>;
  /** Must durably retain uncertainty; it must never enqueue a replay. */
  recordRecoveryRequired(context: AdmissionPromptRecoveryContext<TProcessIdentity>): MaybePromise<void>;
}

/** Provider activity must already include durable conversation/session binding. */
export interface AdmissionPromptProviderContext extends AgyDispatchFence {
  readonly sessionId: string;
  readonly parentId: string;
  readonly provider: string;
  readonly model: string;
}

export type AdmissionPromptProviderActivity =
  | Readonly<{ status: "observed" }>
  | Readonly<{ status: "terminal_observed" }>;

export interface AdmissionPromptTerminalObservation {
  readonly observations: ProviderTerminalObservations;
  /** `requestId` and `now` are derived from the current durable lease. */
  readonly delivery: Omit<EnqueueDelivery, "requestId" | "now">;
}

export interface AdmissionPromptProviderObserver {
  observeProviderActivity(context: AdmissionPromptProviderContext): MaybePromise<AdmissionPromptProviderActivity>;
  observeTerminal(context: AdmissionPromptProviderContext): MaybePromise<AdmissionPromptTerminalObservation>;
}

export type AdmissionPromptDispatchOutcome =
  | Readonly<{ state: "completed"; stopReason: "end_turn" }>
  | Readonly<{ state: "failed"; stopReason: "end_turn" }>
  | Readonly<{ state: "cancelled"; stopReason: "cancelled" }>
  | Readonly<{ state: "queued"; reason: AdmissionPromptDispatchFault | "no_eligible_request" }>
  | Readonly<{ state: "dispatch_ambiguous"; reason: AdmissionPromptDispatchFault }>
  | Readonly<{ state: "recovery_required"; reason: AdmissionPromptDispatchFault }>;

export type AdmissionPromptDispatchNonTerminalOutcome = Exclude<
  AdmissionPromptDispatchOutcome,
  { readonly stopReason: AdmissionPromptStopReason }
>;

export class AdmissionPromptDispatchError extends Error {
  readonly outcome: AdmissionPromptDispatchNonTerminalOutcome;

  constructor(outcome: AdmissionPromptDispatchNonTerminalOutcome) {
    super(`admission prompt dispatch ended in ${outcome.state}: ${outcome.reason}`);
    this.name = "AdmissionPromptDispatchError";
    this.outcome = outcome;
  }
}

export interface AdmissionPromptDispatcherOptions<TProcess, TProcessIdentity> {
  readonly controller: AdmissionPromptDispatchController;
  readonly ownerInstanceId: string;
  /** Optional launcher; undefined preserves a direct process start for this opt-in bridge. */
  readonly startupLauncher?: AgyStartupLauncher;
  readonly lifecycle: AdmissionPromptProcessLifecycleOwner<TProcessIdentity>;
  readonly agy: AdmissionPromptAgyContract<TProcess, TProcessIdentity>;
  readonly provider: AdmissionPromptProviderObserver;
  readonly recovery: AdmissionPromptRecoveryOwner<TProcessIdentity>;
  readonly now?: () => number;
}

/** Runtime-owned construction supplies the controller and any fresh-PTY verifier. */
export type AdmissionRuntimePromptDispatcherOptions<TProcess, TProcessIdentity> = Omit<
  AdmissionPromptDispatcherOptions<TProcess, TProcessIdentity>,
  "controller"
> & {
  /** Omit this to fail closed for PTY while preserving the stdin dispatch path. */
  readonly freshPtyCanary?: AdmissionRuntimeFreshPtyCanaryOptions;
};

type RuntimeOwnedFreshPtyCanaryVerifier<TProcessIdentity> = (
  businessPrompt: string,
  record: AgyDispatchProcessRecord<TProcessIdentity>
) => AgyFreshPtyCanaryResult;

const RUNTIME_OWNED_FRESH_PTY_CANARY = Symbol("runtime-owned-fresh-pty-canary");

type AdmissionPromptDispatcherInternalOptions<TProcess, TProcessIdentity> =
  AdmissionPromptDispatcherOptions<TProcess, TProcessIdentity> & {
    readonly [RUNTIME_OWNED_FRESH_PTY_CANARY]?: RuntimeOwnedFreshPtyCanaryVerifier<TProcessIdentity>;
  };

/**
 * Coordinates one already-claimed ACP prompt through durable admission.
 *
 * It intentionally has no loop and no retry path. A pre-dispatch transition
 * may become queued only through the injected recovery proof owner; once an
 * intent commit or prompt write may have happened, the only automatic outcome
 * is dispatch_ambiguous or recovery_required.
 */
export class AdmissionPromptDispatcher<TProcess, TProcessIdentity> {
  readonly #controller: AdmissionPromptDispatchController;
  readonly #ownerInstanceId: string;
  readonly #startupLauncher: AgyStartupLauncher | undefined;
  readonly #lifecycle: AdmissionPromptProcessLifecycleOwner<TProcessIdentity>;
  readonly #agy: AdmissionPromptAgyContract<TProcess, TProcessIdentity>;
  readonly #provider: AdmissionPromptProviderObserver;
  readonly #recovery: AdmissionPromptRecoveryOwner<TProcessIdentity>;
  readonly #now: () => number;
  readonly #runtimeOwnedFreshPtyCanaryVerifier: RuntimeOwnedFreshPtyCanaryVerifier<TProcessIdentity> | undefined;
  readonly #inFlight = new Set<string>();
  #closed = false;

  constructor(options: AdmissionPromptDispatcherOptions<TProcess, TProcessIdentity>) {
    const internalOptions = options as AdmissionPromptDispatcherInternalOptions<TProcess, TProcessIdentity>;
    this.#controller = options.controller;
    this.#ownerInstanceId = requireIdentifier(options.ownerInstanceId, "ownerInstanceId");
    this.#startupLauncher = options.startupLauncher;
    this.#lifecycle = options.lifecycle;
    this.#agy = options.agy;
    this.#provider = options.provider;
    this.#recovery = options.recovery;
    this.#now = options.now ?? Date.now;
    this.#runtimeOwnedFreshPtyCanaryVerifier = internalOptions[RUNTIME_OWNED_FRESH_PTY_CANARY];
  }

  /** Adapter for `AdmissionPromptSeam`; non-terminal outcomes reject visibly. */
  readonly dispatch: AdmissionPromptDispatchHook = async (input) => {
    const outcome = await this.run(input);
    if (isTerminalOutcome(outcome)) return outcome.stopReason;
    throw new AdmissionPromptDispatchError(outcome);
  };

  close(): void {
    this.#closed = true;
  }

  /** A richer result for queue workers and fault-injection tests. */
  async run(input: AdmissionPromptDispatchInput): Promise<AdmissionPromptDispatchOutcome> {
    if (this.#closed) return Object.freeze({ state: "recovery_required", reason: "unexpected_fault" });
    const requestId = safeRequestId(input);
    if (requestId === null) return Object.freeze({ state: "recovery_required", reason: "unexpected_fault" });
    if (this.#inFlight.has(requestId)) {
      return Object.freeze({ state: "recovery_required", reason: "unexpected_fault" });
    }

    this.#inFlight.add(requestId);
    try {
      return await this.runOnce(input, requestId);
    } finally {
      this.#inFlight.delete(requestId);
    }
  }

  private async runOnce(input: AdmissionPromptDispatchInput, requestId: string): Promise<AdmissionPromptDispatchOutcome> {
    let now: number;
    try {
      now = this.now();
    } catch {
      return Object.freeze({ state: "recovery_required", reason: "unexpected_fault" });
    }

    let lease: AdmissionLease | null;
    try {
      lease = this.#controller.admitRequest(requestId, now, this.#ownerInstanceId);
    } catch {
      // AdmissionController's admission operation is an atomic transaction.
      return Object.freeze({ state: "queued", reason: "admission_failed" });
    }
    if (lease === null) return Object.freeze({ state: "queued", reason: "no_eligible_request" });

    let phase: AdmissionPromptDispatchPhase = "admitted";
    let processRecord: AgyDispatchProcessRecord<TProcessIdentity> | undefined;
    let result: AdmissionPromptDispatchOutcome = Object.freeze({ state: "recovery_required", reason: "unexpected_fault" });

    try {
      try {
        this.#controller.markStarting(lease, now);
        phase = "starting";
      } catch {
        result = await this.recoverPreDispatch(lease, phase, processRecord, "mark_start_failed");
      }

      if (result.state === "recovery_required" && result.reason === "unexpected_fault") {
        let prompt: string;
        try {
          prompt = this.#controller.readPayload(lease.requestId, now);
        } catch {
          result = await this.recoverPreDispatch(lease, phase, processRecord, "payload_unavailable");
          prompt = "";
        }

        if (result.state === "recovery_required" && result.reason === "unexpected_fault") {
          result = await this.startAndObserve(input, lease, prompt, now, (record) => {
            processRecord = record;
          }, (nextPhase) => {
            phase = nextPhase;
          });
        }
      }
    } catch {
      result = await this.recoverRequired(lease, phase, processRecord, "unexpected_fault");
    }
    return result;
  }

  private async startAndObserve(
    input: AdmissionPromptDispatchInput,
    lease: AdmissionLease,
    prompt: string,
    now: number,
    onRecord: (record: AgyDispatchProcessRecord<TProcessIdentity>) => void,
    onPhase: (phase: AdmissionPromptDispatchPhase) => void
  ): Promise<AdmissionPromptDispatchOutcome> {
    const spawnContext = createAdmissionPromptAgySpawnContext(lease, claimSignal(input));
    try {
      return await this.startAndObserveIssued(
        input,
        lease,
        prompt,
        now,
        onRecord,
        onPhase,
        spawnContext
      );
    } finally {
      try {
        this.#agy.discardPromptFree?.(spawnContext);
      } catch {
        // Cleanup failure cannot rewrite the durable dispatch outcome.
      }
    }
  }

  private async startAndObserveIssued(
    input: AdmissionPromptDispatchInput,
    lease: AdmissionLease,
    prompt: string,
    now: number,
    onRecord: (record: AgyDispatchProcessRecord<TProcessIdentity>) => void,
    onPhase: (phase: AdmissionPromptDispatchPhase) => void,
    spawnContext: AdmissionPromptAgySpawnContext
  ): Promise<AdmissionPromptDispatchOutcome> {
    let record: AgyDispatchProcessRecord<TProcessIdentity> | undefined;
    let lastRevalidation: AgyDispatchCancellationRecheck | undefined;
    let durableIntentRecorded = false;
    let intentReplayConfirmed = false;

    const boundary = new AgyPromptFreeDispatchBoundary<TProcess, TProcessIdentity>(
      prompt,
      freezeFence(lease),
      {
        spawnPromptFree: () => this.startPromptFree(spawnContext),
        persistProcessIdentity: (candidate) => {
          record = candidate;
          onRecord(candidate);
          const persisted = this.recordProcessIdentity(candidate);
          if (persisted.status === "recorded") {
            durableIntentRecorded = true;
            onPhase("dispatch_intent");
          }
          return persisted;
        },
        recheckCancellation: (candidate) => {
          const revalidation = this.revalidate(candidate, input);
          lastRevalidation = revalidation;
          return revalidation;
        },
        commitDispatchIntent: (candidate) => {
          if (record !== candidate) return { status: "not_committed" };
          const committed = this.commitDispatchIntent(candidate);
          if (committed.status === "committed") {
            intentReplayConfirmed = true;
          }
          return committed;
        },
        verifyFreshPtyCanary: this.#runtimeOwnedFreshPtyCanaryVerifier === undefined
          ? undefined
          : (candidate) => this.#runtimeOwnedFreshPtyCanaryVerifier!(prompt, candidate)
      }
    );

    let boundaryResult;
    try {
      boundaryResult = boundary.run();
    } catch {
      return durableIntentRecorded
        ? await this.markDispatchAmbiguous(lease, record, "dispatch_ambiguous", now)
        : await this.recoverPreDispatch(lease, "starting", record, "unexpected_fault");
    }

    if (boundaryResult.state === "dispatch_ambiguous") {
      return await this.markDispatchAmbiguous(lease, record, "dispatch_ambiguous", now);
    }
    if (boundaryResult.state === "blocked") {
      if (durableIntentRecorded) return await this.markDispatchAmbiguous(lease, record, "dispatch_ambiguous", now);
      return await this.recoverPreDispatch(
        lease,
        "starting",
        record,
        faultForBlockedBoundary(boundaryResult.reason, lastRevalidation)
      );
    }
    if (!durableIntentRecorded || !intentReplayConfirmed || record === undefined) {
      return await this.recoverRequired(lease, "dispatch_intent", record, "unexpected_fault");
    }

    const context = providerContext(input, lease);
    try {
      const activity = await this.#provider.observeProviderActivity(context);
      if (!isObservedActivity(activity)) throw new Error("provider activity was not observed");
    } catch {
      if (isClaimCancelled(input)) {
        return await this.recoverRequired(lease, "dispatch_intent", record, "cancel_terminal_unobserved");
      }
      return await this.markDispatchAmbiguous(lease, record, "provider_activity_unobserved", now);
    }

    try {
      this.#controller.markActive(lease, now);
      onPhase("active");
    } catch {
      return await this.markDispatchAmbiguous(lease, record, "active_unpersisted", now);
    }

    let terminal: AdmissionPromptTerminalObservation;
    try {
      terminal = await this.#provider.observeTerminal(context);
      if (!isTerminalObservation(terminal)) throw new Error("terminal observation is malformed");
    } catch {
      return await this.recoverRequired(
        lease,
        "active",
        record,
        isClaimCancelled(input) ? "cancel_terminal_unobserved" : "terminal_observation_failed"
      );
    }

    let confirmation;
    try {
      const evidenceInput = parseTerminalEvidenceInput(terminal.observations);
      confirmation = evidenceInput === null ? null : confirmTerminalEvidence(evidenceInput);
    } catch {
      return await this.recoverRequired(lease, "active", record, "terminal_evidence_unreconciled");
    }
    if (confirmation === null || confirmation.outcome !== "confirmed") {
      return await this.recoverRequired(lease, "active", record, "terminal_evidence_unreconciled");
    }
    if (
      isClaimCancelled(input) &&
      confirmation.status !== "CANCELED" &&
      confirmation.status !== "INTERRUPTED"
    ) {
      return await this.recoverRequired(lease, "active", record, "cancel_terminal_unobserved");
    }

    try {
      this.#controller.markProviderTerminal(lease, now, terminal.observations, {
        ...terminal.delivery,
        requestId: lease.requestId,
        now
      });
      onPhase("provider_terminal");
    } catch {
      return await this.recoverRequired(lease, "active", record, "terminal_finalize_failed");
    }

    try {
      this.#controller.release(lease, now);
      onPhase("released");
    } catch {
      return await this.recoverRequired(lease, "provider_terminal", record, "lease_release_failed");
    }

    switch (confirmation.status) {
      case "SUCCESS":
        return Object.freeze({ state: "completed", stopReason: "end_turn" });
      case "ERROR":
        return Object.freeze({ state: "failed", stopReason: "end_turn" });
      case "CANCELED":
      case "INTERRUPTED":
        return Object.freeze({ state: "cancelled", stopReason: "cancelled" });
    }
  }

  private startPromptFree(
    context: AdmissionPromptAgySpawnContext
  ): AgyDispatchProcess<TProcess, TProcessIdentity> {
    const candidate = launchAgyProcess(
      this.#startupLauncher,
      "model_turn",
      () => this.#agy.spawnPromptFree(context)
    );
    if (!isPromptFreeCandidate(candidate)) throw new Error("prompt-free process is invalid");
    return candidate;
  }

  private recordProcessIdentity(
    record: AgyDispatchProcessRecord<TProcessIdentity>
  ): AgyDispatchIdentityPersistenceResult {
    try {
      const result = this.#lifecycle.recordProcessIdentity(record);
      return result?.status === "recorded" ? { status: "recorded" } : { status: "not_recorded" };
    } catch {
      return { status: "not_recorded" };
    }
  }

  private commitDispatchIntent(
    record: AgyDispatchProcessRecord<TProcessIdentity>
  ): AgyDispatchIntentCommitResult {
    try {
      const result = this.#lifecycle.commitDispatchIntent(record);
      return result?.status === "committed" ? { status: "committed" } : { status: "not_committed" };
    } catch {
      return { status: "not_committed" };
    }
  }

  private revalidate(
    record: AgyDispatchProcessRecord<TProcessIdentity>,
    input: AdmissionPromptDispatchInput
  ): AgyDispatchCancellationRecheck {
    let result: AgyDispatchCancellationRecheck | undefined;
    try {
      result = this.#lifecycle.revalidate(record);
    } catch {
      result = undefined;
    }
    const claimCancelled = isClaimCancelled(input);
    return Object.freeze({
      generationMatches: result?.generationMatches === true,
      ownerMatches: result?.ownerMatches === true,
      cancelled: claimCancelled || result?.cancelled === true ? true : result?.cancelled === false ? false : undefined
    });
  }

  private async recoverPreDispatch(
    lease: AdmissionLease,
    phase: Extract<AdmissionPromptDispatchPhase, "admitted" | "starting">,
    processRecord: AgyDispatchProcessRecord<TProcessIdentity> | undefined,
    reason: AdmissionPromptDispatchFault
  ): Promise<AdmissionPromptDispatchOutcome> {
    const context = recoveryContext(lease, phase, processRecord, reason);
    try {
      const resolution = await this.#recovery.recoverPreDispatch(context);
      if (resolution?.state === "queued") return Object.freeze({ state: "queued", reason });
      if (resolution?.state === "recovery_required") return Object.freeze({ state: "recovery_required", reason });
    } catch {
      // A failed recovery proof is not proof of a safe replay.
    }
    return await this.recoverRequired(lease, phase, processRecord, reason);
  }

  private async markDispatchAmbiguous(
    lease: AdmissionLease,
    processRecord: AgyDispatchProcessRecord<TProcessIdentity> | undefined,
    reason: AdmissionPromptDispatchFault,
    now: number
  ): Promise<AdmissionPromptDispatchOutcome> {
    try {
      this.#controller.markDispatchAmbiguous(lease, now);
      return Object.freeze({ state: "dispatch_ambiguous", reason });
    } catch {
      return await this.recoverRequired(lease, "dispatch_intent", processRecord, reason);
    }
  }

  private async recoverRequired(
    lease: AdmissionLease,
    phase: AdmissionPromptDispatchPhase,
    processRecord: AgyDispatchProcessRecord<TProcessIdentity> | undefined,
    reason: AdmissionPromptDispatchFault
  ): Promise<AdmissionPromptDispatchOutcome> {
    try {
      await this.#recovery.recordRecoveryRequired(recoveryContext(lease, phase, processRecord, reason));
    } catch {
      // Persisting uncertainty may itself fail; never reinterpret that as success.
    }
    return Object.freeze({ state: "recovery_required", reason });
  }

  private now(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("admission dispatch time must be a non-negative safe integer");
    return now;
  }
}

export function createAdmissionPromptDispatchHook<TProcess, TProcessIdentity>(
  options: AdmissionPromptDispatcherOptions<TProcess, TProcessIdentity>
): AdmissionPromptDispatchHook {
  return new AdmissionPromptDispatcher(options).dispatch;
}

/**
 * Bind the dispatcher to the enabled runtime's single AdmissionController.
 * The lifecycle owner still owns its process-record transaction, but it must
 * report `committed` only after it has durably advanced this same controller
 * lease to `dispatch_intent` under the supplied fence.
 */
export function createAdmissionRuntimePromptDispatcher<TProcess, TProcessIdentity>(
  runtime: AdmissionRuntime,
  options: AdmissionRuntimePromptDispatcherOptions<TProcess, TProcessIdentity>,
  runtimeOwnedFreshPtyCanaryVerifier: RuntimeOwnedFreshPtyCanaryVerifier<TProcessIdentity> | undefined
): AdmissionPromptDispatcher<TProcess, TProcessIdentity> {
  const { freshPtyCanary: _freshPtyCanary, ...dispatcherOptions } = options;
  const internalOptions: AdmissionPromptDispatcherInternalOptions<TProcess, TProcessIdentity> = {
    ...dispatcherOptions,
    controller: runtime.controller
  };
  Object.defineProperty(internalOptions, RUNTIME_OWNED_FRESH_PTY_CANARY, {
    value: runtimeOwnedFreshPtyCanaryVerifier,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return new AdmissionPromptDispatcher(internalOptions);
}

function freezeFence(lease: AdmissionLease): AgyDispatchFence {
  return Object.freeze({
    requestId: lease.requestId,
    leaseId: lease.leaseId,
    generation: lease.generation,
    ownerInstanceId: lease.ownerInstanceId
  });
}

function providerContext(input: AdmissionPromptDispatchInput, lease: AdmissionLease): AdmissionPromptProviderContext {
  return Object.freeze({
    ...freezeFence(lease),
    sessionId: input.sessionId,
    parentId: input.parentId,
    provider: input.provider,
    model: input.model
  });
}

function recoveryContext<TProcessIdentity>(
  lease: AdmissionLease,
  phase: AdmissionPromptDispatchPhase,
  processRecord: AgyDispatchProcessRecord<TProcessIdentity> | undefined,
  reason: AdmissionPromptDispatchFault
): AdmissionPromptRecoveryContext<TProcessIdentity> {
  return Object.freeze({
    fence: freezeFence(lease),
    phase,
    reason,
    ...(processRecord === undefined ? {} : { processRecord })
  });
}

function faultForBlockedBoundary(
  reason: AgyDispatchBoundaryBlockReason,
  revalidation: AgyDispatchCancellationRecheck | undefined
): AdmissionPromptDispatchFault {
  switch (reason) {
    case "cancellation_fence_failed":
      return revalidation?.cancelled === true ? "cancelled" : "revalidation_failed";
    case "fresh_pty_uncertified":
      return "fresh_pty_uncertified";
    default:
      return reason;
  }
}

function isPromptFreeCandidate<TProcess, TProcessIdentity>(
  candidate: unknown
): candidate is AgyDispatchProcess<TProcess, TProcessIdentity> {
  if (typeof candidate !== "object" || candidate === null) return false;
  const value = candidate as Partial<AgyDispatchProcess<TProcess, TProcessIdentity>>;
  return (
    value.identity !== null &&
    value.identity !== undefined &&
    (value.promptChannel === "stdin" || value.promptChannel === "pty") &&
    typeof value.writeInitialPrompt === "function"
  );
}

function isObservedActivity(value: unknown): value is AdmissionPromptProviderActivity {
  if (typeof value !== "object" || value === null) return false;
  const status = (value as { status?: unknown }).status;
  return status === "observed" || status === "terminal_observed";
}

function isTerminalObservation(value: unknown): value is AdmissionPromptTerminalObservation {
  if (!isExactPlainDataRecord(value, ["observations", "delivery"])) return false;
  return isExactPlainDataRecord((value as Record<string, unknown>).delivery, [
    "eventId",
    "fingerprint",
    "payload",
    "sequence",
    "expiresAt",
    "protocol"
  ]);
}

function isExactPlainDataRecord(value: unknown, expectedFields: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== expectedFields.length || keys.some((key) => typeof key !== "string" || !expectedFields.includes(key))) {
      return false;
    }
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
    });
  } catch {
    return false;
  }
}

function isClaimCancelled(input: AdmissionPromptDispatchInput): boolean {
  try {
    return input.claim.signal.aborted === true;
  } catch {
    return true;
  }
}

function claimSignal(input: AdmissionPromptDispatchInput): AbortSignal {
  try {
    const signal = input.claim.signal;
    if (typeof AbortSignal === "undefined" || !(signal instanceof AbortSignal)) {
      throw new Error("invalid claim signal");
    }
    return signal;
  } catch {
    throw new Error("admission dispatcher claim signal is invalid");
  }
}

function createAdmissionPromptAgySpawnContext(
  lease: AdmissionLease,
  signal: AbortSignal
): AdmissionPromptAgySpawnContext {
  const context = Object.freeze({ ...freezeFence(lease), signal });
  DISPATCHER_ISSUED_AGY_SPAWN_CONTEXTS.add(context);
  return context;
}

function safeRequestId(input: AdmissionPromptDispatchInput): string | null {
  try {
    return typeof input.requestId === "string" && input.requestId.length > 0 ? input.requestId : null;
  } catch {
    return null;
  }
}

function isTerminalOutcome(
  outcome: AdmissionPromptDispatchOutcome
): outcome is Extract<AdmissionPromptDispatchOutcome, { readonly stopReason: AdmissionPromptStopReason }> {
  return "stopReason" in outcome;
}

function requireIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`admission dispatcher ${name} must be a non-empty string without NUL`);
  }
  return value;
}
