import { spawnSync } from "node:child_process";
import path from "node:path";
import type { AgyStartupLauncher } from "./startup-launcher.js";

export type AgyLaunchTransport = "pty" | "stdin";

/**
 * Immutable, non-secret launcher inputs. Business prompts and canary
 * sentinels are deliberately not part of this data model.
 */
export interface AgyLaunchSpecification {
  /** Present only when the CLI has a verified exact agy binary identity. */
  readonly agyVersion?: string;
  /** Present together with agyVersion; never inferred from connector version. */
  readonly launcherFingerprint?: string;
  readonly transport: AgyLaunchTransport;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly processTitle: string;
  readonly temporaryFilePath: string;
  readonly launcherDiagnostics: readonly string[];
}

export interface AgyLaunchSpecificationInput {
  readonly agyVersion?: string;
  readonly launcherFingerprint?: string;
  readonly transport: AgyLaunchTransport;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly processTitle: string;
  readonly temporaryFilePath: string;
  readonly launcherDiagnostics: readonly string[];
}

export interface AgyLaunchExecution<TChild> {
  readonly child: TChild;
  /** The exact immutable spec supplied to the child factory. */
  readonly launch: AgyLaunchSpecification;
}

export interface AgyLaunchRunner {
  readonly id: "paseo-agy-acp/repo-owned-launch-runner-v1";
  run<TChild>(
    specification: AgyLaunchSpecification,
    start: (launch: AgyLaunchSpecification) => TChild,
    forbiddenTexts?: readonly string[]
  ): AgyLaunchExecution<TChild>;
}

// A public launch specification is only an immutable transport description.
// It is runnable by the shared runner, but it is never fresh-PTY evidence.
const runnableSpecifications = new WeakSet<object>();
const verifiedAgyBinaries = new WeakSet<object>();

/** Opaque identity issued only after an exact version probe of one agy binary. */
export interface VerifiedAgyBinary {
  readonly executable: string;
  readonly version: string;
  readonly launcherFingerprint: string;
}

export interface ExactAgyBinaryProbeInput {
  readonly executable: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Explicitly injected synchronous auxiliary gate; never read from environment. */
  readonly startupLauncher?: AgyStartupLauncher;
}

/**
 * Runs the exact configured binary's `--version` command and turns its output
 * into an opaque identity. The CLI rejects lookalike object literals, a
 * connector version, or an identity for a different executable.
 */
export function probeExactAgyBinaryVersion(input: ExactAgyBinaryProbeInput): VerifiedAgyBinary {
  const executable = requiredText(input.executable, "agy executable");
  const cwd = requiredAbsolutePath(input.cwd, "agy version probe cwd");
  const result = runSynchronousAgyAuxiliary(input.startupLauncher, () =>
    spawnSync(executable, ["--version"], {
      cwd,
      env: input.env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    })
  );
  if (result.error || result.status !== 0) throw new Error("agy version probe failed");
  const version = parseExactAgyVersion(result.stdout);
  const identity = Object.freeze({
    executable,
    version,
    launcherFingerprint: freshPtyLauncherFingerprint(version)
  });
  verifiedAgyBinaries.add(identity);
  return identity;
}

/** A spawnSync return or throw is itself the verified end of this local process. */
function runSynchronousAgyAuxiliary<T>(launcher: AgyStartupLauncher | undefined, run: () => T): T {
  if (launcher?.enabled !== true) return run();
  const permit = launcher.acquire("auxiliary");
  if (!permit || typeof permit.release !== "function") {
    throw new Error("enabled agy startup launcher did not return a releasable permit");
  }
  let released = false;
  try {
    return run();
  } finally {
    if (!released) {
      released = true;
      permit.release();
    }
  }
}

/** True only for an identity issued above and bound to this exact executable. */
export function isVerifiedAgyBinary(value: unknown, executable: string): value is VerifiedAgyBinary {
  return isRecord(value) && verifiedAgyBinaries.has(value) && Object.isFrozen(value) &&
    value.executable === executable &&
    typeof value.version === "string" &&
    typeof value.launcherFingerprint === "string" &&
    value.launcherFingerprint === freshPtyLauncherFingerprint(value.version);
}

/**
 * Build a deep-frozen generic launch description for the shared runner.
 *
 * This intentionally does not establish a fresh-PTY trust root. A caller can
 * use this public builder for ordinary stdin or legacy launches, so canary
 * authorization lives in startup-launcher.ts instead.
 */
export function createAgyLaunchSpecification(input: AgyLaunchSpecificationInput): AgyLaunchSpecification {
  const identity = launcherIdentity(input);
  const specification = Object.freeze({
    ...identity,
    transport: requiredTransport(input.transport),
    argv: freezeStringArray(input.argv, "argv", true),
    environment: freezeStringRecord(input.environment, "environment"),
    cwd: requiredAbsolutePath(input.cwd, "cwd"),
    processTitle: requiredText(input.processTitle, "process title"),
    temporaryFilePath: requiredAbsolutePath(input.temporaryFilePath, "temporary file path"),
    launcherDiagnostics: freezeStringArray(input.launcherDiagnostics, "launcher diagnostics", true)
  });
  runnableSpecifications.add(specification);
  return specification;
}

/** Canonical fresh-PTY identity for one exact agy version. */
export function freshPtyLauncherFingerprint(agyVersion: string): string {
  const version = requiredAgyVersion(agyVersion);
  return `agy-v${version}-fresh-pty`;
}

/**
 * Compatibility predicate for the former public canary boundary.
 *
 * A generic specification cannot authenticate a fresh PTY, even when its
 * fields match an exact binary identity. The only authoritative path is the
 * repository-owned registration in startup-launcher.ts; keeping that proof
 * out of this public builder prevents a caller from minting it with a WeakSet
 * brand.
 */
export function isExactFreshPtyAgyLaunch(
  specification: unknown,
  agyVersion: string,
  launcherFingerprint: string
): specification is AgyLaunchSpecification {
  try {
    requiredAgyVersion(agyVersion);
    requiredText(launcherFingerprint, "launcher fingerprint");
    void specification;
    return false;
  } catch {
    return false;
  }
}

/** Shared immutable-spec runner used by production launch paths. */
export const REPO_OWNED_AGY_LAUNCH_RUNNER: AgyLaunchRunner = Object.freeze({
  id: "paseo-agy-acp/repo-owned-launch-runner-v1" as const,
  run<TChild>(
    specification: AgyLaunchSpecification,
    start: (launch: AgyLaunchSpecification) => TChild,
    forbiddenTexts: readonly string[] = []
  ): AgyLaunchExecution<TChild> {
    assertRunnableSpecification(specification);
    assertNoForbiddenText(specification, forbiddenTexts);
    if (typeof start !== "function") throw new Error("agy launch start factory is invalid");
    return Object.freeze({ child: start(specification), launch: specification });
  }
});

function assertRunnableSpecification(value: unknown): asserts value is AgyLaunchSpecification {
  if (!isRunnableSpecification(value)) throw new Error("agy launch specification is not immutable and runner-built");
}

function isRunnableSpecification(value: unknown): value is AgyLaunchSpecification {
  if (!isRecord(value) || !runnableSpecifications.has(value) || !Object.isFrozen(value)) return false;
  const specification = value as Partial<AgyLaunchSpecification>;
  return (
    hasConsistentLauncherIdentity(specification) &&
    (specification.transport === "pty" || specification.transport === "stdin") &&
    Array.isArray(specification.argv) && Object.isFrozen(specification.argv) && specification.argv.every(isNonEmptyString) &&
    isFrozenStringRecord(specification.environment) &&
    typeof specification.cwd === "string" && path.isAbsolute(specification.cwd) &&
    typeof specification.processTitle === "string" && specification.processTitle.length > 0 &&
    typeof specification.temporaryFilePath === "string" && path.isAbsolute(specification.temporaryFilePath) &&
    Array.isArray(specification.launcherDiagnostics) && Object.isFrozen(specification.launcherDiagnostics) &&
    specification.launcherDiagnostics.every(isNonEmptyString)
  );
}

function launcherIdentity(input: AgyLaunchSpecificationInput): {
  readonly agyVersion?: string;
  readonly launcherFingerprint?: string;
} {
  if (input.agyVersion === undefined && input.launcherFingerprint === undefined) return {};
  if (input.agyVersion === undefined || input.launcherFingerprint === undefined) {
    throw new Error("agy launch identity is incomplete");
  }
  return {
    agyVersion: requiredText(input.agyVersion, "agy version"),
    launcherFingerprint: requiredText(input.launcherFingerprint, "launcher fingerprint")
  };
}

function hasConsistentLauncherIdentity(value: Partial<AgyLaunchSpecification>): boolean {
  return (
    (value.agyVersion === undefined && value.launcherFingerprint === undefined) ||
    (typeof value.agyVersion === "string" && typeof value.launcherFingerprint === "string")
  );
}

function assertNoForbiddenText(
  specification: AgyLaunchSpecification,
  forbiddenTexts: readonly string[]
): void {
  const prohibited = forbiddenTexts.map((value) => requiredText(value, "forbidden launch text"));
  if (prohibited.length === 0) return;

  const surfaces = [
    specification.agyVersion ?? "",
    specification.launcherFingerprint ?? "",
    specification.transport,
    ...specification.argv,
    ...Object.keys(specification.environment),
    ...Object.values(specification.environment),
    specification.cwd,
    specification.processTitle,
    specification.temporaryFilePath,
    ...specification.launcherDiagnostics
  ];
  const joined = surfaces.join("");
  if (prohibited.some((value) => surfaces.some((surface) => surface.includes(value)) || joined.includes(value))) {
    throw new Error("agy launch specification contains forbidden text");
  }
}

function requiredAgyVersion(value: string): string {
  const version = requiredText(value, "agy version");
  if (!/^\d+(?:\.\d+){1,4}$/.test(version)) throw new Error("agy version is not exact");
  return version;
}

function parseExactAgyVersion(stdout: unknown): string {
  const text = requiredText(stdout, "agy version output").trim();
  const match = /^(?:agy(?:\s+version)?\s+)?v?(\d+(?:\.\d+){1,4})$/i.exec(text);
  if (!match?.[1]) throw new Error("agy version output is not exact");
  return requiredAgyVersion(match[1]);
}

function requiredTransport(value: unknown): AgyLaunchTransport {
  if (value !== "pty" && value !== "stdin") throw new Error("agy launch transport is invalid");
  return value;
}

function requiredAbsolutePath(value: unknown, label: string): string {
  const candidate = requiredText(value, label);
  if (!path.isAbsolute(candidate)) throw new Error(`${label} must be absolute`);
  return candidate;
}

function freezeStringArray(value: unknown, label: string, nonEmpty: boolean): readonly string[] {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0) || !value.every(isNonEmptyString)) {
    throw new Error(`${label} is invalid`);
  }
  return Object.freeze([...value]);
}

function freezeStringRecord(value: unknown, label: string): Readonly<Record<string, string>> {
  if (!isRecord(value) || !Object.entries(value).every(([key, entry]) => isNonEmptyString(key) && typeof entry === "string")) {
    throw new Error(`${label} is invalid`);
  }
  return Object.freeze({ ...value } as Record<string, string>);
}

function isFrozenStringRecord(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value) && Object.isFrozen(value) &&
    Object.entries(value).every(([key, entry]) => isNonEmptyString(key) && typeof entry === "string");
}

function requiredText(value: unknown, label: string): string {
  if (!isNonEmptyString(value)) throw new Error(`${label} is required`);
  return value;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
