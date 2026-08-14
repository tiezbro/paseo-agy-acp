import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
  type Stats
} from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const KEY_FILE_NAME = "admission.key";
const KEY_LENGTH = 32;
const TEMPORARY_FILE_PREFIX = ".admission.key.";
const TEMPORARY_FILE_SUFFIX = ".tmp";
const MAX_PUBLICATION_READ_RETRIES = 100;
const publicationRetrySignal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export class AdmissionKeyStoreError extends Error {
  constructor(message: string) {
    super(`admission key store error: ${message}`);
    this.name = "AdmissionKeyStoreError";
  }
}

class AdmissionKeyPublicationInProgressError extends Error {}

/**
 * Return the per-state-directory AES key. The caller owns keeping the Buffer
 * out of logs and serialized state; this helper only manages its local file.
 */
export function loadOrCreateAdmissionKey(stateDir: string): Buffer {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  assertSecureDirectory(stateDir);
  const keyPath = path.join(stateDir, KEY_FILE_NAME);

  try {
    return readStableAdmissionKey(keyPath);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  return createAndPublishAdmissionKey(stateDir, keyPath);
}

function createAndPublishAdmissionKey(stateDir: string, keyPath: string): Buffer {
  const key = randomBytes(KEY_LENGTH);
  let temporaryPath: string | undefined = writeTemporaryAdmissionKey(stateDir, key);
  let returnKeyToCaller = false;

  try {
    try {
      // link(2) creates the final name only when it does not already exist.
      linkSync(temporaryPath, keyPath);
    } catch (error) {
      if (!isAlreadyExists(error)) throw normalizeError(error);

      cleanupTemporaryFile(temporaryPath);
      temporaryPath = undefined;
      return readStableAdmissionKey(keyPath);
    }

    cleanupTemporaryFile(temporaryPath);
    temporaryPath = undefined;
    fsyncParentDirectory(stateDir);
    returnKeyToCaller = true;
    return key;
  } finally {
    if (temporaryPath !== undefined) cleanupTemporaryFile(temporaryPath);
    // A losing publisher or any failed publication must not retain its
    // generated key material until garbage collection. The winning key is
    // returned to the caller, which owns its lifetime and zeroization.
    if (!returnKeyToCaller) key.fill(0);
  }
}

function writeTemporaryAdmissionKey(stateDir: string, key: Buffer): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const temporaryPath = path.join(
      stateDir,
      `${TEMPORARY_FILE_PREFIX}${process.pid}.${randomBytes(16).toString("hex")}${TEMPORARY_FILE_SUFFIX}`
    );
    let file: number | undefined;
    let created = false;
    let failure: unknown;

    try {
      file = openSync(temporaryPath, temporaryFileOpenFlags(), 0o600);
      created = true;
      writeAll(file, key);
      fsyncSync(file);
      const stat = fstatSync(file);
      assertSecureKeyFile(stat);
      assertKeyLength(stat.size);
    } catch (error) {
      failure = error;
    }

    if (file !== undefined) {
      try {
        closeSync(file);
      } catch (error) {
        failure ??= error;
      }
    }

    if (failure === undefined) return temporaryPath;

    if (created) cleanupTemporaryFile(temporaryPath);
    if (!created && isAlreadyExists(failure)) continue;
    throw normalizeError(failure);
  }

  throw new AdmissionKeyStoreError("could not create admission key");
}

function readStableAdmissionKey(keyPath: string): Buffer {
  for (let attempt = 0; attempt <= MAX_PUBLICATION_READ_RETRIES; attempt += 1) {
    try {
      return readAdmissionKeyOnce(keyPath);
    } catch (error) {
      if (!(error instanceof AdmissionKeyPublicationInProgressError)) throw error;
      if (attempt === MAX_PUBLICATION_READ_RETRIES) {
        throw new AdmissionKeyStoreError("admission key must have exactly one link");
      }
      Atomics.wait(publicationRetrySignal, 0, 0, 1);
    }
  }

  throw new AdmissionKeyStoreError("admission key must have exactly one link");
}

function readAdmissionKeyOnce(keyPath: string): Buffer {
  let file: number;
  try {
    file = openSync(keyPath, readFileOpenFlags());
  } catch (error) {
    if (isNotFound(error)) throw error;
    if (isUnsafePathError(error)) {
      throw new AdmissionKeyStoreError("admission key path must be a regular file");
    }
    throw new AdmissionKeyStoreError("could not read admission key");
  }

  try {
    assertSecureKeyFile(fstatSync(file));
    const key = readFileSync(file);
    assertSecureKeyFile(fstatSync(file));
    assertKeyLength(key.length);
    return key;
  } catch (error) {
    if (error instanceof AdmissionKeyStoreError || error instanceof AdmissionKeyPublicationInProgressError) {
      throw error;
    }
    throw new AdmissionKeyStoreError("could not read admission key");
  } finally {
    closeSync(file);
  }
}

function assertSecureDirectory(dir: string): void {
  const directory = openSecureDirectory(dir);
  try {
    const stat = fstatSync(directory);
    if (!stat.isDirectory()) {
      throw new AdmissionKeyStoreError("admission state path must be a real directory");
    }
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (currentUid !== undefined && stat.uid !== currentUid) {
      throw new AdmissionKeyStoreError("admission state directory must be owned by the current user");
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new AdmissionKeyStoreError("admission state directory must not grant group or other access");
    }
  } catch (error) {
    if (error instanceof AdmissionKeyStoreError) throw error;
    throw new AdmissionKeyStoreError("could not access admission state directory");
  } finally {
    closeSync(directory);
  }
}

function fsyncParentDirectory(dir: string): void {
  const directory = openSecureDirectory(dir);
  try {
    fsyncSync(directory);
  } catch (error) {
    if (error instanceof AdmissionKeyStoreError) throw error;
    throw new AdmissionKeyStoreError("could not sync admission state directory");
  } finally {
    closeSync(directory);
  }
}

function openSecureDirectory(dir: string): number {
  try {
    return openSync(dir, directoryOpenFlags());
  } catch (error) {
    if (isUnsafePathError(error)) {
      throw new AdmissionKeyStoreError("admission state path must be a real directory");
    }
    if (error instanceof AdmissionKeyStoreError) throw error;
    throw new AdmissionKeyStoreError("could not access admission state directory");
  }
}

function assertSecureKeyFile(stat: Stats): void {
  if (!stat.isFile()) {
    throw new AdmissionKeyStoreError("admission key path must be a regular file");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new AdmissionKeyStoreError("admission key must be owned by the current user");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new AdmissionKeyStoreError("admission key must not grant group or other access");
  }
  if (stat.nlink !== 1) {
    if (stat.nlink === 2) throw new AdmissionKeyPublicationInProgressError();
    throw new AdmissionKeyStoreError("admission key must have exactly one link");
  }
}

function assertKeyLength(length: number): void {
  if (length !== KEY_LENGTH) {
    throw new AdmissionKeyStoreError("admission key must be exactly 32 bytes");
  }
}

function writeAll(file: number, key: Buffer): void {
  let offset = 0;
  while (offset < key.length) {
    const written = writeSync(file, key, offset, key.length - offset, null);
    if (written <= 0) throw new AdmissionKeyStoreError("could not write admission key");
    offset += written;
  }
}

function cleanupTemporaryFile(temporaryPath: string): void {
  try {
    unlinkSync(temporaryPath);
  } catch (error) {
    if (!isNotFound(error)) throw normalizeError(error);
  }
}

function readFileOpenFlags(): number {
  return constants.O_RDONLY | noFollowFlag();
}

function temporaryFileOpenFlags(): number {
  return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag();
}

function directoryOpenFlags(): number {
  const directory = constants.O_DIRECTORY;
  if (typeof directory !== "number" || directory === 0) {
    throw new AdmissionKeyStoreError("secure admission key storage is not supported on this platform");
  }
  return constants.O_RDONLY | directory | noFollowFlag();
}

function noFollowFlag(): number {
  const noFollow = constants.O_NOFOLLOW;
  if (process.platform === "win32" || typeof noFollow !== "number" || noFollow === 0) {
    throw new AdmissionKeyStoreError("secure admission key storage is not supported on this platform");
  }
  return noFollow;
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isNotFound(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isUnsafePathError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ELOOP" || code === "ENOTDIR";
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function normalizeError(error: unknown): AdmissionKeyStoreError {
  if (error instanceof AdmissionKeyStoreError) return error;
  return new AdmissionKeyStoreError("could not create admission key");
}
