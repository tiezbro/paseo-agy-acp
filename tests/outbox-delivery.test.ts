import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcpOutboxDeliveryAcknowledgementError,
  AcpOutboxDeliveryBridge,
  type OutboxDeliveryMessage
} from "../src/agy/acp/outbox-delivery.js";
import { AdmissionController, type AdmissionPolicy, type EnqueueDelivery } from "../src/admission/controller.js";
import {
  ACP_OUTBOX_CAPABILITY,
  ACP_OUTBOX_CAPABILITY_VERSION,
  AcpOutboxProtocolError,
  type OutboxAck
} from "../src/admission/outbox-protocol.js";

const stateDirs: string[] = [];
const POLICY: AdmissionPolicy = {
  maxActiveTurns: 1,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

function controller(): AdmissionController {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-outbox-delivery-"));
  stateDirs.push(stateDir);
  return new AdmissionController({
    databasePath: path.join(stateDir, "runtime.sqlite"),
    policy: POLICY,
    encryptionKey: Buffer.alloc(32, 19),
    contentFingerprintKey: Buffer.alloc(32, 20),
    claimTokenKey: Buffer.alloc(32, 21)
  });
}

function restartController(admission: AdmissionController): AdmissionController {
  const { databasePath, policy } = admission;
  admission.close();
  return new AdmissionController({
    databasePath,
    policy,
    encryptionKey: Buffer.alloc(32, 19),
    contentFingerprintKey: Buffer.alloc(32, 20),
    claimTokenKey: Buffer.alloc(32, 21)
  });
}

function enqueueDelivery(admission: AdmissionController, eventId: string, payload: string): void {
  admission.enqueue({
    requestId: "request-1",
    sessionId: "session-1",
    parentId: "parent-1",
    fingerprint: "request-fingerprint-1",
    provider: "antigravity",
    model: "claude-opus-4-6-thinking",
    now: 1_000
  });
  const delivery: EnqueueDelivery = {
    eventId,
    requestId: "request-1",
    fingerprint: "delivery-fingerprint-1",
    payload,
    sequence: 9,
    now: 1_001,
    expiresAt: 10_000,
    protocol: ACP_OUTBOX_CAPABILITY
  };
  admission.enqueueDelivery(delivery);
}

function deliveryState(admission: AdmissionController, eventId: string): string {
  const database = new Database(admission.databasePath, { readonly: true });
  const row = database.prepare("SELECT state FROM delivery_outbox WHERE event_id = ?").get(eventId) as { state: string };
  database.close();
  return row.state;
}

function deliveryLease(admission: AdmissionController, eventId: string): {
  requestId: string;
  ownerInstanceId: string;
  claimGeneration: number;
  state: string;
  heartbeatAt: number;
  leaseExpiresAt: number;
  terminalReplayCount: number;
} {
  const database = new Database(admission.databasePath, { readonly: true });
  const row = database
    .prepare(
      `SELECT request_id AS requestId, owner_instance_id AS ownerInstanceId, claim_generation AS claimGeneration,
              state, heartbeat_at AS heartbeatAt, lease_expires_at AS leaseExpiresAt,
              terminal_replay_count AS terminalReplayCount
       FROM delivery_claim_leases WHERE event_id = ?`
    )
    .get(eventId) as {
    requestId: string;
    ownerInstanceId: string;
    claimGeneration: number;
    state: string;
    heartbeatAt: number;
    leaseExpiresAt: number;
    terminalReplayCount: number;
  };
  database.close();
  return row;
}

function acknowledgement(message: OutboxDeliveryMessage): OutboxAck {
  return {
    v: ACP_OUTBOX_CAPABILITY_VERSION,
    sessionId: "session-1",
    eventId: message.metadata.eventId,
    claimGeneration: message.metadata.claimGeneration,
    claimToken: message.metadata.claimToken
  };
}

afterEach(() => {
  for (const stateDir of stateDirs.splice(0)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

describe("AcpOutboxDeliveryBridge", () => {
  it("atomically claims one event with a controller-owned lease before sending its exact session route", async () => {
    const admission = controller();
    const secretPayload = "private terminal update";
    enqueueDelivery(admission, "event-1", secretPayload);
    const sent: OutboxDeliveryMessage[] = [];
    let leaseVisibleDuringSend = false;
    const bridge = new AcpOutboxDeliveryBridge({
      admission,
      ownerInstanceId: "delivery-worker-1",
      sender: async (message) => {
        const lease = deliveryLease(admission, message.metadata.eventId);
        leaseVisibleDuringSend =
          lease.state === "claimed" &&
          lease.ownerInstanceId === "delivery-worker-1" &&
          lease.claimGeneration === message.metadata.claimGeneration;
        sent.push(message);
      },
      claimLeaseMs: 100
    });

    await expect(bridge.deliver("event-1", 1_002)).resolves.toEqual({
      status: "awaiting_ack",
      eventId: "event-1",
      claimGeneration: 1
    });

    expect(sent).toHaveLength(1);
    expect(leaseVisibleDuringSend).toBe(true);
    expect(sent[0]).toMatchObject({
      sessionId: "session-1",
      metadata: {
        v: 1,
        eventId: "event-1",
        sequence: 9,
        claimGeneration: 1
      },
      payload: secretPayload
    });
    expect(Object.keys(sent[0]!)).toEqual(["sessionId", "metadata", "payload"]);
    expect(Object.keys(sent[0]!.metadata)).toEqual(["v", "eventId", "sequence", "claimGeneration", "claimToken"]);
    expect(deliveryLease(admission, "event-1")).toEqual({
      requestId: "request-1",
      ownerInstanceId: "delivery-worker-1",
      claimGeneration: 1,
      state: "claimed",
      heartbeatAt: 1_002,
      leaseExpiresAt: 1_102,
      terminalReplayCount: 0
    });
    expect(readFileSync(admission.databasePath, "utf8")).not.toContain(secretPayload);
  });

  it("does not turn sender completion into an ACK and atomically settles only an exact ACK", async () => {
    const admission = controller();
    enqueueDelivery(admission, "event-1", "private terminal update");
    let sent: OutboxDeliveryMessage | undefined;
    const bridge = new AcpOutboxDeliveryBridge({
      admission,
      ownerInstanceId: "delivery-worker-1",
      sender: async (message) => {
        sent = message;
      }
    });

    await bridge.deliver("event-1", 1_002);
    const validAcknowledgement = acknowledgement(sent!);
    expect(deliveryState(admission, "event-1")).toBe("claimed");

    expect(() => bridge.acknowledge({ ...validAcknowledgement, writerCompletion: true }, 1_003)).toThrow(
      AcpOutboxProtocolError
    );
    for (const invalidAcknowledgement of [
      { ...validAcknowledgement, sessionId: "other-session" },
      { ...validAcknowledgement, eventId: "other-event" },
      { ...validAcknowledgement, claimGeneration: validAcknowledgement.claimGeneration + 1 },
      { ...validAcknowledgement, claimToken: "different-token" }
    ]) {
      expect(() => bridge.acknowledge(invalidAcknowledgement, 1_003)).toThrow(AcpOutboxDeliveryAcknowledgementError);
      expect(deliveryState(admission, "event-1")).toBe("claimed");
    }

    expect(bridge.acknowledge(validAcknowledgement, 1_004)).toEqual(validAcknowledgement);
    expect(deliveryState(admission, "event-1")).toBe("delivered");
    expect(deliveryLease(admission, "event-1").state).toBe("delivered");
    expect(() => bridge.acknowledge(validAcknowledgement, 1_005)).not.toThrow();
  });

  it("settles an exact durable ACK after bridge restart without sending the payload again", async () => {
    const admission = controller();
    enqueueDelivery(admission, "event-1", "private terminal update");
    let sent: OutboxDeliveryMessage | undefined;
    const initialSender = vi.fn(async (message: OutboxDeliveryMessage) => {
      sent = message;
    });
    const initialBridge = new AcpOutboxDeliveryBridge({
      admission,
      ownerInstanceId: "delivery-worker-1",
      sender: initialSender
    });

    await initialBridge.deliver("event-1", 1_002);
    const exactAcknowledgement = acknowledgement(sent!);
    initialBridge.close();
    const afterCrash = restartController(admission);
    const reconnectedSender = vi.fn(async (_message: OutboxDeliveryMessage) => undefined);
    const reconnectedBridge = new AcpOutboxDeliveryBridge({
      admission: afterCrash,
      ownerInstanceId: "delivery-worker-1",
      sender: reconnectedSender
    });

    expect(reconnectedBridge.acknowledge(exactAcknowledgement, 1_004)).toEqual(exactAcknowledgement);
    expect(deliveryState(afterCrash, "event-1")).toBe("delivered");
    expect(initialSender).toHaveBeenCalledOnce();
    expect(reconnectedSender).not.toHaveBeenCalled();
  });

  it("marks a sender failure recovery_required without retrying the business turn", async () => {
    const admission = controller();
    enqueueDelivery(admission, "event-1", "private terminal update");
    const sender = vi.fn(async (_message: OutboxDeliveryMessage) => {
      throw new Error("transport unavailable");
    });
    const bridge = new AcpOutboxDeliveryBridge({
      admission,
      ownerInstanceId: "delivery-worker-1",
      sender
    });

    await expect(bridge.deliver("event-1", 1_002)).resolves.toEqual({
      status: "recovery_required",
      eventId: "event-1",
      claimGeneration: 1
    });

    expect(deliveryState(admission, "event-1")).toBe("recovery_required");
    expect(deliveryLease(admission, "event-1").state).toBe("recovery_required");
    await expect(bridge.deliver("event-1", 1_003)).resolves.toEqual({ status: "not_pending", eventId: "event-1" });
    expect(sender).toHaveBeenCalledOnce();
  });

  it("sweeps a controller-owned claim after a crash before ACK without exposing or resending payload", async () => {
    const initial = controller();
    enqueueDelivery(initial, "event-1", "private terminal update");
    let sent: OutboxDeliveryMessage | undefined;
    const sender = vi.fn(async (message: OutboxDeliveryMessage) => {
      sent = message;
    });
    const first = new AcpOutboxDeliveryBridge({
      admission: initial,
      ownerInstanceId: "delivery-worker-1",
      sender,
      claimLeaseMs: 10
    });

    await first.deliver("event-1", 1_002);
    const exactAcknowledgement = acknowledgement(sent!);
    first.close();
    const afterCrash = restartController(initial);
    const recovery = new AcpOutboxDeliveryBridge({
      admission: afterCrash,
      ownerInstanceId: "delivery-worker-1",
      sender,
      claimLeaseMs: 10
    });

    expect(recovery.sweepExpiredDeliveryClaims(1_012)).toEqual([
      { status: "recovery_required", eventId: "event-1", claimGeneration: 1 }
    ]);
    await expect(recovery.replayClaimedDelivery(exactAcknowledgement, "request-1", 1_013)).resolves.toEqual({
      status: "not_replayable",
      eventId: "event-1"
    });
    expect(deliveryState(afterCrash, "event-1")).toBe("recovery_required");
    expect(sender).toHaveBeenCalledOnce();
  });

  it("heartbeats an exact controller lease and reserves one replay only for the same request", async () => {
    const initial = controller();
    enqueueDelivery(initial, "event-1", "private terminal update");
    const sent: OutboxDeliveryMessage[] = [];
    const sender = vi.fn(async (message: OutboxDeliveryMessage) => {
      sent.push(message);
    });
    const first = new AcpOutboxDeliveryBridge({
      admission: initial,
      ownerInstanceId: "delivery-worker-1",
      sender,
      claimLeaseMs: 100
    });

    await first.deliver("event-1", 1_002);
    const exactAcknowledgement = acknowledgement(sent[0]!);
    first.heartbeatClaimedDelivery("event-1", 1_003);
    expect(deliveryLease(initial, "event-1")).toMatchObject({ heartbeatAt: 1_003, leaseExpiresAt: 1_103 });
    first.close();
    const afterCrash = restartController(initial);
    const reconnected = new AcpOutboxDeliveryBridge({
      admission: afterCrash,
      ownerInstanceId: "delivery-worker-1",
      sender,
      claimLeaseMs: 100
    });

    await expect(reconnected.replayClaimedDelivery(exactAcknowledgement, "other-request", 1_004)).resolves.toEqual({
      status: "not_replayable",
      eventId: "event-1"
    });
    await expect(reconnected.replayClaimedDelivery(exactAcknowledgement, "request-1", 1_004)).resolves.toEqual({
      status: "replayed",
      eventId: "event-1",
      claimGeneration: 1
    });
    await expect(reconnected.replayClaimedDelivery(exactAcknowledgement, "request-1", 1_005)).resolves.toEqual({
      status: "not_replayable",
      eventId: "event-1"
    });

    expect(sender).toHaveBeenCalledTimes(2);
    expect(sent[1]).toMatchObject({ sessionId: "session-1", metadata: sent[0]!.metadata });
    expect(reconnected.acknowledge(acknowledgement(sent[1]!), 1_006)).toEqual(acknowledgement(sent[1]!));
    expect(deliveryState(afterCrash, "event-1")).toBe("delivered");
  });

  it("keeps a controller-atomically settled ACK invisible to later sweep or replay", async () => {
    const initial = controller();
    enqueueDelivery(initial, "event-1", "private terminal update");
    let sent: OutboxDeliveryMessage | undefined;
    const sender = vi.fn(async (message: OutboxDeliveryMessage) => {
      sent = message;
    });
    const first = new AcpOutboxDeliveryBridge({
      admission: initial,
      ownerInstanceId: "delivery-worker-1",
      sender,
      claimLeaseMs: 10
    });

    await first.deliver("event-1", 1_002);
    const exactAcknowledgement = acknowledgement(sent!);
    first.acknowledge(exactAcknowledgement, 1_003);
    first.close();
    const afterCrash = restartController(initial);
    const recovery = new AcpOutboxDeliveryBridge({
      admission: afterCrash,
      ownerInstanceId: "delivery-worker-1",
      sender,
      claimLeaseMs: 10
    });

    expect(recovery.sweepExpiredDeliveryClaims(1_012)).toEqual([]);
    await expect(recovery.replayClaimedDelivery(exactAcknowledgement, "request-1", 1_013)).resolves.toEqual({
      status: "not_replayable",
      eventId: "event-1"
    });
    expect(deliveryState(afterCrash, "event-1")).toBe("delivered");
    expect(deliveryLease(afterCrash, "event-1").state).toBe("delivered");
    expect(sender).toHaveBeenCalledOnce();
  });

  it("exposes a narrow controller-owned next-pending drain while preserving the claimed session route", async () => {
    const admission = controller();
    enqueueDelivery(admission, "event-1", "private terminal update");
    const sent: OutboxDeliveryMessage[] = [];
    const sender = vi.fn(async (message: OutboxDeliveryMessage) => {
      sent.push(message);
    });
    const bridge = new AcpOutboxDeliveryBridge({
      admission,
      ownerInstanceId: "delivery-worker-1",
      sender
    });
    const claimNext = vi.spyOn(admission, "claimNextPendingDelivery");

    await expect(bridge.drainNextPendingDelivery(1_002)).resolves.toEqual({
      status: "awaiting_ack",
      eventId: "event-1",
      claimGeneration: 1
    });
    expect(claimNext).toHaveBeenCalledWith("delivery-worker-1", 1_002);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sessionId).toBe("session-1");
    await expect(bridge.drainNextPendingDelivery(1_003)).resolves.toBeNull();
  });
});
