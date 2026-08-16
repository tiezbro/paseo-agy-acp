import { randomUUID } from "node:crypto";
import {
  type AdmissionController,
  type AdmissionLease,
  type AdmissionQueueSnapshot,
  type LiveTurnCompletion,
  type VerifiedLinuxProcessRecord
} from "../../Admission Controller/controller.js";
import {
  captureLinuxProcessIdentity,
  nativeLinuxProcessEvidenceReaders
} from "../../Admission Controller/process-evidence.js";
import {
  captureLinuxConnectorOwnerIdentity,
  type LinuxConnectorOwnerIdentity
} from "./owner-instance.js";
import { classifyProviderFailure } from "./errors.js";
import {
  AgyCliError,
  type AgyAdmissionDispatchBoundary
} from "../agy/cli.js";
import type { TurnClaim } from "../acp/session/turn-scheduler.js";

const DEFAULT_QUEUE_POLL_INTERVAL_MS = 100;
const DEFAULT_PROGRESS_INTERVAL_MS = 1_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 2_000;

export interface AdmissionTurnProgress {
  readonly state: "queued";
  readonly position: number;
  readonly eligiblePosition: number | null;
  readonly waitedMs: number;
  readonly cooldownUntil: number | null;
}

export interface AdmissionTurnExecutionResult {
  readonly stopReason: "end_turn" | "cancelled";
}

export interface AdmissionTurnInput {
  readonly sessionId: string;
  readonly model: string;
  readonly promptText: string;
  readonly claim: TurnClaim;
  readonly reportProgress?: (progress: AdmissionTurnProgress) => void | Promise<void>;
  readonly execute: (
    boundary: AgyAdmissionDispatchBoundary
  ) => Promise<AdmissionTurnExecutionResult>;
}

export interface AdmissionTurnCoordinatorOptions {
  readonly controller: AdmissionController;
  readonly agentId?: string;
  readonly parentId?: string;
  readonly connectorPid?: number;
  readonly now?: () => number;
  readonly createRequestId?: () => string;
  readonly queuePollIntervalMs?: number;
  readonly progressIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

export class AdmissionQueueTimeoutError extends Error {
  constructor() {
    super("admission queue wait timed out");
    this.name = "AdmissionQueueTimeoutError";
  }
}

export class AdmissionTurnRecoveryRequiredError extends Error {
  constructor() {
    super("admission turn requires recovery; the business prompt will not be replayed");
    this.name = "AdmissionTurnRecoveryRequiredError";
  }
}

/**
 * Wraps the existing online ACP turn with the shared queue and one exact stdin
 * write boundary. It never translates output or performs delivery replay.
 */
export class AdmissionTurnCoordinator {
  readonly #controller: AdmissionController;
  readonly #agentId: string;
  readonly #ownerIdentity: LinuxConnectorOwnerIdentity;
  readonly #now: () => number;
  readonly #createRequestId: () => string;
  readonly #queuePollIntervalMs: number;
  readonly #progressIntervalMs: number;
  readonly #heartbeatIntervalMs: number;
  readonly #wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  #closed = false;

  constructor(options: AdmissionTurnCoordinatorOptions) {
    this.#controller = options.controller;
    this.#agentId = optionAgentId(options);
    this.#now = options.now ?? Date.now;
    this.#createRequestId = options.createRequestId ?? randomUUID;
    this.#queuePollIntervalMs = positiveInterval(
      options.queuePollIntervalMs,
      DEFAULT_QUEUE_POLL_INTERVAL_MS,
      "queue poll interval"
    );
    this.#progressIntervalMs = positiveInterval(
      options.progressIntervalMs,
      DEFAULT_PROGRESS_INTERVAL_MS,
      "progress interval"
    );
    this.#heartbeatIntervalMs = positiveInterval(
      options.heartbeatIntervalMs,
      DEFAULT_HEARTBEAT_INTERVAL_MS,
      "heartbeat interval"
    );
    this.#wait = options.wait ?? waitForAbort;
    this.#ownerIdentity = captureLinuxConnectorOwnerIdentity(
      options.connectorPid ?? process.pid,
      nativeLinuxProcessEvidenceReaders
    );
  }

  get ownerIdentity(): LinuxConnectorOwnerIdentity {
    return this.#ownerIdentity;
  }

  async admit(input: AdmissionTurnInput): Promise<"end_turn" | "cancelled"> {
    this.assertOpen();
    requireIdentifier(input.sessionId, "session ID");
    requireIdentifier(input.model, "model");
    if (typeof input.promptText !== "string") throw new Error("admission prompt must be text");
    if (typeof input.execute !== "function") throw new Error("admission execution callback is required");

    input.claim.throwIfAborted();
    const requestId = requireIdentifier(this.#createRequestId(), "request ID");
    const enqueuedAt = this.readNow();
    this.#controller.enqueueWithPayload({
      requestId,
      sessionId: input.sessionId,
      agentId: this.#agentId,
      fingerprint: requestId,
      provider: "antigravity",
      model: input.model,
      now: enqueuedAt
    }, input.promptText, enqueuedAt + this.#controller.policy.queueTimeoutMs);

    const lease = await this.waitForLease(requestId, input);
    if (lease === null) return "cancelled";

    const boundary = new TurnDispatchBoundary(
      this.#controller,
      lease,
      this.#ownerIdentity,
      input.claim,
      this.#now
    );
    let heartbeatFailed = false;
    const heartbeat = setInterval(() => {
      try {
        this.#controller.heartbeat(lease, this.readNow());
      } catch {
        heartbeatFailed = true;
      }
    }, this.#heartbeatIntervalMs);
    heartbeat.unref?.();

    try {
      this.#controller.markStarting(lease, this.readNow());
      const result = await input.execute(boundary);
      if (!boundary.promptWriteIssued || !boundary.active) {
        this.#controller.abandonBeforePrompt(
          lease,
          this.readNow(),
          result.stopReason === "cancelled" ? "cancelled" : "failed"
        );
        return result.stopReason;
      }
      if (heartbeatFailed) {
        this.#controller.markExecutionRecoveryRequired(lease, this.readNow());
        throw new AdmissionTurnRecoveryRequiredError();
      }
      this.#controller.completeLiveTurn(lease, this.readNow(), {
        outcome: result.stopReason === "cancelled" ? "cancelled" : "completed"
      });
      return result.stopReason;
    } catch (error) {
      this.settleFailure(lease, boundary, error);
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  close(): void {
    this.#closed = true;
  }

  private async waitForLease(requestId: string, input: AdmissionTurnInput): Promise<AdmissionLease | null> {
    let lastProgressAt = -1;
    let lastProgress = "";
    while (true) {
      this.assertOpen();
      if (input.claim.aborted) {
        this.cancelQueuedQuietly(requestId);
        return null;
      }
      const now = this.readNow();
      const lease = this.#controller.admitRequest(requestId, now, this.#ownerIdentity.ownerInstanceId);
      if (lease !== null) return lease;

      const request = this.#controller.getRequest(requestId);
      if (request?.state === "queue_timeout") throw new AdmissionQueueTimeoutError();
      if (request?.state !== "queued") {
        throw new AdmissionTurnRecoveryRequiredError();
      }
      const progress = this.#controller.getQueueSnapshot(requestId, now);
      if (progress !== null && now - lastProgressAt >= this.#progressIntervalMs) {
        const signature = progressSignature(progress);
        if (signature !== lastProgress) {
          this.reportProgress(input.reportProgress, progress);
          lastProgress = signature;
        }
        lastProgressAt = now;
      }
      try {
        await this.#wait(this.#queuePollIntervalMs, input.claim.signal);
      } catch {
        this.cancelQueuedQuietly(requestId);
        return null;
      }
    }
  }

  private settleFailure(lease: AdmissionLease, boundary: TurnDispatchBoundary, error: unknown): void {
    const now = this.readNow();
    try {
      const state = this.#controller.getRequest(lease.requestId)?.state;
      if (
        state === "completed" ||
        state === "failed" ||
        state === "cancelled" ||
        state === "dispatch_ambiguous" ||
        state === "recovery_required"
      ) {
        return;
      }
      if (!boundary.promptWriteIssued) {
        this.#controller.abandonBeforePrompt(
          lease,
          now,
          boundary.claim.aborted ? "cancelled" : "failed"
        );
        return;
      }
      if (error instanceof AgyCliError && error.exitCode !== null) {
        this.#controller.completeLiveTurn(lease, now, {
          outcome: "failed",
          failure: failureFromAgyError(error)
        });
        return;
      }
      this.#controller.markExecutionRecoveryRequired(lease, now);
    } catch {
      // Preserve the original execution failure. Durable state remains the
      // authority when this best-effort settlement itself loses its fence.
    }
  }

  private cancelQueuedQuietly(requestId: string): void {
    try {
      this.#controller.cancelQueued(requestId, this.readNow());
    } catch {
      // A concurrent timeout or admission transition already owns settlement.
    }
  }

  private reportProgress(
    reporter: AdmissionTurnInput["reportProgress"],
    snapshot: AdmissionQueueSnapshot
  ): void {
    if (reporter === undefined) return;
    try {
      const result = reporter(Object.freeze({
        state: "queued" as const,
        position: snapshot.position,
        eligiblePosition: snapshot.eligiblePosition,
        waitedMs: snapshot.waitedMs,
        cooldownUntil: snapshot.cooldownUntil
      }));
      if (result && typeof (result as Promise<void>).then === "function") {
        void Promise.resolve(result).catch(() => {});
      }
    } catch {
      // Queue observation cannot change durable scheduling.
    }
  }

  private readNow(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("admission clock is invalid");
    return value;
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error("admission turn coordinator is closed");
  }
}

class TurnDispatchBoundary implements AgyAdmissionDispatchBoundary {
  readonly claim: TurnClaim;
  readonly #controller: AdmissionController;
  readonly #lease: AdmissionLease;
  readonly #ownerIdentity: LinuxConnectorOwnerIdentity;
  readonly #now: () => number;
  #prepared = false;
  #promptWriteIssued = false;
  #active = false;
  #record: VerifiedLinuxProcessRecord | undefined;

  constructor(
    controller: AdmissionController,
    lease: AdmissionLease,
    ownerIdentity: LinuxConnectorOwnerIdentity,
    claim: TurnClaim,
    now: () => number
  ) {
    this.#controller = controller;
    this.#lease = lease;
    this.#ownerIdentity = ownerIdentity;
    this.claim = claim;
    this.#now = now;
  }

  get promptWriteIssued(): boolean {
    return this.#promptWriteIssued;
  }

  get active(): boolean {
    return this.#active;
  }

  prepare(processId: number): void {
    if (this.#prepared) throw new Error("admission process boundary was already prepared");
    this.claim.throwIfAborted();
    const child = captureLinuxProcessIdentity(processId, nativeLinuxProcessEvidenceReaders);
    const record = Object.freeze({
      requestId: this.#lease.requestId,
      leaseId: this.#lease.leaseId,
      generation: this.#lease.generation,
      ownerInstanceId: this.#lease.ownerInstanceId,
      processIdentity: Object.freeze({ connector: this.#ownerIdentity, child }),
      promptChannel: "stdin" as const
    });
    const recorded = this.#controller.recordProcessIdentity(record);
    if (recorded.status !== "recorded") throw new Error("admission process identity was not recorded");
    this.#record = record;
    this.#prepared = true;
  }

  beforePromptWrite(): void {
    if (!this.#prepared || this.#promptWriteIssued) throw new Error("admission prompt boundary is invalid");
    this.claim.throwIfAborted();
    if (this.#controller.getRequest(this.#lease.requestId)?.state !== "dispatch_intent") {
      throw new Error("admission dispatch fence is stale");
    }
  }

  commitDispatchIntent(): void {
    if (!this.#prepared || this.#record === undefined || this.#promptWriteIssued) {
      throw new Error("admission prompt boundary is invalid");
    }
    const committed = this.#controller.commitDispatchIntent(this.#record);
    if (committed.status !== "committed") throw new Error("admission dispatch intent was not committed");
  }

  afterPromptWrite(): void {
    if (!this.#prepared || this.#promptWriteIssued) throw new Error("admission prompt boundary is invalid");
    this.#promptWriteIssued = true;
    this.#controller.markActive(this.#lease, readNow(this.#now));
    this.#active = true;
  }

  markDispatchAmbiguous(): void {
    if (this.#promptWriteIssued) throw new Error("admission prompt boundary is invalid");
    this.#promptWriteIssued = true;
    if (!this.#prepared) {
      this.#controller.markExecutionRecoveryRequired(this.#lease, readNow(this.#now));
      this.#active = false;
      return;
    }
    this.#controller.markDispatchAmbiguous(this.#lease, readNow(this.#now));
    this.#active = false;
  }
}

function failureFromAgyError(error: AgyCliError): NonNullable<LiveTurnCompletion["failure"]> {
  const source = `${error.message}\n${error.stderr}`.toUpperCase();
  const httpStatus = /(?:^|\D)503(?:\D|$)/.test(source)
    ? 503
    : /(?:^|\D)429(?:\D|$)/.test(source)
      ? 429
      : /(?:^|\D)401(?:\D|$)/.test(source)
        ? 401
        : /(?:^|\D)403(?:\D|$)/.test(source)
          ? 403
          : undefined;
  const code = [
    "MODEL_CAPACITY_EXHAUSTED",
    "QUOTA_EXHAUSTED",
    "UNAUTHENTICATED",
    "PERMISSION_DENIED",
    "UNAVAILABLE"
  ].find((candidate) => source.includes(candidate));
  return classifyProviderFailure({ httpStatus, code, reason: code });
}

function progressSignature(snapshot: AdmissionQueueSnapshot): string {
  return [snapshot.position, snapshot.eligiblePosition, snapshot.cooldownUntil].join(":");
}

function optionAgentId(options: AdmissionTurnCoordinatorOptions): string {
  if (options.parentId !== undefined) {
    throw new Error("admission parentId is not accepted");
  }
  if (options.agentId !== undefined) {
    return requireIdentifier(options.agentId, "agent ID");
  }
  return requireIdentifier(undefined, "agent ID");
}

function requireIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`admission ${label} is invalid`);
  }
  return value;
}

function positiveInterval(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`admission ${label} is invalid`);
  return resolved;
}

function readNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("admission clock is invalid");
  return value;
}

function waitForAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
