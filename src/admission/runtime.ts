import { closeSync, lstatSync, openSync } from "node:fs";
import { AdmissionController } from "./controller.js";
import type {
  AdmissionPromptDispatcher,
  AdmissionRuntimePromptDispatcherOptions
} from "./dispatcher.js";
import { loadOrCreateAdmissionKey } from "./key-store.js";
import {
  deriveAdmissionKeyBundle,
  zeroAdmissionKeyBundle,
  type AdmissionKeyBundle
} from "./key-derivation.js";
import type { DeliveryEventIdentityInput } from "./identity.js";
import {
  AdmissionRuntimeComposition,
  type AdmissionDeliveryBridgeFactory,
  type AdmissionPromptSeamFactoryOptions,
  type AdmissionRecoveryBridgeFactory,
  type AdmissionRuntimeBridge
} from "./runtime-composition.js";
import type { AdmissionPromptSeam } from "./prompt-seam.js";
import {
  parseAdmissionRuntimeConfig,
  type AdmissionRuntimeEnvironment,
  type EnabledAdmissionRuntimeConfig
} from "./runtime-config.js";

export class AdmissionRuntimeError extends Error {
  constructor(message: string) {
    super(`admission runtime error: ${message}`);
    this.name = "AdmissionRuntimeError";
  }
}

export class AdmissionRuntime {
  readonly #controller: AdmissionController;
  readonly #composition?: AdmissionRuntimeComposition;
  readonly #agentId?: string;
  #closed = false;

  /** Direct construction remains available for isolated controller tests only. */
  constructor(controller: AdmissionController, composition?: AdmissionRuntimeComposition, agentId?: string) {
    this.#controller = controller;
    this.#composition = composition;
    this.#agentId = agentId;
  }

  get controller(): AdmissionController {
    this.assertOpen();
    return this.#controller;
  }

  createPromptSeam(options: AdmissionPromptSeamFactoryOptions): AdmissionPromptSeam {
    this.assertOpen();
    return this.requireComposition().createPromptSeam(this, this.requireAgentId(), options);
  }

  /** Composition owns PTY HMAC verification; callers provide no verifier or key. */
  createPromptDispatcher<TProcess, TProcessIdentity>(
    options: AdmissionRuntimePromptDispatcherOptions<TProcess, TProcessIdentity>
  ): AdmissionPromptDispatcher<TProcess, TProcessIdentity> {
    this.assertOpen();
    return this.requireComposition().createPromptDispatcher(this, options);
  }

  createDeliveryEventIdentity(input: DeliveryEventIdentityInput): string {
    this.assertOpen();
    return this.requireComposition().createDeliveryEventIdentity(input);
  }

  createDeliveryBridge<T extends AdmissionRuntimeBridge>(factory: AdmissionDeliveryBridgeFactory<T>): T {
    this.assertOpen();
    return this.requireComposition().createDeliveryBridge(this, factory);
  }

  createRecoveryBridge<T extends AdmissionRuntimeBridge>(factory: AdmissionRecoveryBridgeFactory<T>): T {
    this.assertOpen();
    return this.requireComposition().createRecoveryBridge(this, factory);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;

    let failure: unknown;
    try {
      this.#composition?.close();
    } catch (error) {
      failure = error;
    }
    try {
      this.#controller.close();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) throw failure;
  }

  private assertOpen(): void {
    if (this.#closed) throw new AdmissionRuntimeError("runtime is closed");
  }

  private requireComposition(): AdmissionRuntimeComposition {
    if (this.#composition === undefined) {
      throw new AdmissionRuntimeError("runtime composition is unavailable");
    }
    return this.#composition;
  }

  private requireAgentId(): string {
    if (this.#agentId === undefined) {
      throw new AdmissionRuntimeError("runtime agent identity is unavailable");
    }
    return this.#agentId;
  }
}

/** Build the source-only runtime. AcpAgent does not call this until v2 wiring is complete. */
export function createAdmissionRuntime(
  environment: AdmissionRuntimeEnvironment = process.env
): AdmissionRuntime | null {
  const config = parseAdmissionRuntimeConfig(environment);
  if (!config.enabled) return null;

  rejectUnsafeExistingDatabase(config.databasePath);
  const key = loadOrCreateAdmissionKey(config.stateDir);
  let derivedKeys: AdmissionKeyBundle | undefined;
  let composition: AdmissionRuntimeComposition | undefined;
  let controller: AdmissionController | undefined;
  try {
    derivedKeys = deriveAdmissionKeyBundle(key);
    ensureSecureDatabase(config);
    composition = new AdmissionRuntimeComposition(derivedKeys);
    controller = composition.createController({
      databasePath: config.databasePath,
      policy: config.policy
    });
    return new AdmissionRuntime(controller, composition, config.agentId);
  } catch (error) {
    try {
      controller?.close();
    } catch {
      // Preserve the factory failure while releasing any controller-owned copies.
    }
    try {
      composition?.close();
    } catch {
      // Composition close always zeroes its private copies before it can throw.
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
