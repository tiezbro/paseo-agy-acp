import { describe, expect, it } from "vitest";
import {
  ACP_OUTBOX_ACK_METHOD,
  ACP_OUTBOX_CAPABILITY,
  ACP_OUTBOX_CAPABILITY_KEY,
  ACP_OUTBOX_CAPABILITY_VERSION,
  ACP_OUTBOX_DELIVERY_SEMANTICS,
  AcpOutboxProtocolError,
  createOutboxEventMetadata,
  negotiateOutboxCapability,
  negotiateOutboxCapabilityOffer,
  validateOutboxAck,
  type OutboxAck,
  type OutboxAckInput,
  type OutboxEventMetadata,
  type OutboxEventMetadataInput
} from "../ACP Connector/admission/outbox-protocol.js";

function capabilityOffer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    versions: [ACP_OUTBOX_CAPABILITY_VERSION],
    required: false,
    ackRequests: true,
    durableEventIdDedupe: true,
    ...overrides
  };
}

function eventMetadata(overrides: Partial<OutboxEventMetadataInput> = {}): OutboxEventMetadataInput {
  return {
    v: ACP_OUTBOX_CAPABILITY_VERSION,
    eventId: "event-1",
    sequence: 17,
    claimGeneration: 3,
    claimToken: "claim-token-1",
    ...overrides
  };
}

function acknowledgement(overrides: Partial<OutboxAckInput> = {}): OutboxAckInput {
  return {
    v: ACP_OUTBOX_CAPABILITY_VERSION,
    sessionId: "session-1",
    eventId: "event-1",
    claimGeneration: 3,
    claimToken: "claim-token-1",
    ...overrides
  };
}

function thrownMessage(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected protocol validation to throw");
}

describe("admission ACP outbox protocol", () => {
  it("publishes the fixed v1 at-least-once contract", () => {
    expect(ACP_OUTBOX_CAPABILITY_KEY).toBe("paseo-agy-acp/outbox");
    expect(ACP_OUTBOX_CAPABILITY_VERSION).toBe(1);
    expect(ACP_OUTBOX_DELIVERY_SEMANTICS).toBe("at-least-once");
    expect(ACP_OUTBOX_ACK_METHOD).toBe("_paseo-agy-acp/outbox/ack");
    expect(ACP_OUTBOX_CAPABILITY).toEqual({
      key: "paseo-agy-acp/outbox",
      version: 1,
      semantics: "at-least-once",
      ackMethod: "_paseo-agy-acp/outbox/ack"
    });
    expect(Object.isFrozen(ACP_OUTBOX_CAPABILITY)).toBe(true);
  });

  it("negotiates only an exact offer that supports v1 dedupe and ACK guarantees", () => {
    const negotiated = negotiateOutboxCapability(capabilityOffer({ versions: [2, 1] }));

    expect(negotiated).toBe(ACP_OUTBOX_CAPABILITY);
    expect(Object.isFrozen(negotiated)).toBe(true);
  });

  it("distinguishes disabled, optional unsupported, selected, and required unsupported offers", () => {
    expect(negotiateOutboxCapabilityOffer(undefined)).toEqual({ status: "disabled" });
    expect(negotiateOutboxCapabilityOffer(capabilityOffer({ versions: [2] }))).toEqual({ status: "unsupported" });
    expect(negotiateOutboxCapabilityOffer(capabilityOffer())).toEqual({
      status: "selected",
      capability: ACP_OUTBOX_CAPABILITY
    });
    expect(
      negotiateOutboxCapabilityOffer(capabilityOffer({ versions: [2], required: true }))
    ).toEqual({
      status: "protocol_error",
      code: "outbox_required",
      reason: "unsupported"
    });
  });

  it("fails closed for missing, false, malformed, or unsafe capability claims", () => {
    const invalidOffers: unknown[] = [
      undefined,
      null,
      [],
      capabilityOffer({ versions: [] }),
      capabilityOffer({ versions: [2] }),
      capabilityOffer({ versions: [1, Number.MAX_SAFE_INTEGER + 1] }),
      capabilityOffer({ versions: [1, 1.5] }),
      capabilityOffer({ versions: [1, "2"] }),
      capabilityOffer({ versions: new Set([1]) }),
      capabilityOffer({ required: "false" }),
      capabilityOffer({ ackRequests: false }),
      capabilityOffer({ ackRequests: 1 }),
      capabilityOffer({ durableEventIdDedupe: false }),
      capabilityOffer({ reconnectReplay: true }),
      capabilityOffer({ prompt: "must not become outbox metadata" }),
      capabilityOffer({ reasoning: "must not become outbox metadata" }),
      capabilityOffer({ headers: { authorization: "secret" } }),
      capabilityOffer({ rawNotes: "must not become outbox metadata" })
    ];

    for (const offer of invalidOffers) {
      expect(negotiateOutboxCapability(offer)).toBeNull();
    }
  });

  it("fails closed for extra or accessor-backed capability fields", () => {
    const extra = capabilityOffer({ writerCompletion: true });
    const accessor = capabilityOffer();
    Object.defineProperty(accessor, "ackRequests", {
      enumerable: true,
      get() {
        return true;
      }
    });

    expect(negotiateOutboxCapability(extra)).toBeNull();
    expect(negotiateOutboxCapability(accessor)).toBeNull();
  });

  it("creates a detached immutable event metadata record containing structural fields only", () => {
    const source = eventMetadata();
    const metadata = createOutboxEventMetadata(source);
    source.eventId = "changed-after-validation";

    expect(metadata).toEqual({
      v: 1,
      eventId: "event-1",
      sequence: 17,
      claimGeneration: 3,
      claimToken: "claim-token-1"
    });
    expect(metadata).not.toBe(source);
    expect(Object.isFrozen(metadata)).toBe(true);
  });

  it("rejects malformed event metadata without preserving raw payload or reasoning", () => {
    const rawPayload = "private prompt body must never cross the outbox metadata boundary";
    const rawReasoning = "private reasoning must never cross the outbox metadata boundary";
    const invalidMetadata: unknown[] = [
      { ...eventMetadata(), v: 2 },
      { ...eventMetadata(), eventId: "" },
      { ...eventMetadata(), eventId: "event\0-1" },
      { ...eventMetadata(), claimToken: "   " },
      { ...eventMetadata(), claimToken: "claim\0-token" },
      { ...eventMetadata(), sequence: 1.5 },
      { ...eventMetadata(), sequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...eventMetadata(), claimGeneration: -1 },
      { ...eventMetadata(), payload: rawPayload },
      { ...eventMetadata(), reasoning: rawReasoning },
      { ...eventMetadata(), headers: { authorization: "secret" } },
      { ...eventMetadata(), rawNotes: "private delivery note" },
      { ...eventMetadata(), sessionId: "session-1" }
    ];

    for (const input of invalidMetadata) {
      const message = thrownMessage(() => createOutboxEventMetadata(input));
      expect(message).not.toContain(rawPayload);
      expect(message).not.toContain(rawReasoning);
      expect(() => createOutboxEventMetadata(input)).toThrow(AcpOutboxProtocolError);
    }
  });

  it("accepts and freezes only an exact ACK envelope", () => {
    const source = acknowledgement();
    const ack = validateOutboxAck(source);
    source.sessionId = "changed-after-validation";

    expect(ack).toEqual({
      v: 1,
      sessionId: "session-1",
      eventId: "event-1",
      claimGeneration: 3,
      claimToken: "claim-token-1"
    });
    expect(ack).not.toBe(source);
    expect(Object.isFrozen(ack)).toBe(true);
    expect("writerCompletion" in ack).toBe(false);
  });

  it("rejects malformed ACKs, raw content, and writer completion envelopes", () => {
    const rawPayload = "private delivery payload must never be accepted as an acknowledgement";
    const rawReasoning = "private reasoning must never be accepted as an acknowledgement";
    const invalidAcknowledgements: unknown[] = [
      { ...acknowledgement(), v: 2 },
      { ...acknowledgement(), sessionId: "" },
      { ...acknowledgement(), sessionId: "session\0-1" },
      { ...acknowledgement(), eventId: "" },
      { ...acknowledgement(), claimToken: "\0" },
      { ...acknowledgement(), claimGeneration: 1.5 },
      { ...acknowledgement(), claimGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { ...acknowledgement(), sequence: 17 },
      { ...acknowledgement(), payload: rawPayload },
      { ...acknowledgement(), reasoning: rawReasoning },
      { ...acknowledgement(), headers: { authorization: "secret" } },
      { ...acknowledgement(), rawNotes: "private delivery note" },
      { ...acknowledgement(), writerCompletion: true },
      { ...acknowledgement(), completion: { status: "finished" } }
    ];

    for (const input of invalidAcknowledgements) {
      const message = thrownMessage(() => validateOutboxAck(input));
      expect(message).not.toContain(rawPayload);
      expect(message).not.toContain(rawReasoning);
      expect(() => validateOutboxAck(input)).toThrow(AcpOutboxProtocolError);
    }
  });
});
