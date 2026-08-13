import {
  ACP_OUTBOX_CAPABILITY_KEY,
  negotiateOutboxCapabilityOffer,
  type OutboxCapabilityNegotiationResult
} from "../../admission/outbox-protocol.js";
import {
  ACP_REQUEST_IDENTITY_CAPABILITY_KEY,
  negotiateRequestIdentityCapability,
  type RequestIdentityNegotiationResult
} from "../../admission/request-identity-protocol.js";

/** ACP baseline method used for all durable outbox writes. */
export const ACP_OUTBOX_DELIVERY_METHOD = "session/update";
/** `_meta` namespace containing only durable delivery fence and idempotency data. */
export const ACP_OUTBOX_DELIVERY_META_KEY = ACP_OUTBOX_CAPABILITY_KEY;

export interface AcpInitializationProtocolCapabilities {
  readonly requestIdentity: RequestIdentityNegotiationResult;
  readonly outbox: Exclude<OutboxCapabilityNegotiationResult, { readonly status: "protocol_error" }>;
  readonly responseMeta: Record<string, unknown> | undefined;
}

export interface AcpProtocolCapabilityAvailability {
  readonly requestIdentityAvailable?: boolean;
  readonly outboxAvailable?: boolean;
}

export class AcpProtocolCapabilityNegotiationError extends Error {
  constructor(capability: "requestIdentity" | "outbox") {
    super(`required ACP ${capability} capability could not be selected`);
    this.name = "AcpProtocolCapabilityNegotiationError";
  }
}

export function negotiateAcpInitializationProtocolCapabilities(
  meta: unknown,
  availability: AcpProtocolCapabilityAvailability = {}
): AcpInitializationProtocolCapabilities {
  const requestIdentityOffer = readOwnDataProperty(meta, ACP_REQUEST_IDENTITY_CAPABILITY_KEY);
  const requestIdentity = negotiateRequestIdentityCapability(
    requestIdentityOffer,
    { identityAvailable: availability.requestIdentityAvailable ?? true }
  );
  if (requestIdentity.status === "protocol_error") {
    throw new AcpProtocolCapabilityNegotiationError("requestIdentity");
  }

  const outboxOffer = readOwnDataProperty(meta, ACP_OUTBOX_CAPABILITY_KEY);
  let outboxResult = negotiateOutboxCapabilityOffer(outboxOffer);
  if (outboxResult.status === "protocol_error") {
    throw new AcpProtocolCapabilityNegotiationError("outbox");
  }
  // Extension methods are not part of the baseline ACP surface. A peer offer
  // is selected only after the serving app has registered the ACK route around
  // a live durable delivery backend.
  if (outboxResult.status === "selected" && availability.outboxAvailable !== true) {
    if (readRequiredFlag(outboxOffer)) {
      throw new AcpProtocolCapabilityNegotiationError("outbox");
    }
    outboxResult = Object.freeze({ status: "unsupported" });
  }
  const outbox = outboxResult;
  const responseMeta = createResponseMeta(requestIdentity, outbox);
  return Object.freeze({ requestIdentity, outbox, responseMeta });
}

function createResponseMeta(
  requestIdentity: RequestIdentityNegotiationResult,
  outbox: Exclude<OutboxCapabilityNegotiationResult, { readonly status: "protocol_error" }>
): Record<string, unknown> | undefined {
  const response: Record<string, unknown> = Object.create(null);
  if (requestIdentity.status === "selected") {
    response[ACP_REQUEST_IDENTITY_CAPABILITY_KEY] = Object.freeze({
      version: requestIdentity.version,
      delivery: requestIdentity.delivery
    });
  }
  if (outbox.status === "selected") {
    response[ACP_OUTBOX_CAPABILITY_KEY] = Object.freeze({
      version: outbox.capability.version,
      semantics: outbox.capability.semantics,
      ackMethod: outbox.capability.ackMethod,
      deliveryMethod: ACP_OUTBOX_DELIVERY_METHOD,
      deliveryMetaKey: ACP_OUTBOX_DELIVERY_META_KEY
    });
  }
  return Object.keys(response).length === 0 ? undefined : Object.freeze(response);
}

function readOwnDataProperty(value: unknown, key: string): unknown {
  if (!isPlainRecord(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return isEnumerableDataProperty(descriptor) ? descriptor.value : undefined;
}

function readRequiredFlag(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, "required");
  return isEnumerableDataProperty(descriptor) && descriptor.value === true;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEnumerableDataProperty(
  descriptor: PropertyDescriptor | undefined
): descriptor is PropertyDescriptor & { value: unknown } {
  return descriptor !== undefined && descriptor.enumerable === true && Object.prototype.hasOwnProperty.call(descriptor, "value");
}
