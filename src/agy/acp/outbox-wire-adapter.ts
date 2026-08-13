import * as v1 from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import { z } from "zod";
import { createOutboxEventMetadata } from "../../admission/outbox-protocol.js";
import type { OutboxDeliveryMessage, OutboxDeliverySender } from "./outbox-delivery.js";
import { ACP_OUTBOX_DELIVERY_META_KEY } from "./protocol-capabilities.js";
import { sessionUpdateToV1, sessionUpdateToV2 } from "./session/update-wire.js";

const TEXT_CONTENT = z.object({
  type: z.literal("text"),
  text: z.string()
}).strict();

const TOOL_KIND = z.enum([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "other"
]);

const TOOL_STATUS = z.enum(["pending", "in_progress", "completed", "failed"]);

// The durable payload intentionally accepts a small, serializable v1-shaped
// subset. It excludes ACP extension metadata and raw tool inputs/outputs.
const DURABLE_INTERNAL_SESSION_UPDATE = z.discriminatedUnion("sessionUpdate", [
  z.object({
    sessionUpdate: z.literal("agent_message_chunk"),
    messageId: z.string().min(1),
    content: TEXT_CONTENT
  }).strict(),
  z.object({
    sessionUpdate: z.literal("tool_call"),
    toolCallId: z.string().min(1),
    title: z.string(),
    kind: TOOL_KIND.optional(),
    status: TOOL_STATUS.optional(),
    content: z.array(TEXT_CONTENT).optional()
  }).strict(),
  z.object({
    sessionUpdate: z.literal("tool_call_update"),
    toolCallId: z.string().min(1),
    title: z.string().optional(),
    kind: TOOL_KIND.optional(),
    status: TOOL_STATUS.optional(),
    content: z.array(TEXT_CONTENT).optional()
  }).strict()
]);

export class AcpOutboxWirePayloadError extends Error {
  constructor() {
    super("durable outbox payload is not a supported internal session update");
    this.name = "AcpOutboxWirePayloadError";
  }
}

export class AcpOutboxWireRouteError extends Error {
  constructor() {
    super("durable outbox delivery does not have a valid ACP session route");
    this.name = "AcpOutboxWireRouteError";
  }
}

type DurableInternalSessionUpdate = z.infer<typeof DURABLE_INTERNAL_SESSION_UPDATE>;

interface PreparedOutboxDelivery {
  readonly sessionId: string;
  readonly update: v1.SessionUpdate;
  readonly meta: Record<string, unknown>;
}

/**
 * Parse the encrypted durable payload only into a deliberate internal update
 * subset. Nothing parsed from payload can become ACP request metadata.
 */
export function parseDurableOutboxSessionUpdate(payload: string): v1.SessionUpdate {
  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    throw new AcpOutboxWirePayloadError();
  }

  const parsed = DURABLE_INTERNAL_SESSION_UPDATE.safeParse(decoded);
  if (!parsed.success) throw new AcpOutboxWirePayloadError();
  return parsed.data as DurableInternalSessionUpdate as unknown as v1.SessionUpdate;
}

/** Write one durable delivery over the stable ACP v1 client.session.update route. */
export async function notifyOutboxDeliveryV1(client: v1.AgentContext, message: OutboxDeliveryMessage): Promise<void> {
  const delivery = prepareOutboxDelivery(message);
  await client.notify(v1.methods.client.session.update, {
    sessionId: delivery.sessionId,
    update: sessionUpdateToV1(delivery.update),
    _meta: delivery.meta
  });
}

/** Write one durable delivery over the draft ACP v2 client.session.update route. */
export async function notifyOutboxDeliveryV2(client: v2.AgentContext, message: OutboxDeliveryMessage): Promise<void> {
  const delivery = prepareOutboxDelivery(message);
  await client.notify(v2.methods.client.session.update, {
    sessionId: delivery.sessionId,
    update: sessionUpdateToV2(delivery.update),
    _meta: delivery.meta
  });
}

/** Attach the narrow v1 adapter to an outbox bridge without exposing raw payloads to a client. */
export function createOutboxDeliverySenderV1(client: v1.AgentContext): OutboxDeliverySender {
  return (message) => notifyOutboxDeliveryV1(client, message);
}

/** Attach the narrow v2 adapter to an outbox bridge without exposing raw payloads to a client. */
export function createOutboxDeliverySenderV2(client: v2.AgentContext): OutboxDeliverySender {
  return (message) => notifyOutboxDeliveryV2(client, message);
}

function prepareOutboxDelivery(message: OutboxDeliveryMessage): PreparedOutboxDelivery {
  if (typeof message.sessionId !== "string" || message.sessionId.length === 0) {
    throw new AcpOutboxWireRouteError();
  }

  const metadata = createOutboxEventMetadata(message.metadata);
  const update = parseDurableOutboxSessionUpdate(message.payload);
  const deliveryMetadata = Object.freeze({
    v: metadata.v,
    eventId: metadata.eventId,
    idempotencyKey: metadata.eventId,
    sequence: metadata.sequence,
    claimGeneration: metadata.claimGeneration,
    claimToken: metadata.claimToken
  });
  return Object.freeze({
    sessionId: message.sessionId,
    update,
    meta: Object.freeze({ [ACP_OUTBOX_DELIVERY_META_KEY]: deliveryMetadata })
  });
}
