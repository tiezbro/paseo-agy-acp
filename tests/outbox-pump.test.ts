import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpOutboxDeliveryBridge, type OutboxDeliveryMessage } from "../ACP Connector/acp/outbox-delivery.js";
import {
  AcpOutboxPump,
  type OutboxPumpBridge,
  type OutboxPumpReport,
  type OutboxPumpScheduledTrigger
} from "../ACP Connector/acp/outbox-pump.js";
import {
  AdmissionController,
  DURABLE_DELIVERY_PROTOCOL,
  type AdmissionPolicy,
  type EnqueueDelivery
} from "../Admission Controller/controller.js";
import { ACP_OUTBOX_CAPABILITY } from "../ACP Connector/admission/outbox-protocol.js";

const stateDirs: string[] = [];
const POLICY: AdmissionPolicy = {
  maxActiveTurns: 1,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const stateDir of stateDirs.splice(0)) rmSync(stateDir, { recursive: true, force: true });
});

describe("AcpOutboxPump", () => {
  it("coalesces concurrent pokes onto the exact same worker promise", async () => {
    let resolveDrain!: (value: null) => void;
    const drainResult = new Promise<null>((resolve) => {
      resolveDrain = resolve;
    });
    const bridge = fakeBridge({
      drainNextPendingDelivery: vi.fn(() => drainResult)
    });
    const pump = new AcpOutboxPump({ bridge, defaultMaxDeliveries: 4 });

    const first = pump.poke(1_000);
    const second = pump.poke(1_001);

    expect(second).toBe(first);
    expect(bridge.sweepExpiredDeliveryClaims).toHaveBeenCalledOnce();
    expect(bridge.drainNextPendingDelivery).toHaveBeenCalledOnce();
    resolveDrain(null);
    await expect(first).resolves.toEqual(report("idle", 1));
  });

  it("uses a bounded loop and continues after awaiting_ack without re-sending claimed records", async () => {
    const admission = controller();
    enqueueDeliveries(admission, ["event-1", "event-2", "event-3"]);
    const sent: OutboxDeliveryMessage[] = [];
    const bridge = new AcpOutboxDeliveryBridge({
      admission,
      ownerInstanceId: "pump-worker",
      sender: async (message) => {
        sent.push(message);
      },
      claimLeaseMs: 100
    });
    const pump = new AcpOutboxPump({ bridge });

    const first = await pump.drain(2_000, 2);
    expect(first).toEqual({
      status: "bounded",
      attempted: 2,
      swept: [],
      deliveries: [
        { status: "awaiting_ack", eventId: "event-1", claimGeneration: 1 },
        { status: "awaiting_ack", eventId: "event-2", claimGeneration: 1 }
      ]
    });
    expect(sent.map((message) => message.metadata.eventId)).toEqual(["event-1", "event-2"]);
    expect(deliveryStates(admission)).toEqual([
      { eventId: "event-1", state: "claimed" },
      { eventId: "event-2", state: "claimed" },
      { eventId: "event-3", state: "pending" }
    ]);

    const second = await pump.drain(2_001, 2);
    expect(second).toMatchObject({ status: "idle", attempted: 2 });
    expect(second.deliveries).toEqual([
      { status: "awaiting_ack", eventId: "event-3", claimGeneration: 1 }
    ]);
    expect(sent.map((message) => message.metadata.eventId)).toEqual(["event-1", "event-2", "event-3"]);
    expect(new Set(sent.map((message) => message.metadata.eventId)).size).toBe(3);

    pump.close();
    bridge.close();
    admission.close();
  });

  it("returns idle for an empty queue and exposes no payload surface", async () => {
    const bridge = fakeBridge();
    const pump = new AcpOutboxPump({ bridge });

    const result = await pump.drain(1_000, 8);

    expect(result).toEqual(report("idle", 1));
    expect(Object.keys(result)).toEqual(["status", "attempted", "swept", "deliveries"]);
    expect(JSON.stringify(result)).not.toContain("payload");
  });

  it("records recovery_required and moves to the next pending delivery without any provider replay", async () => {
    const drainNextPendingDelivery = vi
      .fn<OutboxPumpBridge["drainNextPendingDelivery"]>()
      .mockResolvedValueOnce({ status: "recovery_required", eventId: "failed-event", claimGeneration: 2 })
      .mockResolvedValueOnce({ status: "awaiting_ack", eventId: "next-event", claimGeneration: 1 })
      .mockResolvedValueOnce(null);
    const bridge = fakeBridge({ drainNextPendingDelivery });
    const pump = new AcpOutboxPump({ bridge });

    await expect(pump.drain(1_000, 4)).resolves.toEqual({
      status: "idle",
      attempted: 3,
      swept: [],
      deliveries: [
        { status: "recovery_required", eventId: "failed-event", claimGeneration: 2 },
        { status: "awaiting_ack", eventId: "next-event", claimGeneration: 1 }
      ]
    });
    expect(drainNextPendingDelivery).toHaveBeenCalledTimes(3);
  });

  it("turns a crash-like bridge throw into a detail-free blocked result without automatic retry", async () => {
    const privateFailure = "provider prompt and bearer token must not escape";
    const drainNextPendingDelivery = vi.fn<OutboxPumpBridge["drainNextPendingDelivery"]>().mockRejectedValue(
      new Error(privateFailure)
    );
    const bridge = fakeBridge({ drainNextPendingDelivery });
    const pump = new AcpOutboxPump({ bridge });

    const result = await pump.poke(1_000);

    expect(result).toEqual({
      status: "blocked",
      reason: "delivery_failed",
      attempted: 1,
      swept: [],
      deliveries: []
    });
    expect(JSON.stringify(result)).not.toContain(privateFailure);
    await Promise.resolve();
    expect(drainNextPendingDelivery).toHaveBeenCalledOnce();
  });

  it("fails closed after close, cancels an optional schedule, and owns no timer", async () => {
    let trigger!: OutboxPumpScheduledTrigger;
    let cancellations = 0;
    let registrations = 0;
    let resolveDrain!: (value: null) => void;
    const pendingDrain = new Promise<null>((resolve) => {
      resolveDrain = resolve;
    });
    const timer = vi.spyOn(globalThis, "setTimeout");
    const bridge = fakeBridge({
      drainNextPendingDelivery: vi.fn(() => pendingDrain)
    });
    const pump = new AcpOutboxPump({
      bridge,
      clock: () => 1_000,
      schedule: (scheduledTrigger) => {
        registrations += 1;
        trigger = scheduledTrigger;
        return () => {
          cancellations += 1;
        };
      }
    });

    const first = trigger();
    const second = pump.poke(1_001);
    expect(second).toBe(first);
    pump.close();
    resolveDrain(null);

    expect(registrations).toBe(1);
    expect(cancellations).toBe(1);
    expect(timer).not.toHaveBeenCalled();
    await expect(first).resolves.toEqual(report("closed", 1));
    const bridgeCalls = vi.mocked(bridge.drainNextPendingDelivery).mock.calls.length;
    await expect(trigger()).resolves.toEqual(report("closed", 0));
    await expect(pump.drain(1_002, 2)).resolves.toEqual(report("closed", 0));
    expect(bridge.drainNextPendingDelivery).toHaveBeenCalledTimes(bridgeCalls);
  });

  it("contains scheduled clock failure and never enters the bridge", async () => {
    const privateClockFailure = "clock exception with Authorization header";
    let trigger!: OutboxPumpScheduledTrigger;
    const bridge = fakeBridge();
    const pump = new AcpOutboxPump({
      bridge,
      clock: () => {
        throw new Error(privateClockFailure);
      },
      schedule: (scheduledTrigger) => {
        trigger = scheduledTrigger;
      }
    });

    const result = await trigger();

    expect(result).toEqual({
      status: "blocked",
      reason: "clock_failed",
      attempted: 0,
      swept: [],
      deliveries: []
    });
    expect(JSON.stringify(result)).not.toContain(privateClockFailure);
    expect(bridge.sweepExpiredDeliveryClaims).not.toHaveBeenCalled();
    expect(bridge.drainNextPendingDelivery).not.toHaveBeenCalled();
    pump.close();
  });
});

function fakeBridge(overrides: Partial<OutboxPumpBridge> = {}): OutboxPumpBridge {
  return {
    sweepExpiredDeliveryClaims: vi.fn(() => []),
    drainNextPendingDelivery: vi.fn(async () => null),
    ...overrides
  };
}

function report(status: "idle" | "closed", attempted: number): OutboxPumpReport {
  return {
    status,
    attempted,
    swept: [],
    deliveries: []
  };
}

function controller(): AdmissionController {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-outbox-pump-"));
  stateDirs.push(stateDir);
  return new AdmissionController({
    databasePath: path.join(stateDir, "runtime.sqlite"),
    policy: POLICY,
    encryptionKey: Buffer.alloc(32, 41),
    contentFingerprintKey: Buffer.alloc(32, 42),
    claimTokenKey: Buffer.alloc(32, 43)
  });
}

function enqueueDeliveries(admission: AdmissionController, eventIds: readonly string[]): void {
  admission.enqueue({
    requestId: "pump-request",
    sessionId: "pump-session",
    parentId: "pump-parent",
    fingerprint: "pump-request-fingerprint",
    provider: "antigravity",
    model: "claude-opus-4-6-thinking",
    now: 1_000
  });
  for (const [index, eventId] of eventIds.entries()) {
    const delivery: EnqueueDelivery = {
      eventId,
      requestId: "pump-request",
      fingerprint: `pump-delivery-fingerprint-${index}`,
      payload: `private-payload-${index}`,
      sequence: index,
      now: 1_001 + index,
      expiresAt: 10_000,
      protocol: DURABLE_DELIVERY_PROTOCOL
    };
    admission.enqueueDelivery(delivery);
  }
}

function deliveryStates(admission: AdmissionController): Array<{ eventId: string; state: string }> {
  const database = new Database(admission.databasePath, { readonly: true });
  const rows = database
    .prepare("SELECT event_id AS eventId, state FROM delivery_outbox ORDER BY event_id")
    .all() as Array<{ eventId: string; state: string }>;
  database.close();
  return rows;
}
