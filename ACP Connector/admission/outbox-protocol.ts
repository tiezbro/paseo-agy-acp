export const ACP_OUTBOX_CAPABILITY_KEY = "paseo-agy-acp/outbox";
export const ACP_OUTBOX_CAPABILITY_VERSION = 1;
export const ACP_OUTBOX_DELIVERY_SEMANTICS = "at-least-once";
export const ACP_OUTBOX_ACK_METHOD = "_paseo-agy-acp/outbox/ack";

const CAPABILITY_FIELDS = ["versions", "required", "ackRequests", "durableEventIdDedupe"] as const;
const EVENT_METADATA_FIELDS = ["v", "eventId", "sequence", "claimGeneration", "claimToken"] as const;
const ACK_FIELDS = ["v", "sessionId", "eventId", "claimGeneration", "claimToken"] as const;
const MAX_CAPABILITY_VERSIONS = 16;

export interface OutboxCapability {
  readonly key: typeof ACP_OUTBOX_CAPABILITY_KEY;
  readonly version: typeof ACP_OUTBOX_CAPABILITY_VERSION;
  readonly semantics: typeof ACP_OUTBOX_DELIVERY_SEMANTICS;
  readonly ackMethod: typeof ACP_OUTBOX_ACK_METHOD;
}

export interface SelectedOutboxCapability {
  readonly status: "selected";
  readonly capability: OutboxCapability;
}

export interface DisabledOutboxCapability {
  readonly status: "disabled";
}

export interface UnsupportedOutboxCapability {
  readonly status: "unsupported";
}

export interface OutboxProtocolErrorResult {
  readonly status: "protocol_error";
  readonly code: "outbox_required";
  readonly reason: "unsupported";
}

export type OutboxCapabilityNegotiationResult =
  | SelectedOutboxCapability
  | DisabledOutboxCapability
  | UnsupportedOutboxCapability
  | OutboxProtocolErrorResult;

export interface OutboxEventMetadataInput {
  v: number;
  eventId: string;
  sequence: number;
  claimGeneration: number;
  claimToken: string;
}

export interface OutboxEventMetadata {
  readonly v: typeof ACP_OUTBOX_CAPABILITY_VERSION;
  readonly eventId: string;
  readonly sequence: number;
  readonly claimGeneration: number;
  readonly claimToken: string;
}

export interface OutboxAckInput {
  v: number;
  sessionId: string;
  eventId: string;
  claimGeneration: number;
  claimToken: string;
}

/** A durable-delivery acknowledgement only; writer completion has no ACK form. */
export interface OutboxAck {
  readonly v: typeof ACP_OUTBOX_CAPABILITY_VERSION;
  readonly sessionId: string;
  readonly eventId: string;
  readonly claimGeneration: number;
  readonly claimToken: string;
}

export class AcpOutboxProtocolError extends Error {
  constructor(message: string) {
    super(`ACP outbox protocol error: ${message}`);
    this.name = "AcpOutboxProtocolError";
  }
}

export const ACP_OUTBOX_CAPABILITY: OutboxCapability = Object.freeze({
  key: ACP_OUTBOX_CAPABILITY_KEY,
  version: ACP_OUTBOX_CAPABILITY_VERSION,
  semantics: ACP_OUTBOX_DELIVERY_SEMANTICS,
  ackMethod: ACP_OUTBOX_ACK_METHOD
});

/** Project a negotiated ACP capability into the protocol-neutral controller contract. */
export function durableDeliveryProtocol(capability: OutboxCapability): Readonly<{
  version: typeof ACP_OUTBOX_CAPABILITY_VERSION;
  semantics: typeof ACP_OUTBOX_DELIVERY_SEMANTICS;
}> {
  if (
    capability.key !== ACP_OUTBOX_CAPABILITY_KEY ||
    capability.version !== ACP_OUTBOX_CAPABILITY_VERSION ||
    capability.semantics !== ACP_OUTBOX_DELIVERY_SEMANTICS ||
    capability.ackMethod !== ACP_OUTBOX_ACK_METHOD
  ) {
    throw new AcpOutboxProtocolError("delivery capability is not negotiated");
  }
  return Object.freeze({ version: capability.version, semantics: capability.semantics });
}

const SELECTED_OUTBOX_CAPABILITY: SelectedOutboxCapability = Object.freeze({
  status: "selected",
  capability: ACP_OUTBOX_CAPABILITY
});
const DISABLED_OUTBOX_CAPABILITY: DisabledOutboxCapability = Object.freeze({ status: "disabled" });
const UNSUPPORTED_OUTBOX_CAPABILITY: UnsupportedOutboxCapability = Object.freeze({ status: "unsupported" });
const REQUIRED_OUTBOX_CAPABILITY_ERROR: OutboxProtocolErrorResult = Object.freeze({
  status: "protocol_error",
  code: "outbox_required",
  reason: "unsupported"
});

/**
 * Accept only an exact peer offer that proves v1 durable dedupe and ACK handling.
 * Unconfirmed delivery is recovery debt and is never replayed after reconnect.
 */
export function negotiateOutboxCapability(offer: unknown): OutboxCapability | null {
  try {
    const fields = readExactRecord(offer, CAPABILITY_FIELDS, "capability offer");
    if (!isSupportedVersionList(fields.versions)) return null;
    if (fields.required !== true && fields.required !== false) return null;
    if (fields.ackRequests !== true) return null;
    if (fields.durableEventIdDedupe !== true) return null;
    return ACP_OUTBOX_CAPABILITY;
  } catch {
    return null;
  }
}

/**
 * Negotiate the initialization value carried at `_meta["paseo-agy-acp/outbox"]`.
 * A required offer that cannot establish all at-least-once guarantees is never
 * silently downgraded to legacy delivery.
 */
export function negotiateOutboxCapabilityOffer(offer: unknown): OutboxCapabilityNegotiationResult {
  if (offer === undefined) return DISABLED_OUTBOX_CAPABILITY;

  const capability = negotiateOutboxCapability(offer);
  if (capability !== null) return SELECTED_OUTBOX_CAPABILITY;
  return hasSafeRequiredFlag(offer) ? REQUIRED_OUTBOX_CAPABILITY_ERROR : UNSUPPORTED_OUTBOX_CAPABILITY;
}

/**
 * Copy structural delivery metadata into an immutable record. Content, prompt,
 * reasoning, and every other non-protocol field are rejected at this boundary.
 */
export function createOutboxEventMetadata(input: unknown): OutboxEventMetadata {
  const fields = readExactRecord(input, EVENT_METADATA_FIELDS, "event metadata");
  return Object.freeze({
    v: requireVersion(fields.v, "event metadata.v"),
    eventId: requireIdentifier(fields.eventId, "event metadata.eventId"),
    sequence: requireNonNegativeSafeInteger(fields.sequence, "event metadata.sequence"),
    claimGeneration: requireNonNegativeSafeInteger(fields.claimGeneration, "event metadata.claimGeneration"),
    claimToken: requireIdentifier(fields.claimToken, "event metadata.claimToken")
  });
}

/**
 * Validate a durable outbox acknowledgement. This record cannot carry writer
 * completion, payload, reasoning, or delivery sequencing fields.
 */
export function validateOutboxAck(input: unknown): OutboxAck {
  const fields = readExactRecord(input, ACK_FIELDS, "acknowledgement");
  return Object.freeze({
    v: requireVersion(fields.v, "acknowledgement.v"),
    sessionId: requireIdentifier(fields.sessionId, "acknowledgement.sessionId"),
    eventId: requireIdentifier(fields.eventId, "acknowledgement.eventId"),
    claimGeneration: requireNonNegativeSafeInteger(fields.claimGeneration, "acknowledgement.claimGeneration"),
    claimToken: requireIdentifier(fields.claimToken, "acknowledgement.claimToken")
  });
}

function readExactRecord(
  input: unknown,
  allowedFields: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isPlainRecord(input)) {
    throw new AcpOutboxProtocolError(`${label} must be a plain object`);
  }

  const names = Object.getOwnPropertyNames(input);
  if (Object.getOwnPropertySymbols(input).length !== 0 || names.length !== allowedFields.length) {
    throw new AcpOutboxProtocolError(`${label} has unsupported fields`);
  }

  for (const name of allowedFields) {
    if (!names.includes(name)) {
      throw new AcpOutboxProtocolError(`${label} has unsupported fields`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!isEnumerableDataProperty(descriptor)) {
      throw new AcpOutboxProtocolError(`${label} has unsafe fields`);
    }
  }

  return input as Record<string, unknown>;
}

function isSupportedVersionList(value: unknown): boolean {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length === 0 || value.length > MAX_CAPABILITY_VERSIONS) {
    return false;
  }

  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  for (const name of names) {
    if (name === "length") continue;
    const index = Number(name);
    if (!Number.isSafeInteger(index) || index < 0 || String(index) !== name || index >= value.length) return false;
  }

  let includesVersionOne = false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!isEnumerableDataProperty(descriptor)) return false;
    const version = descriptor.value;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return false;
    if (version === ACP_OUTBOX_CAPABILITY_VERSION) includesVersionOne = true;
  }
  return includesVersionOne;
}

function requireVersion(value: unknown, label: string): typeof ACP_OUTBOX_CAPABILITY_VERSION {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value !== ACP_OUTBOX_CAPABILITY_VERSION) {
    throw new AcpOutboxProtocolError(`${label} is unsupported`);
  }
  return ACP_OUTBOX_CAPABILITY_VERSION;
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new AcpOutboxProtocolError(`${label} must be a non-empty string without NUL`);
  }
  return value;
}

function requireNonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AcpOutboxProtocolError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasSafeRequiredFlag(input: unknown): boolean {
  if (!isPlainRecord(input)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(input, "required");
  return isEnumerableDataProperty(descriptor) && descriptor.value === true;
}

function isEnumerableDataProperty(
  descriptor: PropertyDescriptor | undefined
): descriptor is PropertyDescriptor & { value: unknown } {
  return descriptor !== undefined && descriptor.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, "value");
}
