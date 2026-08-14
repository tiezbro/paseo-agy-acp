import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { describe, expect, it, vi } from "vitest";
import {
  AcpOutboxWirePayloadError,
  notifyOutboxDeliveryV1,
  notifyOutboxDeliveryV2
} from "../ACP Connector/acp/outbox-wire-adapter.js";
import { ACP_OUTBOX_CAPABILITY_KEY } from "../ACP Connector/admission/outbox-protocol.js";
import type { OutboxDeliveryMessage } from "../ACP Connector/acp/outbox-delivery.js";

const MESSAGE: Omit<OutboxDeliveryMessage, "payload"> = {
  sessionId: "session-1",
  metadata: {
    v: 1,
    eventId: "event-1",
    sequence: 9,
    claimGeneration: 2,
    claimToken: "claim-token-2"
  }
};

function withPayload(payload: unknown): OutboxDeliveryMessage {
  return {
    ...MESSAGE,
    payload: typeof payload === "string" ? payload : JSON.stringify(payload)
  };
}

const AGENT_MESSAGE_UPDATE = {
  sessionUpdate: "agent_message_chunk",
  messageId: "message-1",
  content: { type: "text", text: "durable terminal result" }
} as const;

describe("outbox session/update wire adapter", () => {
  it("routes a strictly validated v1 update through standard client.session.update with controlled durable metadata", async () => {
    const notify = vi.fn(async (_method: string, _params: unknown) => undefined);
    const client = { notify } as unknown as v1.AgentContext;

    await notifyOutboxDeliveryV1(client, withPayload(AGENT_MESSAGE_UPDATE));

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(v1.methods.client.session.update, {
      sessionId: "session-1",
      update: AGENT_MESSAGE_UPDATE,
      _meta: {
        [ACP_OUTBOX_CAPABILITY_KEY]: {
          v: 1,
          eventId: "event-1",
          idempotencyKey: "event-1",
          sequence: 9,
          claimGeneration: 2,
          claimToken: "claim-token-2"
        }
      }
    });
    const params = notify.mock.calls[0]![1] as Record<string, unknown>;
    expect(Object.keys(params)).toEqual(["sessionId", "update", "_meta"]);
    expect(Object.keys(params._meta as Record<string, unknown>)).toEqual([ACP_OUTBOX_CAPABILITY_KEY]);
    expect(params).not.toHaveProperty("payload");
    expect(params).not.toHaveProperty("metadata");
  });

  it("maps the same strict internal update onto draft v2 session/update without changing its durable idempotency identity", async () => {
    const notify = vi.fn(async (_method: string, _params: unknown) => undefined);
    const client = { notify } as unknown as v2.AgentContext;
    const v1ToolCall = {
      sessionUpdate: "tool_call",
      toolCallId: "tool-1",
      title: "Run durable check",
      kind: "execute",
      status: "completed",
      content: [{ type: "text", text: "done" }]
    };

    await notifyOutboxDeliveryV2(client, withPayload(v1ToolCall));

    expect(notify).toHaveBeenCalledWith(v2.methods.client.session.update, {
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "Run durable check",
        kind: "execute",
        status: "completed",
        content: [{ type: "text", text: "done" }]
      },
      _meta: {
        [ACP_OUTBOX_CAPABILITY_KEY]: expect.objectContaining({
          eventId: "event-1",
          idempotencyKey: "event-1"
        })
      }
    });
  });

  it("rejects raw or non-contract payload fields before client.notify", async () => {
    const notify = vi.fn(async (_method: string, _params: unknown) => undefined);
    const client = { notify } as unknown as v1.AgentContext;
    const rejectedPayloads = [
      "not json",
      { ...AGENT_MESSAGE_UPDATE, raw: { private: true } },
      { ...AGENT_MESSAGE_UPDATE, headers: { authorization: "secret" } },
      { ...AGENT_MESSAGE_UPDATE, prompt: "private prompt" },
      { ...AGENT_MESSAGE_UPDATE, reasoning: "private reasoning" },
      {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "unsafe",
        rawInput: { secret: true }
      },
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "thought-1",
        content: { type: "text", text: "private reasoning" }
      }
    ];

    for (const payload of rejectedPayloads) {
      await expect(notifyOutboxDeliveryV1(client, withPayload(payload))).rejects.toBeInstanceOf(AcpOutboxWirePayloadError);
    }

    expect(notify).not.toHaveBeenCalled();
  });

  it("replays only the same session/update envelope and stable delivery identity after reconnect", async () => {
    const notify = vi.fn(async (_method: string, _params: unknown) => undefined);
    const request = vi.fn(async () => undefined);
    const client = { notify, request } as unknown as v1.AgentContext;
    const delivery = withPayload(AGENT_MESSAGE_UPDATE);

    await notifyOutboxDeliveryV1(client, delivery);
    await notifyOutboxDeliveryV1(client, delivery);

    expect(notify).toHaveBeenCalledTimes(2);
    expect(request).not.toHaveBeenCalled();
    for (const [method, params] of notify.mock.calls) {
      expect(method).toBe(v1.methods.client.session.update);
      expect((params as { sessionId: string }).sessionId).toBe("session-1");
      expect((params as { _meta: Record<string, { eventId: string; idempotencyKey: string }> })._meta[
        ACP_OUTBOX_CAPABILITY_KEY
      ]).toMatchObject({ eventId: "event-1", idempotencyKey: "event-1" });
    }
  });
});
