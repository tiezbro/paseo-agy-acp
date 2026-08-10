import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AdmissionIdentityError,
  createDeliveryEventIdentity,
  createRequestIdentity,
  type DeliveryEventIdentityInput,
  type RequestIdentityInput
} from "../src/admission/identity.js";

const KEY = Buffer.alloc(32, 0x31);
const REQUEST_DOMAIN = "paseo-agy-acp/admission/request-identity/v1";
const DELIVERY_DOMAIN = "paseo-agy-acp/admission/delivery-event-identity/v1";

function request(overrides: Partial<RequestIdentityInput> = {}): RequestIdentityInput {
  return {
    agentId: "agent-1",
    acpSessionId: "session-1",
    clientMessageId: "message-1",
    ...overrides
  };
}

function delivery(overrides: Partial<DeliveryEventIdentityInput> = {}): DeliveryEventIdentityInput {
  return {
    conversationId: "conversation-1",
    cursor: "cursor-1",
    eventType: "tool_call",
    toolId: "tool-1",
    state: "pending",
    ...overrides
  };
}

function expectedIdentity(domain: string, components: readonly string[]): string {
  const framed: Buffer[] = [];
  for (const component of [domain, ...components]) {
    const bytes = Buffer.from(component, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    framed.push(length, bytes);
  }
  return createHmac("sha256", KEY).update(Buffer.concat(framed)).digest("hex");
}

function thrownMessage(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected identity construction to throw");
}

describe("admission identities", () => {
  it("creates a deterministic lowercase HMAC-SHA256 request identity", () => {
    const input = request();
    const identity = createRequestIdentity(KEY, input);

    expect(identity).toBe(expectedIdentity(REQUEST_DOMAIN, [input.agentId, input.acpSessionId, input.clientMessageId]));
    expect(createRequestIdentity(KEY, input)).toBe(identity);
    expect(identity).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses length-prefixed fields so concatenation boundaries cannot collide", () => {
    const first = createRequestIdentity(KEY, request({ agentId: "ab", acpSessionId: "c" }));
    const second = createRequestIdentity(KEY, request({ agentId: "a", acpSessionId: "bc" }));

    expect(first).not.toBe(second);
  });

  it("separates identities by key and domain", () => {
    const input = request();
    const otherKey = Buffer.alloc(32, 0x32);
    const requestIdentity = createRequestIdentity(KEY, input);
    const deliveryInput = delivery({
      conversationId: input.agentId,
      cursor: input.acpSessionId,
      eventType: input.clientMessageId
    });
    const deliveryIdentity = createDeliveryEventIdentity(KEY, deliveryInput);

    expect(createRequestIdentity(otherKey, input)).not.toBe(requestIdentity);
    expect(deliveryIdentity).toBe(
      expectedIdentity(DELIVERY_DOMAIN, [
        deliveryInput.conversationId,
        deliveryInput.cursor,
        deliveryInput.eventType,
        deliveryInput.toolId,
        deliveryInput.state
      ])
    );
    expect(deliveryIdentity).not.toBe(requestIdentity);
  });

  it("rejects invalid keys and every empty identity field without exposing content", () => {
    expect(() => createRequestIdentity(Buffer.alloc(31), request())).toThrow(AdmissionIdentityError);
    expect(() => createRequestIdentity(Buffer.alloc(33), request())).toThrow(AdmissionIdentityError);
    expect(() => createRequestIdentity("not-a-key" as unknown as Buffer, request())).toThrow(AdmissionIdentityError);

    for (const invalid of ["", "   "]) {
      expect(() => createRequestIdentity(KEY, request({ clientMessageId: invalid }))).toThrow(AdmissionIdentityError);
      expect(() => createDeliveryEventIdentity(KEY, delivery({ toolId: invalid }))).toThrow(AdmissionIdentityError);
    }

    const rawPrompt = "sensitive business prompt must not appear in identity errors";
    const message = thrownMessage(() =>
      createDeliveryEventIdentity(
        KEY,
        delivery({ cursor: { content: rawPrompt } as unknown as string })
      )
    );
    const contentBearingMessage = thrownMessage(() =>
      createDeliveryEventIdentity(
        KEY,
        { ...delivery(), content: rawPrompt } as unknown as DeliveryEventIdentityInput
      )
    );
    expect(message).not.toContain(rawPrompt);
    expect(contentBearingMessage).not.toContain(rawPrompt);
    expect(createRequestIdentity(KEY, request())).not.toContain(rawPrompt);
  });
});
