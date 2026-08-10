export const ACP_REQUEST_IDENTITY_CAPABILITY_KEY = "paseo-agy-acp/requestIdentity";
export const ACP_REQUEST_IDENTITY_CAPABILITY_VERSION = 1;

const INITIALIZATION_FIELDS = ["versions", "required"] as const;
const PROMPT_METADATA_FIELDS = ["v", "clientMessageId"] as const;
const MAX_CAPABILITY_VERSIONS = 16;
const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface RequestIdentityNegotiationOptions {
  /** False means this server cannot safely create recoverable request identities. */
  readonly identityAvailable?: boolean;
}

export interface SelectedRequestIdentityCapability {
  readonly status: "selected";
  readonly version: typeof ACP_REQUEST_IDENTITY_CAPABILITY_VERSION;
  readonly delivery: "recoverable";
}

export interface DisabledRequestIdentityCapability {
  readonly status: "disabled";
}

export interface UnsupportedRequestIdentityCapability {
  readonly status: "unsupported";
}

export interface IdentityUnavailableRequestIdentityCapability {
  readonly status: "identity_unavailable";
}

export interface RequestIdentityProtocolErrorResult {
  readonly status: "protocol_error";
  readonly code: "request_identity_required";
  readonly reason: "unsupported" | "identity_unavailable";
}

export type RequestIdentityNegotiationResult =
  | SelectedRequestIdentityCapability
  | DisabledRequestIdentityCapability
  | UnsupportedRequestIdentityCapability
  | IdentityUnavailableRequestIdentityCapability
  | RequestIdentityProtocolErrorResult;

export interface RecoverablePromptRequestIdentity {
  readonly kind: "recoverable";
  readonly version: typeof ACP_REQUEST_IDENTITY_CAPABILITY_VERSION;
  readonly clientMessageId: string;
}

export interface LegacyEphemeralPromptRequestIdentity {
  readonly kind: "legacy_ephemeral";
}

export type PromptRequestIdentityResult =
  | RecoverablePromptRequestIdentity
  | LegacyEphemeralPromptRequestIdentity;

export class AcpRequestIdentityProtocolError extends Error {
  constructor(message: string) {
    super(`ACP request identity protocol error: ${message}`);
    this.name = "AcpRequestIdentityProtocolError";
  }
}

export const ACP_REQUEST_IDENTITY_CAPABILITY: SelectedRequestIdentityCapability = Object.freeze({
  status: "selected",
  version: ACP_REQUEST_IDENTITY_CAPABILITY_VERSION,
  delivery: "recoverable"
});

const DISABLED_REQUEST_IDENTITY_CAPABILITY: DisabledRequestIdentityCapability = Object.freeze({
  status: "disabled"
});
const UNSUPPORTED_REQUEST_IDENTITY_CAPABILITY: UnsupportedRequestIdentityCapability = Object.freeze({
  status: "unsupported"
});
const IDENTITY_UNAVAILABLE_REQUEST_IDENTITY_CAPABILITY: IdentityUnavailableRequestIdentityCapability = Object.freeze({
  status: "identity_unavailable"
});
const LEGACY_EPHEMERAL_PROMPT_REQUEST_IDENTITY: LegacyEphemeralPromptRequestIdentity = Object.freeze({
  kind: "legacy_ephemeral"
});

/**
 * Negotiate the value carried at `_meta["paseo-agy-acp/requestIdentity"]` in
 * an initialization request. The offer is deliberately structural: prompt
 * content and reasoning never have a valid position in this protocol record.
 */
export function negotiateRequestIdentityCapability(
  offer: unknown,
  options: RequestIdentityNegotiationOptions = {}
): RequestIdentityNegotiationResult {
  if (offer === undefined) return DISABLED_REQUEST_IDENTITY_CAPABILITY;

  const required = hasSafeRequiredFlag(offer);
  let fields: Record<string, unknown>;
  try {
    fields = readExactRecord(offer, INITIALIZATION_FIELDS, "initialization offer");
  } catch {
    return selectFailure(required, "unsupported");
  }

  if (fields.required !== true && fields.required !== false) {
    return selectFailure(required, "unsupported");
  }
  if (!isSafeVersionList(fields.versions)) {
    return selectFailure(fields.required, "unsupported");
  }
  if (!includesVersionOne(fields.versions)) {
    return selectFailure(fields.required, "unsupported");
  }
  if (options.identityAvailable === false) {
    return selectFailure(fields.required, "identity_unavailable");
  }
  return ACP_REQUEST_IDENTITY_CAPABILITY;
}

/**
 * Admit structural prompt metadata after capability negotiation. Callers pass
 * the value of `_meta["paseo-agy-acp/requestIdentity"]`, not the full `_meta`
 * object, so unrelated ACP metadata remains outside this protocol boundary.
 */
export function validateRequestIdentityPromptMetadata(
  negotiation: RequestIdentityNegotiationResult,
  metadata: unknown
): PromptRequestIdentityResult {
  if (negotiation.status === "selected") {
    return createRecoverablePromptRequestIdentity(metadata);
  }

  if (negotiation.status === "protocol_error") {
    throw new AcpRequestIdentityProtocolError("required identity negotiation did not select a safe version");
  }

  if (metadata !== undefined) {
    throw new AcpRequestIdentityProtocolError("identity metadata was sent without successful negotiation");
  }
  return LEGACY_EPHEMERAL_PROMPT_REQUEST_IDENTITY;
}

function createRecoverablePromptRequestIdentity(metadata: unknown): RecoverablePromptRequestIdentity {
  const fields = readExactRecord(metadata, PROMPT_METADATA_FIELDS, "prompt identity metadata");
  if (fields.v !== ACP_REQUEST_IDENTITY_CAPABILITY_VERSION) {
    throw new AcpRequestIdentityProtocolError("prompt identity metadata.v is unsupported");
  }
  if (!isClientMessageId(fields.clientMessageId)) {
    throw new AcpRequestIdentityProtocolError("prompt identity metadata.clientMessageId is invalid");
  }

  return Object.freeze({
    kind: "recoverable",
    version: ACP_REQUEST_IDENTITY_CAPABILITY_VERSION,
    clientMessageId: fields.clientMessageId
  });
}

function selectFailure(
  required: boolean,
  reason: RequestIdentityProtocolErrorResult["reason"]
): RequestIdentityNegotiationResult {
  if (required) {
    return Object.freeze({
      status: "protocol_error" as const,
      code: "request_identity_required" as const,
      reason
    });
  }
  return reason === "identity_unavailable"
    ? IDENTITY_UNAVAILABLE_REQUEST_IDENTITY_CAPABILITY
    : UNSUPPORTED_REQUEST_IDENTITY_CAPABILITY;
}

function readExactRecord(
  input: unknown,
  allowedFields: readonly string[],
  label: string
): Record<string, unknown> {
  if (!isPlainRecord(input)) {
    throw new AcpRequestIdentityProtocolError(`${label} must be a plain object`);
  }

  const names = Object.getOwnPropertyNames(input);
  if (Object.getOwnPropertySymbols(input).length !== 0 || names.length !== allowedFields.length) {
    throw new AcpRequestIdentityProtocolError(`${label} has unsupported fields`);
  }

  for (const name of allowedFields) {
    if (!names.includes(name)) {
      throw new AcpRequestIdentityProtocolError(`${label} has unsupported fields`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!isEnumerableDataProperty(descriptor)) {
      throw new AcpRequestIdentityProtocolError(`${label} has unsafe fields`);
    }
  }

  return input as Record<string, unknown>;
}

function hasSafeRequiredFlag(input: unknown): boolean {
  if (!isPlainRecord(input)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(input, "required");
  return isEnumerableDataProperty(descriptor) && descriptor.value === true;
}

function isSafeVersionList(value: unknown): value is readonly number[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length === 0 ||
    value.length > MAX_CAPABILITY_VERSIONS
  ) {
    return false;
  }

  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 || names.length !== value.length + 1) return false;

  for (const name of names) {
    if (name === "length") continue;
    const index = Number(name);
    if (!Number.isSafeInteger(index) || index < 0 || String(index) !== name || index >= value.length) {
      return false;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!isEnumerableDataProperty(descriptor)) return false;
  }

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!isEnumerableDataProperty(descriptor)) return false;
    if (!Number.isSafeInteger(descriptor.value) || descriptor.value < 1) return false;
  }
  return true;
}

function includesVersionOne(versions: readonly number[]): boolean {
  return versions.includes(ACP_REQUEST_IDENTITY_CAPABILITY_VERSION);
}

function isClientMessageId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_MESSAGE_ID_PATTERN.test(value);
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
