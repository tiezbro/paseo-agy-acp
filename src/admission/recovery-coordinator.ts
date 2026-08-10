import type {
  AdmissionController,
  RecoveryResolutionAttestations
} from "./controller.js";
import {
  validateRecoveryClaimToken,
  type AcceptedRecoveryResolutionPlan,
  type RecoveryClaimToken,
  type RecoveryResolutionPlan
} from "./recovery-resolution.js";
import {
  verifyLinuxPreDispatchTerminationProof,
  type LinuxPreDispatchProofVerifier,
  type LinuxPreDispatchTerminationProof
} from "./process-evidence.js";
import type {
  LinuxPreDispatchRecoveryResult,
  LinuxProcessLifecycleAdapter,
  LinuxProcessLifecycleRecord
} from "./process-lifecycle.js";

const MAX_IDENTIFIER_LENGTH = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const HMAC_PATTERN = /^[0-9a-f]{64}$/;

/** The durable controller operations required to coordinate automatic recovery. */
export type AdmissionRecoveryController = Pick<
  AdmissionController,
  "recoverOwner" | "createRecoveryResolutionAttestations" | "resolveRecovery"
>;

/**
 * The recovery-only observation surface of LinuxProcessLifecycleAdapter.
 *
 * `recoverPreDispatch` is a proof-only observation. This coordinator is the
 * sole owner of durable recovery resolution through controller APIs.
 */
export type RecoveryLifecycleObserver = Pick<
  LinuxProcessLifecycleAdapter,
  "observeHeartbeat" | "recoverPreDispatch"
>;

export interface AdmissionRecoveryCoordinatorOptions {
  readonly controller: AdmissionRecoveryController;
  readonly lifecycle: RecoveryLifecycleObserver;
  readonly claimantInstanceId: string;
  readonly preDispatchProofVerifier: LinuxPreDispatchProofVerifier;
}

export interface AdmissionRecoveryHeartbeatRequest {
  readonly leaseId: string;
  readonly heartbeatAt: number;
  readonly now: number;
  readonly ownerSuspectAfterMs: number;
}

export interface AdmissionRecoveryPreDispatchRequest {
  readonly claim: RecoveryClaimToken;
  readonly record: LinuxProcessLifecycleRecord;
  readonly now: number;
}

export type AdmissionRecoveryRequiredReason =
  | "invalid_request"
  | "observation_unverifiable"
  | "owner_suspect"
  | "claim_unavailable"
  | "claim_mismatch"
  | "unverifiable_evidence"
  | "evidence_not_verified"
  | "forged_proof"
  | "stale_proof"
  | "resolution_rejected"
  | "closed";

export interface AdmissionRecoveryRequired {
  readonly outcome: "recovery_required";
  readonly reason: AdmissionRecoveryRequiredReason;
  readonly claim?: RecoveryClaimToken;
}

export type AdmissionRecoveryHeartbeatResult = Readonly<{ outcome: "current" }> | AdmissionRecoveryRequired;

export type AdmissionRecoveryPreDispatchResult =
  | Readonly<{
      outcome: "requeued";
      claim: RecoveryClaimToken;
      plan: AcceptedRecoveryResolutionPlan;
    }>
  | AdmissionRecoveryRequired;

export class AdmissionRecoveryCoordinatorConfigurationError extends Error {
  constructor(message: string) {
    super(`admission recovery coordinator configuration error: ${message}`);
    this.name = "AdmissionRecoveryCoordinatorConfigurationError";
  }
}

/**
 * Coordinates the only automatic retry path. A heartbeat can open recovery,
 * but it cannot requeue. Requeue needs the lifecycle adapter's exact
 * pre-dispatch proof and a current signed durable recovery claim.
 */
export class AdmissionRecoveryCoordinator {
  readonly #controller: AdmissionRecoveryController;
  readonly #lifecycle: RecoveryLifecycleObserver;
  readonly #claimantInstanceId: string;
  readonly #preDispatchProofVerifier: LinuxPreDispatchProofVerifier;
  #closed = false;

  constructor(options: AdmissionRecoveryCoordinatorOptions) {
    const normalized = validateOptions(options);
    this.#controller = normalized.controller;
    this.#lifecycle = normalized.lifecycle;
    this.#claimantInstanceId = normalized.claimantInstanceId;
    this.#preDispatchProofVerifier = normalized.preDispatchProofVerifier;
  }

  /** Observe a heartbeat and, only for a suspect owner, open a durable claim. */
  observeHeartbeat(value: unknown): AdmissionRecoveryHeartbeatResult {
    if (this.#closed) return recoveryRequired("closed");
    const request = normalizeHeartbeatRequest(value);
    if (request === null) return recoveryRequired("invalid_request");

    let observation: unknown;
    try {
      observation = this.#lifecycle.observeHeartbeat({
        heartbeatAt: request.heartbeatAt,
        now: request.now,
        ownerSuspectAfterMs: request.ownerSuspectAfterMs
      });
    } catch {
      return recoveryRequired("observation_unverifiable");
    }

    const state = lifecycleHeartbeatState(observation);
    if (state === "current") return Object.freeze({ outcome: "current" });
    if (state !== "suspect") return recoveryRequired("observation_unverifiable");

    try {
      const claim = validateRecoveryClaimToken(
        this.#controller.recoverOwner(request.leaseId, request.now, this.#claimantInstanceId)
      );
      if (claim === null || claim.leaseId !== request.leaseId || claim.claimantInstanceId !== this.#claimantInstanceId) {
        return recoveryRequired("claim_unavailable");
      }
      return recoveryRequired("owner_suspect", claim);
    } catch {
      return recoveryRequired("claim_unavailable");
    }
  }

  /**
   * Requeue only after the lifecycle observer confirms the narrow
   * pre-dispatch condition. The recovery claim and both HMACs remain fenced
   * all the way through the controller's atomic resolution.
   */
  async recoverPreDispatch(value: unknown): Promise<AdmissionRecoveryPreDispatchResult> {
    if (this.#closed) return recoveryRequired("closed");
    const request = normalizePreDispatchRequest(value);
    if (request === null) return recoveryRequired("invalid_request");
    if (request.claim.claimantInstanceId !== this.#claimantInstanceId || !recordMatchesClaim(request.record, request.claim)) {
      return recoveryRequired("claim_mismatch");
    }

    const attestations = this.createPreDispatchAttestations(request.claim);
    if (attestations === null) return recoveryRequired("claim_mismatch", request.claim);

    let observation: LinuxPreDispatchRecoveryResult;
    try {
      observation = await this.#lifecycle.recoverPreDispatch({
        record: request.record,
        claim: request.claim,
        now: request.now,
        phase: "starting",
        dispatchIntent: "not_committed"
      });
    } catch {
      return recoveryRequired("unverifiable_evidence", request.claim);
    }

    if (this.#closed) return recoveryRequired("closed", request.claim);
    const proofStatus = preDispatchProofStatus(
      observation,
      request.record,
      request.claim,
      this.#preDispatchProofVerifier
    );
    if (proofStatus === "forged") return recoveryRequired("forged_proof", request.claim);
    if (proofStatus === "stale") return recoveryRequired("stale_proof", request.claim);
    if (proofStatus !== "verified") {
      return recoveryRequired(preDispatchFailureReason(observation), request.claim);
    }

    const resolution = Object.freeze({
      claim: request.claim,
      action: "confirmed_not_dispatched_requeue" as const,
      evidenceCode: "pre_dispatch_residue_empty" as const,
      reasonCode: "owner_lost" as const,
      actorHmac: attestations.actorHmac,
      evidenceHmac: attestations.evidenceHmac
    });

    let plan: RecoveryResolutionPlan;
    try {
      plan = this.#controller.resolveRecovery(resolution, request.now);
    } catch {
      return recoveryRequired("claim_mismatch", request.claim);
    }

    if (!isAcceptedPreDispatchPlan(plan, request.claim, attestations)) {
      return recoveryRequired("resolution_rejected", request.claim);
    }
    return Object.freeze({ outcome: "requeued", claim: request.claim, plan });
  }

  /** Satisfies the runtime bridge lifecycle without owning controller key material. */
  close(): void {
    this.#closed = true;
  }

  private createPreDispatchAttestations(claim: RecoveryClaimToken): RecoveryResolutionAttestations | null {
    try {
      const attestations = this.#controller.createRecoveryResolutionAttestations(
        claim,
        "confirmed_not_dispatched_requeue",
        "pre_dispatch_residue_empty",
        "owner_lost"
      );
      return isAttestations(attestations) ? Object.freeze(attestations) : null;
    } catch {
      return null;
    }
  }
}

function validateOptions(value: unknown): AdmissionRecoveryCoordinatorOptions {
  if (!isRecord(value)) {
    throw new AdmissionRecoveryCoordinatorConfigurationError("options must be an object");
  }

  const controller = dataValue(value, "controller");
  const lifecycle = dataValue(value, "lifecycle");
  const claimantInstanceId = dataValue(value, "claimantInstanceId");
  const preDispatchProofVerifier = dataValue(value, "preDispatchProofVerifier");
  if (
    !hasMethods(controller, ["recoverOwner", "createRecoveryResolutionAttestations", "resolveRecovery"]) ||
    !hasMethods(lifecycle, ["observeHeartbeat", "recoverPreDispatch"]) ||
    !hasMethods(preDispatchProofVerifier, ["verifyPreDispatchProof"]) ||
    !isIdentifier(claimantInstanceId)
  ) {
    throw new AdmissionRecoveryCoordinatorConfigurationError(
      "options must provide controller, lifecycle, claimant identity, and pre-dispatch proof verification"
    );
  }

  return Object.freeze({
    controller: controller as AdmissionRecoveryController,
    lifecycle: lifecycle as RecoveryLifecycleObserver,
    claimantInstanceId,
    preDispatchProofVerifier: preDispatchProofVerifier as LinuxPreDispatchProofVerifier
  });
}

function normalizeHeartbeatRequest(value: unknown): AdmissionRecoveryHeartbeatRequest | null {
  const record = exactRecord(value, ["leaseId", "heartbeatAt", "now", "ownerSuspectAfterMs"]);
  if (
    record === null ||
    !isIdentifier(record.leaseId) ||
    !isTimestamp(record.heartbeatAt) ||
    !isTimestamp(record.now) ||
    record.now < record.heartbeatAt ||
    !isPositiveSafeInteger(record.ownerSuspectAfterMs)
  ) {
    return null;
  }

  return Object.freeze({
    leaseId: record.leaseId,
    heartbeatAt: record.heartbeatAt,
    now: record.now,
    ownerSuspectAfterMs: record.ownerSuspectAfterMs
  });
}

function normalizePreDispatchRequest(value: unknown): AdmissionRecoveryPreDispatchRequest | null {
  const record = exactRecord(value, ["claim", "record", "now"]);
  if (record === null || !isTimestamp(record.now)) return null;

  const claim = validateRecoveryClaimToken(record.claim);
  if (claim === null || !isLifecycleRecord(record.record) || !recordMatchesClaim(record.record, claim)) return null;

  return Object.freeze({ claim, record: record.record, now: record.now });
}

function isLifecycleRecord(value: unknown): value is LinuxProcessLifecycleRecord {
  if (!isRecord(value)) return false;
  return (
    isIdentifier(dataValue(value, "requestId")) &&
    isIdentifier(dataValue(value, "leaseId")) &&
    isPositiveSafeInteger(dataValue(value, "generation")) &&
    isIdentifier(dataValue(value, "ownerInstanceId"))
  );
}

function recordMatchesClaim(record: LinuxProcessLifecycleRecord, claim: RecoveryClaimToken): boolean {
  return (
    record.requestId === claim.requestId &&
    record.leaseId === claim.leaseId &&
    record.generation === claim.leaseGeneration
  );
}

function lifecycleHeartbeatState(value: unknown): "current" | "suspect" | null {
  const record = exactRecord(value, ["state"]);
  if (record === null || (record.state !== "current" && record.state !== "suspect")) return null;
  return record.state;
}

function preDispatchProofStatus(
  value: unknown,
  expectedRecord: LinuxProcessLifecycleRecord,
  expectedClaim: RecoveryClaimToken,
  verifier: LinuxPreDispatchProofVerifier
): "verified" | "forged" | "stale" | "not_proven" {
  const record = exactRecord(value, ["outcome", "proof"]);
  if (record === null || record.outcome !== "proof") return "not_proven";

  const proof = verifyLinuxPreDispatchTerminationProof(record.proof, verifier);
  if (proof === null) return "forged";
  return proofMatchesCurrentRecovery(proof, expectedRecord, expectedClaim) ? "verified" : "stale";
}

function preDispatchFailureReason(value: unknown): AdmissionRecoveryRequiredReason {
  const record = exactRecord(value, ["outcome", "reason"]);
  if (record === null || record.outcome !== "not_proven" || typeof record.reason !== "string") {
    return "unverifiable_evidence";
  }
  return record.reason.endsWith("unverifiable") || record.reason === "invalid_recovery_request"
    ? "unverifiable_evidence"
    : "evidence_not_verified";
}

function proofMatchesCurrentRecovery(
  proof: LinuxPreDispatchTerminationProof,
  record: LinuxProcessLifecycleRecord,
  claim: RecoveryClaimToken
): boolean {
  try {
    const subject = proof.subject;
    const connector = record.processIdentity.connector;
    return (
      sameClaim(proof.binding, claim) &&
      subject.ownerInstanceId === record.ownerInstanceId &&
      subject.connectorCreatedAt === connector.createdAt &&
      connector.ownerInstanceId === record.ownerInstanceId &&
      subject.promptChannel === record.promptChannel &&
      sameProcessIdentity(subject.connector, connector) &&
      sameProcessIdentity(subject.child, record.processIdentity.child)
    );
  } catch {
    return false;
  }
}

function sameProcessIdentity(
  left: LinuxPreDispatchTerminationProof["subject"]["connector"],
  right: unknown
): boolean {
  if (typeof right !== "object" || right === null) return false;
  const candidate = right as Record<string, unknown>;
  try {
    return (
      left.bootId === candidate.bootId &&
      left.pid === candidate.pid &&
      left.startTimeTicks === candidate.startTimeTicks &&
      left.pidNamespaceInode === candidate.pidNamespaceInode &&
      left.ppid === candidate.ppid &&
      left.pgrp === candidate.pgrp &&
      left.session === candidate.session
    );
  } catch {
    return false;
  }
}

function isAcceptedPreDispatchPlan(
  value: unknown,
  claim: RecoveryClaimToken,
  attestations: RecoveryResolutionAttestations
): value is AcceptedRecoveryResolutionPlan {
  const record = exactRecord(value, [
    "accepted",
    "action",
    "nextState",
    "claim",
    "evidenceCode",
    "reasonCode",
    "actorHmac",
    "evidenceHmac"
  ]);
  if (
    record === null ||
    record.accepted !== true ||
    record.action !== "confirmed_not_dispatched_requeue" ||
    record.nextState !== "queued" ||
    record.evidenceCode !== "pre_dispatch_residue_empty" ||
    record.reasonCode !== "owner_lost" ||
    record.actorHmac !== attestations.actorHmac ||
    record.evidenceHmac !== attestations.evidenceHmac
  ) {
    return false;
  }

  const plannedClaim = validateRecoveryClaimToken(record.claim);
  return plannedClaim !== null && sameClaim(plannedClaim, claim);
}

function isAttestations(value: unknown): value is RecoveryResolutionAttestations {
  const record = exactRecord(value, ["actorHmac", "evidenceHmac"]);
  return record !== null && isHmac(record.actorHmac) && isHmac(record.evidenceHmac);
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | null {
  if (!isRecord(value)) return null;

  try {
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== expectedKeys.length || Object.getOwnPropertySymbols(value).length !== 0) return null;

    const result: Record<string, unknown> = Object.create(null);
    for (const key of expectedKeys) {
      if (!names.includes(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function dataValue(record: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function hasMethods(value: unknown, names: readonly string[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  try {
    return names.every((name) => typeof (value as Record<string, unknown>)[name] === "function");
  } catch {
    return false;
  }
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isHmac(value: unknown): value is string {
  return typeof value === "string" && HMAC_PATTERN.test(value);
}

function sameClaim(left: RecoveryClaimToken, right: RecoveryClaimToken): boolean {
  return (
    left.requestId === right.requestId &&
    left.leaseId === right.leaseId &&
    left.leaseGeneration === right.leaseGeneration &&
    left.recoveryGeneration === right.recoveryGeneration &&
    left.claimantInstanceId === right.claimantInstanceId
  );
}

function recoveryRequired(reason: AdmissionRecoveryRequiredReason, claim?: RecoveryClaimToken): AdmissionRecoveryRequired {
  return claim === undefined
    ? Object.freeze({ outcome: "recovery_required", reason })
    : Object.freeze({ outcome: "recovery_required", reason, claim });
}
