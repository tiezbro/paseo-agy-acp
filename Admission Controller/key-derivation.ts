import { hkdfSync } from "node:crypto";

const MASTER_KEY_LENGTH = 32;
const DERIVED_KEY_LENGTH = 32;
const UINT32_MAX = 0xffff_ffff;
const DERIVATION_NAMESPACE = "paseo-agy-acp/admission/key-derivation";
const DERIVATION_ALGORITHM = "hkdf-sha256";
const DERIVATION_SALT_LABEL = "salt";
const DERIVATION_INFO_LABEL = "subkey";

export const ADMISSION_KEY_DERIVATION_VERSION = 1;

export const ADMISSION_KEY_PURPOSES = [
  "encryption",
  "request-identity",
  "content-fingerprint",
  "delivery-identity",
  "claim-token",
  "startup-canary",
  "pre-dispatch-proof"
] as const;

export type AdmissionKeyPurpose = (typeof ADMISSION_KEY_PURPOSES)[number];

export interface AdmissionKeyBundle {
  encryption: Buffer;
  requestIdentity: Buffer;
  contentFingerprint: Buffer;
  deliveryIdentity: Buffer;
  claimToken: Buffer;
  startupCanary: Buffer;
  preDispatchProof: Buffer;
}

export class AdmissionKeyDerivationError extends Error {
  constructor(message: string) {
    super(`admission key derivation error: ${message}`);
    this.name = "AdmissionKeyDerivationError";
  }
}

const PURPOSE_SET: ReadonlySet<string> = new Set(ADMISSION_KEY_PURPOSES);
const BUNDLE_FIELDS = [
  "encryption",
  "requestIdentity",
  "contentFingerprint",
  "deliveryIdentity",
  "claimToken",
  "startupCanary",
  "preDispatchProof"
] as const satisfies readonly (keyof AdmissionKeyBundle)[];

/**
 * Derive one 32-byte admission subkey. The version is embedded in both HKDF
 * salt and info frames so a later derivation format cannot share this domain.
 */
export function deriveAdmissionSubkey(
  masterKey: Buffer,
  purpose: AdmissionKeyPurpose,
  version: number = ADMISSION_KEY_DERIVATION_VERSION
): Buffer {
  requireMasterKey(masterKey);
  requirePurpose(purpose);
  requireVersion(version);
  return deriveValidatedSubkey(masterKey, purpose, version);
}

/** Derive the complete independent key set used by the admission controller. */
export function deriveAdmissionKeyBundle(
  masterKey: Buffer,
  version: number = ADMISSION_KEY_DERIVATION_VERSION
): AdmissionKeyBundle {
  requireMasterKey(masterKey);
  requireVersion(version);

  return {
    encryption: deriveValidatedSubkey(masterKey, "encryption", version),
    requestIdentity: deriveValidatedSubkey(masterKey, "request-identity", version),
    contentFingerprint: deriveValidatedSubkey(masterKey, "content-fingerprint", version),
    deliveryIdentity: deriveValidatedSubkey(masterKey, "delivery-identity", version),
    claimToken: deriveValidatedSubkey(masterKey, "claim-token", version),
    startupCanary: deriveValidatedSubkey(masterKey, "startup-canary", version),
    preDispatchProof: deriveValidatedSubkey(masterKey, "pre-dispatch-proof", version)
  };
}

/** Overwrite all derived key buffers after the caller no longer needs them. */
export function zeroAdmissionKeyBundle(bundle: AdmissionKeyBundle): void {
  requireKeyBundle(bundle);
  for (const field of BUNDLE_FIELDS) bundle[field].fill(0);
}

function deriveValidatedSubkey(masterKey: Buffer, purpose: AdmissionKeyPurpose, version: number): Buffer {
  const derived = new Uint8Array(
    hkdfSync("sha256", masterKey, derivationSalt(version), derivationInfo(purpose, version), DERIVED_KEY_LENGTH)
  );
  try {
    return Buffer.from(derived);
  } finally {
    derived.fill(0);
  }
}

function derivationSalt(version: number): Buffer {
  return frame([
    utf8(DERIVATION_NAMESPACE),
    utf8(DERIVATION_ALGORITHM),
    utf8(DERIVATION_SALT_LABEL),
    encodeVersion(version)
  ]);
}

function derivationInfo(purpose: AdmissionKeyPurpose, version: number): Buffer {
  return frame([
    utf8(DERIVATION_NAMESPACE),
    utf8(DERIVATION_ALGORITHM),
    utf8(DERIVATION_INFO_LABEL),
    encodeVersion(version),
    utf8(purpose)
  ]);
}

function frame(parts: readonly Uint8Array[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if (part.byteLength > UINT32_MAX) {
      throw new AdmissionKeyDerivationError("derivation frame component is too long");
    }
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(part.byteLength);
    chunks.push(length, Buffer.from(part));
  }
  return Buffer.concat(chunks);
}

function utf8(value: string): Buffer {
  return Buffer.from(value, "utf8");
}

function encodeVersion(version: number): Buffer {
  const output = Buffer.alloc(4);
  output.writeUInt32BE(version);
  return output;
}

function requireMasterKey(masterKey: unknown): asserts masterKey is Buffer {
  if (!Buffer.isBuffer(masterKey) || masterKey.length !== MASTER_KEY_LENGTH) {
    throw new AdmissionKeyDerivationError("admission master key must be exactly 32 bytes");
  }
}

function requirePurpose(purpose: unknown): asserts purpose is AdmissionKeyPurpose {
  if (typeof purpose !== "string" || !PURPOSE_SET.has(purpose)) {
    throw new AdmissionKeyDerivationError("admission key purpose is unsupported");
  }
}

function requireVersion(version: unknown): asserts version is number {
  if (
    !Number.isSafeInteger(version) ||
    version !== ADMISSION_KEY_DERIVATION_VERSION ||
    version < 1 ||
    version > UINT32_MAX
  ) {
    throw new AdmissionKeyDerivationError("admission key derivation version is unsupported");
  }
}

function requireKeyBundle(bundle: unknown): asserts bundle is AdmissionKeyBundle {
  if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle)) {
    throw new AdmissionKeyDerivationError("derived key bundle is invalid");
  }

  const candidate = bundle as Record<string, unknown>;
  for (const field of BUNDLE_FIELDS) {
    const key = candidate[field];
    if (!Buffer.isBuffer(key) || key.length !== DERIVED_KEY_LENGTH) {
      throw new AdmissionKeyDerivationError("derived key bundle is invalid");
    }
  }
}
