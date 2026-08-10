import { describe, expect, it } from "vitest";
import {
  ACP_REQUEST_IDENTITY_CAPABILITY,
  ACP_REQUEST_IDENTITY_CAPABILITY_KEY,
  ACP_REQUEST_IDENTITY_CAPABILITY_VERSION,
  AcpRequestIdentityProtocolError,
  negotiateRequestIdentityCapability,
  validateRequestIdentityPromptMetadata,
  type RequestIdentityNegotiationResult
} from "../src/admission/request-identity-protocol.js";

function initializationOffer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    versions: [ACP_REQUEST_IDENTITY_CAPABILITY_VERSION],
    required: false,
    ...overrides
  };
}

function negotiated(): RequestIdentityNegotiationResult {
  return negotiateRequestIdentityCapability(initializationOffer());
}

function thrownMessage(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected protocol validation to throw");
}

describe("admission request identity protocol", () => {
  it("publishes the fixed v1 metadata contract", () => {
    expect(ACP_REQUEST_IDENTITY_CAPABILITY_KEY).toBe("paseo-agy-acp/requestIdentity");
    expect(ACP_REQUEST_IDENTITY_CAPABILITY_VERSION).toBe(1);
    expect(ACP_REQUEST_IDENTITY_CAPABILITY).toEqual({
      status: "selected",
      version: 1,
      delivery: "recoverable"
    });
    expect(Object.isFrozen(ACP_REQUEST_IDENTITY_CAPABILITY)).toBe(true);
  });

  it("negotiates recoverable v1 only from an exact initialization offer", () => {
    const result = negotiateRequestIdentityCapability(initializationOffer({ versions: [2, 1] }));

    expect(result).toBe(ACP_REQUEST_IDENTITY_CAPABILITY);
  });

  it("distinguishes disabled, unsupported, and identity-unavailable optional offers", () => {
    expect(negotiateRequestIdentityCapability(undefined)).toEqual({ status: "disabled" });
    expect(negotiateRequestIdentityCapability(initializationOffer({ versions: [2] }))).toEqual({
      status: "unsupported"
    });
    expect(
      negotiateRequestIdentityCapability(initializationOffer(), { identityAvailable: false })
    ).toEqual({ status: "identity_unavailable" });
  });

  it("returns a typed error rather than downgrading a required unsafe selection", () => {
    expect(negotiateRequestIdentityCapability(initializationOffer({ versions: [2], required: true }))).toEqual({
      status: "protocol_error",
      code: "request_identity_required",
      reason: "unsupported"
    });
    expect(
      negotiateRequestIdentityCapability(initializationOffer({ required: true }), {
        identityAvailable: false
      })
    ).toEqual({
      status: "protocol_error",
      code: "request_identity_required",
      reason: "identity_unavailable"
    });
  });

  it("fails closed for malformed offers and unsafe version arrays", () => {
    const accessorVersions = initializationOffer();
    Object.defineProperty(accessorVersions, "versions", {
      enumerable: true,
      get() {
        return [1];
      }
    });

    const accessorElement = [1];
    Object.defineProperty(accessorElement, "0", {
      enumerable: true,
      get() {
        return 1;
      }
    });

    const arrayWithExtraField = [1] as number[] & { injected?: boolean };
    arrayWithExtraField.injected = true;

    const unsafeOffers: unknown[] = [
      null,
      [],
      initializationOffer({ versions: [] }),
      initializationOffer({ versions: new Array(1) }),
      initializationOffer({ versions: [1, 1.5] }),
      initializationOffer({ versions: [1, "2"] }),
      initializationOffer({ versions: new Set([1]) }),
      initializationOffer({ versions: accessorElement }),
      initializationOffer({ versions: arrayWithExtraField }),
      initializationOffer({ required: "false" }),
      initializationOffer({ rawPrompt: "must not become metadata" }),
      initializationOffer({ prompt: "must not become metadata" }),
      initializationOffer({ reasoning: "must not become metadata" }),
      initializationOffer({ headers: { authorization: "secret" } }),
      initializationOffer({ rawNotes: "must not become metadata" }),
      accessorVersions
    ];

    for (const offer of unsafeOffers) {
      expect(negotiateRequestIdentityCapability(offer)).toEqual({ status: "unsupported" });
    }

    expect(
      negotiateRequestIdentityCapability(initializationOffer({ versions: [], required: true }))
    ).toEqual({
      status: "protocol_error",
      code: "request_identity_required",
      reason: "unsupported"
    });
  });

  it("accepts and freezes exact structural prompt identity metadata after negotiation", () => {
    const source = { v: 1, clientMessageId: "Message_A.1:alpha-beta" };
    const result = validateRequestIdentityPromptMetadata(negotiated(), source);
    source.clientMessageId = "mutated-after-validation";

    expect(result).toEqual({
      kind: "recoverable",
      version: 1,
      clientMessageId: "Message_A.1:alpha-beta"
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("rejects missing, malformed, raw-content, and extra prompt metadata after negotiation", () => {
    const rawPrompt = "sensitive prompt must never reach identity metadata errors";
    const rawReasoning = "sensitive reasoning must never reach identity metadata errors";
    const invalidMetadata: unknown[] = [
      undefined,
      null,
      {},
      { v: 2, clientMessageId: "message-1" },
      { v: 1, clientMessageId: "" },
      { v: 1, clientMessageId: `message${String.fromCharCode(0)}-1` },
      { v: 1, clientMessageId: "message id" },
      { v: 1, clientMessageId: "x".repeat(129) },
      { v: 1, clientMessageId: "message-1", prompt: rawPrompt },
      { v: 1, clientMessageId: "message-1", reasoning: rawReasoning },
      { v: 1, clientMessageId: "message-1", content: rawPrompt },
      { v: 1, clientMessageId: "message-1", headers: { authorization: "secret" } },
      { v: 1, clientMessageId: "message-1", rawNotes: "private note" },
      { v: 1, clientMessageId: "message-1", requestId: "json-rpc-request-1" }
    ];

    for (const metadata of invalidMetadata) {
      const message = thrownMessage(() => validateRequestIdentityPromptMetadata(negotiated(), metadata));
      expect(message).not.toContain(rawPrompt);
      expect(message).not.toContain(rawReasoning);
      expect(() => validateRequestIdentityPromptMetadata(negotiated(), metadata)).toThrow(
        AcpRequestIdentityProtocolError
      );
    }
  });

  it("only permits an ephemeral legacy request when identity was not negotiated", () => {
    const disabled = negotiateRequestIdentityCapability(undefined);
    const unsupported = negotiateRequestIdentityCapability(initializationOffer({ versions: [2] }));
    const unavailable = negotiateRequestIdentityCapability(initializationOffer(), {
      identityAvailable: false
    });

    expect(validateRequestIdentityPromptMetadata(disabled, undefined)).toEqual({ kind: "legacy_ephemeral" });
    expect(validateRequestIdentityPromptMetadata(unsupported, undefined)).toEqual({ kind: "legacy_ephemeral" });
    expect(validateRequestIdentityPromptMetadata(unavailable, undefined)).toEqual({ kind: "legacy_ephemeral" });

    for (const result of [disabled, unsupported, unavailable]) {
      expect(() => validateRequestIdentityPromptMetadata(result, { v: 1, clientMessageId: "message-1" })).toThrow(
        AcpRequestIdentityProtocolError
      );
    }
  });

  it("does not admit a prompt after a required negotiation error", () => {
    const failed = negotiateRequestIdentityCapability(initializationOffer({ versions: [2], required: true }));

    expect(() => validateRequestIdentityPromptMetadata(failed, undefined)).toThrow(
      AcpRequestIdentityProtocolError
    );
  });
});
