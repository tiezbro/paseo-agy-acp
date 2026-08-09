import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const KEY_FILE_NAME = "admission.key";
const KEY_LENGTH = 32;

export class AdmissionKeyStoreError extends Error {
  constructor(message: string) {
    super(`admission key store error: ${message}`);
    this.name = "AdmissionKeyStoreError";
  }
}

/**
 * Return the per-state-directory AES key. The caller owns keeping the Buffer
 * out of logs and serialized state; this helper only manages its local file.
 */
export function loadOrCreateAdmissionKey(stateDir: string): Buffer {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  assertSecureDirectory(stateDir);
  const keyPath = path.join(stateDir, KEY_FILE_NAME);

  try {
    const file = openSync(keyPath, "wx", 0o600);
    const key = randomBytes(KEY_LENGTH);
    try {
      writeFileSync(file, key);
      fsyncSync(file);
    } finally {
      closeSync(file);
    }
    assertSecureFile(keyPath);
    return key;
  } catch (error) {
    if (!isAlreadyExists(error)) throw normalizeError(error);
  }

  assertSecureFile(keyPath);
  const key = readFileSync(keyPath);
  if (key.length !== KEY_LENGTH) {
    throw new AdmissionKeyStoreError("admission key must be exactly 32 bytes");
  }
  return key;
}

function assertSecureDirectory(dir: string): void {
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new AdmissionKeyStoreError("admission state path must be a real directory");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new AdmissionKeyStoreError("admission state directory must not grant group or other access");
  }
}

function assertSecureFile(file: string): void {
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AdmissionKeyStoreError("admission key path must be a regular file");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new AdmissionKeyStoreError("admission key must not grant group or other access");
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function normalizeError(error: unknown): AdmissionKeyStoreError {
  if (error instanceof AdmissionKeyStoreError) return error;
  return new AdmissionKeyStoreError("could not create admission key");
}
