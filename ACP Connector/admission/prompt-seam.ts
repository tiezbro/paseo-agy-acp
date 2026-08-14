import { createRequestIdentity } from "./identity.js";
import type { PromptRequestIdentityResult, RequestIdentityNegotiationResult } from "./request-identity-protocol.js";
import type { AdmissionRuntime } from "./runtime.js";
import type { AdmissionQueueSnapshot } from "../../Admission Controller/controller.js";
import { onAbort, type TurnClaim } from "../acp/session/turn-scheduler.js";

export type AdmissionPromptStopReason = "end_turn" | "cancelled";

/**
 * Queue progress is intentionally an observation, not an ACP delivery ACK.
 * A future outbox owner must persist and acknowledge delivery separately.
 */
export interface AdmissionQueueProgress {
  readonly requestId: string;
  readonly sessionId: string;
  readonly parentId: string;
  readonly state: "queued" | "reconnected" | "recovery_required";
  readonly position?: number;
  readonly eligiblePosition?: number | null;
  readonly waitedMs?: number;
  readonly cooldownUntil?: number | null;
  readonly delivery: "unacknowledged";
}

/**
 * The CLI owner receives structural state only. It must acquire a global lease
 * and use a version-approved prompt-free transport before starting agy.
 */
export interface AdmissionPromptDispatchInput {
  readonly runtime: AdmissionRuntime;
  readonly requestId: string;
  readonly sessionId: string;
  readonly parentId: string;
  readonly provider: string;
  readonly model: string;
  readonly claim: TurnClaim;
  readonly reportQueueProgress?: (snapshot: AdmissionQueueSnapshot) => void;
}

export type AdmissionPromptDispatchHook = (
  input: AdmissionPromptDispatchInput
) => Promise<AdmissionPromptStopReason> | AdmissionPromptStopReason;

export interface AdmissionPromptSeamOptions {
  readonly runtime: AdmissionRuntime;
  /** Stable local parent identifier, normally the Paseo agent or CLI instance. */
  readonly agentId: string;
  /** Dedicated request-identity subkey; callers retain ownership of the master key. */
  readonly requestIdentityKey: Buffer;
  readonly dispatch: AdmissionPromptDispatchHook;
  readonly provider?: string;
  readonly now?: () => number;
  readonly reportQueueProgress?: (progress: AdmissionQueueProgress) => void | Promise<void>;
}

export interface AdmissionPromptTurn {
  readonly sessionId: string;
  readonly model: string;
  /** Plaintext is accepted only to atomically encrypt it in AdmissionController. */
  readonly promptText: string;
  /** Must already own the local TurnScheduler slot before this boundary. */
  readonly claim: TurnClaim;
  readonly requestIdentity: PromptRequestIdentityResult;
}

/** Optional prompt dependency: absent means exact legacy execution. */
export interface PromptAdmission {
  readonly seam: Pick<AdmissionPromptSeam, "admit">;
  readonly requestIdentity: RequestIdentityNegotiationResult;
}

export class AdmissionPromptReplayBlockedError extends Error {
  constructor(requestId: string, state: string) {
    super(`admission request ${requestId} is already ${state}; automatic replay is blocked`);
    this.name = "AdmissionPromptReplayBlockedError";
  }
}

export class AdmissionPromptDispatchIncompleteError extends Error {
  constructor(requestId: string, state: string | undefined) {
    super(`admission dispatch for ${requestId} returned without a terminal request state (${state ?? "missing"})`);
    this.name = "AdmissionPromptDispatchIncompleteError";
  }
}

export class AdmissionPromptIdentityRequiredError extends Error {
  constructor() {
    super("admission requires a negotiated recoverable request identity");
    this.name = "AdmissionPromptIdentityRequiredError";
  }
}

const TERMINAL_REQUEST_STATES = new Set(["completed", "failed", "cancelled", "queue_timeout"]);

/**
 * Bridges a claimed ACP turn into durable admission without owning provider
 * dispatch. This keeps the existing prompt-argv path out of enabled admission.
 */
export class AdmissionPromptSeam {
  readonly #runtime: AdmissionRuntime;
  readonly #agentId: string;
  readonly #requestIdentityKey: Buffer;
  readonly #dispatch: AdmissionPromptDispatchHook;
  readonly #provider: string;
  readonly #now: () => number;
  readonly #reportQueueProgress?: (progress: AdmissionQueueProgress) => void | Promise<void>;

  constructor(options: AdmissionPromptSeamOptions) {
    this.#runtime = options.runtime;
    this.#agentId = requireIdentifier(options.agentId, "agentId");
    this.#requestIdentityKey = copyRequestIdentityKey(options.requestIdentityKey);
    this.#dispatch = options.dispatch;
    this.#provider = requireIdentifier(options.provider ?? "antigravity", "provider");
    this.#now = options.now ?? Date.now;
    this.#reportQueueProgress = options.reportQueueProgress;
  }

  close(): void {
    this.#requestIdentityKey.fill(0);
  }

  async admit(input: AdmissionPromptTurn): Promise<AdmissionPromptStopReason> {
    input.claim.throwIfAborted();
    const now = this.now();
    const requestId = this.requestId(input.sessionId, input.requestIdentity);
    const request = {
      requestId,
      sessionId: requireIdentifier(input.sessionId, "sessionId"),
      parentId: this.#agentId,
      fingerprint: requestId,
      provider: this.#provider,
      model: requireIdentifier(input.model, "model"),
      now
    };

    let persisted: { requestId: string; existed: boolean };
    try {
      persisted = this.#runtime.controller.enqueueWithPayload(
        request,
        input.promptText,
        now + this.#runtime.controller.policy.queueTimeoutMs
      );
    } catch (error) {
      const existing = this.#runtime.controller.getRequest(requestId);
      if (existing && existing.state !== "queued") {
        this.report({ requestId, sessionId: request.sessionId, state: "recovery_required" });
        throw new AdmissionPromptReplayBlockedError(requestId, existing.state);
      }
      throw error;
    }

    this.report({
      requestId,
      sessionId: request.sessionId,
      state: persisted.existed ? "reconnected" : "queued"
    });
    if (persisted.existed) {
      throw new AdmissionPromptReplayBlockedError(requestId, "queued");
    }

    // Before control reaches the CLI owner, cancellation can safely revoke the
    // queued payload. After handoff, only the owner has enough lease/process
    // evidence to decide whether a request is still cancellable.
    let handedOff = false;
    const detachAbort = onAbort(input.claim.signal, () => {
      if (handedOff) return;
      try {
        this.#runtime.controller.cancelQueued(requestId, this.now());
      } catch {
        // Another owner transition is evidence-sensitive; do not infer success.
      }
    });
    try {
      input.claim.throwIfAborted();
      handedOff = true;
      const outcome = await this.#dispatch({
        runtime: this.#runtime,
        requestId,
        sessionId: request.sessionId,
        parentId: request.parentId,
        provider: request.provider,
        model: request.model,
        claim: input.claim,
        reportQueueProgress: (snapshot) => this.report({
          requestId,
          sessionId: request.sessionId,
          state: "queued",
          position: snapshot.position,
          eligiblePosition: snapshot.eligiblePosition,
          waitedMs: snapshot.waitedMs,
          cooldownUntil: snapshot.cooldownUntil
        })
      });
      const state = this.#runtime.controller.getRequest(requestId)?.state;
      if (!state || !TERMINAL_REQUEST_STATES.has(state)) {
        throw new AdmissionPromptDispatchIncompleteError(requestId, state);
      }
      return outcome;
    } finally {
      detachAbort();
    }
  }

  private requestId(sessionId: string, requestIdentity: PromptRequestIdentityResult): string {
    if (requestIdentity.kind === "legacy_ephemeral") {
      throw new AdmissionPromptIdentityRequiredError();
    }
    return createRequestIdentity(this.#requestIdentityKey, {
      agentId: this.#agentId,
      acpSessionId: sessionId,
      clientMessageId: requestIdentity.clientMessageId
    });
  }

  private now(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new Error("admission prompt time must be a non-negative safe integer");
    }
    return now;
  }

  private report(progress: Omit<AdmissionQueueProgress, "parentId" | "delivery">): void {
    if (!this.#reportQueueProgress) return;
    const event: AdmissionQueueProgress = Object.freeze({
      ...progress,
      parentId: this.#agentId,
      delivery: "unacknowledged"
    });
    try {
      const result = this.#reportQueueProgress(event);
      if (result && typeof (result as Promise<void>).then === "function") {
        void Promise.resolve(result).catch(() => {});
      }
    } catch {
      // Progress transport cannot roll back a durable queue record.
    }
  }
}

function requireIdentifier(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`admission prompt ${name} must be a non-empty string without NUL`);
  }
  return value;
}

function copyRequestIdentityKey(value: unknown): Buffer {
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    throw new Error("admission prompt requestIdentityKey must be exactly 32 bytes");
  }
  return Buffer.from(value);
}
