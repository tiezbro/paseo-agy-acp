import { describe, expect, it } from "vitest";
import { handleInitializeV1, handleInitializeV2 } from "../src/acp/initialize.js";
import {
  ACP_OUTBOX_ACK_METHOD,
  ACP_OUTBOX_CAPABILITY,
  ACP_OUTBOX_CAPABILITY_KEY,
  ACP_OUTBOX_CAPABILITY_VERSION
} from "../src/admission/outbox-protocol.js";
import {
  ACP_REQUEST_IDENTITY_CAPABILITY,
  ACP_REQUEST_IDENTITY_CAPABILITY_KEY,
  ACP_REQUEST_IDENTITY_CAPABILITY_VERSION
} from "../src/admission/request-identity-protocol.js";
import {
  ACP_OUTBOX_DELIVERY_META_KEY,
  ACP_OUTBOX_DELIVERY_METHOD,
  AcpProtocolCapabilityNegotiationError
} from "../src/acp/protocol-capabilities.js";

function requestIdentityOffer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    versions: [ACP_REQUEST_IDENTITY_CAPABILITY_VERSION],
    required: false,
    ...overrides
  };
}

function outboxOffer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    versions: [ACP_OUTBOX_CAPABILITY_VERSION],
    required: false,
    ackRequests: true,
    durableEventIdDedupe: true,
    reconnectReplay: true,
    ...overrides
  };
}

function initializeV1(meta?: Record<string, unknown>, outboxAvailable = false) {
  return handleInitializeV1(
    {
      protocolVersion: 1,
      clientCapabilities: {},
      ...(meta === undefined ? {} : { _meta: meta })
    },
    "1.0.0",
    { outboxAvailable }
  );
}

function initializeV2(meta?: Record<string, unknown>, outboxAvailable = false) {
  return handleInitializeV2(
    {
      protocolVersion: 2,
      info: { name: "test-client", version: "1.0.0" },
      capabilities: {},
      ...(meta === undefined ? {} : { _meta: meta })
    },
    "1.0.0",
    { outboxAvailable }
  );
}

describe("ACP admission protocol capability negotiation", () => {
  it("preserves legacy initialization when neither extension is offered", () => {
    for (const initialize of [initializeV1, initializeV2]) {
      const result = initialize();

      expect(result.clientProtocolCapabilities.requestIdentity).toEqual({ status: "disabled" });
      expect(result.clientProtocolCapabilities.outbox).toEqual({ status: "disabled" });
      expect(result.response).not.toHaveProperty("_meta");
    }
  });

  it("selects explicit v1 request identity and outbox offers with exact response metadata", () => {
    const result = initializeV1({
      [ACP_REQUEST_IDENTITY_CAPABILITY_KEY]: requestIdentityOffer(),
      [ACP_OUTBOX_CAPABILITY_KEY]: outboxOffer()
    }, true);

    expect(result.clientProtocolCapabilities.requestIdentity).toBe(ACP_REQUEST_IDENTITY_CAPABILITY);
    expect(result.clientProtocolCapabilities.outbox).toEqual({
      status: "selected",
      capability: ACP_OUTBOX_CAPABILITY
    });
    expect(result.response._meta).toEqual({
      [ACP_REQUEST_IDENTITY_CAPABILITY_KEY]: {
        version: 1,
        delivery: "recoverable"
      },
      [ACP_OUTBOX_CAPABILITY_KEY]: {
        version: 1,
        semantics: "at-least-once",
        ackMethod: ACP_OUTBOX_ACK_METHOD,
        deliveryMethod: ACP_OUTBOX_DELIVERY_METHOD,
        deliveryMetaKey: ACP_OUTBOX_DELIVERY_META_KEY
      }
    });
    expect(result.response._meta?.[ACP_OUTBOX_CAPABILITY_KEY]).not.toHaveProperty("writerCompletion");
  });

  it("does not select malformed optional offers or accept raw non-protocol metadata", () => {
    const result = initializeV2({
      [ACP_REQUEST_IDENTITY_CAPABILITY_KEY]: requestIdentityOffer({
        prompt: "private prompt",
        reasoning: "private reasoning",
        headers: { authorization: "secret" },
        rawNotes: "private note"
      }),
      [ACP_OUTBOX_CAPABILITY_KEY]: outboxOffer({
        prompt: "private prompt",
        reasoning: "private reasoning",
        headers: { authorization: "secret" },
        rawNotes: "private note"
      })
    });

    expect(result.clientProtocolCapabilities.requestIdentity).toEqual({ status: "unsupported" });
    expect(result.clientProtocolCapabilities.outbox).toEqual({ status: "unsupported" });
    expect(result.response).not.toHaveProperty("_meta");
  });

  it("fails closed when either required extension cannot be selected", () => {
    expect(() =>
      initializeV1({
        [ACP_REQUEST_IDENTITY_CAPABILITY_KEY]: requestIdentityOffer({ versions: [2], required: true })
      })
    ).toThrow(AcpProtocolCapabilityNegotiationError);

    expect(() =>
      initializeV2({
        [ACP_OUTBOX_CAPABILITY_KEY]: outboxOffer({ versions: [2], required: true })
      })
    ).toThrow(AcpProtocolCapabilityNegotiationError);
  });

  it("never treats a JSON-RPC requestId as stable client message identity", () => {
    const result = handleInitializeV1(
      {
        protocolVersion: 1,
        clientCapabilities: {},
        requestId: "transport-request-42"
      } as unknown as Parameters<typeof handleInitializeV1>[0],
      "1.0.0"
    );

    expect(result.clientProtocolCapabilities.requestIdentity).toEqual({ status: "disabled" });
    expect(result.response).not.toHaveProperty("_meta");
  });
});
