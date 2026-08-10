import { createHmac } from "node:crypto";

const KEY_LENGTH = 32;
const MAX_COMPONENT_LENGTH = 0xffff_ffff;
const REQUEST_DOMAIN = "paseo-agy-acp/admission/request-identity/v1";
const DELIVERY_DOMAIN = "paseo-agy-acp/admission/delivery-event-identity/v1";
const REQUEST_FIELDS = ["agentId", "acpSessionId", "clientMessageId"] as const;
const DELIVERY_FIELDS = ["conversationId", "cursor", "eventType", "toolId", "state"] as const;

export interface RequestIdentityInput {
  agentId: string;
  acpSessionId: string;
  clientMessageId: string;
}

/** Structural delivery identifiers only; payload or prompt content is not accepted. */
export interface DeliveryEventIdentityInput {
  conversationId: string;
  cursor: string;
  eventType: string;
  toolId: string;
  state: string;
}

export class AdmissionIdentityError extends Error {
  constructor(message: string) {
    super(`admission identity error: ${message}`);
    this.name = "AdmissionIdentityError";
  }
}

/**
 * Derive the stable identity for an ACP request that supplies a client message ID.
 * The HMAC input deliberately contains identifiers only, never prompt content.
 */
export function createRequestIdentity(key: Buffer, input: RequestIdentityInput): string {
  const fields = asIdentityRecord(input, "request", REQUEST_FIELDS);
  return createIdentity(key, REQUEST_DOMAIN, [
    requireIdentityField(fields, "agentId"),
    requireIdentityField(fields, "acpSessionId"),
    requireIdentityField(fields, "clientMessageId")
  ]);
}

/**
 * Derive the stable identity for one outbound ACP update from structural state.
 * Content blocks and prompt text are intentionally absent from this API.
 */
export function createDeliveryEventIdentity(key: Buffer, input: DeliveryEventIdentityInput): string {
  const fields = asIdentityRecord(input, "delivery event", DELIVERY_FIELDS);
  return createIdentity(key, DELIVERY_DOMAIN, [
    requireIdentityField(fields, "conversationId"),
    requireIdentityField(fields, "cursor"),
    requireIdentityField(fields, "eventType"),
    requireIdentityField(fields, "toolId"),
    requireIdentityField(fields, "state")
  ]);
}

function createIdentity(key: Buffer, domain: string, components: readonly string[]): string {
  requireKey(key);
  return createHmac("sha256", key).update(frame([domain, ...components])).digest("hex").toLowerCase();
}

function asIdentityRecord(
  input: unknown,
  identityKind: string,
  allowedFields: readonly string[]
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new AdmissionIdentityError(`${identityKind} identity input must be an object`);
  }
  if (Object.keys(input).some((name) => !allowedFields.includes(name))) {
    throw new AdmissionIdentityError(`${identityKind} identity input has unsupported fields`);
  }
  return input as Record<string, unknown>;
}

function requireIdentityField(fields: Record<string, unknown>, name: string): string {
  const value = fields[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AdmissionIdentityError(`identity field ${name} must be a non-empty string`);
  }
  return value;
}

function requireKey(key: unknown): asserts key is Buffer {
  if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
    throw new AdmissionIdentityError("identity key must be exactly 32 bytes");
  }
}

function frame(components: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const component of components) {
    const bytes = Buffer.from(component, "utf8");
    if (bytes.length > MAX_COMPONENT_LENGTH) {
      throw new AdmissionIdentityError("identity component is too long");
    }
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
}
