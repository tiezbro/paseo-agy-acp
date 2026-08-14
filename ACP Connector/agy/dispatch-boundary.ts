/** Identifies the durable admission lease that fences a provider dispatch. */
export interface AgyDispatchFence {
  requestId: string;
  leaseId: string;
  generation: number;
  ownerInstanceId: string;
}

/** The two prompt transports supported by the prompt-free startup boundary. */
export type AgyDispatchPromptChannel = "stdin" | "pty";

/** Structural data safe to pass to persistence and fencing hooks. */
export interface AgyDispatchProcessRecord<TProcessIdentity> extends AgyDispatchFence {
  processIdentity: TProcessIdentity;
  promptChannel: AgyDispatchPromptChannel;
}

/** A process created without business prompt content in its startup inputs. */
export interface AgyDispatchProcess<TProcess, TProcessIdentity> {
  process: TProcess;
  identity: TProcessIdentity;
  promptChannel: AgyDispatchPromptChannel;
  /**
   * Makes the single irreversible business-prompt write. A caller may report
   * accepted only when it can prove that write; every other outcome is
   * dispatch_ambiguous and is never retried by this boundary.
   */
  writeInitialPrompt(prompt: string): AgyDispatchWriteResult;
}

/** Only a positive, synchronous result proves the initial write. */
export type AgyDispatchWriteResult = { status: "accepted" } | { status: "ambiguous" } | undefined;

/**
 * A recorded identity includes the durable dispatch intent. Any following
 * cancellation fence or exact-replay failure must retain that uncertainty.
 */
export type AgyDispatchIdentityPersistenceResult = { status: "recorded" } | { status: "not_recorded" };

/** A dispatch-intent commit must have crossed its durability boundary before success. */
export type AgyDispatchIntentCommitResult = { status: "committed" } | { status: "not_committed" };

/**
 * The recheck is fenced by the same durable identity/lease record passed to
 * the hook. `cancelled` must be explicitly false before a write is allowed.
 */
export interface AgyDispatchCancellationRecheck {
  generationMatches: boolean;
  ownerMatches: boolean;
  cancelled?: boolean;
}

/**
 * Fresh prompt-free PTY startup is deliberately unsupported unless a
 * version-specific fake canary explicitly verifies the transport. The CLI
 * never supplies this hook by default.
 */
export type AgyFreshPtyCanaryResult = { status: "verified" } | { status: "unverified" };

/**
 * All boundary hooks are synchronous. In particular, a Promise returned by a
 * hook is not a durability proof and therefore fails closed at runtime.
 */
export interface AgyDispatchBoundaryDependencies<TProcess, TProcessIdentity> {
  /** Must spawn the provider with no business prompt in argv or environment. */
  spawnPromptFree(): AgyDispatchProcess<TProcess, TProcessIdentity>;
  persistProcessIdentity(
    record: AgyDispatchProcessRecord<TProcessIdentity>
  ): AgyDispatchIdentityPersistenceResult;
  recheckCancellation(
    record: AgyDispatchProcessRecord<TProcessIdentity>
  ): AgyDispatchCancellationRecheck;
  commitDispatchIntent(
    record: AgyDispatchProcessRecord<TProcessIdentity>
  ): AgyDispatchIntentCommitResult;
  /** Required for a fresh PTY candidate; omitted means fresh PTY is blocked. */
  verifyFreshPtyCanary?(
    record: AgyDispatchProcessRecord<TProcessIdentity>
  ): AgyFreshPtyCanaryResult;
}

export type AgyDispatchBoundaryBlockReason =
  | "process_start_failed"
  | "process_identity_unrecorded"
  | "fresh_pty_uncertified"
  | "cancellation_fence_failed"
  | "dispatch_intent_uncommitted";

export type AgyDispatchBoundaryResult<TProcess, TProcessIdentity> =
  | {
    state: "active";
    process: TProcess;
    record: AgyDispatchProcessRecord<TProcessIdentity>;
    promptChannel: AgyDispatchPromptChannel;
    writeAttempts: 1;
  }
  | {
    state: "blocked";
    reason: AgyDispatchBoundaryBlockReason;
    process?: TProcess;
    record?: AgyDispatchProcessRecord<TProcessIdentity>;
    writeAttempts: 0;
  }
  | {
    state: "dispatch_ambiguous";
    process: TProcess;
    record: AgyDispatchProcessRecord<TProcessIdentity>;
    writeAttempts: 0 | 1;
  };

/**
 * Synchronous irreversible-start boundary for an admitted agy turn.
 *
 * `run` intentionally contains no `await`. Once `commitDispatchIntent`
 * returns `{ status: "committed" }`, `writeInitialPrompt` is invoked before
 * control returns to the event loop. This keeps cancellation and ownership
 * checks fenced directly adjacent to the write.
 */
export class AgyPromptFreeDispatchBoundary<TProcess, TProcessIdentity> {
  #result: AgyDispatchBoundaryResult<TProcess, TProcessIdentity> | undefined;
  #running = false;

  constructor(
    private readonly prompt: string,
    private readonly fence: AgyDispatchFence,
    private readonly dependencies: AgyDispatchBoundaryDependencies<TProcess, TProcessIdentity>
  ) {}

  run(): AgyDispatchBoundaryResult<TProcess, TProcessIdentity> {
    if (this.#result) return this.#result;
    if (this.#running) {
      return { state: "blocked", reason: "process_start_failed", writeAttempts: 0 };
    }

    this.#running = true;
    try {
      return this.runOnce();
    } finally {
      this.#running = false;
    }
  }

  private runOnce(): AgyDispatchBoundaryResult<TProcess, TProcessIdentity> {
    const candidate = this.startPromptFree();
    if (!candidate) return this.block("process_start_failed");

    const record = this.recordFor(candidate);
    if (!record) return this.block("process_identity_unrecorded", candidate.process);

    if (candidate.promptChannel === "pty" && !this.verifyFreshPtyCanary(record)) {
      return this.block("fresh_pty_uncertified", candidate.process, record);
    }

    if (!this.persistProcessIdentity(record)) {
      return this.block("process_identity_unrecorded", candidate.process, record);
    }

    if (!this.recheckCancellation(record)) {
      return this.ambiguous(candidate.process, record, 0);
    }

    if (!this.commitDispatchIntent(record)) {
      return this.ambiguous(candidate.process, record, 0);
    }

    // Do not insert an await, callback, or deferred write after this point.
    // A successful commit and the first prompt byte must share this stack.
    try {
      const write = candidate.writeInitialPrompt(this.prompt);
      if (write?.status !== "accepted") return this.ambiguous(candidate.process, record, 1);
    } catch {
      return this.ambiguous(candidate.process, record, 1);
    }

    return this.finish({
      state: "active",
      process: candidate.process,
      record,
      promptChannel: candidate.promptChannel,
      writeAttempts: 1
    });
  }

  private startPromptFree(): AgyDispatchProcess<TProcess, TProcessIdentity> | null {
    try {
      const candidate = this.dependencies.spawnPromptFree();
      return isDispatchProcess(candidate) ? candidate : null;
    } catch {
      return null;
    }
  }

  private recordFor(
    candidate: AgyDispatchProcess<TProcess, TProcessIdentity>
  ): AgyDispatchProcessRecord<TProcessIdentity> | null {
    if (candidate.identity === null || candidate.identity === undefined) return null;
    return {
      ...this.fence,
      processIdentity: candidate.identity,
      promptChannel: candidate.promptChannel
    };
  }

  private verifyFreshPtyCanary(record: AgyDispatchProcessRecord<TProcessIdentity>): boolean {
    try {
      return this.dependencies.verifyFreshPtyCanary?.(record).status === "verified";
    } catch {
      return false;
    }
  }

  private persistProcessIdentity(record: AgyDispatchProcessRecord<TProcessIdentity>): boolean {
    try {
      return this.dependencies.persistProcessIdentity(record).status === "recorded";
    } catch {
      return false;
    }
  }

  private recheckCancellation(record: AgyDispatchProcessRecord<TProcessIdentity>): boolean {
    try {
      const result = this.dependencies.recheckCancellation(record);
      return result.generationMatches === true && result.ownerMatches === true && result.cancelled === false;
    } catch {
      return false;
    }
  }

  private commitDispatchIntent(record: AgyDispatchProcessRecord<TProcessIdentity>): boolean {
    try {
      return this.dependencies.commitDispatchIntent(record).status === "committed";
    } catch {
      return false;
    }
  }

  private block(
    reason: AgyDispatchBoundaryBlockReason,
    process?: TProcess,
    record?: AgyDispatchProcessRecord<TProcessIdentity>
  ): AgyDispatchBoundaryResult<TProcess, TProcessIdentity> {
    return this.finish({ state: "blocked", reason, process, record, writeAttempts: 0 });
  }

  private ambiguous(
    process: TProcess,
    record: AgyDispatchProcessRecord<TProcessIdentity>,
    writeAttempts: 0 | 1
  ): AgyDispatchBoundaryResult<TProcess, TProcessIdentity> {
    return this.finish({ state: "dispatch_ambiguous", process, record, writeAttempts });
  }

  private finish(
    result: AgyDispatchBoundaryResult<TProcess, TProcessIdentity>
  ): AgyDispatchBoundaryResult<TProcess, TProcessIdentity> {
    this.#result = result;
    return result;
  }
}

function isDispatchProcess<TProcess, TProcessIdentity>(
  value: unknown
): value is AgyDispatchProcess<TProcess, TProcessIdentity> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AgyDispatchProcess<TProcess, TProcessIdentity>>;
  return (
    (candidate.promptChannel === "stdin" || candidate.promptChannel === "pty") &&
    typeof candidate.writeInitialPrompt === "function"
  );
}
