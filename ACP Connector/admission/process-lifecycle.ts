import {
  LocalProcessCancellationEscalator,
  type LocalCancellationPhase,
  type LocalProcessCancellationRecoveryReason,
  type LocalProcessCancellationTimeouts,
  type LocalProcessResidueProof
} from "./cancellation.js";
import {
  captureLinuxConnectorOwnerIdentity,
  observePersistedLinuxConnectorOwnerIdentity,
  type LinuxConnectorOwnerIdentity,
  type OwnerInstanceDependencies
} from "./owner-instance.js";
import {
  issueLinuxPreDispatchTerminationProof,
  isSameLinuxProcessIdentity,
  observeLinuxProcessIdentity,
  validateLinuxPreDispatchProofBinding,
  type LinuxProcessEvidenceReaders,
  type LinuxProcessIdentity,
  type LinuxPreDispatchProofBinding,
  type LinuxPreDispatchProofSigner,
  type LinuxPreDispatchProofSubject,
  type LinuxPreDispatchTerminationProof
} from "../../Admission Controller/process-evidence.js";
const MAX_IDENTIFIER_LENGTH = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const OWNER_INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Lease ownership data passed to every admission-state operation. */
export interface LinuxProcessLifecycleFence {
  readonly requestId: string;
  readonly leaseId: string;
  readonly generation: number;
  readonly ownerInstanceId: string;
}

/** Immutable connector and child evidence retained for one local process. */
export interface LinuxProcessLifecycleIdentity {
  readonly connector: LinuxConnectorOwnerIdentity;
  readonly child: LinuxProcessIdentity;
}

export type LinuxProcessLifecyclePromptChannel = "stdin" | "pty";

/** Durable process record shared by startup, cancellation, and recovery. */
export interface LinuxProcessLifecycleRecord extends LinuxProcessLifecycleFence {
  readonly processIdentity: LinuxProcessLifecycleIdentity;
  readonly promptChannel: LinuxProcessLifecyclePromptChannel;
}

/**
 * Narrow agy boundary. This adapter deliberately does not import agy CLI
 * classes, spawn a process, or translate provider terminal outcomes.
 */
export interface AgyProcessLifecycleOwner {
  signal(phase: LocalCancellationPhase, identity: LinuxProcessIdentity): Promise<void>;
  waitForExit(identity: LinuxProcessIdentity, timeoutMs: number): Promise<void>;
  queryResidue(identity: LinuxProcessIdentity): Promise<LocalProcessResidueProof>;
}

/**
 * Narrow admission boundary. Implementations must apply both the owner and
 * generation fence atomically; this module never imports AdmissionController.
 */
export interface AdmissionProcessLifecycleOwner {
  revalidate(record: LinuxProcessLifecycleRecord): LinuxProcessLifecycleRevalidation;
  markRecoveryRequired(fence: LinuxProcessLifecycleFence, reason: LinuxProcessLifecycleRecoveryReason): void;
}

export interface LinuxProcessLifecycleRevalidation {
  readonly generationMatches: boolean;
  readonly ownerMatches: boolean;
  readonly cancelled?: boolean;
}

export interface LinuxProcessLifecycleAdapterOptions {
  readonly connectorPid: number;
  readonly readers: LinuxProcessEvidenceReaders;
  readonly controller: AdmissionProcessLifecycleOwner;
  readonly agy: AgyProcessLifecycleOwner;
  readonly preDispatchProofSigner: LinuxPreDispatchProofSigner;
  readonly ownerDependencies?: OwnerInstanceDependencies;
}

export interface LinuxProcessLifecycleHeartbeat {
  readonly heartbeatAt: number;
  readonly now: number;
  readonly ownerSuspectAfterMs: number;
}

export type LinuxProcessLifecycleHeartbeatResult = Readonly<{ state: "current" | "suspect" }>;

export interface LinuxPreDispatchRecoveryRequest {
  readonly record: LinuxProcessLifecycleRecord;
  readonly claim: LinuxPreDispatchProofBinding;
  readonly now: number;
  readonly phase: "starting";
  readonly dispatchIntent: "not_committed";
}

export interface LinuxProcessLifecycleCancellationRequest {
  readonly record: LinuxProcessLifecycleRecord;
  readonly timeouts: LocalProcessCancellationTimeouts;
}

export type LinuxProcessLifecycleRecoveryReason =
  | "owner_fence_mismatch"
  | "connector_gone"
  | "connector_pid_reused"
  | "connector_unverifiable"
  | "invalid_recovery_request"
  | "owner_pid_reused"
  | "owner_unverifiable"
  | "root_still_present"
  | "pid_reused"
  | "root_unverifiable"
  | "residue_present"
  | "residue_unverifiable"
  | "requeue_fence_rejected"
  | "invalid_cancellation_request"
  | "cancellation_fence_invalid"
  | `cancellation_${LocalProcessCancellationRecoveryReason}`
  | "local_termination_unconfirmed"
  | "local_sigkill";

export interface LinuxProcessLifecycleRecoveryRequired {
  readonly outcome: "recovery_required";
  readonly providerCancellation: "unconfirmed";
  readonly reason: LinuxProcessLifecycleRecoveryReason;
  readonly attemptedPhases?: readonly LocalCancellationPhase[];
}

export type LinuxPreDispatchRecoveryFailureReason =
  | "invalid_recovery_request"
  | "owner_alive"
  | "owner_pid_reused"
  | "owner_unverifiable"
  | "root_still_present"
  | "pid_reused"
  | "root_unverifiable"
  | "residue_present"
  | "residue_unverifiable"
  | "proof_unverifiable";

/** Process inspection returns evidence only; the coordinator owns state mutation. */
export type LinuxPreDispatchRecoveryResult =
  | Readonly<{ outcome: "proof"; proof: LinuxPreDispatchTerminationProof }>
  | Readonly<{ outcome: "not_proven"; reason: LinuxPreDispatchRecoveryFailureReason }>;

export class LinuxProcessLifecycleConfigurationError extends Error {
  constructor(message: string) {
    super(`linux process lifecycle configuration error: ${message}`);
    this.name = "LinuxProcessLifecycleConfigurationError";
  }
}

/**
 * Binds recovery and cancellation rules to Linux evidence while keeping
 * controller and agy integrations narrow. Process startup and prompt writing
 * are intentionally absent; the admission dispatcher is their sole owner.
 */
export class LinuxProcessLifecycleAdapter {
  readonly #readers: LinuxProcessEvidenceReaders;
  readonly #controller: AdmissionProcessLifecycleOwner;
  readonly #agy: AgyProcessLifecycleOwner;
  readonly #preDispatchProofSigner: LinuxPreDispatchProofSigner;
  readonly ownerIdentity: LinuxConnectorOwnerIdentity;

  constructor(options: LinuxProcessLifecycleAdapterOptions) {
    const dependencies = validateOptions(options);
    this.#readers = dependencies.readers;
    this.#controller = dependencies.controller;
    this.#agy = dependencies.agy;
    this.#preDispatchProofSigner = dependencies.preDispatchProofSigner;
    this.ownerIdentity = captureLinuxConnectorOwnerIdentity(
      dependencies.connectorPid,
      dependencies.readers,
      dependencies.ownerDependencies
    );
  }

  /**
   * Heartbeats only identify a suspect owner. They intentionally do not read
   * procfs, reclaim a lease, signal a process, or requeue a request.
   */
  observeHeartbeat(value: unknown): LinuxProcessLifecycleHeartbeatResult {
    const heartbeat = normalizeHeartbeat(value);
    if (heartbeat === null || heartbeat.now - heartbeat.heartbeatAt >= heartbeat.ownerSuspectAfterMs) {
      return Object.freeze({ state: "suspect" });
    }
    return Object.freeze({ state: "current" });
  }

  /**
   * Inspect one explicitly pre-dispatch record and return a signed proof only
   * after owner loss and independent root/residue observations. This method
   * deliberately never calls a controller API or requeues a request.
   */
  async recoverPreDispatch(value: unknown): Promise<LinuxPreDispatchRecoveryResult> {
    const request = normalizePreDispatchRecoveryRequest(value);
    if (request === null) return preDispatchNotProven("invalid_recovery_request");

    const ownerState = observePersistedLinuxConnectorOwnerIdentity(request.record.processIdentity.connector, this.#readers);
    if (ownerState === "same") return preDispatchNotProven("owner_alive");
    if (ownerState === "pid_reused") return preDispatchNotProven("owner_pid_reused");
    if (ownerState === "unverifiable") return preDispatchNotProven("owner_unverifiable");

    const rootState = observeLinuxProcessIdentity(request.record.processIdentity.child, this.#readers);
    if (rootState === "same") return preDispatchNotProven("root_still_present");
    if (rootState === "pid_reused") return preDispatchNotProven("pid_reused");
    if (rootState === "unverifiable") return preDispatchNotProven("root_unverifiable");

    let residueProof: LocalProcessResidueProof;
    try {
      residueProof = await this.#agy.queryResidue(request.record.processIdentity.child);
    } catch {
      return preDispatchNotProven("residue_unverifiable");
    }
    if (!isResidueProof(residueProof)) return preDispatchNotProven("residue_unverifiable");
    if (residueProof.root === "pid_reused") return preDispatchNotProven("pid_reused");
    if (residueProof.root !== "gone") return preDispatchNotProven("root_still_present");
    if (residueProof.residue === "present") return preDispatchNotProven("residue_present");
    if (residueProof.residue !== "empty") return preDispatchNotProven("residue_unverifiable");

    try {
      return Object.freeze({
        outcome: "proof",
        proof: issueLinuxPreDispatchTerminationProof(
          {
            binding: request.claim,
            subject: preDispatchProofSubject(request.record),
            observedAt: request.now,
            owner: "gone",
            root: "gone",
            residue: "empty"
          },
          this.#preDispatchProofSigner
        )
      });
    } catch {
      return preDispatchNotProven("proof_unverifiable");
    }
  }

  /**
   * Perform local-only cancellation behind current owner and generation
   * fences. Every result remains recovery_required until separate official
   * terminal evidence verifies provider cancellation.
   */
  async cancel(value: unknown): Promise<LinuxProcessLifecycleRecoveryRequired> {
    const request = normalizeCancellationRequest(value);
    if (request === null) return recoveryRequired(undefined, "invalid_cancellation_request");
    if (
      request.record.ownerInstanceId !== this.ownerIdentity.ownerInstanceId ||
      !sameConnectorIdentity(request.record.processIdentity.connector, this.ownerIdentity)
    ) {
      return recoveryRequired(undefined, "owner_fence_mismatch");
    }

    const connectorState = observePersistedLinuxConnectorOwnerIdentity(this.ownerIdentity, this.#readers);
    if (connectorState !== "same") return this.recover(request.record, connectorRecoveryReason(connectorState));

    const revalidation = this.revalidate(request.record);
    if (
      revalidation === null ||
      revalidation.generationMatches !== true ||
      revalidation.ownerMatches !== true ||
      revalidation.cancelled !== true
    ) {
      return this.recover(request.record, "cancellation_fence_invalid");
    }

    const escalator = new LocalProcessCancellationEscalator({
      reverifyIdentity: async (identity) => observeLinuxProcessIdentity(identity, this.#readers),
      signal: async (phase, identity) => {
        // Re-check immediately before the effectful owner call to close the PID reuse window.
        if (observeLinuxProcessIdentity(identity, this.#readers) !== "same") {
          throw new Error("process identity changed before signal");
        }
        await this.#agy.signal(phase, identity);
      },
      wait: async (timeoutMs) => this.#agy.waitForExit(request.record.processIdentity.child, timeoutMs),
      queryResidue: async (identity) => this.#agy.queryResidue(identity)
    });

    try {
      const result = await escalator.cancel({ identity: request.record.processIdentity.child, timeouts: request.timeouts });
      if (result.outcome === "recovery_required") {
        return this.recover(request.record, `cancellation_${result.reason}`, result.attemptedPhases);
      }
      return this.recover(
        request.record,
        result.terminalPhase === "kill" ? "local_sigkill" : "local_termination_unconfirmed",
        result.attemptedPhases
      );
    } catch {
      return this.recover(request.record, "cancellation_identity_unverifiable");
    }
  }

  private revalidate(record: LinuxProcessLifecycleRecord): LinuxProcessLifecycleRevalidation | null {
    try {
      const result = this.#controller.revalidate(record);
      return isRevalidation(result) ? result : null;
    } catch {
      return null;
    }
  }

  private recover(
    fence: LinuxProcessLifecycleFence,
    reason: LinuxProcessLifecycleRecoveryReason,
    attemptedPhases?: readonly LocalCancellationPhase[]
  ): LinuxProcessLifecycleRecoveryRequired {
    try {
      this.#controller.markRecoveryRequired(fence, reason);
    } catch {
      // A failed persistence attempt cannot turn an uncertain local outcome into success.
    }
    return recoveryRequired(fence, reason, attemptedPhases);
  }
}

function validateOptions(value: unknown): LinuxProcessLifecycleAdapterOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LinuxProcessLifecycleConfigurationError("options must be an object");
  }
  const options = value as Partial<LinuxProcessLifecycleAdapterOptions>;
  if (
    typeof options.connectorPid !== "number" ||
    !Number.isSafeInteger(options.connectorPid) ||
    options.connectorPid < 1 ||
    !hasMethods(options.readers, ["readFile", "readLink"]) ||
    !hasMethods(options.controller, ["revalidate", "markRecoveryRequired"]) ||
    !hasMethods(options.agy, ["signal", "waitForExit", "queryResidue"]) ||
    !hasMethods(options.preDispatchProofSigner, ["signPreDispatchProof"])
  ) {
    throw new LinuxProcessLifecycleConfigurationError(
      "options must provide connector evidence, admission, agy, and pre-dispatch proof owners"
    );
  }
  return options as LinuxProcessLifecycleAdapterOptions;
}

function hasMethods(value: unknown, names: readonly string[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  try {
    return names.every((name) => typeof (value as Record<string, unknown>)[name] === "function");
  } catch {
    return false;
  }
}

function normalizeLifecycleRecord(value: unknown): LinuxProcessLifecycleRecord | null {
  const record = dataRecord(value);
  const fence = record === null ? null : normalizeFence(record);
  if (record === null || fence === null) return null;
  const processIdentity = normalizeLifecycleIdentity(dataValue(record, "processIdentity"));
  const promptChannel = dataValue(record, "promptChannel");
  if (
    processIdentity === null ||
    (promptChannel !== "stdin" && promptChannel !== "pty") ||
    processIdentity.connector.ownerInstanceId !== fence.ownerInstanceId
  ) {
    return null;
  }
  return Object.freeze({ ...fence, processIdentity, promptChannel });
}

function normalizeLifecycleIdentity(value: unknown): LinuxProcessLifecycleIdentity | null {
  const record = dataRecord(value);
  if (record === null) return null;
  const connector = normalizeConnectorIdentity(dataValue(record, "connector"));
  const child = normalizeProcessIdentity(dataValue(record, "child"));
  return connector === null || child === null ? null : Object.freeze({ connector, child });
}

function normalizeConnectorIdentity(value: unknown): LinuxConnectorOwnerIdentity | null {
  const record = dataRecord(value);
  if (record === null) return null;
  const ownerInstanceId = dataValue(record, "ownerInstanceId");
  const createdAt = dataValue(record, "createdAt");
  const process = normalizeProcessIdentity(record);
  if (
    process === null ||
    typeof ownerInstanceId !== "string" ||
    !OWNER_INSTANCE_ID_PATTERN.test(ownerInstanceId) ||
    !isCanonicalTimestamp(createdAt)
  ) {
    return null;
  }
  return Object.freeze({ ownerInstanceId, createdAt, ...process });
}

function normalizeProcessIdentity(value: unknown): LinuxProcessIdentity | null {
  const record = dataRecord(value);
  if (record === null) return null;
  const process = {
    bootId: dataValue(record, "bootId"),
    pid: dataValue(record, "pid"),
    startTimeTicks: dataValue(record, "startTimeTicks"),
    pidNamespaceInode: dataValue(record, "pidNamespaceInode"),
    ppid: dataValue(record, "ppid"),
    pgrp: dataValue(record, "pgrp"),
    session: dataValue(record, "session")
  };
  if (!isSameLinuxProcessIdentity(process, process)) return null;
  return Object.freeze({
    bootId: process.bootId as string,
    pid: process.pid as number,
    startTimeTicks: process.startTimeTicks as string,
    pidNamespaceInode: process.pidNamespaceInode as number,
    ppid: process.ppid as number,
    pgrp: process.pgrp as number,
    session: process.session as number
  });
}

function normalizeFence(record: Record<string, unknown>): LinuxProcessLifecycleFence | null {
  const requestId = dataValue(record, "requestId");
  const leaseId = dataValue(record, "leaseId");
  const generation = dataValue(record, "generation");
  const ownerInstanceId = dataValue(record, "ownerInstanceId");
  if (!isIdentifier(requestId) || !isIdentifier(leaseId) || !isPositiveSafeInteger(generation) || !isIdentifier(ownerInstanceId)) {
    return null;
  }
  return Object.freeze({ requestId, leaseId, generation, ownerInstanceId });
}

function normalizeHeartbeat(value: unknown): LinuxProcessLifecycleHeartbeat | null {
  const record = dataRecord(value);
  if (record === null) return null;
  const heartbeatAt = dataValue(record, "heartbeatAt");
  const now = dataValue(record, "now");
  const ownerSuspectAfterMs = dataValue(record, "ownerSuspectAfterMs");
  if (
    !isNonNegativeSafeInteger(heartbeatAt) ||
    !isNonNegativeSafeInteger(now) ||
    !isNonNegativeSafeInteger(ownerSuspectAfterMs) ||
    now < heartbeatAt
  ) {
    return null;
  }
  return Object.freeze({ heartbeatAt, now, ownerSuspectAfterMs });
}

function normalizePreDispatchRecoveryRequest(value: unknown): LinuxPreDispatchRecoveryRequest | null {
  const record = dataRecord(value);
  if (record === null || dataValue(record, "phase") !== "starting" || dataValue(record, "dispatchIntent") !== "not_committed") {
    return null;
  }
  const lifecycleRecord = normalizeLifecycleRecord(dataValue(record, "record"));
  const claim = validateLinuxPreDispatchProofBinding(dataValue(record, "claim"));
  const now = dataValue(record, "now");
  if (
    lifecycleRecord === null ||
    claim === null ||
    !isNonNegativeSafeInteger(now) ||
    claim.requestId !== lifecycleRecord.requestId ||
    claim.leaseId !== lifecycleRecord.leaseId ||
    claim.leaseGeneration !== lifecycleRecord.generation
  ) {
    return null;
  }
  return Object.freeze({
    record: lifecycleRecord,
    claim,
    now,
    phase: "starting",
    dispatchIntent: "not_committed"
  });
}

function normalizeCancellationRequest(value: unknown): LinuxProcessLifecycleCancellationRequest | null {
  const record = dataRecord(value);
  if (record === null) return null;
  const lifecycleRecord = normalizeLifecycleRecord(dataValue(record, "record"));
  const timeoutsValue = dataRecord(dataValue(record, "timeouts"));
  if (lifecycleRecord === null || timeoutsValue === null) return null;
  const interruptMs = dataValue(timeoutsValue, "interruptMs");
  const terminateMs = dataValue(timeoutsValue, "terminateMs");
  const killMs = dataValue(timeoutsValue, "killMs");
  if (
    !isNonNegativeSafeInteger(interruptMs) ||
    !isNonNegativeSafeInteger(terminateMs) ||
    !isNonNegativeSafeInteger(killMs)
  ) {
    return null;
  }
  return Object.freeze({
    record: lifecycleRecord,
    timeouts: Object.freeze({ interruptMs, terminateMs, killMs })
  });
}

function dataRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function dataValue(record: Record<string, unknown>, name: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, name);
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
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

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_UTC_TIMESTAMP_PATTERN.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isRevalidation(value: unknown): value is LinuxProcessLifecycleRevalidation {
  if (typeof value !== "object" || value === null) return false;
  const revalidation = value as Partial<LinuxProcessLifecycleRevalidation>;
  return (
    typeof revalidation.generationMatches === "boolean" &&
    typeof revalidation.ownerMatches === "boolean" &&
    (revalidation.cancelled === undefined || typeof revalidation.cancelled === "boolean")
  );
}

function sameConnectorIdentity(left: LinuxConnectorOwnerIdentity, right: LinuxConnectorOwnerIdentity): boolean {
  return (
    left.ownerInstanceId === right.ownerInstanceId &&
    left.createdAt === right.createdAt &&
    isSameLinuxProcessIdentity(left, right)
  );
}

function preDispatchProofSubject(record: LinuxProcessLifecycleRecord): LinuxPreDispatchProofSubject {
  return Object.freeze({
    ownerInstanceId: record.ownerInstanceId,
    connectorCreatedAt: record.processIdentity.connector.createdAt,
    connector: copyProcessIdentity(record.processIdentity.connector),
    child: copyProcessIdentity(record.processIdentity.child),
    promptChannel: record.promptChannel
  });
}

function copyProcessIdentity(identity: LinuxProcessIdentity): LinuxProcessIdentity {
  return Object.freeze({
    bootId: identity.bootId,
    pid: identity.pid,
    startTimeTicks: identity.startTimeTicks,
    pidNamespaceInode: identity.pidNamespaceInode,
    ppid: identity.ppid,
    pgrp: identity.pgrp,
    session: identity.session
  });
}

function isResidueProof(value: unknown): value is LocalProcessResidueProof {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proof = value as Partial<LocalProcessResidueProof>;
  return (
    (proof.root === "same" || proof.root === "gone" || proof.root === "pid_reused" || proof.root === "unverifiable") &&
    (proof.residue === "empty" || proof.residue === "present" || proof.residue === "unverifiable")
  );
}

function connectorRecoveryReason(
  state: "gone" | "pid_reused" | "unverifiable"
): Extract<LinuxProcessLifecycleRecoveryReason, "connector_gone" | "connector_pid_reused" | "connector_unverifiable"> {
  switch (state) {
    case "gone":
      return "connector_gone";
    case "pid_reused":
      return "connector_pid_reused";
    case "unverifiable":
      return "connector_unverifiable";
  }
}

function recoveryRequired(
  _fence: LinuxProcessLifecycleFence | undefined,
  reason: LinuxProcessLifecycleRecoveryReason,
  attemptedPhases?: readonly LocalCancellationPhase[]
): LinuxProcessLifecycleRecoveryRequired {
  return Object.freeze({
    outcome: "recovery_required",
    providerCancellation: "unconfirmed",
    reason,
    ...(attemptedPhases === undefined ? {} : { attemptedPhases: Object.freeze([...attemptedPhases]) })
  });
}

function preDispatchNotProven(reason: LinuxPreDispatchRecoveryFailureReason): LinuxPreDispatchRecoveryResult {
  return Object.freeze({ outcome: "not_proven", reason });
}
