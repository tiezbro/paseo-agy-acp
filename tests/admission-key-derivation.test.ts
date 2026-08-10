import { hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ADMISSION_KEY_DERIVATION_VERSION,
  ADMISSION_KEY_PURPOSES,
  AdmissionKeyDerivationError,
  deriveAdmissionKeyBundle,
  deriveAdmissionSubkey,
  zeroAdmissionKeyBundle,
  type AdmissionKeyPurpose
} from "../src/admission/key-derivation.js";

const MASTER_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const DERIVATION_NAMESPACE = "paseo-agy-acp/admission/key-derivation";
const DERIVATION_ALGORITHM = "hkdf-sha256";
const DERIVATION_SALT_LABEL = "salt";
const DERIVATION_INFO_LABEL = "subkey";

function frame(parts: readonly Buffer[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(part.length);
    chunks.push(length, part);
  }
  return Buffer.concat(chunks);
}

function versionBytes(version: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(version);
  return bytes;
}

function expectedSubkey(purpose: AdmissionKeyPurpose, version = ADMISSION_KEY_DERIVATION_VERSION): Buffer {
  const salt = frame([
    Buffer.from(DERIVATION_NAMESPACE, "utf8"),
    Buffer.from(DERIVATION_ALGORITHM, "utf8"),
    Buffer.from(DERIVATION_SALT_LABEL, "utf8"),
    versionBytes(version)
  ]);
  const info = frame([
    Buffer.from(DERIVATION_NAMESPACE, "utf8"),
    Buffer.from(DERIVATION_ALGORITHM, "utf8"),
    Buffer.from(DERIVATION_INFO_LABEL, "utf8"),
    versionBytes(version),
    Buffer.from(purpose, "utf8")
  ]);
  return Buffer.from(hkdfSync("sha256", MASTER_KEY, salt, info, 32));
}

function thrownMessage(run: () => void): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected admission key derivation to throw");
}

describe("admission key derivation", () => {
  it("derives each 32-byte purpose subkey with versioned, framed HKDF-SHA256", () => {
    const keys = ADMISSION_KEY_PURPOSES.map((purpose) => deriveAdmissionSubkey(MASTER_KEY, purpose));

    expect(keys).toHaveLength(7);
    for (const [index, purpose] of ADMISSION_KEY_PURPOSES.entries()) {
      expect(keys[index]).toEqual(expectedSubkey(purpose));
      expect(keys[index]).toHaveLength(32);
    }
    for (let left = 0; left < keys.length; left += 1) {
      for (let right = left + 1; right < keys.length; right += 1) {
        expect(keys[left].equals(keys[right])).toBe(false);
      }
    }
  });

  it("returns independent buffers for individual subkeys and key bundles", () => {
    const first = deriveAdmissionSubkey(MASTER_KEY, "encryption");
    const second = deriveAdmissionSubkey(MASTER_KEY, "encryption");
    const bundle = deriveAdmissionKeyBundle(MASTER_KEY);

    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    first.fill(0);
    expect(second).toEqual(expectedSubkey("encryption"));
    expect(deriveAdmissionSubkey(MASTER_KEY, "encryption")).toEqual(expectedSubkey("encryption"));

    const bundleKeys = Object.values(bundle);
    expect(new Set(bundleKeys).size).toBe(bundleKeys.length);
    bundle.encryption.fill(0xa5);
    expect(bundle.requestIdentity).toEqual(expectedSubkey("request-identity"));
    expect(bundle.startupCanary).toEqual(expectedSubkey("startup-canary"));
    expect(bundle.preDispatchProof).toEqual(expectedSubkey("pre-dispatch-proof"));
  });

  it("zeroes every valid derived key in a bundle", () => {
    const bundle = deriveAdmissionKeyBundle(MASTER_KEY);
    const keys = Object.values(bundle);

    zeroAdmissionKeyBundle(bundle);

    for (const key of keys) expect(key.equals(Buffer.alloc(32))).toBe(true);
    expect(bundle.startupCanary.equals(Buffer.alloc(32))).toBe(true);
    expect(bundle.preDispatchProof.equals(Buffer.alloc(32))).toBe(true);
  });

  it("rejects malformed master keys, purposes, versions, and bundles without echoing key content", () => {
    expect(() => deriveAdmissionSubkey(Buffer.alloc(31), "encryption")).toThrow(AdmissionKeyDerivationError);
    expect(() => deriveAdmissionSubkey(Buffer.alloc(33), "encryption")).toThrow(AdmissionKeyDerivationError);
    expect(() => deriveAdmissionSubkey(new Uint8Array(32) as unknown as Buffer, "encryption")).toThrow(
      AdmissionKeyDerivationError
    );

    const privateMarker = "private admission master material";
    const keyError = thrownMessage(() => deriveAdmissionSubkey(Buffer.from(privateMarker), "encryption"));
    expect(keyError).not.toContain(privateMarker);

    for (const purpose of ["", "untrusted-purpose", null, {}]) {
      expect(() => deriveAdmissionSubkey(MASTER_KEY, purpose as AdmissionKeyPurpose)).toThrow(
        AdmissionKeyDerivationError
      );
    }
    for (const version of [0, 2, 1.5, Number.NaN, "1"]) {
      expect(() => deriveAdmissionSubkey(MASTER_KEY, "encryption", version as number)).toThrow(
        AdmissionKeyDerivationError
      );
    }

    expect(() => zeroAdmissionKeyBundle({ encryption: Buffer.alloc(32) } as never)).toThrow(AdmissionKeyDerivationError);
  });
});
