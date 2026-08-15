import { closeSync, lstatSync, openSync } from "node:fs";
import { AdmissionController } from "../../Admission Controller/controller.js";
import { loadOrCreateAdmissionKey } from "../../Admission Controller/key-store.js";
import {
  deriveAdmissionKeyBundle,
  zeroAdmissionKeyBundle,
  type AdmissionKeyBundle
} from "../../Admission Controller/key-derivation.js";
import {
  parseAdmissionRuntimeConfig,
  type AdmissionRuntimeEnvironment,
  type EnabledAdmissionRuntimeConfig
} from "../../Admission Controller/runtime-config.js";
import { recoverExitedAdmissionSeats } from "./startup-recovery.js";

export class AdmissionRuntimeError extends Error {
  constructor(message: string) {
    super(`admission runtime error: ${message}`);
    this.name = "AdmissionRuntimeError";
  }
}

export class AdmissionRuntime {
  readonly #controller: AdmissionController;
  #closed = false;

  constructor(controller: AdmissionController) {
    this.#controller = controller;
  }

  get controller(): AdmissionController {
    this.assertOpen();
    return this.#controller;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#controller.close();
  }

  private assertOpen(): void {
    if (this.#closed) throw new AdmissionRuntimeError("runtime is closed");
  }

}

/** Build the opt-in shared queue runtime and reconcile exited local seats. */
export function createAdmissionRuntime(
  environment: AdmissionRuntimeEnvironment = process.env
): AdmissionRuntime | null {
  const config = parseAdmissionRuntimeConfig(environment);
  if (!config.enabled) return null;

  rejectUnsafeExistingDatabase(config.databasePath);
  const key = loadOrCreateAdmissionKey(config.stateDir);
  let derivedKeys: AdmissionKeyBundle | undefined;
  let controller: AdmissionController | undefined;
  try {
    derivedKeys = deriveAdmissionKeyBundle(key);
    ensureSecureDatabase(config);
    controller = new AdmissionController({
      databasePath: config.databasePath,
      policy: config.policy,
      encryptionKey: derivedKeys.encryption,
      contentFingerprintKey: derivedKeys.contentFingerprint
    });
    recoverExitedAdmissionSeats(controller);
    return new AdmissionRuntime(controller);
  } catch (error) {
    try {
      controller?.close();
    } catch {
      // Preserve the factory failure while releasing any controller-owned copies.
    }
    throw error;
  } finally {
    if (derivedKeys !== undefined) zeroAdmissionKeyBundle(derivedKeys);
    key.fill(0);
  }
}

function ensureSecureDatabase(config: EnabledAdmissionRuntimeConfig): void {
  try {
    const file = openSync(config.databasePath, "wx", 0o600);
    closeSync(file);
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw new AdmissionRuntimeError("could not create the admission database");
    }
  }
  assertSecureDatabase(config.databasePath);
}

function rejectUnsafeExistingDatabase(databasePath: string): void {
  try {
    assertSecureDatabase(databasePath);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
}

function assertSecureDatabase(databasePath: string): void {
  const stat = lstatSync(databasePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new AdmissionRuntimeError("admission database path must be a regular file");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new AdmissionRuntimeError("admission database must not grant group or other access");
  }
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new AdmissionRuntimeError("admission database must be owned by the current user");
  }
  if (stat.nlink !== 1) {
    throw new AdmissionRuntimeError("admission database must have exactly one link");
  }
}

function hasErrorCode(error: unknown, expected: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === expected;
}
