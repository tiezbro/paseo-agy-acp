import { AdmissionController, type AdmissionPolicy } from "../../Admission Controller/controller.js";
import {
  createAdmissionRuntimePromptDispatcher,
  type AdmissionPromptDispatcher,
  type AdmissionRuntimeFreshPtyCanaryOptions,
  type AdmissionRuntimePromptDispatcherOptions
} from "./dispatcher.js";
import { createDeliveryEventIdentity, type DeliveryEventIdentityInput } from "./identity.js";
import type { AdmissionKeyBundle } from "../../Admission Controller/key-derivation.js";
import { AdmissionPromptSeam, type AdmissionPromptSeamOptions } from "./prompt-seam.js";
import {
  createLinuxPreDispatchProofAuthority,
  type LinuxPreDispatchProofAuthority
} from "../../Admission Controller/process-evidence.js";
import type { AdmissionRuntime } from "./runtime.js";
import {
  asAgyFreshPtyCanaryVerifier,
  runPromptFreePtyCanary
} from "../agy/prompt-free-canary.js";
import type {
  AgyDispatchProcessRecord,
  AgyFreshPtyCanaryResult
} from "../agy/dispatch-boundary.js";

const KEY_LENGTH = 32;

type AdmissionKeyName = keyof AdmissionKeyBundle;

const KEY_NAMES = [
  "encryption",
  "requestIdentity",
  "contentFingerprint",
  "deliveryIdentity",
  "claimToken",
  "startupCanary",
  "preDispatchProof"
] as const satisfies readonly AdmissionKeyName[];

const UNVERIFIED_FRESH_PTY_CANARY: AgyFreshPtyCanaryResult = Object.freeze({ status: "unverified" });

export class AdmissionRuntimeCompositionError extends Error {
  constructor(message: string) {
    super(`admission runtime composition error: ${message}`);
    this.name = "AdmissionRuntimeCompositionError";
  }
}

export interface AdmissionRuntimeControllerOptions {
  readonly databasePath: string;
  readonly policy: Readonly<AdmissionPolicy>;
}

/** The runtime supplies its own identity key, agent identity, and runtime reference. */
export type AdmissionPromptSeamFactoryOptions = Omit<
  AdmissionPromptSeamOptions,
  "runtime" | "agentId" | "requestIdentityKey"
>;

/** Future bridges must be closeable so the runtime can own their key lifetime. */
export interface AdmissionRuntimeBridge {
  close(): void;
}

/** Delivery bridges receive an operation, never delivery-key material. */
export interface AdmissionDeliveryBridgeContext {
  readonly runtime: AdmissionRuntime;
  readonly createEventIdentity: (input: DeliveryEventIdentityInput) => string;
}

export type AdmissionDeliveryBridgeFactory<T extends AdmissionRuntimeBridge> = (
  context: AdmissionDeliveryBridgeContext
) => T;

/** Recovery claim HMACs remain inside AdmissionController. */
export interface AdmissionRecoveryBridgeContext {
  readonly runtime: AdmissionRuntime;
  readonly createPreDispatchProofAuthority: () => LinuxPreDispatchProofAuthority;
}

export type AdmissionRecoveryBridgeFactory<T extends AdmissionRuntimeBridge> = (
  context: AdmissionRecoveryBridgeContext
) => T;

/**
 * Owns only copied, purpose-separated subkeys. The master key never enters
 * this boundary, and bridge constructors receive capabilities rather than keys.
 */
export class AdmissionRuntimeComposition {
  readonly #encryptionKey: Buffer;
  readonly #requestIdentityKey: Buffer;
  readonly #contentFingerprintKey: Buffer;
  readonly #deliveryIdentityKey: Buffer;
  readonly #claimTokenKey: Buffer;
  readonly #startupCanaryKey: Buffer;
  readonly #preDispatchProofKey: Buffer;
  readonly #bridges = new Set<AdmissionRuntimeBridge>();
  #closed = false;

  constructor(keys: AdmissionKeyBundle) {
    const copies = copyKeyBundle(keys);
    this.#encryptionKey = copies.encryption;
    this.#requestIdentityKey = copies.requestIdentity;
    this.#contentFingerprintKey = copies.contentFingerprint;
    this.#deliveryIdentityKey = copies.deliveryIdentity;
    this.#claimTokenKey = copies.claimToken;
    this.#startupCanaryKey = copies.startupCanary;
    this.#preDispatchProofKey = copies.preDispatchProof;
  }

  createController(options: AdmissionRuntimeControllerOptions): AdmissionController {
    this.assertOpen();
    const encryptionKey = Buffer.from(this.#encryptionKey);
    const contentFingerprintKey = Buffer.from(this.#contentFingerprintKey);
    const claimTokenKey = Buffer.from(this.#claimTokenKey);

    try {
      return new AdmissionController({
        databasePath: options.databasePath,
        policy: options.policy,
        encryptionKey,
        contentFingerprintKey,
        claimTokenKey
      });
    } finally {
      encryptionKey.fill(0);
      contentFingerprintKey.fill(0);
      claimTokenKey.fill(0);
    }
  }

  createPromptSeam(
    runtime: AdmissionRuntime,
    agentId: string,
    options: AdmissionPromptSeamFactoryOptions
  ): AdmissionPromptSeam {
    this.assertOpen();
    const requestIdentityKey = Buffer.from(this.#requestIdentityKey);
    try {
      return this.ownBridge(new AdmissionPromptSeam({
        ...options,
        runtime,
        agentId,
        requestIdentityKey
      }));
    } finally {
      requestIdentityKey.fill(0);
    }
  }

  createPromptDispatcher<TProcess, TProcessIdentity>(
    runtime: AdmissionRuntime,
    options: AdmissionRuntimePromptDispatcherOptions<TProcess, TProcessIdentity>
  ): AdmissionPromptDispatcher<TProcess, TProcessIdentity> {
    this.assertOpen();
    const { freshPtyCanary, ...dispatcherOptions } = options;
    return this.ownBridge(createAdmissionRuntimePromptDispatcher(
      runtime,
      dispatcherOptions,
      this.createFreshPtyCanaryVerifier(freshPtyCanary, options.now)
    ));
  }

  createDeliveryEventIdentity(input: DeliveryEventIdentityInput): string {
    this.assertOpen();
    return createDeliveryEventIdentity(this.#deliveryIdentityKey, input);
  }

  createDeliveryBridge<T extends AdmissionRuntimeBridge>(
    runtime: AdmissionRuntime,
    factory: AdmissionDeliveryBridgeFactory<T>
  ): T {
    this.assertOpen();
    if (typeof factory !== "function") {
      throw new AdmissionRuntimeCompositionError("delivery bridge factory must be a function");
    }
    return this.ownBridge(factory(Object.freeze({
      runtime,
      createEventIdentity: (input: DeliveryEventIdentityInput) => runtime.createDeliveryEventIdentity(input)
    })));
  }

  createRecoveryBridge<T extends AdmissionRuntimeBridge>(
    runtime: AdmissionRuntime,
    factory: AdmissionRecoveryBridgeFactory<T>
  ): T {
    this.assertOpen();
    if (typeof factory !== "function") {
      throw new AdmissionRuntimeCompositionError("recovery bridge factory must be a function");
    }
    return this.ownBridge(factory(Object.freeze({
      runtime,
      createPreDispatchProofAuthority: () => this.createPreDispatchProofAuthority()
    })));
  }

  /** Create an owned signing/verifying capability without exposing key bytes. */
  createPreDispatchProofAuthority(): LinuxPreDispatchProofAuthority {
    this.assertOpen();
    const proofKey = Buffer.from(this.#preDispatchProofKey);
    try {
      return this.ownBridge(createLinuxPreDispatchProofAuthority(proofKey));
    } finally {
      proofKey.fill(0);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;

    let failure: unknown;
    for (const bridge of this.#bridges) {
      try {
        bridge.close();
      } catch (error) {
        failure ??= error;
      }
    }
    this.#bridges.clear();
    this.#encryptionKey.fill(0);
    this.#requestIdentityKey.fill(0);
    this.#contentFingerprintKey.fill(0);
    this.#deliveryIdentityKey.fill(0);
    this.#claimTokenKey.fill(0);
    this.#startupCanaryKey.fill(0);
    this.#preDispatchProofKey.fill(0);

    if (failure !== undefined) throw failure;
  }

  private ownBridge<T extends AdmissionRuntimeBridge>(bridge: T): T {
    if (typeof bridge !== "object" || bridge === null || typeof bridge.close !== "function") {
      throw new AdmissionRuntimeCompositionError("runtime bridge must provide close()");
    }
    if (this.#closed) {
      try {
        bridge.close();
      } finally {
        throw new AdmissionRuntimeCompositionError("runtime is closed");
      }
    }
    this.#bridges.add(bridge);
    return bridge;
  }

  private assertOpen(): void {
    if (this.#closed) throw new AdmissionRuntimeCompositionError("runtime is closed");
  }

  private createFreshPtyCanaryVerifier<TProcessIdentity>(
    options: AdmissionRuntimeFreshPtyCanaryOptions | undefined,
    now: (() => number) | undefined
  ): ((businessPrompt: string, record: AgyDispatchProcessRecord<TProcessIdentity>) => AgyFreshPtyCanaryResult) | undefined {
    if (options === undefined) return undefined;

    let verifiedAgyBinary: AdmissionRuntimeFreshPtyCanaryOptions["verifiedAgyBinary"];
    let fakeChild: AdmissionRuntimeFreshPtyCanaryOptions["fakeChild"];
    let maxAgeMs: number | undefined;
    try {
      verifiedAgyBinary = options.verifiedAgyBinary;
      fakeChild = options.fakeChild;
      maxAgeMs = options.maxAgeMs;
    } catch {
      return () => UNVERIFIED_FRESH_PTY_CANARY;
    }
    const canaryNow = now ?? Date.now;

    return (businessPrompt, record) => {
      if (this.#closed || record.promptChannel !== "pty") return UNVERIFIED_FRESH_PTY_CANARY;

      const canaryKey = Buffer.from(this.#startupCanaryKey);
      try {
        const canary = runPromptFreePtyCanary({
          businessPrompt,
          verifiedAgyBinary,
          agyVersion: verifiedAgyBinary.version,
          launcherFingerprint: verifiedAgyBinary.launcherFingerprint,
          canaryKey,
          fakeChild,
          maxAgeMs,
          now: canaryNow
        });
        return asAgyFreshPtyCanaryVerifier(canary, {
          businessPrompt,
          verifiedAgyBinary,
          agyVersion: verifiedAgyBinary.version,
          launcherFingerprint: verifiedAgyBinary.launcherFingerprint,
          canaryKey,
          now: canaryNow
        })(record);
      } catch {
        return UNVERIFIED_FRESH_PTY_CANARY;
      } finally {
        canaryKey.fill(0);
      }
    };
  }
}

function copyKeyBundle(keys: AdmissionKeyBundle): AdmissionKeyBundle {
  if (typeof keys !== "object" || keys === null || Array.isArray(keys)) {
    throw new AdmissionRuntimeCompositionError("derived key bundle is invalid");
  }

  const copies = {} as AdmissionKeyBundle;
  try {
    for (const name of KEY_NAMES) {
      const key = keys[name];
      if (!Buffer.isBuffer(key) || key.length !== KEY_LENGTH) {
        throw new AdmissionRuntimeCompositionError("derived key bundle is invalid");
      }
      copies[name] = Buffer.from(key);
    }
    return copies;
  } catch (error) {
    zeroKeyBundle(copies);
    throw error;
  }
}

function zeroKeyBundle(keys: Partial<AdmissionKeyBundle>): void {
  for (const name of KEY_NAMES) keys[name]?.fill(0);
}
