import {
  classifyProviderFailure,
  type ClassifiedProviderFailure,
  type ProviderFailureInput
} from "./errors.js";

const OBSERVATION_FIELDS = new Set([
  "source",
  "conversationId",
  "observedAt",
  "status",
  "httpStatus",
  "code",
  "reason"
]);
const REQUIRED_OBSERVATION_FIELDS = ["source", "conversationId", "observedAt", "status"] as const;

export type TerminalObservationSource = "stream_json" | "sqlite_reconciliation";

export type OfficialTerminalStatus = "SUCCESS" | "ERROR" | "CANCELED" | "INTERRUPTED";

/** The evidence policy selected by the admission controller. */
export type TerminalEvidenceMode = "sqlite_primary" | "dual_source";

/** The only structured terminal fields that may cross the admission boundary. */
export interface OfficialTerminalObservation {
  readonly source: TerminalObservationSource;
  readonly conversationId: string;
  readonly observedAt: number;
  readonly status: OfficialTerminalStatus;
  readonly httpStatus?: number;
  readonly code?: string;
  readonly reason?: string;
}

/** v2.0 policy: SQLite is the sole online terminal source of truth. */
export interface SqlitePrimaryTerminalEvidence {
  readonly mode: "sqlite_primary";
  readonly sqliteReconciliation: OfficialTerminalObservation;
}

/** v2.1 policy: stream-json shadows SQLite and must reconcile exactly. */
export interface DualSourceTerminalEvidence {
  readonly mode: "dual_source";
  readonly streamJson: OfficialTerminalObservation;
  readonly sqliteReconciliation: OfficialTerminalObservation;
}

/**
 * The only terminal-evidence envelope accepted at the admission boundary.
 * The discriminant prevents a v2.0 SQLite-primary turn from accidentally
 * inheriting v2.1 dual-source requirements.
 */
export type TerminalEvidenceInput = SqlitePrimaryTerminalEvidence | DualSourceTerminalEvidence;

/**
 * Transitional v2.1 source shape. It is accepted only when it is an exact
 * two-field record and is converted to the explicit dual-source policy.
 */
export interface LegacyDualSourceTerminalObservations {
  streamJson: OfficialTerminalObservation;
  sqliteReconciliation: OfficialTerminalObservation;
}

interface TerminalEvidenceBase {
  readonly source: TerminalObservationSource;
  readonly conversationId: string;
  readonly observedAt: number;
  readonly status: OfficialTerminalStatus;
}

export interface CompletedTerminalEvidence extends TerminalEvidenceBase {
  readonly status: "SUCCESS";
  readonly outcome: "completed";
}

export interface CancelledTerminalEvidence extends TerminalEvidenceBase {
  readonly status: "CANCELED" | "INTERRUPTED";
  readonly outcome: "cancelled";
}

export interface FailedTerminalEvidence extends TerminalEvidenceBase {
  readonly status: "ERROR";
  readonly outcome: "failed";
  readonly failure: Readonly<ClassifiedProviderFailure>;
}

/** A terminal result with no prompt, reasoning, stack, or raw event content. */
export type TerminalEvidence = CompletedTerminalEvidence | CancelledTerminalEvidence | FailedTerminalEvidence;

interface ConfirmedTerminalEvidenceBase {
  readonly outcome: "confirmed";
  readonly conversationId: string;
  readonly status: OfficialTerminalStatus;
  readonly sqliteReconciliation: TerminalEvidence;
}

export interface ConfirmedSqlitePrimaryTerminalEvidence extends ConfirmedTerminalEvidenceBase {
  readonly mode: "sqlite_primary";
  readonly streamJson: null;
}

export interface ConfirmedDualSourceTerminalEvidence extends ConfirmedTerminalEvidenceBase {
  readonly mode: "dual_source";
  readonly streamJson: TerminalEvidence;
}

export interface ReconciledTerminalEvidence {
  readonly outcome: "reconciled";
  readonly conversationId: string;
  readonly status: OfficialTerminalStatus;
  readonly streamJson: TerminalEvidence;
  readonly sqliteReconciliation: TerminalEvidence;
}

/** A comparison result intentionally contains no source values or raw payload data. */
export interface TerminalEvidenceRecoveryRequired {
  readonly outcome: "recovery_required";
}

export type TerminalEvidenceReconciliation = ReconciledTerminalEvidence | TerminalEvidenceRecoveryRequired;

export type TerminalEvidenceConfirmation =
  | ConfirmedSqlitePrimaryTerminalEvidence
  | ConfirmedDualSourceTerminalEvidence
  | TerminalEvidenceRecoveryRequired;

export class TerminalEvidenceError extends Error {
  constructor(message: string) {
    super(`terminal evidence error: ${message}`);
    this.name = "TerminalEvidenceError";
  }
}

/**
 * Normalize one official structured terminal observation. The input boundary is
 * deliberately exact: any payload-bearing or unrecognized field is rejected.
 */
export function normalizeTerminalObservation(input: unknown): TerminalEvidence {
  try {
    const fields = requireObservationRecord(input);
    const source = requireSource(fields.source);
    const conversationId = requireConversationId(fields.conversationId);
    const observedAt = requireObservedAt(fields.observedAt);
    const status = requireTerminalStatus(fields.status);

    if (status === "SUCCESS") {
      assertNoProviderFailureFields(fields);
      return Object.freeze({ source, conversationId, observedAt, status, outcome: "completed" });
    }
    if (status === "CANCELED" || status === "INTERRUPTED") {
      assertNoProviderFailureFields(fields);
      return Object.freeze({ source, conversationId, observedAt, status, outcome: "cancelled" });
    }

    const providerFailure = readProviderFailureInput(fields);
    return Object.freeze({
      source,
      conversationId,
      observedAt,
      status,
      outcome: "failed",
      failure: Object.freeze(classifyProviderFailure(providerFailure))
    });
  } catch (error) {
    if (error instanceof TerminalEvidenceError) throw error;
    throw new TerminalEvidenceError("terminal observation is invalid");
  }
}

/**
 * Confirm one explicitly selected terminal-evidence policy. Any malformed
 * envelope, source mismatch, raw payload field, or reconciliation mismatch
 * becomes a data-free recovery result.
 */
export function confirmTerminalEvidence(input: unknown): TerminalEvidenceConfirmation {
  const envelope = readTerminalEvidenceEnvelope(input);
  if (envelope === null) return recoveryRequired();

  if (envelope.mode === "sqlite_primary") {
    const sqliteReconciliation = normalizedOrNull(envelope.sqliteReconciliation);
    if (sqliteReconciliation === null || sqliteReconciliation.source !== "sqlite_reconciliation") {
      return recoveryRequired();
    }
    return Object.freeze({
      outcome: "confirmed" as const,
      mode: "sqlite_primary" as const,
      conversationId: sqliteReconciliation.conversationId,
      status: sqliteReconciliation.status,
      streamJson: null,
      sqliteReconciliation
    });
  }

  const reconciled = reconcileTerminalEvidence(envelope.streamJson, envelope.sqliteReconciliation);
  if (reconciled.outcome !== "reconciled") return recoveryRequired();
  return Object.freeze({
    outcome: "confirmed" as const,
    mode: "dual_source" as const,
    conversationId: reconciled.conversationId,
    status: reconciled.status,
    streamJson: reconciled.streamJson,
    sqliteReconciliation: reconciled.sqliteReconciliation
  });
}

/**
 * Convert only the historical exact dual-source shape for source adapters
 * that have not yet been wired to emit the explicit policy discriminant.
 */
export function parseTerminalEvidenceInput(input: unknown): TerminalEvidenceInput | null {
  const explicit = readTerminalEvidenceEnvelope(input);
  if (explicit !== null) return explicit;

  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(input);
    if (
      keys.length !== 2 ||
      keys.some((key) => key !== "streamJson" && key !== "sqliteReconciliation")
    ) {
      return null;
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    }
    const fields = input as LegacyDualSourceTerminalObservations;
    return Object.freeze({
      mode: "dual_source" as const,
      streamJson: fields.streamJson,
      sqliteReconciliation: fields.sqliteReconciliation
    });
  } catch {
    return null;
  }
}

/**
 * Reconcile independently observed stream-json and SQLite terminals. Only an
 * exact conversation and terminal-status match is evidence; all other cases
 * fail closed without preserving either source value.
 */
export function reconcileTerminalEvidence(
  streamJsonObservation: unknown,
  sqliteReconciliationObservation: unknown
): TerminalEvidenceReconciliation {
  const streamJson = normalizedOrNull(streamJsonObservation);
  const sqliteReconciliation = normalizedOrNull(sqliteReconciliationObservation);

  if (
    streamJson === null ||
    sqliteReconciliation === null ||
    streamJson.source !== "stream_json" ||
    sqliteReconciliation.source !== "sqlite_reconciliation" ||
    streamJson.conversationId !== sqliteReconciliation.conversationId ||
    streamJson.status !== sqliteReconciliation.status ||
    !sameTerminalSemantics(streamJson, sqliteReconciliation)
  ) {
    return recoveryRequired();
  }

  return Object.freeze({
    outcome: "reconciled",
    conversationId: streamJson.conversationId,
    status: streamJson.status,
    streamJson,
    sqliteReconciliation
  });
}

function readTerminalEvidenceEnvelope(input: unknown): TerminalEvidenceInput | null {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return null;

    const fields = input as Record<string, unknown>;
    const mode = fields.mode;
    const expectedFields = mode === "sqlite_primary"
      ? new Set(["mode", "sqliteReconciliation"])
      : mode === "dual_source"
        ? new Set(["mode", "streamJson", "sqliteReconciliation"])
        : null;
    if (expectedFields === null) return null;

    const keys = Reflect.ownKeys(input);
    if (keys.length !== expectedFields.size || keys.some((key) => typeof key !== "string" || !expectedFields.has(key))) {
      return null;
    }
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
    }

    if (mode === "sqlite_primary") {
      return Object.freeze({ mode, sqliteReconciliation: fields.sqliteReconciliation as OfficialTerminalObservation });
    }
    return Object.freeze({
      mode: "dual_source" as const,
      streamJson: fields.streamJson as OfficialTerminalObservation,
      sqliteReconciliation: fields.sqliteReconciliation as OfficialTerminalObservation
    });
  } catch {
    return null;
  }
}

function requireObservationRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TerminalEvidenceError("terminal observation must be a plain object");
  }

  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TerminalEvidenceError("terminal observation must be a plain object");
  }

  const keys = Reflect.ownKeys(input);
  if (keys.some((key) => typeof key !== "string" || !OBSERVATION_FIELDS.has(key))) {
    throw new TerminalEvidenceError("terminal observation contains unsupported fields");
  }

  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TerminalEvidenceError("terminal observation contains unsupported fields");
    }
  }

  const fields = input as Record<string, unknown>;
  for (const key of REQUIRED_OBSERVATION_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(fields, key)) {
      throw new TerminalEvidenceError("terminal observation is missing required fields");
    }
  }
  return fields;
}

function requireSource(value: unknown): TerminalObservationSource {
  if (value === "stream_json" || value === "sqlite_reconciliation") return value;
  throw new TerminalEvidenceError("terminal observation source is invalid");
}

function requireConversationId(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\u0000")) {
    throw new TerminalEvidenceError("terminal observation conversation ID is invalid");
  }
  return value;
}

function requireObservedAt(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TerminalEvidenceError("terminal observation timestamp is invalid");
  }
  return value;
}

function assertNoProviderFailureFields(fields: Record<string, unknown>): void {
  if (["httpStatus", "code", "reason"].some((field) => Object.prototype.hasOwnProperty.call(fields, field))) {
    throw new TerminalEvidenceError("non-error terminal observation contains provider failure fields");
  }
}

function sameTerminalSemantics(left: TerminalEvidence, right: TerminalEvidence): boolean {
  if (left.outcome !== right.outcome) return false;
  if (left.outcome !== "failed" || right.outcome !== "failed") return true;
  return (
    left.failure.category === right.failure.category &&
    left.failure.httpStatus === right.failure.httpStatus &&
    left.failure.code === right.failure.code &&
    left.failure.reason === right.failure.reason
  );
}

function requireTerminalStatus(value: unknown): OfficialTerminalStatus {
  if (value === "SUCCESS" || value === "ERROR" || value === "CANCELED" || value === "INTERRUPTED") {
    return value;
  }
  throw new TerminalEvidenceError("terminal observation status is invalid");
}

function readProviderFailureInput(fields: Record<string, unknown>): ProviderFailureInput {
  const input: ProviderFailureInput = {};
  if (Object.prototype.hasOwnProperty.call(fields, "httpStatus")) {
    input.httpStatus = requireHttpStatus(fields.httpStatus);
  }
  if (Object.prototype.hasOwnProperty.call(fields, "code")) {
    input.code = requireSafeSignal(fields.code, "code");
  }
  if (Object.prototype.hasOwnProperty.call(fields, "reason")) {
    input.reason = requireSafeSignal(fields.reason, "reason");
  }
  return input;
}

function requireHttpStatus(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 599) {
    throw new TerminalEvidenceError("terminal observation HTTP status is invalid");
  }
  return value;
}

function requireSafeSignal(value: unknown, field: "code" | "reason"): string {
  if (typeof value !== "string") {
    throw new TerminalEvidenceError(`terminal observation ${field} is invalid`);
  }

  const signal = field === "code" ? { code: value } : { reason: value };
  const recognized = [
    classifyProviderFailure(signal),
    classifyProviderFailure({ ...signal, httpStatus: 503 }),
    classifyProviderFailure({ ...signal, httpStatus: 429 })
  ].some((classified) => classified[field] === value);
  if (!recognized) {
    throw new TerminalEvidenceError(`terminal observation ${field} is invalid`);
  }
  return value;
}

function normalizedOrNull(input: unknown): TerminalEvidence | null {
  try {
    return normalizeTerminalObservation(input);
  } catch {
    return null;
  }
}

function recoveryRequired(): TerminalEvidenceRecoveryRequired {
  return Object.freeze({ outcome: "recovery_required" });
}
