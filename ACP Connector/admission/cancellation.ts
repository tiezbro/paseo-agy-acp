import { isSameLinuxProcessIdentity, type LinuxProcessIdentity } from "../../Admission Controller/process-evidence.js";

export const LOCAL_CANCELLATION_PHASES = Object.freeze(["interrupt", "terminate", "kill"] as const);

export type LocalCancellationPhase = (typeof LOCAL_CANCELLATION_PHASES)[number];

/** The only identity states permitted from the injected process verifier. */
export type LocalProcessIdentityState = "same" | "gone" | "pid_reused" | "unverifiable";

export type LocalProcessResidueState = "empty" | "present" | "unverifiable";

/**
 * Proof taken after an escalation phase. `root` is always evaluated against
 * the immutable identity provided to the escalator, never PID existence alone.
 */
export interface LocalProcessResidueProof {
  readonly root: LocalProcessIdentityState;
  readonly residue: LocalProcessResidueState;
}

export interface LocalProcessCancellationTimeouts {
  readonly interruptMs: number;
  readonly terminateMs: number;
  readonly killMs: number;
}

export interface LocalProcessCancellationRequest {
  readonly identity: LinuxProcessIdentity;
  readonly timeouts: LocalProcessCancellationTimeouts;
}

/**
 * All potentially effectful operations are injected. The integration layer is
 * responsible for mapping a phase to its platform-specific local signal.
 */
export interface LocalProcessCancellationDependencies {
  reverifyIdentity(identity: LinuxProcessIdentity): Promise<LocalProcessIdentityState>;
  signal(phase: LocalCancellationPhase, identity: LinuxProcessIdentity): Promise<void>;
  wait(timeoutMs: number): Promise<void>;
  queryResidue(identity: LinuxProcessIdentity): Promise<LocalProcessResidueProof>;
}

export type LocalProcessCancellationRecoveryReason =
  | "pid_reused"
  | "identity_unverifiable"
  | "identity_reverification_failed"
  | "invalid_identity_proof"
  | "signal_failed"
  | "wait_failed"
  | "residue_query_failed"
  | "invalid_residue_proof"
  | "residue_present"
  | "residue_unverifiable"
  | "root_still_present";

interface LocalCancellationSafetyBoundary {
  readonly providerCancellation: "unconfirmed";
  readonly businessTurn: "not_retried";
  readonly attemptedPhases: readonly LocalCancellationPhase[];
}

/**
 * This outcome proves only local process-tree termination. It deliberately
 * does not claim that the provider accepted, observed, or settled a cancel.
 */
export interface LocallyTerminated extends LocalCancellationSafetyBoundary {
  readonly outcome: "locally_terminated";
  readonly terminalPhase: LocalCancellationPhase | "already_gone";
}

export interface RecoveryRequired extends LocalCancellationSafetyBoundary {
  readonly outcome: "recovery_required";
  readonly reason: LocalProcessCancellationRecoveryReason;
}

export type LocalProcessCancellationResult = LocallyTerminated | RecoveryRequired;

export class LocalProcessCancellationConfigurationError extends Error {
  constructor(message: string) {
    super(`local process cancellation configuration error: ${message}`);
    this.name = "LocalProcessCancellationConfigurationError";
  }
}

/**
 * Escalate only local process cancellation. Provider cancellation and replay
 * are intentionally outside this API so neither can be inferred or retried.
 */
export class LocalProcessCancellationEscalator {
  readonly #dependencies: LocalProcessCancellationDependencies;

  constructor(dependencies: LocalProcessCancellationDependencies) {
    this.#dependencies = validateDependencies(dependencies);
  }

  cancel(request: LocalProcessCancellationRequest): Promise<LocalProcessCancellationResult> {
    const { identity, timeouts } = validateRequest(request);
    return this.cancelWith(identity, timeouts);
  }

  private async cancelWith(
    identity: LinuxProcessIdentity,
    timeouts: LocalProcessCancellationTimeouts
  ): Promise<LocalProcessCancellationResult> {
    const attemptedPhases: LocalCancellationPhase[] = [];

    for (const phase of LOCAL_CANCELLATION_PHASES) {
      const identityState = await this.reverify(identity);
      if (identityState === "pid_reused") return recovery(attemptedPhases, "pid_reused");
      if (identityState === "unverifiable") return recovery(attemptedPhases, "identity_unverifiable");
      if (identityState === null) return recovery(attemptedPhases, "identity_reverification_failed");
      if (identityState === "gone") {
        return this.settleWithoutSignal(identity, attemptedPhases);
      }

      attemptedPhases.push(phase);
      const signalFailed = !(await this.signal(phase, identity));
      if (signalFailed) {
        const proof = await this.queryResidue(identity);
        if (isTerminated(proof)) return locallyTerminated(attemptedPhases, phase);
        return recovery(attemptedPhases, "signal_failed");
      }

      const waitFailed = !(await this.wait(timeoutsFor(phase, timeouts)));
      const proof = await this.queryResidue(identity);
      if (isTerminated(proof)) return locallyTerminated(attemptedPhases, phase);
      if (waitFailed) return recovery(attemptedPhases, "wait_failed");
      if (proof === null) return recovery(attemptedPhases, "residue_query_failed");

      const proofFailure = proofFailureReason(proof);
      if (proofFailure !== null) return recovery(attemptedPhases, proofFailure);
      if (phase === "kill") return recovery(attemptedPhases, "root_still_present");
    }

    return recovery(attemptedPhases, "root_still_present");
  }

  private async reverify(identity: LinuxProcessIdentity): Promise<LocalProcessIdentityState | null> {
    try {
      const state = await this.#dependencies.reverifyIdentity(identity);
      return isIdentityState(state) ? state : null;
    } catch {
      return null;
    }
  }

  private async signal(phase: LocalCancellationPhase, identity: LinuxProcessIdentity): Promise<boolean> {
    try {
      await this.#dependencies.signal(phase, identity);
      return true;
    } catch {
      return false;
    }
  }

  private async wait(timeoutMs: number): Promise<boolean> {
    try {
      await this.#dependencies.wait(timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  private async settleWithoutSignal(
    identity: LinuxProcessIdentity,
    attemptedPhases: LocalCancellationPhase[]
  ): Promise<LocalProcessCancellationResult> {
    const proof = await this.queryResidue(identity);
    if (isTerminated(proof)) return locallyTerminated(attemptedPhases, "already_gone");
    if (proof === null) return recovery(attemptedPhases, "residue_query_failed");
    return recovery(attemptedPhases, proofFailureReason(proof) ?? "root_still_present");
  }

  private async queryResidue(identity: LinuxProcessIdentity): Promise<LocalProcessResidueProof | null> {
    try {
      const proof = await this.#dependencies.queryResidue(identity);
      return isResidueProof(proof) ? proof : null;
    } catch {
      return null;
    }
  }
}

function validateDependencies(value: unknown): LocalProcessCancellationDependencies {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as LocalProcessCancellationDependencies).reverifyIdentity !== "function" ||
    typeof (value as LocalProcessCancellationDependencies).signal !== "function" ||
    typeof (value as LocalProcessCancellationDependencies).wait !== "function" ||
    typeof (value as LocalProcessCancellationDependencies).queryResidue !== "function"
  ) {
    throw new LocalProcessCancellationConfigurationError("dependencies must provide identity, signal, wait, and residue operations");
  }
  return value as LocalProcessCancellationDependencies;
}

function validateRequest(request: unknown): {
  identity: LinuxProcessIdentity;
  timeouts: LocalProcessCancellationTimeouts;
} {
  if (typeof request !== "object" || request === null || Array.isArray(request)) {
    throw new LocalProcessCancellationConfigurationError("request must be an object");
  }
  const candidate = request as Partial<LocalProcessCancellationRequest>;
  if (!isCompleteLinuxProcessIdentity(candidate.identity)) {
    throw new LocalProcessCancellationConfigurationError("identity must contain complete immutable Linux process evidence");
  }
  if (typeof candidate.timeouts !== "object" || candidate.timeouts === null || Array.isArray(candidate.timeouts)) {
    throw new LocalProcessCancellationConfigurationError("timeouts must be an object");
  }

  const timeouts = candidate.timeouts as LocalProcessCancellationTimeouts;
  for (const [name, value] of [
    ["interruptMs", timeouts.interruptMs],
    ["terminateMs", timeouts.terminateMs],
    ["killMs", timeouts.killMs]
  ] as const) {
    if (!isExactTimeout(value)) {
      throw new LocalProcessCancellationConfigurationError(`${name} must be a non-negative safe integer`);
    }
  }

  const identity = candidate.identity;
  return {
    identity: Object.freeze({
      bootId: identity.bootId,
      pid: identity.pid,
      startTimeTicks: identity.startTimeTicks,
      pidNamespaceInode: identity.pidNamespaceInode,
      ppid: identity.ppid,
      pgrp: identity.pgrp,
      session: identity.session
    }),
    timeouts: Object.freeze({
      interruptMs: timeouts.interruptMs,
      terminateMs: timeouts.terminateMs,
      killMs: timeouts.killMs
    })
  };
}

function isExactTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCompleteLinuxProcessIdentity(value: unknown): value is LinuxProcessIdentity {
  return isSameLinuxProcessIdentity(value, value);
}

function timeoutsFor(phase: LocalCancellationPhase, timeouts: LocalProcessCancellationTimeouts): number {
  switch (phase) {
    case "interrupt":
      return timeouts.interruptMs;
    case "terminate":
      return timeouts.terminateMs;
    case "kill":
      return timeouts.killMs;
  }
}

function isIdentityState(value: unknown): value is LocalProcessIdentityState {
  return value === "same" || value === "gone" || value === "pid_reused" || value === "unverifiable";
}

function isResidueState(value: unknown): value is LocalProcessResidueState {
  return value === "empty" || value === "present" || value === "unverifiable";
}

function isResidueProof(value: unknown): value is LocalProcessResidueProof {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proof = value as LocalProcessResidueProof;
  return isIdentityState(proof.root) && isResidueState(proof.residue);
}

function isTerminated(proof: LocalProcessResidueProof | null): proof is LocalProcessResidueProof {
  return proof?.root === "gone" && proof.residue === "empty";
}

function proofFailureReason(proof: LocalProcessResidueProof): LocalProcessCancellationRecoveryReason | null {
  if (proof.root === "pid_reused") return "pid_reused";
  if (proof.root === "unverifiable") return "identity_unverifiable";
  if (proof.residue === "unverifiable") return "residue_unverifiable";
  if (proof.root === "gone" && proof.residue === "present") return "residue_present";
  return null;
}

function locallyTerminated(
  attemptedPhases: LocalCancellationPhase[],
  terminalPhase: LocalCancellationPhase | "already_gone"
): LocallyTerminated {
  return Object.freeze({
    outcome: "locally_terminated",
    providerCancellation: "unconfirmed",
    businessTurn: "not_retried",
    attemptedPhases: Object.freeze([...attemptedPhases]),
    terminalPhase
  });
}

function recovery(
  attemptedPhases: LocalCancellationPhase[],
  reason: LocalProcessCancellationRecoveryReason
): RecoveryRequired {
  return Object.freeze({
    outcome: "recovery_required",
    providerCancellation: "unconfirmed",
    businessTurn: "not_retried",
    attemptedPhases: Object.freeze([...attemptedPhases]),
    reason
  });
}
