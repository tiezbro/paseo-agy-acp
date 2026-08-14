import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  AgyDispatchProcessRecord,
  AgyFreshPtyCanaryResult
} from "./dispatch-boundary.js";
import {
  freshPtyLauncherFingerprint,
  isVerifiedAgyBinary,
  type AgyLaunchSpecification,
  type VerifiedAgyBinary
} from "./launch-spec.js";
import {
  isRepositoryOwnedPromptFreePtyLaunch,
  runRepositoryOwnedPromptFreePtyCanary
} from "./startup-launcher.js";

export const PROMPT_FREE_PTY_CANARY_PROTOCOL = "agy-prompt-free-pty-v1";

const DEFAULT_MAX_AGE_MS = 30_000;
const CANARY_KEY_BYTES = 32;
const CANARY_HMAC_CONTEXT = "paseo-agy-acp/prompt-free-pty-canary";
const VERIFIED_RESULT: AgyFreshPtyCanaryResult = Object.freeze({ status: "verified" });
const UNVERIFIED_RESULT: AgyFreshPtyCanaryResult = Object.freeze({ status: "unverified" });

/**
 * Legacy callback shape retained only so older runtime-composition callers
 * continue to type-check. Its presence is rejected by the canary.
 */
export interface PromptFreePtyCanaryLaunch {
  readonly protocol: typeof PROMPT_FREE_PTY_CANARY_PROTOCOL;
  readonly transport: "pty";
  readonly launcherFingerprint: string;
  readonly promptDigest: string;
  readonly sentinel: string;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly processTitle: string;
  readonly temporaryFilePath: string;
  readonly launcherDiagnostics: readonly string[];
}

/** @deprecated A caller-supplied observation is never accepted as evidence. */
export interface PromptFreePtyCanaryObservation {
  readonly protocol: string;
  readonly transport: string;
  readonly launcherFingerprint: string;
  readonly promptDigest: string;
  readonly sentinel: string;
  readonly exitCode: number;
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly processTitle: string;
  readonly temporaryFilePath: string;
  readonly launcherDiagnostics: readonly string[];
}

/** The injected fake child can report only its exit code, never launch metadata. */
export type PromptFreePtyCanaryFakeChild = (
  launch: AgyLaunchSpecification
) => PromptFreePtyCanaryFakeChildResult;

export interface PromptFreePtyCanaryFakeChildResult {
  readonly exitCode: number;
}

export interface PromptFreePtyCanaryOptions {
  /** Plaintext remains inside this function and is never sent to a launcher. */
  readonly businessPrompt: string;
  /**
   * Opaque proof from an exact `agy --version` probe. A copied object, raw
   * version, or connector version cannot replace it.
   */
  readonly verifiedAgyBinary?: VerifiedAgyBinary;
  /** Compatibility assertion against the verified binary identity. */
  readonly agyVersion?: string;
  /** Compatibility assertion against the verified binary identity. */
  readonly launcherFingerprint: string;
  /** Exactly 32 bytes from the caller's purpose-separated local key material. */
  readonly canaryKey: Uint8Array;
  /**
   * @deprecated Caller-supplied specs are always rejected. The runner resolves
   * its source internally from startup-launcher.ts.
   */
  readonly launchSpecification?: AgyLaunchSpecification;
  /** Required fake child injection. It cannot return a startup observation. */
  readonly fakeChild?: PromptFreePtyCanaryFakeChild;
  /** @deprecated A caller-owned runner is always rejected. */
  readonly runner?: unknown;
  /**
   * @deprecated Rejected compatibility input. A callback can self-report a
   * matching observation without invoking a real launcher and is not proof.
   */
  readonly launch?: (launch: PromptFreePtyCanaryLaunch) => PromptFreePtyCanaryObservation;
  /** Injected in tests to keep certification and expiry deterministic. */
  readonly now?: () => number;
  readonly maxAgeMs?: number;
}

export interface PromptFreePtyCanaryExpectation {
  readonly businessPrompt: string;
  /** The same opaque exact-binary proof used when the canary was issued. */
  readonly verifiedAgyBinary?: VerifiedAgyBinary;
  readonly agyVersion?: string;
  readonly launcherFingerprint: string;
  /** The same exact 32-byte purpose-separated key used for certification. */
  readonly canaryKey: Uint8Array;
  readonly now?: () => number;
}

export interface VerifiedPromptFreePtyCanary {
  readonly status: "verified";
  readonly protocol: typeof PROMPT_FREE_PTY_CANARY_PROTOCOL;
  readonly agyVersion: string;
  readonly launcherFingerprint: string;
  readonly promptDigest: string;
  readonly sentinel: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  /** Detects stale or altered evidence without retaining the plaintext prompt. */
  readonly attestation: string;
}

export interface FailedPromptFreePtyCanary {
  readonly status: "failed";
}

/** A failed run intentionally carries no child error text or prompt-derived diagnostics. */
export type PromptFreePtyCanary = VerifiedPromptFreePtyCanary | FailedPromptFreePtyCanary;

/**
 * Certifies a fake fresh-PTY launch through the one repository-owned runner.
 * Caller-owned specs, runners, callbacks, and observations are rejected. Any
 * malformed identity, missing internal source, child failure, or
 * prompt/sentinel exposure returns a deliberately detail-free failed result.
 */
export function runPromptFreePtyCanary(options: PromptFreePtyCanaryOptions): PromptFreePtyCanary {
  try {
    const businessPrompt = requiredText(options.businessPrompt);
    const verifiedAgyBinary = requiredVerifiedAgyBinary(options.verifiedAgyBinary);
    const agyVersion = verifiedAgyBinary.version;
    const launcherFingerprint = verifiedAgyBinary.launcherFingerprint;
    if (!sameText(requiredAgyVersion(options.agyVersion), agyVersion)) return failedCanary();
    if (!sameText(requiredText(options.launcherFingerprint), launcherFingerprint)) return failedCanary();
    if (
      options.launchSpecification !== undefined ||
      options.runner !== undefined ||
      options.launch !== undefined
    ) return failedCanary();
    const fakeChild = requiredFakeChild(options.fakeChild);

    const canaryKey = requiredCanaryKey(options.canaryKey);
    const issuedAt = currentTime(options.now);
    const maxAgeMs = positiveDuration(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS);
    const expiresAt = checkedExpiry(issuedAt, maxAgeMs);
    const promptDigest = hmacSha256(canaryKey, "prompt-digest", [businessPrompt]);
    const sentinel = hmacSha256(canaryKey, "sentinel", [
      PROMPT_FREE_PTY_CANARY_PROTOCOL,
      agyVersion,
      launcherFingerprint,
      promptDigest,
      String(issuedAt),
      String(expiresAt)
    ]);

    // The runner receives prompt and sentinel only as forbidden values. They
    // are never included in the spec, child arguments, environment, or logs.
    const execution = runRepositoryOwnedPromptFreePtyCanary(
      verifiedAgyBinary,
      fakeChild,
      [businessPrompt, sentinel]
    );
    if (execution === undefined) return failedCanary();
    if (!isRepositoryOwnedPromptFreePtyLaunch(verifiedAgyBinary, execution.launch)) return failedCanary();
    if (!isExactFakeChildResult(execution.child) || execution.child.exitCode !== 0) return failedCanary();

    return Object.freeze({
      status: "verified" as const,
      protocol: PROMPT_FREE_PTY_CANARY_PROTOCOL,
      agyVersion,
      launcherFingerprint,
      promptDigest,
      sentinel,
      issuedAt,
      expiresAt,
      attestation: attestationFor(canaryKey, {
        agyVersion,
        launcherFingerprint,
        promptDigest,
        sentinel,
        issuedAt,
        expiresAt
      })
    });
  } catch {
    return failedCanary();
  }
}

/**
 * Verifies that a canary is current and bound to this exact prompt, agy
 * version, and launcher fingerprint. Missing/malformed evidence fails closed.
 */
export function verifyPromptFreePtyCanary(
  canary: PromptFreePtyCanary | undefined,
  expectation: PromptFreePtyCanaryExpectation
): boolean {
  try {
    if (!isVerifiedCanary(canary)) return false;

    const businessPrompt = requiredText(expectation.businessPrompt);
    const verifiedAgyBinary = requiredVerifiedAgyBinary(expectation.verifiedAgyBinary);
    const agyVersion = verifiedAgyBinary.version;
    const launcherFingerprint = verifiedAgyBinary.launcherFingerprint;
    if (!sameText(requiredAgyVersion(expectation.agyVersion), agyVersion)) return false;
    if (!sameText(requiredText(expectation.launcherFingerprint), launcherFingerprint)) return false;
    const canaryKey = requiredCanaryKey(expectation.canaryKey);
    const now = currentTime(expectation.now);
    if (now < canary.issuedAt || now >= canary.expiresAt) return false;
    if (!sameText(canary.protocol, PROMPT_FREE_PTY_CANARY_PROTOCOL)) return false;
    if (!sameText(canary.agyVersion, agyVersion)) return false;
    if (!sameText(canary.launcherFingerprint, launcherFingerprint)) return false;
    if (!sameText(canary.promptDigest, hmacSha256(canaryKey, "prompt-digest", [businessPrompt]))) return false;
    if (!sameText(
      canary.attestation,
      attestationFor(canaryKey, {
        agyVersion: canary.agyVersion,
        launcherFingerprint: canary.launcherFingerprint,
        promptDigest: canary.promptDigest,
        sentinel: canary.sentinel,
        issuedAt: canary.issuedAt,
        expiresAt: canary.expiresAt
      })
    )) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Adapts a certificate to the existing fresh-PTY boundary hook. A non-PTY
 * record is rejected as a defensive check even though the boundary calls it
 * only for PTY candidates.
 */
export function asAgyFreshPtyCanaryVerifier<TProcessIdentity>(
  canary: PromptFreePtyCanary | undefined,
  expectation: PromptFreePtyCanaryExpectation
): (record: AgyDispatchProcessRecord<TProcessIdentity>) => AgyFreshPtyCanaryResult {
  return (record) =>
    record?.promptChannel === "pty" && verifyPromptFreePtyCanary(canary, expectation)
      ? VERIFIED_RESULT
      : UNVERIFIED_RESULT;
}

function requiredFakeChild(value: unknown): PromptFreePtyCanaryFakeChild {
  if (typeof value !== "function") throw new Error("fake canary child is required");
  return value as PromptFreePtyCanaryFakeChild;
}

function isExactFakeChildResult(value: unknown): value is PromptFreePtyCanaryFakeChildResult {
  if (!isRecord(value) || Object.keys(value).length !== 1 || Object.keys(value)[0] !== "exitCode") return false;
  return typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode);
}

function isVerifiedCanary(value: unknown): value is VerifiedPromptFreePtyCanary {
  if (!isRecord(value) || value.status !== "verified") return false;
  return (
    value.protocol === PROMPT_FREE_PTY_CANARY_PROTOCOL &&
    typeof value.agyVersion === "string" &&
    typeof value.launcherFingerprint === "string" &&
    typeof value.promptDigest === "string" &&
    typeof value.sentinel === "string" &&
    isTimestamp(value.issuedAt) &&
    isTimestamp(value.expiresAt) &&
    value.expiresAt > value.issuedAt &&
    typeof value.attestation === "string"
  );
}

function attestationFor(canaryKey: Buffer, input: {
  agyVersion: string;
  launcherFingerprint: string;
  promptDigest: string;
  sentinel: string;
  issuedAt: number;
  expiresAt: number;
}): string {
  return hmacSha256(canaryKey, "attestation", [
    PROMPT_FREE_PTY_CANARY_PROTOCOL,
    input.agyVersion,
    input.launcherFingerprint,
    input.promptDigest,
    input.sentinel,
    String(input.issuedAt),
    String(input.expiresAt)
  ]);
}

function hmacSha256(canaryKey: Buffer, purpose: string, fields: readonly string[]): string {
  const hmac = createHmac("sha256", canaryKey);
  updateFrame(hmac, CANARY_HMAC_CONTEXT);
  updateFrame(hmac, purpose);
  for (const field of fields) updateFrame(hmac, field);
  return hmac.digest("hex");
}

function updateFrame(hmac: ReturnType<typeof createHmac>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 0xffff_ffff) throw new Error("canary frame is too large");
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(bytes.length);
  hmac.update(length);
  hmac.update(bytes);
}

function sameText(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) throw new Error("missing required canary text");
  return value;
}

function requiredAgyVersion(value: unknown): string {
  const version = requiredText(value);
  freshPtyLauncherFingerprint(version);
  return version;
}

function requiredVerifiedAgyBinary(value: unknown): VerifiedAgyBinary {
  if (!isRecord(value) || typeof value.executable !== "string") {
    throw new Error("missing exact agy binary identity");
  }
  if (!isVerifiedAgyBinary(value, value.executable)) {
    throw new Error("agy binary identity was not issued by the exact probe");
  }
  return value;
}

function requiredCanaryKey(value: unknown): Buffer {
  if (!(value instanceof Uint8Array) || value.byteLength !== CANARY_KEY_BYTES) {
    throw new Error("invalid canary key");
  }
  return Buffer.from(value);
}

function positiveDuration(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("invalid canary duration");
  }
  return value;
}

function currentTime(now: (() => number) | undefined): number {
  const value = (now ?? Date.now)();
  if (!isTimestamp(value)) throw new Error("invalid canary clock");
  return value;
}

function checkedExpiry(issuedAt: number, maxAgeMs: number): number {
  const expiresAt = issuedAt + maxAgeMs;
  if (!isTimestamp(expiresAt) || expiresAt <= issuedAt) throw new Error("invalid canary expiry");
  return expiresAt;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failedCanary(): FailedPromptFreePtyCanary {
  return Object.freeze({ status: "failed" as const });
}
