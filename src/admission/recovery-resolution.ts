export const RECOVERY_RESOLUTION_ACTIONS = Object.freeze([
  "confirmed_not_dispatched_requeue",
  "confirmed_completed",
  "confirmed_cancelled",
  "acknowledge_unknown_release"
] as const);

export type RecoveryResolutionAction = (typeof RECOVERY_RESOLUTION_ACTIONS)[number];

export const RECOVERY_EVIDENCE_CODES = Object.freeze([
  "pre_dispatch_residue_empty",
  "provider_completed",
  "provider_cancelled",
  "unknown_release"
] as const);

export type RecoveryEvidenceCode = (typeof RECOVERY_EVIDENCE_CODES)[number];

/** Fixed classifications only; this boundary deliberately accepts no raw operator notes. */
export const RECOVERY_REASON_CODES = Object.freeze([
  "owner_lost",
  "dispatch_ambiguous",
  "provider_terminal_unproven",
  "cancellation_unproven",
  "unknown_release"
] as const);

export type RecoveryReasonCode = (typeof RECOVERY_REASON_CODES)[number];

/**
 * A recovery claim is fenced twice: the original lease generation and the
 * recovery generation must both agree with the current recovery record.
 */
export interface RecoveryClaimToken {
  readonly requestId: string;
  readonly leaseId: string;
  readonly leaseGeneration: number;
  readonly recoveryGeneration: number;
  readonly claimantInstanceId: string;
}

export interface RecoveryResolutionContext {
  readonly state: "recovery_required";
  readonly claim: RecoveryClaimToken;
}

/** Opaque HMAC attestations bind an actor and retained evidence outside this pure planner. */
export interface RecoveryResolution {
  readonly claim: RecoveryClaimToken;
  readonly action: RecoveryResolutionAction;
  readonly evidenceCode: RecoveryEvidenceCode;
  readonly reasonCode: RecoveryReasonCode;
  readonly actorHmac: string;
  readonly evidenceHmac: string;
}

export type RecoveryResolutionNextState = "queued" | "completed" | "cancelled" | "recovery_resolved";

export type RecoveryResolutionRejectionCode =
  | "invalid_context"
  | "invalid_resolution"
  | "claim_mismatch"
  | "evidence_mismatch";

export interface AcceptedRecoveryResolutionPlan {
  readonly accepted: true;
  readonly action: RecoveryResolutionAction;
  readonly nextState: RecoveryResolutionNextState;
  readonly claim: RecoveryClaimToken;
  readonly evidenceCode: RecoveryEvidenceCode;
  readonly reasonCode: RecoveryReasonCode;
  readonly actorHmac: string;
  readonly evidenceHmac: string;
}

export interface RejectedRecoveryResolutionPlan {
  readonly accepted: false;
  readonly nextState: "recovery_required";
  readonly rejectionCode: RecoveryResolutionRejectionCode;
}

export type RecoveryResolutionPlan = AcceptedRecoveryResolutionPlan | RejectedRecoveryResolutionPlan;

const MAX_ID_LENGTH = 256;
const HMAC_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const ACTIONS = new Set<string>(RECOVERY_RESOLUTION_ACTIONS);
const EVIDENCE_CODES = new Set<string>(RECOVERY_EVIDENCE_CODES);
const REASON_CODES = new Set<string>(RECOVERY_REASON_CODES);

const REQUIRED_EVIDENCE: Readonly<Record<RecoveryResolutionAction, RecoveryEvidenceCode>> = Object.freeze({
  confirmed_not_dispatched_requeue: "pre_dispatch_residue_empty",
  confirmed_completed: "provider_completed",
  confirmed_cancelled: "provider_cancelled",
  acknowledge_unknown_release: "unknown_release"
});

/**
 * Validate and copy a recovery fence. It reads no persistent state and treats
 * malformed or expanded objects as invalid rather than attempting a repair.
 */
export function validateRecoveryClaimToken(value: unknown): RecoveryClaimToken | null {
  const record = exactRecord(value, [
    "requestId",
    "leaseId",
    "leaseGeneration",
    "recoveryGeneration",
    "claimantInstanceId"
  ]);
  if (record === null) return null;

  if (
    !isIdentifier(record.requestId) ||
    !isIdentifier(record.leaseId) ||
    !isPositiveSafeInteger(record.leaseGeneration) ||
    !isPositiveSafeInteger(record.recoveryGeneration) ||
    !isIdentifier(record.claimantInstanceId)
  ) {
    return null;
  }

  return Object.freeze({
    requestId: record.requestId,
    leaseId: record.leaseId,
    leaseGeneration: record.leaseGeneration,
    recoveryGeneration: record.recoveryGeneration,
    claimantInstanceId: record.claimantInstanceId
  });
}

/**
 * Validate and copy a human-supplied resolution without accepting free-form
 * notes, evidence payloads, or transcripts at this boundary.
 */
export function validateRecoveryResolution(value: unknown): RecoveryResolution | null {
  const record = exactRecord(value, ["claim", "action", "evidenceCode", "reasonCode", "actorHmac", "evidenceHmac"]);
  if (record === null) return null;

  const claim = validateRecoveryClaimToken(record.claim);
  if (
    claim === null ||
    !isAction(record.action) ||
    !isEvidenceCode(record.evidenceCode) ||
    !isReasonCode(record.reasonCode) ||
    !isHmac(record.actorHmac) ||
    !isHmac(record.evidenceHmac)
  ) {
    return null;
  }

  return Object.freeze({
    claim,
    action: record.action,
    evidenceCode: record.evidenceCode,
    reasonCode: record.reasonCode,
    actorHmac: record.actorHmac,
    evidenceHmac: record.evidenceHmac
  });
}

/**
 * Produce a side-effect-free transition plan. Callers must apply the returned
 * plan atomically against the same fenced claim; this module never updates a
 * controller, SQLite, or transcript store.
 */
export function planRecoveryResolution(contextValue: unknown, resolutionValue: unknown): RecoveryResolutionPlan {
  const context = validateContext(contextValue);
  if (context === null) return rejected("invalid_context");

  const resolution = validateRecoveryResolution(resolutionValue);
  if (resolution === null) return rejected("invalid_resolution");
  if (!sameClaim(context.claim, resolution.claim)) return rejected("claim_mismatch");
  if (REQUIRED_EVIDENCE[resolution.action] !== resolution.evidenceCode) return rejected("evidence_mismatch");

  return accepted(resolution);
}

function validateContext(value: unknown): RecoveryResolutionContext | null {
  const record = exactRecord(value, ["state", "claim"]);
  if (record === null || record.state !== "recovery_required") return null;

  const claim = validateRecoveryClaimToken(record.claim);
  return claim === null ? null : Object.freeze({ state: "recovery_required", claim });
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;

  try {
    if (Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;

    const names = Object.getOwnPropertyNames(value);
    if (names.length !== expectedKeys.length || Object.getOwnPropertySymbols(value).length !== 0) return null;

    const record: Record<string, unknown> = Object.create(null);
    for (const key of expectedKeys) {
      if (!names.includes(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    value.trim() === value &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isAction(value: unknown): value is RecoveryResolutionAction {
  return typeof value === "string" && ACTIONS.has(value);
}

function isEvidenceCode(value: unknown): value is RecoveryEvidenceCode {
  return typeof value === "string" && EVIDENCE_CODES.has(value);
}

function isReasonCode(value: unknown): value is RecoveryReasonCode {
  return typeof value === "string" && REASON_CODES.has(value);
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

function accepted(resolution: RecoveryResolution): AcceptedRecoveryResolutionPlan {
  return Object.freeze({
    accepted: true,
    action: resolution.action,
    nextState: nextStateFor(resolution.action),
    claim: resolution.claim,
    evidenceCode: resolution.evidenceCode,
    reasonCode: resolution.reasonCode,
    actorHmac: resolution.actorHmac,
    evidenceHmac: resolution.evidenceHmac
  });
}

function nextStateFor(action: RecoveryResolutionAction): RecoveryResolutionNextState {
  switch (action) {
    case "confirmed_not_dispatched_requeue":
      return "queued";
    case "confirmed_completed":
      return "completed";
    case "confirmed_cancelled":
      return "cancelled";
    case "acknowledge_unknown_release":
      return "recovery_resolved";
  }
}

function rejected(rejectionCode: RecoveryResolutionRejectionCode): RejectedRecoveryResolutionPlan {
  return Object.freeze({ accepted: false, nextState: "recovery_required", rejectionCode });
}
