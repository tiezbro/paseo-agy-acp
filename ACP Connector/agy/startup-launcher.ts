import {
  REPO_OWNED_AGY_LAUNCH_RUNNER,
  createAgyLaunchSpecification,
  isVerifiedAgyBinary,
  type AgyLaunchExecution,
  type AgyLaunchSpecification,
  type VerifiedAgyBinary
} from "./launch-spec.js";

/** Process classes supplied to an explicitly injected local-start gate. */
export const AGY_STARTUP_CLASSES = ["model_turn", "auxiliary", "resident_pty"] as const;

export type AgyStartupClass = (typeof AGY_STARTUP_CLASSES)[number];

/** A synchronous permit for one local agy process creation or lifetime. */
export interface AgyStartupPermit {
  release(): void;
}

/**
 * Optional integration point for an external admission gate.
 *
 * This owns no queue and is never configured from environment. Model turns use
 * it only as a synchronous start boundary; auxiliary and resident PTY permits
 * are bound to the process lifetime by this module.
 */
export interface AgyStartupLauncher {
  readonly enabled: boolean;
  acquire(classification: AgyStartupClass): AgyStartupPermit;
}

/** Repository-known terminal observation contracts for held startup permits. */
export type AgyStartupProcessLifetime = "child_process" | "pty";

/**
 * Raised after a process was spawned but its requested lifetime contract could
 * not be bound. The permit is deliberately retained: releasing it while an
 * unobservable process may still be alive would violate the admission limit.
 */
export class AgyStartupLifetimeBindingError extends Error {
  readonly classification: Exclude<AgyStartupClass, "model_turn">;
  readonly permitRetained = true;

  constructor(classification: Exclude<AgyStartupClass, "model_turn">) {
    super(`agy ${classification} process has no verifiable terminal lifetime; startup permit retained`);
    this.name = "AgyStartupLifetimeBindingError";
    this.classification = classification;
  }
}

/**
 * The exact PTY fields that a future repository-owned CLI construction must
 * provide. Version, fingerprint, and transport deliberately are not inputs:
 * they are derived from the opaque binary identity and fixed to PTY here.
 */
export interface RepositoryOwnedPromptFreePtyLaunchInput<TProcess> {
  readonly binary: VerifiedAgyBinary;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly processTitle: string;
  readonly temporaryFilePath: string;
  readonly launcherDiagnostics: readonly string[];
  readonly forbiddenTexts: readonly string[];
  readonly start: (launch: AgyLaunchSpecification) => TProcess;
}

interface RegisteredPromptFreePtyLaunch {
  readonly binary: VerifiedAgyBinary;
  readonly specification: AgyLaunchSpecification;
}

const registeredPromptFreePtyLaunches = new WeakMap<object, RegisteredPromptFreePtyLaunch>();
const registeredPromptFreePtySources = new WeakSet<object>();

/**
 * Registers the concrete construction produced by a real prompt-free PTY
 * launcher. This stays module-private: a runtime caller cannot add a source
 * through a canary option or an exported registrar. A future real CLI path
 * must move its exact construction into this module before it can call this.
 *
 * The currently shipped interactive PTY path uses --prompt-interactive with
 * the business prompt in argv. It is rejected here and therefore cannot
 * become fresh-PTY evidence.
 */
function createRepositoryOwnedPromptFreePtyLaunch(
  binary: VerifiedAgyBinary,
  input: RepositoryOwnedPromptFreePtyLaunchInput<unknown>
): AgyLaunchSpecification {
  const executable = requiredExecutableArgument(input.argv);
  if (!isVerifiedAgyBinary(binary, executable)) {
    throw new Error("prompt-free PTY launcher requires its exact verified agy binary");
  }

  const specification = createAgyLaunchSpecification({
    agyVersion: binary.version,
    launcherFingerprint: binary.launcherFingerprint,
    transport: "pty",
    argv: input.argv,
    environment: input.environment,
    cwd: input.cwd,
    processTitle: input.processTitle,
    temporaryFilePath: input.temporaryFilePath,
    launcherDiagnostics: input.launcherDiagnostics
  });
  if (specification.argv.includes("--prompt-interactive")) {
    throw new Error("interactive PTY argv cannot be registered as prompt-free");
  }

  return specification;
}

function registerRepositoryOwnedPromptFreePtyLaunch(
  binary: VerifiedAgyBinary,
  specification: AgyLaunchSpecification
): void {
  if (!isVerifiedAgyBinary(binary, specification.argv[0] ?? "")) {
    throw new Error("prompt-free PTY launcher requires its exact verified agy binary");
  }

  const source = Object.freeze({ binary, specification });
  registeredPromptFreePtySources.add(source);
  registeredPromptFreePtyLaunches.set(binary, source);
}

/**
 * Starts the one repository-owned prompt-free PTY construction and registers
 * that exact successful launch as the only canary source for this binary
 * identity. The business prompt is accepted only as forbidden launch text.
 */
export function startRepositoryOwnedPromptFreePty<TProcess>(
  input: RepositoryOwnedPromptFreePtyLaunchInput<TProcess>
): AgyLaunchExecution<TProcess> {
  const specification = createRepositoryOwnedPromptFreePtyLaunch(
    input.binary,
    input as RepositoryOwnedPromptFreePtyLaunchInput<unknown>
  );
  const execution = REPO_OWNED_AGY_LAUNCH_RUNNER.run(
    specification,
    input.start,
    input.forbiddenTexts
  );
  registerRepositoryOwnedPromptFreePtyLaunch(input.binary, execution.launch);
  return execution;
}

/**
 * Runs a fake child through the exact launcher construction registered above.
 * Its source, spec, and runner are resolved inside this module; callers can
 * inject only the fake child exit result used by the test canary.
 */
export function runRepositoryOwnedPromptFreePtyCanary<TChild>(
  binary: unknown,
  fakeChild: (launch: AgyLaunchSpecification) => TChild,
  forbiddenTexts: readonly string[]
): AgyLaunchExecution<TChild> | undefined {
  const source = registeredPromptFreePtySource(binary);
  if (source === undefined) return undefined;
  return REPO_OWNED_AGY_LAUNCH_RUNNER.run(source.specification, fakeChild, forbiddenTexts);
}

/** True only for the exact source resolved internally by the shared launcher. */
export function isRepositoryOwnedPromptFreePtyLaunch(
  binary: unknown,
  specification: unknown
): specification is AgyLaunchSpecification {
  const source = registeredPromptFreePtySource(binary);
  return source !== undefined && source.specification === specification;
}

/**
 * Starts one local agy process under an optional gate permit.
 *
 * Disabled launchers call `start` directly, retaining the legacy path exactly.
 * An enabled launcher must yield a releasable permit before the process factory
 * is invoked. Model-turn permits cover only the spawn boundary because the
 * AdmissionController lease owns execution capacity. Auxiliary and resident
 * PTY permits remain held until a repository-known terminal callback fires.
 * Spawn throws release immediately. Every release path is exactly once.
 */
export function launchAgyProcess<T>(
  launcher: AgyStartupLauncher | undefined,
  classification: AgyStartupClass,
  start: () => T,
  lifetime?: AgyStartupProcessLifetime
): T {
  if (launcher?.enabled !== true) return start();

  if (classification !== "model_turn" && lifetime === undefined) {
    throw new Error(`enabled agy ${classification} startup requires an explicit process lifetime`);
  }

  const permit = launcher.acquire(classification);
  if (!permit || typeof permit.release !== "function") {
    throw new Error("enabled agy startup launcher did not return a releasable permit");
  }

  let released = false;
  const releaseOnce = () => {
    if (released) return;
    released = true;
    permit.release();
  };

  let process: T;
  try {
    process = start();
  } catch (error) {
    releaseOnce();
    throw error;
  }

  if (classification === "model_turn") {
    releaseOnce();
    return process;
  }

  let releaseFailed = false;
  let releaseError: unknown;
  const releaseFromTerminal = () => {
    try {
      releaseOnce();
    } catch (error) {
      releaseFailed = true;
      releaseError = error;
      throw error;
    }
  };
  try {
    bindStartupPermitLifetime(process, lifetime!, releaseFromTerminal);
  } catch {
    if (releaseFailed) throw releaseError;
    throw new AgyStartupLifetimeBindingError(classification);
  }
  return process;
}

function bindStartupPermitLifetime(
  process: unknown,
  lifetime: AgyStartupProcessLifetime,
  onTerminal: () => void
): void {
  if (lifetime === "child_process") {
    bindChildProcessTerminal(process, onTerminal);
    return;
  }
  bindPtyTerminal(process, onTerminal);
}

function bindChildProcessTerminal(value: unknown, onTerminal: () => void): void {
  if (!isRecord(value) || typeof value.once !== "function") throw new Error("invalid child process");
  if (!isNullableNumber(value.exitCode) || !isNullableString(value.signalCode)) {
    throw new Error("child process terminal state is unavailable");
  }

  if (value.exitCode !== null || value.signalCode !== null) {
    onTerminal();
    return;
  }

  const observer = bufferedTerminalObserver(onTerminal);
  const subscription = value.once("close", observer.notify);
  if (subscription !== value) throw new Error("child process terminal subscription is invalid");
  observer.arm();
  if (value.exitCode !== null || value.signalCode !== null) onTerminal();
}

function bindPtyTerminal(value: unknown, onTerminal: () => void): void {
  if (!isRecord(value) || typeof value.onExit !== "function") throw new Error("invalid PTY process");
  const observer = bufferedTerminalObserver(onTerminal);
  const subscription = value.onExit(observer.notify);
  if (!isRecord(subscription) || typeof subscription.dispose !== "function") {
    throw new Error("PTY terminal subscription is invalid");
  }
  observer.arm();
}

function bufferedTerminalObserver(onTerminal: () => void): {
  notify(): void;
  arm(): void;
} {
  let armed = false;
  let pending = false;
  return {
    notify() {
      if (!armed) {
        pending = true;
        return;
      }
      onTerminal();
    },
    arm() {
      armed = true;
      if (pending) onTerminal();
    }
  };
}

function registeredPromptFreePtySource(value: unknown): RegisteredPromptFreePtyLaunch | undefined {
  const binary = verifiedAgyBinary(value);
  if (binary === undefined) return undefined;
  const source = registeredPromptFreePtyLaunches.get(binary);
  if (!source || !registeredPromptFreePtySources.has(source) || !Object.isFrozen(source)) return undefined;
  const specification = source.specification;
  if (
    source.binary !== binary ||
    specification.transport !== "pty" ||
    specification.agyVersion !== binary.version ||
    specification.launcherFingerprint !== binary.launcherFingerprint ||
    specification.argv[0] !== binary.executable ||
    specification.argv.includes("--prompt-interactive")
  ) return undefined;
  return source;
}

function verifiedAgyBinary(value: unknown): VerifiedAgyBinary | undefined {
  if (!isRecord(value) || typeof value.executable !== "string") return undefined;
  return isVerifiedAgyBinary(value, value.executable) ? value : undefined;
}

function requiredExecutableArgument(argv: unknown): string {
  if (!Array.isArray(argv) || typeof argv[0] !== "string" || argv[0].length === 0) {
    throw new Error("prompt-free PTY launcher requires an executable argv entry");
  }
  return argv[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
