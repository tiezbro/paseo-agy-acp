import type { AdmissionController, ClaimedDelivery, DeliveryClaimFence } from "../admission/controller.js";
import {
  createOutboxEventMetadata,
  validateOutboxAck,
  type OutboxAck,
  type OutboxEventMetadata
} from "../admission/outbox-protocol.js";

const DEFAULT_CLAIM_LEASE_MS = 30_000;

type DeliveryAdmissionController = Pick<
  AdmissionController,
  | "claimPendingDeliveryAtomically"
  | "claimNextPendingDelivery"
  | "heartbeatClaimedDelivery"
  | "reserveTerminalReplay"
  | "readClaimedDelivery"
  | "acknowledgeDelivery"
  | "markDeliveryRecoveryRequired"
  | "sweepExpiredDeliveryClaims"
>;

/** The only data an ACP transport receives for one durable outbox event. */
export interface OutboxDeliveryMessage {
  /** Exact ACP session route recovered from the durable claim. */
  readonly sessionId: string;
  readonly metadata: OutboxEventMetadata;
  readonly payload: string;
}

export type OutboxDeliverySender = (message: OutboxDeliveryMessage) => void | Promise<void>;

export interface AcpOutboxDeliveryBridgeOptions {
  /** Controller-owned atomic claim, fencing, replay, ACK, and recovery authority. */
  readonly admission: DeliveryAdmissionController;
  readonly ownerInstanceId: string;
  readonly sender: OutboxDeliverySender;
  readonly claimLeaseMs?: number;
}

export interface OutboxDeliveryAwaitingAcknowledgement {
  readonly status: "awaiting_ack";
  readonly eventId: string;
  readonly claimGeneration: number;
}

export interface OutboxDeliveryNotPending {
  readonly status: "not_pending";
  readonly eventId: string;
}

export interface OutboxDeliveryRecoveryRequired {
  readonly status: "recovery_required";
  readonly eventId: string;
  readonly claimGeneration: number;
}

export type OutboxDeliveryResult =
  | OutboxDeliveryAwaitingAcknowledgement
  | OutboxDeliveryNotPending
  | OutboxDeliveryRecoveryRequired;

export interface OutboxDeliveryReplayed {
  readonly status: "replayed";
  readonly eventId: string;
  readonly claimGeneration: number;
}

export interface OutboxDeliveryNotReplayable {
  readonly status: "not_replayable";
  readonly eventId: string;
}

export type OutboxDeliveryReplayResult =
  | OutboxDeliveryReplayed
  | OutboxDeliveryNotReplayable
  | OutboxDeliveryRecoveryRequired;

export type OutboxDeliveryOrphanSweepResult = OutboxDeliveryRecoveryRequired;

export class AcpOutboxDeliveryAcknowledgementError extends Error {
  constructor() {
    super("outbox acknowledgement does not match an active delivery claim");
    this.name = "AcpOutboxDeliveryAcknowledgementError";
  }
}

export class AcpOutboxDeliveryClaimError extends Error {
  constructor() {
    super("outbox delivery claim does not match its protocol metadata");
    this.name = "AcpOutboxDeliveryClaimError";
  }
}

/**
 * Delivers one already-persisted ACP event. It never executes or retries a
 * business turn, and transport write completion is deliberately not an ACK.
 *
 * Every durable state transition is controller-owned. A process crash can
 * therefore be swept without relying on a second store or re-sending payload.
 */
export class AcpOutboxDeliveryBridge {
  readonly #admission: DeliveryAdmissionController;
  readonly #ownerInstanceId: string;
  readonly #sender: OutboxDeliverySender;
  readonly #claimLeaseMs: number;
  readonly #claims = new Map<string, ClaimedDelivery>();
  #closed = false;

  constructor(options: AcpOutboxDeliveryBridgeOptions) {
    this.#admission = options.admission;
    this.#ownerInstanceId = options.ownerInstanceId;
    this.#sender = options.sender;
    this.#claimLeaseMs = options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS;
    if (!Number.isSafeInteger(this.#claimLeaseMs) || this.#claimLeaseMs <= 0) {
      throw new AcpOutboxDeliveryClaimError();
    }
  }

  /** A route may negotiate this bridge only while its durable owner is live. */
  get active(): boolean {
    return !this.#closed;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#claims.clear();
  }

  /** Atomically claim and write one named pending event, leaving it claimed until an ACK arrives. */
  async deliver(eventId: string, now: number): Promise<OutboxDeliveryResult> {
    this.assertOpen();
    const claim = this.#admission.claimPendingDeliveryAtomically({
      eventId,
      ownerInstanceId: this.#ownerInstanceId,
      now,
      leaseMs: this.#claimLeaseMs
    });
    if (claim === null) return Object.freeze({ status: "not_pending", eventId });

    const recovery = await this.sendClaim(claim, now);
    return recovery ?? Object.freeze({
      status: "awaiting_ack",
      eventId: claim.eventId,
      claimGeneration: claim.claimGeneration
    });
  }

  /**
   * Claim and deliver one globally pending record through the controller's
   * safe ordering. This is deliberately not session-scoped: composition must
   * resolve the claimed session route at send time, or wait for a controller
   * API that claims only a specified session.
   */
  async drainNextPendingDelivery(now: number): Promise<OutboxDeliveryResult | null> {
    this.assertOpen();
    const claim = this.#admission.claimNextPendingDelivery(this.#ownerInstanceId, now);
    if (claim === null) return null;

    const recovery = await this.sendClaim(claim, now);
    return recovery ?? Object.freeze({
      status: "awaiting_ack",
      eventId: claim.eventId,
      claimGeneration: claim.claimGeneration
    });
  }

  /**
   * Accept only the exact acknowledgement for a controller-owned claim.
   * `acknowledgeDelivery` atomically settles both the outbox and its lease.
   */
  acknowledge(input: unknown, now: number): OutboxAck {
    this.assertOpen();
    const acknowledgement = validateOutboxAck(input);
    try {
      this.#admission.acknowledgeDelivery(acknowledgement, now);
    } catch {
      throw new AcpOutboxDeliveryAcknowledgementError();
    }
    this.#claims.delete(acknowledgement.eventId);
    return acknowledgement;
  }

  /** Call on connection loss or another explicit decision that ACK cannot arrive. */
  markUnconfirmedDeliveryRecoveryRequired(eventId: string, now: number): void {
    this.assertOpen();
    const claim = this.#claims.get(eventId);
    if (!claim) throw new AcpOutboxDeliveryAcknowledgementError();
    try {
      this.#admission.markDeliveryRecoveryRequired(toFence(claim), now);
    } catch {
      throw new AcpOutboxDeliveryAcknowledgementError();
    }
    this.#claims.delete(eventId);
  }

  /** Extend only the exact local owner's controller-owned claim lease. */
  heartbeatClaimedDelivery(eventId: string, now: number): void {
    this.assertOpen();
    const claim = this.#claims.get(eventId);
    if (!claim) throw new AcpOutboxDeliveryAcknowledgementError();
    try {
      this.#admission.heartbeatClaimedDelivery(toFence(claim), now, this.#claimLeaseMs);
    } catch {
      throw new AcpOutboxDeliveryAcknowledgementError();
    }
  }

  /**
   * A reconnect may send one terminal update only after the controller reserves
   * a replay for the exact same request and durable claim fence.
   */
  async replayClaimedDelivery(
    input: unknown,
    requestId: string,
    now: number
  ): Promise<OutboxDeliveryReplayResult> {
    this.assertOpen();
    const acknowledgement = validateOutboxAck(input);
    const fence: DeliveryClaimFence = {
      eventId: acknowledgement.eventId,
      ownerInstanceId: this.#ownerInstanceId,
      claimGeneration: acknowledgement.claimGeneration,
      claimToken: acknowledgement.claimToken
    };

    try {
      const claimed = this.#admission.readClaimedDelivery(fence, now);
      if (!matchesClaim(acknowledgement, claimed)) {
        return Object.freeze({ status: "not_replayable", eventId: acknowledgement.eventId });
      }
    } catch {
      return Object.freeze({ status: "not_replayable", eventId: acknowledgement.eventId });
    }

    try {
      const reservation = this.#admission.reserveTerminalReplay({
        requestId,
        ownerInstanceId: this.#ownerInstanceId,
        fence,
        now
      });
      if (reservation === null) {
        return Object.freeze({ status: "not_replayable", eventId: acknowledgement.eventId });
      }
    } catch {
      return Object.freeze({ status: "not_replayable", eventId: acknowledgement.eventId });
    }

    let claim: ClaimedDelivery;
    try {
      claim = this.#admission.readClaimedDelivery(fence, now);
    } catch {
      return Object.freeze({ status: "not_replayable", eventId: acknowledgement.eventId });
    }
    if (!matchesClaim(acknowledgement, claim)) {
      return this.recoverClaim(claim, now);
    }

    const recovery = await this.sendClaim(claim, now);
    return recovery ?? Object.freeze({
      status: "replayed",
      eventId: claim.eventId,
      claimGeneration: claim.claimGeneration
    });
  }

  /** Sweep controller-owned, payload-free expired claim metadata into recovery_required. */
  sweepExpiredDeliveryClaims(now: number): readonly OutboxDeliveryOrphanSweepResult[] {
    this.assertOpen();
    const swept = this.#admission.sweepExpiredDeliveryClaims(now);
    const results: OutboxDeliveryOrphanSweepResult[] = [];
    for (const claim of swept) {
      this.#claims.delete(claim.eventId);
      results.push(Object.freeze({
        status: "recovery_required",
        eventId: claim.eventId,
        claimGeneration: claim.claimGeneration
      }));
    }
    return Object.freeze(results);
  }

  private async sendClaim(claim: ClaimedDelivery, now: number): Promise<OutboxDeliveryRecoveryRequired | null> {
    this.#claims.set(claim.eventId, claim);
    try {
      await this.#sender(createDeliveryMessage(claim));
      return null;
    } catch {
      return this.recoverClaim(claim, now);
    }
  }

  private assertOpen(): void {
    if (this.#closed) throw new AcpOutboxDeliveryAcknowledgementError();
  }

  private recoverClaim(claim: ClaimedDelivery, now: number): OutboxDeliveryRecoveryRequired {
    this.#claims.delete(claim.eventId);
    try {
      this.#admission.markDeliveryRecoveryRequired(toFence(claim), now);
    } catch {
      // An exact fence failure remains controller-owned and is swept closed;
      // this bridge must not retry or expose the payload again.
    }
    return Object.freeze({
      status: "recovery_required",
      eventId: claim.eventId,
      claimGeneration: claim.claimGeneration
    });
  }
}

function createDeliveryMessage(claim: ClaimedDelivery): OutboxDeliveryMessage {
  const metadata = createOutboxEventMetadata(claim.metadata);
  if (
    typeof claim.sessionId !== "string" ||
    claim.sessionId.length === 0 ||
    metadata.eventId !== claim.eventId ||
    metadata.claimGeneration !== claim.claimGeneration ||
    metadata.claimToken !== claim.claimToken
  ) {
    throw new AcpOutboxDeliveryClaimError();
  }
  return Object.freeze({ sessionId: claim.sessionId, metadata, payload: claim.payload });
}

function matchesClaim(acknowledgement: OutboxAck, claim: ClaimedDelivery): boolean {
  return (
    acknowledgement.sessionId === claim.sessionId &&
    acknowledgement.eventId === claim.eventId &&
    acknowledgement.claimGeneration === claim.claimGeneration &&
    acknowledgement.claimToken === claim.claimToken
  );
}

function toFence(claim: ClaimedDelivery): DeliveryClaimFence {
  return {
    eventId: claim.eventId,
    ownerInstanceId: claim.ownerInstanceId,
    claimGeneration: claim.claimGeneration,
    claimToken: claim.claimToken
  };
}
