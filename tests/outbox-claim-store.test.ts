import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaimedDelivery, DeliveryClaimFence } from "../src/admission/controller.js";
import type { OutboxAck } from "../src/admission/outbox-protocol.js";
import {
  OutboxClaimStoreFenceError,
  SqliteOutboxClaimStore
} from "../src/acp/outbox-claim-store.js";

const stateDirs: string[] = [];
const stores: SqliteOutboxClaimStore[] = [];

function claimedDelivery(overrides: Partial<ClaimedDelivery> = {}): ClaimedDelivery {
  const base: ClaimedDelivery = {
    eventId: "event-1",
    requestId: "request-1",
    sessionId: "session-1",
    payload: "private durable terminal update",
    sequence: 9,
    ownerInstanceId: "delivery-worker-1",
    claimGeneration: 2,
    claimToken: "claim-token-2",
    metadata: {
      v: 1,
      eventId: "event-1",
      sequence: 9,
      claimGeneration: 2,
      claimToken: "claim-token-2"
    }
  };
  return { ...base, ...overrides };
}

function fence(claim: ClaimedDelivery): DeliveryClaimFence {
  return {
    eventId: claim.eventId,
    ownerInstanceId: claim.ownerInstanceId,
    claimGeneration: claim.claimGeneration,
    claimToken: claim.claimToken
  };
}

function acknowledgement(claim: ClaimedDelivery): OutboxAck {
  return {
    v: 1,
    sessionId: claim.sessionId,
    eventId: claim.eventId,
    claimGeneration: claim.claimGeneration,
    claimToken: claim.claimToken
  };
}

function openStore(databasePath?: string): { store: SqliteOutboxClaimStore; databasePath: string } {
  const directory = databasePath === undefined ? mkdtempSync(path.join(os.tmpdir(), "paseo-agy-outbox-claims-")) : null;
  if (directory) stateDirs.push(directory);
  const resolvedPath = databasePath ?? path.join(directory!, "claims.sqlite");
  const store = new SqliteOutboxClaimStore({
    databasePath: resolvedPath,
    encryptionKey: Buffer.alloc(32, 31)
  });
  stores.push(store);
  return { store, databasePath: resolvedPath };
}

function closeStore(store: SqliteOutboxClaimStore): void {
  store.close();
  const index = stores.indexOf(store);
  if (index >= 0) stores.splice(index, 1);
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of stateDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteOutboxClaimStore", () => {
  it("persists an encrypted exact claim fence across restart without retaining payload", () => {
    const { store: initial, databasePath } = openStore();
    const claim = claimedDelivery();
    initial.recordClaim(claim, 1_000, 100);
    closeStore(initial);

    const { store: reconnected } = openStore(databasePath);
    const replay = reconnected.reserveReconnectReplay({
      eventId: claim.eventId,
      requestId: claim.requestId,
      ownerInstanceId: claim.ownerInstanceId,
      now: 1_010
    });

    expect(replay).toMatchObject({
      eventId: claim.eventId,
      requestId: claim.requestId,
      sessionId: claim.sessionId,
      fence: fence(claim),
      terminalReplayCount: 1
    });
    expect(replay).not.toHaveProperty("payload");
    const rawDatabase = readFileSync(databasePath, "utf8");
    expect(rawDatabase).not.toContain(claim.payload);
    expect(rawDatabase).not.toContain(claim.claimToken);
  });

  it("fences a stale owner and reserves at most one replay for the exact request", () => {
    const { store } = openStore();
    const claim = claimedDelivery();
    store.recordClaim(claim, 1_000, 100);

    expect(() => store.heartbeat({ ...fence(claim), ownerInstanceId: "other-owner" }, 1_010, 100)).toThrow(
      OutboxClaimStoreFenceError
    );
    expect(store.reserveReconnectReplay({
      eventId: claim.eventId,
      requestId: "other-request",
      ownerInstanceId: claim.ownerInstanceId,
      now: 1_010
    })).toBeNull();

    const replay = store.reserveReconnectReplay({
      eventId: claim.eventId,
      requestId: claim.requestId,
      ownerInstanceId: claim.ownerInstanceId,
      now: 1_010
    });
    expect(replay).toMatchObject({ fence: fence(claim), terminalReplayCount: 1 });
    store.markReplaySent(fence(claim), 1_011);
    expect(store.reserveReconnectReplay({
      eventId: claim.eventId,
      requestId: claim.requestId,
      ownerInstanceId: claim.ownerInstanceId,
      now: 1_012
    })).toBeNull();

    store.acknowledge(acknowledgement(claim), 1_013);
    expect(store.reserveReconnectReplay({
      eventId: claim.eventId,
      requestId: claim.requestId,
      ownerInstanceId: claim.ownerInstanceId,
      now: 1_014
    })).toBeNull();
  });

  it("sweeps an expired owner once and makes the fence unavailable for replay or heartbeat", () => {
    const { store } = openStore();
    const claim = claimedDelivery();
    store.recordClaim(claim, 1_000, 10);

    expect(store.sweepExpired(1_009)).toEqual([]);
    expect(store.sweepExpired(1_010)).toEqual([
      expect.objectContaining({
        eventId: claim.eventId,
        requestId: claim.requestId,
        fence: fence(claim)
      })
    ]);
    expect(store.sweepExpired(1_011)).toEqual([]);
    expect(() => store.heartbeat(fence(claim), 1_011, 10)).toThrow(OutboxClaimStoreFenceError);
    expect(store.reserveReconnectReplay({
      eventId: claim.eventId,
      requestId: claim.requestId,
      ownerInstanceId: claim.ownerInstanceId,
      now: 1_011
    })).toBeNull();
  });

  it("never revives an expired owner through an idempotent recordClaim call", () => {
    const { store } = openStore();
    const claim = claimedDelivery();
    store.recordClaim(claim, 1_000, 10);

    expect(() => store.recordClaim(claim, 1_010, 10)).toThrow(OutboxClaimStoreFenceError);
    expect(store.sweepExpired(1_010)).toEqual([
      expect.objectContaining({ eventId: claim.eventId, fence: fence(claim) })
    ]);
  });

  it("persists a pre-send replay reservation after a committed sidecar record so it cannot create a second terminal replay", () => {
    const { store: initial, databasePath } = openStore();
    const claim = claimedDelivery();
    initial.recordClaim(claim, 1_000, 100);
    expect(initial.reserveReconnectReplay({
      eventId: claim.eventId,
      requestId: claim.requestId,
      ownerInstanceId: claim.ownerInstanceId,
      now: 1_010
    })).toMatchObject({ terminalReplayCount: 1 });
    closeStore(initial);

    const { store: afterCrash } = openStore(databasePath);
    expect(afterCrash.reserveReconnectReplay({
      eventId: claim.eventId,
      requestId: claim.requestId,
      ownerInstanceId: claim.ownerInstanceId,
      now: 1_011
    })).toBeNull();
    expect(afterCrash.sweepExpired(1_100)).toEqual([
      expect.objectContaining({ eventId: claim.eventId, terminalReplayCount: 1 })
    ]);
  });
});
