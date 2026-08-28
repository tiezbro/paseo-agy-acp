import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeSync,
  type Stats
} from "node:fs";
import path from "node:path";
import {
  KERNEL_COMPAT_TARGET_NAMES,
  PRODUCTION_KERNEL_COMPAT_PINS,
  type KernelCompatPins,
  type KernelCompatTargetName
} from "./kernel-compat-pins.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const INTERNAL_DIRECTORY_PATTERN = /^[.A-Za-z0-9][A-Za-z0-9._-]*$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const INTEGER_PATTERN = /^\d+$/;

const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_ACTIVATION_STATE_BYTES = 16 * 1024;
const MAX_LOCK_BYTES = 4 * 1024;
const MAX_PATCHED_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_PATCH_EDIT_COUNT = 16;
const MAX_PATCH_TEXT_BYTES = 64 * 1024;
const MAX_SYMLINK_CHAIN = 16;
const LOCK_INCOMPLETE_GRACE_MS = 30_000;

const RECEIPT_SCHEMA_VERSION = 2;
const ACTIVATION_STATE_SCHEMA_VERSION = 1;
const LOCK_SCHEMA_VERSION = 1;
const RELEASES_DIRECTORY = "releases";
const STAGING_DIRECTORY = ".staging";
const ACTIVATION_STATES_DIRECTORY = "activation-states";
const ACTIVE_REFERENCE = "active";
const LOCK_FILE = ".kernel-compat.lock";
const KERNEL_EXECUTABLE_FILE = "agy_acp_server";
const RUNFILES_DIRECTORY = "agy_acp_server.runfiles";
const EXTERNAL_HARNESS_FILE = "localharness_external";
const RELEASE_WRAPPER_FILE = "agy-acp-kernel-compat";
const RELEASE_VERIFIER_FILE = "kernel-compat-wrapper-verify.mjs";
const STABLE_WRAPPER_FILE = "agy-acp-kernel-compat-active";
const ACTIVE_RESOLVER_FILE = "kernel-compat-active-resolve.mjs";
const STALE_LOCK_QUARANTINE_PATTERN = /^\.kernel-compat\.lock\.stale-[a-f0-9]{16}$/;
const MANAGED_ACTIVATION_STATE_PATTERN = /^activation-[a-f0-9]{24}$/;

const REQUIRED_NOFOLLOW = constants.O_NOFOLLOW;
const CLOEXEC = 0;
const DIRECTORY = constants.O_DIRECTORY ?? 0;

export interface KernelCompatLayout {
  /** The binary and harness are release-root-relative, not runfiles-relative. */
  readonly kernelExecutableRelativePath: string;
  readonly externalHarnessRelativePath: string;
  /** The compatibility module and importer values are runfiles-relative. */
  readonly compatModuleRelativePath: string;
  readonly importerEnvironment: Readonly<Record<string, string>>;
}

export const DEFAULT_KERNEL_COMPAT_LAYOUT: KernelCompatLayout = Object.freeze({
  kernelExecutableRelativePath: KERNEL_EXECUTABLE_FILE,
  externalHarnessRelativePath: EXTERNAL_HARNESS_FILE,
  compatModuleRelativePath: "paseo_model_compat.py",
  importerEnvironment: Object.freeze({})
});

export interface KernelCompatMarkerEdit {
  readonly id: string;
  readonly target: "modelSelection" | "proxyServer";
  readonly find: string;
  readonly replacement: string;
}

/**
 * Marker strings are caller-supplied and only their digests are persisted.
 * This keeps proprietary source context and conventional patches out of Git.
 */
export interface KernelCompatPatchPlan {
  readonly edits: readonly KernelCompatMarkerEdit[];
}

export interface KernelCompatLifecycleHooks {
  /** Test-only fault seam immediately before the one atomic active-pointer commit. */
  readonly beforeActivationCommit?: (state: Readonly<ActivationStateView>) => void;
  /** Test-only fault seam immediately after the one atomic active-pointer commit. */
  readonly afterActivationCommit?: (state: Readonly<ActivationStateView>) => void;
}

export interface OfficialKernelCompatLifecycleOptions {
  readonly stateRoot: string;
  readonly pins?: KernelCompatPins;
  readonly clock?: () => Date;
  readonly hooks?: KernelCompatLifecycleHooks;
}

export interface PrepareKernelCompatOptions {
  readonly parPath: string;
  readonly externalHarnessPath: string;
  readonly compatModulePath: string;
  readonly patchPlan: KernelCompatPatchPlan;
  readonly compatibilityVersion?: string;
  readonly layout?: Partial<KernelCompatLayout>;
}

export interface PreparedKernel {
  readonly artifactId: string;
  readonly releasePath: string;
  /** A release-local wrapper suitable for pre-activation smoke tests. */
  readonly wrapperPath: string;
  /** Stable path for PASEO_AGY_ACP_OFFICIAL_BIN after activate(). */
  readonly stableWrapperPath: string;
  readonly receiptPath: string;
  readonly reused: boolean;
}

export interface VerificationResult {
  readonly artifactId: string;
  readonly releasePath: string;
  readonly wrapperPath: string;
  readonly verifiedAt: string;
}

export interface ActivationResult {
  readonly changed: boolean;
  readonly currentArtifactId: string;
  readonly previousArtifactId?: string;
  /** Stable activation wrapper, not a mutable per-release alias. */
  readonly wrapperPath: string;
  readonly releaseWrapperPath: string;
}

export interface KernelCompatReferenceStatus {
  readonly artifactId: string;
  readonly wrapperPath?: string;
  readonly verified: boolean;
  readonly error?: string;
}

export interface KernelCompatStatus {
  readonly stateRoot: string;
  readonly rootExists: boolean;
  readonly rootSecure: boolean;
  readonly stableWrapperPath?: string;
  readonly current?: KernelCompatReferenceStatus;
  readonly previous?: KernelCompatReferenceStatus;
  readonly stagingEntries: readonly string[];
  readonly issues: readonly string[];
}

export interface CleanupOptions {
  /** Completed releases are retained unless this explicit local opt-in is set. */
  readonly removeUnreferenced?: boolean;
}

export interface CleanupResult {
  readonly removedArtifactIds: readonly string[];
  readonly removedStagingEntries: readonly string[];
  /** Finalized, unreferenced activation records only; the active record is retained. */
  readonly removedActivationStateDirectories: readonly string[];
  /** Safe, current-user-owned stale lock receipts recovered from prior writers. */
  readonly removedStaleLockQuarantineFiles: readonly string[];
  readonly skippedEntries: readonly string[];
}

export class KernelCompatLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KernelCompatLifecycleError";
  }
}

interface FileDigest {
  readonly sha256: string;
  readonly bytes: number;
}

interface PinVerifiedInput {
  readonly fd: number;
  readonly before: Stats;
  readonly digest: FileDigest;
}

interface ReceiptPostimage extends FileDigest {
  readonly relativePath: string;
}

interface KernelCompatReceipt {
  readonly schemaVersion: number;
  readonly artifactId: string;
  readonly profileId: string;
  readonly createdAt: string;
  readonly pinDigest: string;
  readonly patchDigest: string;
  readonly inputs: Readonly<{
    par: FileDigest;
    externalHarness: FileDigest;
    compatModule: FileDigest;
  }>;
  readonly layout: Readonly<{
    runfilesRelativePath: string;
    kernelExecutableRelativePath: string;
    externalHarnessRelativePath: string;
    compatModuleRelativePath: string;
    importerEnvironment: Readonly<Record<string, string>>;
  }>;
  readonly postimages: Readonly<Record<KernelCompatTargetName | "compatModule", ReceiptPostimage>>;
  readonly wrapper: Readonly<{
    relativePath: string;
    sha256: string;
    bytes: number;
    verifierRelativePath: string;
    verifierSha256: string;
    verifierBytes: number;
  }>;
}

interface ResolvedPrepareOptions {
  readonly parPath: string;
  readonly externalHarnessPath: string;
  readonly compatModulePath: string;
  readonly patchPlan: KernelCompatPatchPlan;
  readonly compatibilityVersion: string;
  readonly layout: KernelCompatLayout;
}

interface ReleaseVerification {
  readonly receipt: KernelCompatReceipt;
  readonly wrapperPath: string;
}

interface ProcessIdentity {
  readonly pid: number;
  readonly procStartTime: string;
}

interface LockReceipt extends ProcessIdentity {
  readonly schemaVersion: number;
}

interface ActivationStateView {
  readonly currentArtifactId: string;
  readonly previousArtifactId?: string;
}

interface ActivationState extends ActivationStateView {
  readonly schemaVersion: number;
  readonly pinDigest: string;
}

interface ActiveStateReference {
  readonly stateId: string;
  readonly stateDirectory: string;
}

interface ExistingLock {
  readonly stat: Stats;
  readonly receipt?: LockReceipt;
}

export class OfficialKernelCompatLifecycle {
  readonly #stateRoot: string;
  readonly #pins: KernelCompatPins;
  readonly #pinDigest: string;
  readonly #clock: () => Date;
  readonly #hooks: KernelCompatLifecycleHooks;

  constructor(options: OfficialKernelCompatLifecycleOptions) {
    this.#stateRoot = requireAbsolutePath("state root", options.stateRoot);
    this.#pins = snapshotPins(options.pins ?? PRODUCTION_KERNEL_COMPAT_PINS);
    this.#pinDigest = sha256Text(canonicalJson(this.#pins));
    this.#clock = options.clock ?? (() => new Date());
    this.#hooks = options.hooks ?? {};
  }

  async prepare(options: PrepareKernelCompatOptions): Promise<PreparedKernel> {
    const uid = requireNonRootLinuxUid();
    ensureSecureDirectory(this.#stateRoot, "kernel compatibility root", uid, true);
    return withWriterLock(this.#stateRoot, uid, this.#clock, () => this.prepareUnlocked(options, uid));
  }

  async verify(artifactId?: string): Promise<VerificationResult> {
    const uid = requireNonRootLinuxUid();
    ensureSecureDirectory(this.#stateRoot, "kernel compatibility root", uid, false);
    const selectedArtifactId = artifactId === undefined
      ? requireActiveState(this.#stateRoot, uid, this.#pinDigest).currentArtifactId
      : requireArtifactId(artifactId);
    const releasePath = releasePathFor(this.#stateRoot, selectedArtifactId, uid);
    const verified = verifyRelease(releasePath, this.#pins, this.#pinDigest, uid);
    return {
      artifactId: verified.receipt.artifactId,
      releasePath,
      wrapperPath: verified.wrapperPath,
      verifiedAt: this.#clock().toISOString()
    };
  }

  async activate(artifactId: string): Promise<ActivationResult> {
    const uid = requireNonRootLinuxUid();
    ensureSecureDirectory(this.#stateRoot, "kernel compatibility root", uid, false);
    const selectedArtifactId = requireArtifactId(artifactId);
    return withWriterLock(this.#stateRoot, uid, this.#clock, () => {
      const selected = verifyRelease(
        releasePathFor(this.#stateRoot, selectedArtifactId, uid),
        this.#pins,
        this.#pinDigest,
        uid
      );
      ensureStableActivationWrapper(this.#stateRoot, this.#pinDigest, uid);
      const active = readActiveState(this.#stateRoot, uid, this.#pinDigest);
      if (active?.currentArtifactId === selectedArtifactId) {
        return {
          changed: false,
          currentArtifactId: selectedArtifactId,
          previousArtifactId: active.previousArtifactId,
          wrapperPath: stableWrapperPathFor(this.#stateRoot),
          releaseWrapperPath: selected.wrapperPath
        };
      }
      if (active !== undefined) {
        verifyRelease(
          releasePathFor(this.#stateRoot, active.currentArtifactId, uid),
          this.#pins,
          this.#pinDigest,
          uid
        );
      }
      const state: ActivationStateView = {
        currentArtifactId: selectedArtifactId,
        ...(active === undefined ? {} : { previousArtifactId: active.currentArtifactId })
      };
      commitActivationState(this.#stateRoot, state, this.#pinDigest, uid, this.#hooks);
      return {
        changed: true,
        ...state,
        wrapperPath: stableWrapperPathFor(this.#stateRoot),
        releaseWrapperPath: selected.wrapperPath
      };
    });
  }

  async rollback(): Promise<ActivationResult> {
    const uid = requireNonRootLinuxUid();
    ensureSecureDirectory(this.#stateRoot, "kernel compatibility root", uid, false);
    return withWriterLock(this.#stateRoot, uid, this.#clock, () => {
      const active = requireActiveState(this.#stateRoot, uid, this.#pinDigest);
      if (active.previousArtifactId === undefined) {
        throw new KernelCompatLifecycleError("no previous compatibility release is available for rollback");
      }
      const current = verifyRelease(
        releasePathFor(this.#stateRoot, active.currentArtifactId, uid),
        this.#pins,
        this.#pinDigest,
        uid
      );
      const previous = verifyRelease(
        releasePathFor(this.#stateRoot, active.previousArtifactId, uid),
        this.#pins,
        this.#pinDigest,
        uid
      );
      const state: ActivationStateView = {
        currentArtifactId: active.previousArtifactId,
        previousArtifactId: active.currentArtifactId
      };
      commitActivationState(this.#stateRoot, state, this.#pinDigest, uid, this.#hooks);
      return {
        changed: true,
        ...state,
        wrapperPath: stableWrapperPathFor(this.#stateRoot),
        releaseWrapperPath: previous.wrapperPath
      };
    });
  }

  async status(): Promise<KernelCompatStatus> {
    const uid = requireNonRootLinuxUid();
    const rootStatus = inspectSecureDirectory(this.#stateRoot, uid, false);
    if (!rootStatus.exists) {
      return {
        stateRoot: this.#stateRoot,
        rootExists: false,
        rootSecure: false,
        stagingEntries: [],
        issues: []
      };
    }
    if (rootStatus.error !== undefined) {
      return {
        stateRoot: this.#stateRoot,
        rootExists: true,
        rootSecure: false,
        stagingEntries: [],
        issues: [rootStatus.error]
      };
    }

    const issues: string[] = [];
    let active: ActivationState | undefined;
    try {
      active = readActiveState(this.#stateRoot, uid, this.#pinDigest);
    } catch (error) {
      issues.push(`active: ${messageFor(error)}`);
    }
    const describe = (artifactId: string | undefined, label: "current" | "previous"): KernelCompatReferenceStatus | undefined => {
      if (artifactId === undefined) return undefined;
      try {
        const releasePath = releasePathFor(this.#stateRoot, artifactId, uid);
        const verified = verifyRelease(releasePath, this.#pins, this.#pinDigest, uid);
        return { artifactId, wrapperPath: verified.wrapperPath, verified: true };
      } catch (error) {
        const message = messageFor(error);
        issues.push(`${label}: ${message}`);
        return { artifactId, verified: false, error: message };
      }
    };
    const stableWrapperPath = stableWrapperPathFor(this.#stateRoot);
    try {
      assertOwnedRegularFile(stableWrapperPath, "stable activation wrapper", uid, true);
    } catch (error) {
      issues.push(`stable wrapper: ${messageFor(error)}`);
    }
    return {
      stateRoot: this.#stateRoot,
      rootExists: true,
      rootSecure: true,
      stableWrapperPath,
      current: describe(active?.currentArtifactId, "current"),
      previous: describe(active?.previousArtifactId, "previous"),
      stagingEntries: listSafeStagingEntries(this.#stateRoot, uid, issues),
      issues
    };
  }

  async cleanup(options: CleanupOptions = {}): Promise<CleanupResult> {
    const uid = requireNonRootLinuxUid();
    const rootStatus = inspectSecureDirectory(this.#stateRoot, uid, false);
    if (!rootStatus.exists) {
      return {
        removedArtifactIds: [],
        removedStagingEntries: [],
        removedActivationStateDirectories: [],
        removedStaleLockQuarantineFiles: [],
        skippedEntries: []
      };
    }
    if (rootStatus.error !== undefined) throw new KernelCompatLifecycleError(rootStatus.error);
    return withWriterLock(this.#stateRoot, uid, this.#clock, () => cleanupUnlocked(this.#stateRoot, uid, options));
  }

  private prepareUnlocked(options: PrepareKernelCompatOptions, uid: number): PreparedKernel {
    const prepared = resolvePrepareOptions(options);
    const patchDigest = digestPatchPlan(prepared.patchPlan);
    // The only hot path that hashes the large official inputs is prepare().
    // Their production distribution mode is 0775, so retain the verified FDs
    // until their copies have independently been rechecked in private staging.
    const parInput = openPinVerifiedInput(prepared.parPath, "official PAR", uid, true);
    try {
      const parDigest = parInput.digest;
      if (parDigest.sha256 !== this.#pins.parSha256) {
        throw new KernelCompatLifecycleError("official PAR hash does not match the pinned production artifact");
      }
      const externalHarnessInput = openPinVerifiedInput(prepared.externalHarnessPath, "external harness", uid, true);
      try {
        const externalHarnessDigest = externalHarnessInput.digest;
        if (externalHarnessDigest.sha256 !== this.#pins.externalHarnessSha256) {
          throw new KernelCompatLifecycleError("external harness hash does not match the pinned production artifact");
        }
        const compatDigest = digestRegularFile(prepared.compatModulePath, "compatibility module", uid, false);
    const artifactId = buildArtifactId(
      this.#pins.profileId,
      this.#pins.parSha256,
      prepared.compatibilityVersion,
      compatDigest.sha256,
      patchDigest
    );

    const releasesPath = ensureInternalDirectory(this.#stateRoot, RELEASES_DIRECTORY, uid);
    const stagingPath = ensureInternalDirectory(this.#stateRoot, STAGING_DIRECTORY, uid);
    if (statSync(releasesPath).dev !== statSync(stagingPath).dev) {
      throw new KernelCompatLifecycleError("staging and releases must be on the same filesystem");
    }

    const finalReleasePath = path.join(releasesPath, artifactId);
    const existing = tryLstat(finalReleasePath);
    if (existing !== undefined) {
      if (existing.isSymbolicLink() || !existing.isDirectory()) {
        throw new KernelCompatLifecycleError("existing prepared release is not a real directory");
      }
      const verified = verifyRelease(finalReleasePath, this.#pins, this.#pinDigest, uid);
      assertIdempotentReceipt(verified.receipt, parDigest, externalHarnessDigest, compatDigest, patchDigest);
      ensureStableActivationWrapper(this.#stateRoot, this.#pinDigest, uid);
      return {
        artifactId,
        releasePath: finalReleasePath,
        wrapperPath: verified.wrapperPath,
        stableWrapperPath: stableWrapperPathFor(this.#stateRoot),
        receiptPath: path.join(finalReleasePath, "receipt.json"),
        reused: true
      };
    }

    const stagingRoot = mkdtempSync(path.join(stagingPath, `kernel-compat-stage-${artifactId}-`), "utf8");
    chmodSync(stagingRoot, 0o700);
    try {
      const stageReleasePath = path.join(stagingRoot, artifactId);
      mkdirSync(stageReleasePath, { mode: 0o700 });
      const stagedBinaryPath = path.join(stageReleasePath, KERNEL_EXECUTABLE_FILE);
      const stagedHarnessPath = path.join(stageReleasePath, EXTERNAL_HARNESS_FILE);

      // The real self-unpacker derives its adjacent .runfiles directory from argv[0].
      copyPinVerifiedInput(parInput, stagedBinaryPath, "official PAR", uid, 0o500);
      copyPinVerifiedInput(externalHarnessInput, stagedHarnessPath, "external harness", uid, 0o500);
      runOfficialSelfUnpacker(stagedBinaryPath, stageReleasePath, stagingRoot);
      assertAndHardenUnpackedKernelExecutable(stageReleasePath, stagedBinaryPath, uid);

      const runfilesPath = path.join(stageReleasePath, RUNFILES_DIRECTORY);
      assertRealDirectory(runfilesPath, "unpacked runfiles", uid);
      hardenRunfiles(runfilesPath, stageReleasePath, mainSymlinkRelativePath(this.#pins), uid);
      // The private stage is reopened only long enough to place the caller module.
      chmodSync(runfilesPath, 0o700);

      const preimagePaths = targetPaths(runfilesPath, this.#pins, uid);
      for (const target of KERNEL_COMPAT_TARGET_NAMES) {
        const digest = digestRegularFile(preimagePaths[target], `${target} preimage`, uid, false);
        if (digest.sha256 !== this.#pins.targets[target].preimageSha256) {
          throw new KernelCompatLifecycleError(`${target} preimage hash does not match the pinned production source`);
        }
      }

      ensureParentDirectories(runfilesPath, prepared.layout.compatModuleRelativePath, uid);
      const compatDestination = safePathUnderDirectory(
        runfilesPath,
        prepared.layout.compatModuleRelativePath,
        "compatibility module destination",
        false
      );
      copyRegularFile(prepared.compatModulePath, compatDestination, "compatibility module", uid, compatDigest, 0o400);
      applyPatchPlan(preimagePaths, prepared.patchPlan, uid);

      const postimages = collectPostimages(runfilesPath, this.#pins, prepared.layout, uid);
      if (postimages.serverControl.sha256 !== this.#pins.targets.serverControl.preimageSha256) {
        throw new KernelCompatLifecycleError("server.py changed during preparation; this control source must never be modified");
      }
      hardenRunfiles(runfilesPath, stageReleasePath, mainSymlinkRelativePath(this.#pins), uid);
      assertOwnedRegularFile(stagedBinaryPath, "staged kernel executable", uid, true, 0o500);
      assertOwnedRegularFile(stagedHarnessPath, "staged external harness", uid, true, 0o500);
      validateImporterEnvironment(runfilesPath, prepared.layout, uid);

      const wrapperVerifierPath = path.join(stageReleasePath, RELEASE_VERIFIER_FILE);
      writeNewFile(wrapperVerifierPath, renderReleaseWrapperVerifier(this.#pinDigest), 0o500);
      const wrapperPath = path.join(stageReleasePath, RELEASE_WRAPPER_FILE);
      writeNewFile(wrapperPath, renderReleaseWrapper(prepared.layout), 0o500);
      const wrapperDigest = digestSmallFile(wrapperPath, "generated wrapper", uid, true);
      const wrapperVerifierDigest = digestSmallFile(wrapperVerifierPath, "generated wrapper verifier", uid, true);

      const receipt: KernelCompatReceipt = {
        schemaVersion: RECEIPT_SCHEMA_VERSION,
        artifactId,
        profileId: this.#pins.profileId,
        createdAt: this.#clock().toISOString(),
        pinDigest: this.#pinDigest,
        patchDigest,
        inputs: {
          par: parDigest,
          externalHarness: externalHarnessDigest,
          compatModule: compatDigest
        },
        layout: {
          runfilesRelativePath: RUNFILES_DIRECTORY,
          kernelExecutableRelativePath: KERNEL_EXECUTABLE_FILE,
          externalHarnessRelativePath: EXTERNAL_HARNESS_FILE,
          compatModuleRelativePath: prepared.layout.compatModuleRelativePath,
          importerEnvironment: prepared.layout.importerEnvironment
        },
        postimages,
        wrapper: {
          relativePath: RELEASE_WRAPPER_FILE,
          sha256: wrapperDigest.sha256,
          bytes: wrapperDigest.bytes,
          verifierRelativePath: RELEASE_VERIFIER_FILE,
          verifierSha256: wrapperVerifierDigest.sha256,
          verifierBytes: wrapperVerifierDigest.bytes
        }
      };
      writeNewFile(path.join(stageReleasePath, "receipt.json"), `${canonicalJson(receipt)}\n`, 0o600);
      chmodSync(stageReleasePath, 0o500);
      fsyncDirectory(runfilesPath);
      fsyncDirectory(stageReleasePath);
      fsyncDirectory(stagingRoot);

      verifyRelease(stageReleasePath, this.#pins, this.#pinDigest, uid);
      // This filesystem requires write permission on the staged directory itself for rename.
      // Its parent remains private until the atomic publish below.
      chmodSync(stageReleasePath, 0o700);
      renameSync(stageReleasePath, finalReleasePath);
      chmodSync(finalReleasePath, 0o500);
      fsyncDirectory(finalReleasePath);
      fsyncDirectory(releasesPath);
      ensureStableActivationWrapper(this.#stateRoot, this.#pinDigest, uid);
      return {
        artifactId,
        releasePath: finalReleasePath,
        wrapperPath: path.join(finalReleasePath, RELEASE_WRAPPER_FILE),
        stableWrapperPath: stableWrapperPathFor(this.#stateRoot),
        receiptPath: path.join(finalReleasePath, "receipt.json"),
        reused: false
      };
      } finally {
        removeDirectoryIfSafe(stagingPath, stagingRoot, "kernel-compat-stage-", uid);
      }
      } finally {
        closeSync(externalHarnessInput.fd);
      }
    } finally {
      closeSync(parInput.fd);
    }
  }
}

function resolvePrepareOptions(options: PrepareKernelCompatOptions): ResolvedPrepareOptions {
  const compatibilityVersion = options.compatibilityVersion ?? "compat-v1";
  requireIdentifier("compatibility version", compatibilityVersion);
  const layout = resolveLayout(options.layout);
  const patchPlan = validatePatchPlan(options.patchPlan);
  return {
    parPath: requireAbsolutePath("official PAR path", options.parPath),
    externalHarnessPath: requireAbsolutePath("external harness path", options.externalHarnessPath),
    compatModulePath: requireAbsolutePath("compatibility module path", options.compatModulePath),
    patchPlan,
    compatibilityVersion,
    layout
  };
}

function resolveLayout(partial: Partial<KernelCompatLayout> | undefined): KernelCompatLayout {
  const layout: KernelCompatLayout = {
    kernelExecutableRelativePath: partial?.kernelExecutableRelativePath ?? KERNEL_EXECUTABLE_FILE,
    externalHarnessRelativePath: partial?.externalHarnessRelativePath ?? EXTERNAL_HARNESS_FILE,
    compatModuleRelativePath: partial?.compatModuleRelativePath ?? DEFAULT_KERNEL_COMPAT_LAYOUT.compatModuleRelativePath,
    importerEnvironment: partial?.importerEnvironment ?? DEFAULT_KERNEL_COMPAT_LAYOUT.importerEnvironment
  };
  if (layout.kernelExecutableRelativePath !== KERNEL_EXECUTABLE_FILE) {
    throw new KernelCompatLifecycleError("kernel executable must be the release-root agy_acp_server copy");
  }
  if (layout.externalHarnessRelativePath !== EXTERNAL_HARNESS_FILE) {
    throw new KernelCompatLifecycleError("external harness must be the release-root localharness_external copy");
  }
  assertSafeRelativePath("compatibility module destination", layout.compatModuleRelativePath);
  for (const [name, relativePath] of Object.entries(layout.importerEnvironment)) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
      throw new KernelCompatLifecycleError("importer environment names must be uppercase shell identifiers");
    }
    if (["ANTIGRAVITY_HARNESS_PATH", "PYTHONDONTWRITEBYTECODE", "PYTHONPATH"].includes(name)) {
      throw new KernelCompatLifecycleError(`${name} is controlled by the generated wrapper`);
    }
    assertSafeRelativePath(`importer environment ${name}`, relativePath);
  }
  return Object.freeze({
    ...layout,
    importerEnvironment: Object.freeze({ ...layout.importerEnvironment })
  });
}

function validatePatchPlan(plan: KernelCompatPatchPlan): KernelCompatPatchPlan {
  if (plan === null || typeof plan !== "object" || !Array.isArray(plan.edits)) {
    throw new KernelCompatLifecycleError("patch plan must contain an edits array");
  }
  if (plan.edits.length === 0 || plan.edits.length > MAX_PATCH_EDIT_COUNT) {
    throw new KernelCompatLifecycleError(`patch plan edit count exceeds the limit of ${MAX_PATCH_EDIT_COUNT}`);
  }
  const ids = new Set<string>();
  const targetCounts: Record<"modelSelection" | "proxyServer", number> = { modelSelection: 0, proxyServer: 0 };
  const edits = plan.edits.map((edit) => {
    if (edit === null || typeof edit !== "object") {
      throw new KernelCompatLifecycleError("patch plan contains an invalid edit");
    }
    requireIdentifier("patch marker id", edit.id);
    if (ids.has(edit.id)) throw new KernelCompatLifecycleError(`patch marker id ${edit.id} is duplicated`);
    ids.add(edit.id);
    const target = edit.target;
    if (target !== "modelSelection" && target !== "proxyServer") {
      throw new KernelCompatLifecycleError("patch edits may target only modelSelection or proxyServer");
    }
    assertPatchText(edit.find, `patch marker ${edit.id} exact match`);
    assertPatchText(edit.replacement, `patch marker ${edit.id} replacement`);
    if (edit.find === edit.replacement) {
      throw new KernelCompatLifecycleError(`patch marker ${edit.id} replacement must change the matched text`);
    }
    if (target === "modelSelection") targetCounts.modelSelection += 1;
    else targetCounts.proxyServer += 1;
    return Object.freeze({ ...edit, target });
  });
  if (targetCounts.modelSelection === 0 || targetCounts.proxyServer === 0) {
    throw new KernelCompatLifecycleError("patch plan must contain exact edits for modelSelection and proxyServer");
  }
  return Object.freeze({ edits: Object.freeze(edits) });
}

function assertPatchText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new KernelCompatLifecycleError(`${label} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, "utf8") > MAX_PATCH_TEXT_BYTES) {
    throw new KernelCompatLifecycleError(`${label} exceeds the ${MAX_PATCH_TEXT_BYTES}-byte limit`);
  }
}

function validatePins(pins: KernelCompatPins): void {
  if (pins === null || typeof pins !== "object") throw new KernelCompatLifecycleError("kernel compatibility pins are invalid");
  requireIdentifier("pin profile", pins.profileId);
  requireSha256("PAR pin", pins.parSha256);
  requireSha256("external harness pin", pins.externalHarnessSha256);
  for (const target of KERNEL_COMPAT_TARGET_NAMES) {
    const pin = pins.targets?.[target];
    if (pin === undefined || typeof pin !== "object") throw new KernelCompatLifecycleError(`missing ${target} pin`);
    assertSafeRelativePath(`${target} pin path`, pin.relativePath);
    requireSha256(`${target} preimage pin`, pin.preimageSha256);
    if (target === "serverControl" && pin.patchable) {
      throw new KernelCompatLifecycleError("serverControl pin must be non-patchable");
    }
    if (target !== "serverControl" && !pin.patchable) {
      throw new KernelCompatLifecycleError(`${target} pin must be patchable`);
    }
  }
}

function snapshotPins(pins: KernelCompatPins): KernelCompatPins {
  validatePins(pins);
  return Object.freeze({
    profileId: pins.profileId,
    parSha256: pins.parSha256,
    externalHarnessSha256: pins.externalHarnessSha256,
    targets: Object.freeze({
      modelSelection: Object.freeze({ ...pins.targets.modelSelection }),
      proxyServer: Object.freeze({ ...pins.targets.proxyServer }),
      serverControl: Object.freeze({ ...pins.targets.serverControl })
    })
  });
}

function requireNonRootLinuxUid(): number {
  if (process.platform !== "linux") {
    throw new KernelCompatLifecycleError("kernel compatibility lifecycle is pinned to Linux process-identity semantics");
  }
  if (typeof process.getuid !== "function") {
    throw new KernelCompatLifecycleError("kernel compatibility lifecycle requires a POSIX user identity");
  }
  const uid = process.getuid();
  if (uid === 0) throw new KernelCompatLifecycleError("kernel compatibility lifecycle refuses root mode");
  return uid;
}

function requireAbsolutePath(label: string, value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !path.isAbsolute(value)) {
    throw new KernelCompatLifecycleError(`${label} must be a non-empty absolute path`);
  }
  return path.resolve(value);
}

function requireIdentifier(label: string, value: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new KernelCompatLifecycleError(`${label} must contain only letters, digits, dots, underscores, or hyphens`);
  }
  return value;
}

function requireArtifactId(value: string): string {
  return requireIdentifier("artifact id", value);
}

function requireSha256(label: string, value: string): void {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new KernelCompatLifecycleError(`${label} must be a lowercase SHA-256 digest`);
  }
}

function assertSafeRelativePath(label: string, value: string): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw new KernelCompatLifecycleError(`${label} must be a normalized relative path`);
  }
}

function inspectSecureDirectory(directory: string, uid: number, create: boolean): { readonly exists: boolean; readonly error?: string } {
  try {
    if (create) {
      assertExistingPathHasNoSymlinkComponents(directory, "kernel compatibility root");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    assertExistingPathHasNoSymlinkComponents(directory, "kernel compatibility root");
    const stat = tryLstat(directory);
    if (stat === undefined) return { exists: false };
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { exists: true, error: "kernel compatibility root must be a real directory" };
    if (stat.uid !== uid) return { exists: true, error: "kernel compatibility root must be owned by the current user" };
    if ((stat.mode & 0o777) !== 0o700) return { exists: true, error: "kernel compatibility root must have mode 0700" };
    return { exists: true };
  } catch (error) {
    return { exists: true, error: messageFor(error) };
  }
}

function ensureSecureDirectory(directory: string, label: string, uid: number, create: boolean): void {
  const result = inspectSecureDirectory(directory, uid, create);
  if (!result.exists) throw new KernelCompatLifecycleError(`${label} does not exist`);
  if (result.error !== undefined) throw new KernelCompatLifecycleError(result.error.replace("kernel compatibility root", label));
}

function assertExistingPathHasNoSymlinkComponents(candidate: string, label: string): void {
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = tryLstat(cursor);
    if (stat === undefined) return;
    if (stat.isSymbolicLink()) throw new KernelCompatLifecycleError(`${label} must not traverse a symbolic link`);
    if (!stat.isDirectory() && cursor !== resolved) throw new KernelCompatLifecycleError(`${label} has a non-directory parent`);
  }
}

function ensureInternalDirectory(parent: string, name: string, uid: number): string {
  if (!INTERNAL_DIRECTORY_PATTERN.test(name) || name === "." || name === "..") {
    throw new KernelCompatLifecycleError("internal directory must contain only letters, digits, dots, underscores, or hyphens");
  }
  const directory = path.join(parent, name);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertRealDirectory(directory, `internal directory ${name}`, uid, 0o700);
  return directory;
}

function assertRealDirectory(directory: string, label: string, uid: number, expectedMode?: number): void {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new KernelCompatLifecycleError(`${label} must be a real directory`);
  if (stat.uid !== uid) throw new KernelCompatLifecycleError(`${label} must be owned by the current user`);
  if (expectedMode !== undefined && (stat.mode & 0o777) !== expectedMode) {
    throw new KernelCompatLifecycleError(`${label} must have mode ${expectedMode.toString(8).padStart(4, "0")}`);
  }
}

function requiredNoFollow(): number {
  if (REQUIRED_NOFOLLOW === undefined) {
    throw new KernelCompatLifecycleError("kernel compatibility lifecycle requires O_NOFOLLOW support");
  }
  return REQUIRED_NOFOLLOW;
}

function openOwnedRegularFile(filePath: string, label: string, uid: number, executable: boolean): { fd: number; before: Stats } {
  return openCurrentUserRegularFile(filePath, label, uid, executable, false);
}

function openCurrentUserRegularFile(
  filePath: string,
  label: string,
  uid: number,
  executable: boolean,
  allowGroupWritable: boolean
): { fd: number; before: Stats } {
  assertExistingPathHasNoSymlinkComponents(filePath, label);
  const lstat = lstatSync(filePath);
  if (lstat.isSymbolicLink() || !lstat.isFile()) {
    throw new KernelCompatLifecycleError(`${label} must be a regular file and not a symbolic link`);
  }
  if (lstat.uid !== uid) throw new KernelCompatLifecycleError(`${label} must be owned by the current user`);
  if (!allowGroupWritable && (lstat.mode & 0o022) !== 0) {
    throw new KernelCompatLifecycleError(`${label} must not be group- or world-writable`);
  }
  if (allowGroupWritable && (lstat.mode & 0o002) !== 0) {
    throw new KernelCompatLifecycleError(`${label} must not be world-writable`);
  }
  if (executable && (lstat.mode & 0o111) === 0) throw new KernelCompatLifecycleError(`${label} must be executable`);
  const fd = openSync(filePath, constants.O_RDONLY | requiredNoFollow() | CLOEXEC);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFileSnapshot(opened, lstat) || opened.uid !== uid) {
      throw new KernelCompatLifecycleError(`${label} changed while it was being opened`);
    }
    return { fd, before: opened };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function assertStableFile(fd: number, before: Stats, label: string): void {
  const after = fstatSync(fd);
  if (!sameFileSnapshot(after, before)) {
    throw new KernelCompatLifecycleError(`${label} changed while it was being read`);
  }
}

function openPinVerifiedInput(filePath: string, label: string, uid: number, executable: boolean): PinVerifiedInput {
  const opened = openCurrentUserRegularFile(filePath, label, uid, executable, true);
  try {
    const digest = digestOpenFile(opened.fd);
    assertStableFile(opened.fd, opened.before, label);
    return { ...opened, digest };
  } catch (error) {
    closeSync(opened.fd);
    throw error;
  }
}

function digestRegularFile(filePath: string, label: string, uid: number, executable: boolean): FileDigest {
  const opened = openOwnedRegularFile(filePath, label, uid, executable);
  try {
    const digest = digestOpenFile(opened.fd);
    assertStableFile(opened.fd, opened.before, label);
    return digest;
  } finally {
    closeSync(opened.fd);
  }
}

function digestSmallFile(filePath: string, label: string, uid: number, executable: boolean): FileDigest {
  const opened = openOwnedRegularFile(filePath, label, uid, executable);
  try {
    if (opened.before.size > MAX_PATCHED_SOURCE_BYTES) {
      throw new KernelCompatLifecycleError(`${label} exceeds the small-file verification limit`);
    }
    const digest = digestOpenFile(opened.fd);
    assertStableFile(opened.fd, opened.before, label);
    return digest;
  } finally {
    closeSync(opened.fd);
  }
}

function digestOpenFile(fd: number): FileDigest {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let bytes = 0;
  let position = 0;
  while (true) {
    const count = readSync(fd, buffer, 0, buffer.length, position);
    if (count === 0) break;
    hash.update(buffer.subarray(0, count));
    bytes += count;
    position += count;
  }
  return { sha256: hash.digest("hex"), bytes };
}

function copyPinVerifiedInput(
  source: PinVerifiedInput,
  destinationPath: string,
  label: string,
  uid: number,
  mode: number
): void {
  let destination: number | undefined;
  try {
    destination = openSync(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | requiredNoFollow() | CLOEXEC,
      mode
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    let position = 0;
    while (true) {
      const count = readSync(source.fd, buffer, 0, buffer.length, position);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      writeAll(destination, buffer.subarray(0, count));
      bytes += count;
      position += count;
    }
    fsyncSync(destination);
    const copied = { sha256: hash.digest("hex"), bytes };
    assertStableFile(source.fd, source.before, label);
    if (copied.sha256 !== source.digest.sha256 || copied.bytes !== source.digest.bytes) {
      throw new KernelCompatLifecycleError(`${label} changed before it could be staged`);
    }
  } finally {
    if (destination !== undefined) closeSync(destination);
  }
  chmodSync(destinationPath, mode);
  fsyncFile(destinationPath);
  assertOwnedRegularFile(destinationPath, `staged ${label}`, uid, true, mode);
  const copiedDigest = digestRegularFile(destinationPath, `staged ${label}`, uid, true);
  if (copiedDigest.sha256 !== source.digest.sha256 || copiedDigest.bytes !== source.digest.bytes) {
    throw new KernelCompatLifecycleError(`staged ${label} hash does not match the pin-verified input`);
  }
}

function copyRegularFile(
  sourcePath: string,
  destinationPath: string,
  label: string,
  uid: number,
  expected: FileDigest,
  mode: number
): void {
  const source = openOwnedRegularFile(sourcePath, label, uid, (mode & 0o111) !== 0);
  let destination: number | undefined;
  try {
    destination = openSync(
      destinationPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | requiredNoFollow() | CLOEXEC,
      mode
    );
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes = 0;
    while (true) {
      const count = readSync(source.fd, buffer, 0, buffer.length, null);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      writeAll(destination, buffer.subarray(0, count));
      bytes += count;
    }
    fsyncSync(destination);
    const actual = { sha256: hash.digest("hex"), bytes };
    assertStableFile(source.fd, source.before, label);
    if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
      throw new KernelCompatLifecycleError(`${label} changed before it could be staged`);
    }
  } finally {
    if (destination !== undefined) closeSync(destination);
    closeSync(source.fd);
  }
  chmodSync(destinationPath, mode);
}

function writeAll(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset);
    if (written <= 0) throw new KernelCompatLifecycleError("could not write staged kernel compatibility data");
    offset += written;
  }
}

function writeNewFile(filePath: string, content: string, mode: number): void {
  const fd = openSync(
    filePath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | requiredNoFollow() | CLOEXEC,
    mode
  );
  try {
    writeAll(fd, Buffer.from(content, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(filePath, mode);
}

function readSmallTextFile(filePath: string, label: string, uid: number): string {
  const opened = openOwnedRegularFile(filePath, label, uid, false);
  try {
    if (opened.before.size > MAX_PATCHED_SOURCE_BYTES) {
      throw new KernelCompatLifecycleError(`${label} exceeds the patched-source size limit`);
    }
    const content = readFileSync(opened.fd, "utf8");
    assertStableFile(opened.fd, opened.before, label);
    return content;
  } finally {
    closeSync(opened.fd);
  }
}

function rewriteSmallTextFile(filePath: string, content: string, label: string, uid: number): void {
  const lstat = lstatSync(filePath);
  if (lstat.isSymbolicLink() || !lstat.isFile() || lstat.uid !== uid) {
    throw new KernelCompatLifecycleError(`${label} is no longer a safe regular file`);
  }
  chmodSync(filePath, 0o600);
  const fd = openSync(filePath, constants.O_WRONLY | constants.O_TRUNC | requiredNoFollow() | CLOEXEC);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== lstat.dev || opened.ino !== lstat.ino || opened.uid !== uid) {
      throw new KernelCompatLifecycleError(`${label} changed while it was being patched`);
    }
    writeAll(fd, Buffer.from(content, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(filePath, 0o400);
}

function runOfficialSelfUnpacker(stagedBinaryPath: string, releaseRoot: string, stagingRoot: string): void {
  const unpackHome = path.join(stagingRoot, "unpack-home");
  mkdirSync(unpackHome, { mode: 0o700 });
  const result = spawnSync(stagedBinaryPath, ["--unpack_par_and_exit"], {
    cwd: releaseRoot,
    encoding: "utf8",
    stdio: "ignore",
    timeout: 300_000,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: unpackHome,
      XDG_CACHE_HOME: path.join(unpackHome, ".cache"),
      XDG_CONFIG_HOME: path.join(unpackHome, ".config"),
      LANG: "C",
      LC_ALL: "C",
      http_proxy: "",
      https_proxy: "",
      HTTP_PROXY: "",
      HTTPS_PROXY: "",
      ALL_PROXY: "",
      all_proxy: ""
    }
  });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    throw new KernelCompatLifecycleError("official self-unpacker did not complete successfully");
  }
}

function assertAndHardenUnpackedKernelExecutable(releaseRoot: string, stagedBinaryPath: string, uid: number): void {
  assertRealDirectory(releaseRoot, "unpacked release root", uid, 0o700);
  const executablePath = safePathUnderDirectory(
    releaseRoot,
    KERNEL_EXECUTABLE_FILE,
    "unpacked adjacent kernel executable",
    true
  );
  if (path.resolve(executablePath) !== path.resolve(stagedBinaryPath)) {
    throw new KernelCompatLifecycleError("unpacked adjacent kernel executable is outside the private stage");
  }
  const opened = openCurrentUserRegularFile(executablePath, "unpacked adjacent kernel executable", uid, true, true);
  try {
    fchmodSync(opened.fd, 0o500);
    fsyncSync(opened.fd);
    const hardened = fstatSync(opened.fd);
    if (!hardened.isFile() || hardened.uid !== uid || (hardened.mode & 0o777) !== 0o500) {
      throw new KernelCompatLifecycleError("unpacked adjacent kernel executable could not be hardened to mode 0500");
    }
  } finally {
    closeSync(opened.fd);
  }
  assertOwnedRegularFile(executablePath, "unpacked adjacent kernel executable", uid, true, 0o500);
}

function targetPaths(runfilesPath: string, pins: KernelCompatPins, uid: number): Record<KernelCompatTargetName, string> {
  const paths = {} as Record<KernelCompatTargetName, string>;
  for (const target of KERNEL_COMPAT_TARGET_NAMES) {
    const targetPath = safePathUnderDirectory(runfilesPath, pins.targets[target].relativePath, `${target} source`, true);
    assertOwnedRegularFile(targetPath, `${target} source`, uid, false);
    paths[target] = targetPath;
  }
  return paths;
}

function applyPatchPlan(paths: Record<KernelCompatTargetName, string>, patchPlan: KernelCompatPatchPlan, uid: number): void {
  for (const target of ["modelSelection", "proxyServer"] as const) {
    const source = readSmallTextFile(paths[target], `${target} source`, uid);
    const edits = patchPlan.edits.filter((edit) => edit.target === target);
    let patched = source;
    for (const edit of edits) {
      const occurrences = countExactOccurrences(patched, edit.find);
      if (occurrences !== 1) {
        throw new KernelCompatLifecycleError(`patch marker ${edit.id} in ${target} must occur exactly once; found ${occurrences}`);
      }
      patched = patched.replace(edit.find, edit.replacement);
    }
    rewriteSmallTextFile(paths[target], patched, `${target} source`, uid);
  }
}

function countExactOccurrences(source: string, marker: string): number {
  let count = 0;
  let start = 0;
  while (true) {
    const index = source.indexOf(marker, start);
    if (index === -1) return count;
    count += 1;
    start = index + marker.length;
  }
}

function collectPostimages(
  runfilesPath: string,
  pins: KernelCompatPins,
  layout: KernelCompatLayout,
  uid: number
): Record<KernelCompatTargetName | "compatModule", ReceiptPostimage> {
  const postimages = {} as Record<KernelCompatTargetName | "compatModule", ReceiptPostimage>;
  for (const target of KERNEL_COMPAT_TARGET_NAMES) {
    const relativePath = pins.targets[target].relativePath;
    const digest = digestSmallFile(
      safePathUnderDirectory(runfilesPath, relativePath, `${target} postimage`, true),
      `${target} postimage`,
      uid,
      false
    );
    postimages[target] = { relativePath, ...digest };
  }
  const compatDigest = digestSmallFile(
    safePathUnderDirectory(runfilesPath, layout.compatModuleRelativePath, "compatibility module postimage", true),
    "compatibility module postimage",
    uid,
    false
  );
  postimages.compatModule = { relativePath: layout.compatModuleRelativePath, ...compatDigest };
  return postimages;
}

function validateImporterEnvironment(runfilesPath: string, layout: KernelCompatLayout, uid: number): void {
  for (const [name, relativePath] of Object.entries(layout.importerEnvironment)) {
    const importerPath = safePathUnderDirectory(runfilesPath, relativePath, `importer environment ${name}`, true);
    const stat = lstatSync(importerPath);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || stat.uid !== uid) {
      throw new KernelCompatLifecycleError(`importer environment ${name} must point to a current-user-owned real path`);
    }
  }
}

function assertOwnedRegularFile(filePath: string, label: string, uid: number, executable: boolean, exactMode?: number): void {
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== uid) {
    throw new KernelCompatLifecycleError(`${label} must be a current-user-owned regular file`);
  }
  if ((stat.mode & 0o022) !== 0) throw new KernelCompatLifecycleError(`${label} must not be group- or world-writable`);
  if (executable && (stat.mode & 0o111) === 0) throw new KernelCompatLifecycleError(`${label} must be executable`);
  if (exactMode !== undefined && (stat.mode & 0o777) !== exactMode) {
    throw new KernelCompatLifecycleError(`${label} must have mode ${exactMode.toString(8).padStart(4, "0")}`);
  }
}

function safePathUnderDirectory(root: string, relativePath: string, label: string, requireExisting: boolean): string {
  assertSafeRelativePath(label, relativePath);
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, relativePath);
  if (!isInsideDirectory(candidate, resolvedRoot)) {
    throw new KernelCompatLifecycleError(`${label} escapes its expected directory`);
  }
  let cursor = resolvedRoot;
  const parts = relativePath.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    cursor = path.join(cursor, parts[index]);
    const stat = tryLstat(cursor);
    const finalPart = index === parts.length - 1;
    if (stat === undefined) {
      if (finalPart && !requireExisting) return candidate;
      throw new KernelCompatLifecycleError(`${label} is missing`);
    }
    if (stat.isSymbolicLink()) throw new KernelCompatLifecycleError(`${label} must not traverse a symbolic link`);
    if (!finalPart && !stat.isDirectory()) throw new KernelCompatLifecycleError(`${label} has a non-directory parent`);
  }
  return candidate;
}

function isInsideDirectory(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function ensureParentDirectories(root: string, relativePath: string, uid: number): void {
  const parts = relativePath.split("/");
  if (parts.length === 1) return;
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    const existing = tryLstat(cursor);
    if (existing === undefined) mkdirSync(cursor, { mode: 0o700 });
    assertRealDirectory(cursor, "staged runfiles parent", uid);
    chmodSync(cursor, 0o700);
  }
}

function mainSymlinkRelativePath(pins: KernelCompatPins): string {
  return `${path.posix.dirname(pins.targets.modelSelection.relativePath)}/main`;
}

function hardenRunfiles(runfilesPath: string, releaseRoot: string, requiredMainLink: string, uid: number): void {
  let mainLinkTarget: string | undefined;
  const walk = (directory: string, prefix: string): void => {
    const directoryStat = lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory() || directoryStat.uid !== uid) {
      throw new KernelCompatLifecycleError("unpacked runfiles contain an unsafe directory");
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const child = path.join(directory, entry.name);
      const stat = lstatSync(child);
      if (stat.uid !== uid) {
        throw new KernelCompatLifecycleError("unpacked runfiles contain a foreign-owned entry");
      }
      if (stat.isSymbolicLink()) {
        const target = resolveSafeRunfilesSymlink(child, releaseRoot, uid);
        if (relativePath === requiredMainLink) mainLinkTarget = target;
        continue;
      }
      if (entry.isDirectory()) {
        walk(child, relativePath);
      } else if (entry.isFile()) {
        const executable = (stat.mode & 0o111) !== 0;
        chmodSync(child, executable ? 0o500 : 0o400);
        fsyncFile(child);
      } else {
        throw new KernelCompatLifecycleError("unpacked runfiles contain a special filesystem entry");
      }
    }
    chmodSync(directory, 0o500);
    fsyncDirectory(directory);
  };
  walk(runfilesPath, "");
  if (mainLinkTarget === undefined) {
    throw new KernelCompatLifecycleError("unpacked runfiles are missing the required acp_server/main symbolic link");
  }
  if (mainLinkTarget !== path.join(releaseRoot, KERNEL_EXECUTABLE_FILE)) {
    throw new KernelCompatLifecycleError("acp_server/main symbolic link must resolve to the staged agy_acp_server");
  }
}

function resolveSafeRunfilesSymlink(linkPath: string, releaseRoot: string, uid: number): string {
  const resolvedReleaseRoot = path.resolve(releaseRoot);
  const visited = new Set<string>();
  let cursor = linkPath;
  for (let depth = 0; depth < MAX_SYMLINK_CHAIN; depth += 1) {
    const linkStat = lstatSync(cursor);
    if (!linkStat.isSymbolicLink() || linkStat.uid !== uid) {
      throw new KernelCompatLifecycleError("unpacked symbolic link chain is not current-user-owned");
    }
    const identity = `${linkStat.dev}:${linkStat.ino}`;
    if (visited.has(identity)) throw new KernelCompatLifecycleError("unpacked symbolic link chain contains a cycle");
    visited.add(identity);
    const targetText = readlinkSync(cursor);
    if (targetText.length === 0 || targetText.includes("\0") || targetText.includes("\\") || path.isAbsolute(targetText)) {
      throw new KernelCompatLifecycleError("unpacked symbolic link must use a relative target");
    }
    const candidate = path.resolve(path.dirname(cursor), targetText);
    if (!isInsideDirectory(candidate, resolvedReleaseRoot)) {
      throw new KernelCompatLifecycleError("unpacked symbolic link escapes the staged release root");
    }
    assertNoIntermediateSymlinkComponents(resolvedReleaseRoot, candidate);
    const candidateStat = tryLstat(candidate);
    if (candidateStat === undefined) throw new KernelCompatLifecycleError("unpacked symbolic link target is broken");
    if (candidateStat.isSymbolicLink()) {
      cursor = candidate;
      continue;
    }
    if (!candidateStat.isFile() || candidateStat.uid !== uid || (candidateStat.mode & 0o022) !== 0) {
      throw new KernelCompatLifecycleError("unpacked symbolic link target must be a safe current-user-owned regular file");
    }
    return candidate;
  }
  throw new KernelCompatLifecycleError("unpacked symbolic link chain cannot be proven safe");
}

function assertNoIntermediateSymlinkComponents(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  const parts = relative.split(path.sep);
  let cursor = root;
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    const stat = tryLstat(cursor);
    if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) {
      throw new KernelCompatLifecycleError("unpacked symbolic link chain has an unsafe parent");
    }
  }
}

function verifyRelease(releasePath: string, pins: KernelCompatPins, pinDigest: string, uid: number): ReleaseVerification {
  assertRealDirectory(releasePath, "prepared release", uid, 0o500);
  const receipt = readReceipt(releasePath, uid);
  if (receipt.artifactId !== path.basename(releasePath)) {
    throw new KernelCompatLifecycleError("prepared release directory does not match its receipt artifact id");
  }
  if (receipt.pinDigest !== pinDigest || receipt.profileId !== pins.profileId) {
    throw new KernelCompatLifecycleError("prepared release uses stale or unknown kernel compatibility pins");
  }
  if (receipt.inputs.par.sha256 !== pins.parSha256 || receipt.inputs.externalHarness.sha256 !== pins.externalHarnessSha256) {
    throw new KernelCompatLifecycleError("prepared release does not attest to the pinned official inputs");
  }
  if (
    receipt.layout.runfilesRelativePath !== RUNFILES_DIRECTORY ||
    receipt.layout.kernelExecutableRelativePath !== KERNEL_EXECUTABLE_FILE ||
    receipt.layout.externalHarnessRelativePath !== EXTERNAL_HARNESS_FILE
  ) {
    throw new KernelCompatLifecycleError("prepared release has an unsupported adjacent runfiles layout");
  }
  const runfilesPath = safePathUnderDirectory(releasePath, receipt.layout.runfilesRelativePath, "receipt runfiles", true);
  assertRealDirectory(runfilesPath, "receipt runfiles", uid, 0o500);

  // Runtime verification intentionally hashes only bounded patched sources and generated files.
  for (const target of KERNEL_COMPAT_TARGET_NAMES) {
    const postimage = receipt.postimages[target];
    if (postimage.relativePath !== pins.targets[target].relativePath) {
      throw new KernelCompatLifecycleError(`${target} receipt path does not match current pins`);
    }
    const actual = digestSmallPostimage(runfilesPath, postimage, target, uid);
    if (actual.sha256 !== postimage.sha256 || actual.bytes !== postimage.bytes) {
      throw new KernelCompatLifecycleError(`${target} postimage hash does not match the receipt`);
    }
  }
  if (receipt.postimages.serverControl.sha256 !== pins.targets.serverControl.preimageSha256) {
    throw new KernelCompatLifecycleError("server.py receipt hash does not match the immutable control pin");
  }
  const compatPostimage = receipt.postimages.compatModule;
  if (compatPostimage.relativePath !== receipt.layout.compatModuleRelativePath) {
    throw new KernelCompatLifecycleError("compatibility module receipt path is inconsistent");
  }
  const actualCompat = digestSmallPostimage(runfilesPath, compatPostimage, "compatibility module", uid);
  if (actualCompat.sha256 !== compatPostimage.sha256 || actualCompat.bytes !== compatPostimage.bytes) {
    throw new KernelCompatLifecycleError("compatibility module postimage hash does not match the receipt");
  }

  const executable = safePathUnderDirectory(releasePath, KERNEL_EXECUTABLE_FILE, "receipt kernel executable", true);
  assertOwnedRegularFile(executable, "receipt kernel executable", uid, true, 0o500);
  const harness = safePathUnderDirectory(releasePath, EXTERNAL_HARNESS_FILE, "receipt external harness", true);
  assertOwnedRegularFile(harness, "receipt external harness", uid, true, 0o500);
  validateImporterEnvironment(runfilesPath, receipt.layout, uid);

  const wrapperPath = safePathUnderDirectory(releasePath, receipt.wrapper.relativePath, "receipt wrapper", true);
  const wrapperDigest = digestSmallFile(wrapperPath, "receipt wrapper", uid, true);
  if (wrapperDigest.sha256 !== receipt.wrapper.sha256 || wrapperDigest.bytes !== receipt.wrapper.bytes) {
    throw new KernelCompatLifecycleError("receipt wrapper hash does not match the generated wrapper");
  }
  const verifierPath = safePathUnderDirectory(releasePath, receipt.wrapper.verifierRelativePath, "receipt wrapper verifier", true);
  const verifierDigest = digestSmallFile(verifierPath, "receipt wrapper verifier", uid, true);
  if (verifierDigest.sha256 !== receipt.wrapper.verifierSha256 || verifierDigest.bytes !== receipt.wrapper.verifierBytes) {
    throw new KernelCompatLifecycleError("receipt wrapper verifier hash does not match the generated verifier");
  }
  return { receipt, wrapperPath };
}

function digestSmallPostimage(runfilesPath: string, postimage: ReceiptPostimage, label: string, uid: number): FileDigest {
  const filePath = safePathUnderDirectory(runfilesPath, postimage.relativePath, `${label} receipt postimage`, true);
  return digestSmallFile(filePath, `${label} receipt postimage`, uid, false);
}

function readReceipt(releasePath: string, uid: number): KernelCompatReceipt {
  const receiptPath = safePathUnderDirectory(releasePath, "receipt.json", "receipt", true);
  let parsed: unknown;
  try {
    const opened = openOwnedRegularFile(receiptPath, "receipt", uid, false);
    try {
      if ((opened.before.mode & 0o777) !== 0o600) {
        throw new KernelCompatLifecycleError("receipt must be a current-user-owned regular file with mode 0600");
      }
      if (opened.before.size > MAX_RECEIPT_BYTES) throw new KernelCompatLifecycleError("receipt exceeds the sanitised size limit");
      parsed = JSON.parse(readFileSync(opened.fd, "utf8"));
      assertStableFile(opened.fd, opened.before, "receipt");
    } finally {
      closeSync(opened.fd);
    }
  } catch (error) {
    if (error instanceof KernelCompatLifecycleError) throw error;
    throw new KernelCompatLifecycleError("receipt is not valid JSON");
  }
  return validateReceipt(parsed);
}

function validateReceipt(value: unknown): KernelCompatReceipt {
  if (!isRecord(value)) throw new KernelCompatLifecycleError("receipt must be an object");
  if (value.schemaVersion !== RECEIPT_SCHEMA_VERSION) throw new KernelCompatLifecycleError("receipt schema version is unsupported");
  const artifactId = requireArtifactIdValue(value.artifactId, "receipt artifact id");
  const profileId = requireArtifactIdValue(value.profileId, "receipt profile id");
  const createdAt = requireString(value.createdAt, "receipt timestamp");
  const pinDigest = requireDigestValue(value.pinDigest, "receipt pin digest");
  const patchDigest = requireDigestValue(value.patchDigest, "receipt patch digest");
  const inputs = requireRecord(value.inputs, "receipt inputs");
  const layout = requireRecord(value.layout, "receipt layout");
  const postimages = requireRecord(value.postimages, "receipt postimages");
  const wrapper = requireRecord(value.wrapper, "receipt wrapper");
  const parsedPostimages = {} as Record<KernelCompatTargetName | "compatModule", ReceiptPostimage>;
  for (const key of [...KERNEL_COMPAT_TARGET_NAMES, "compatModule"] as const) {
    parsedPostimages[key] = parsePostimage(postimages[key], `receipt postimage ${key}`);
  }
  const parsedImporterEnvironment = parseImporterEnvironment(layout.importerEnvironment);
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    artifactId,
    profileId,
    createdAt,
    pinDigest,
    patchDigest,
    inputs: {
      par: parseDigest(inputs.par, "receipt PAR input"),
      externalHarness: parseDigest(inputs.externalHarness, "receipt external harness input"),
      compatModule: parseDigest(inputs.compatModule, "receipt compatibility module input")
    },
    layout: {
      runfilesRelativePath: requireSafeRelativeValue(layout.runfilesRelativePath, "receipt runfiles path"),
      kernelExecutableRelativePath: requireSafeRelativeValue(layout.kernelExecutableRelativePath, "receipt kernel executable path"),
      externalHarnessRelativePath: requireSafeRelativeValue(layout.externalHarnessRelativePath, "receipt external harness path"),
      compatModuleRelativePath: requireSafeRelativeValue(layout.compatModuleRelativePath, "receipt compatibility module path"),
      importerEnvironment: parsedImporterEnvironment
    },
    postimages: parsedPostimages,
    wrapper: {
      relativePath: requireSafeRelativeValue(wrapper.relativePath, "receipt wrapper path"),
      sha256: requireDigestValue(wrapper.sha256, "receipt wrapper hash"),
      bytes: requireByteCount(wrapper.bytes, "receipt wrapper byte count"),
      verifierRelativePath: requireSafeRelativeValue(wrapper.verifierRelativePath, "receipt wrapper verifier path"),
      verifierSha256: requireDigestValue(wrapper.verifierSha256, "receipt wrapper verifier hash"),
      verifierBytes: requireByteCount(wrapper.verifierBytes, "receipt wrapper verifier byte count")
    }
  };
}

function parseImporterEnvironment(value: unknown): Readonly<Record<string, string>> {
  const record = requireRecord(value, "receipt importer environment");
  const parsed: Record<string, string> = {};
  for (const [name, relativePath] of Object.entries(record)) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) throw new KernelCompatLifecycleError("receipt importer environment name is invalid");
    if (["ANTIGRAVITY_HARNESS_PATH", "PYTHONDONTWRITEBYTECODE", "PYTHONPATH"].includes(name)) {
      throw new KernelCompatLifecycleError("receipt importer environment overrides a wrapper-controlled value");
    }
    parsed[name] = requireSafeRelativeValue(relativePath, `receipt importer environment ${name}`);
  }
  return Object.freeze(parsed);
}

function parseDigest(value: unknown, label: string): FileDigest {
  const record = requireRecord(value, label);
  return { sha256: requireDigestValue(record.sha256, `${label} hash`), bytes: requireByteCount(record.bytes, `${label} byte count`) };
}

function parsePostimage(value: unknown, label: string): ReceiptPostimage {
  const record = requireRecord(value, label);
  return { relativePath: requireSafeRelativeValue(record.relativePath, `${label} path`), ...parseDigest(record, label) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new KernelCompatLifecycleError(`${label} must be an object`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new KernelCompatLifecycleError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireArtifactIdValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new KernelCompatLifecycleError(`${label} must be an identifier`);
  return requireIdentifier(label, value);
}

function requireDigestValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new KernelCompatLifecycleError(`${label} must be a SHA-256 digest`);
  requireSha256(label, value);
  return value;
}

function requireByteCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new KernelCompatLifecycleError(`${label} must be a non-negative integer`);
  }
  return value;
}

function requireSafeRelativeValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new KernelCompatLifecycleError(`${label} must be a relative path`);
  assertSafeRelativePath(label, value);
  return value;
}

function assertIdempotentReceipt(
  receipt: KernelCompatReceipt,
  par: FileDigest,
  externalHarness: FileDigest,
  compatModule: FileDigest,
  patchDigest: string
): void {
  if (
    receipt.patchDigest !== patchDigest ||
    receipt.inputs.par.sha256 !== par.sha256 || receipt.inputs.par.bytes !== par.bytes ||
    receipt.inputs.externalHarness.sha256 !== externalHarness.sha256 || receipt.inputs.externalHarness.bytes !== externalHarness.bytes ||
    receipt.inputs.compatModule.sha256 !== compatModule.sha256 || receipt.inputs.compatModule.bytes !== compatModule.bytes
  ) {
    throw new KernelCompatLifecycleError("existing prepared release does not match the current local inputs");
  }
}

function buildArtifactId(profileId: string, parHash: string, compatibilityVersion: string, compatHash: string, patchDigest: string): string {
  return `${profileId}-${parHash.slice(0, 12)}-${compatibilityVersion}-${compatHash.slice(0, 12)}-${patchDigest.slice(0, 12)}`;
}

function digestPatchPlan(plan: KernelCompatPatchPlan): string {
  return sha256Text(canonicalJson({
    edits: plan.edits.map((edit) => ({
      id: edit.id,
      target: edit.target,
      findSha256: sha256Text(edit.find),
      replacementSha256: sha256Text(edit.replacement)
    }))
  }));
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new KernelCompatLifecycleError("cannot canonicalise an undefined receipt value");
}

function withWriterLock<T>(root: string, uid: number, clock: () => Date, operation: () => T): T {
  const lockPath = path.join(root, LOCK_FILE);
  const identity = observeCurrentProcessIdentity();
  let fd: number | undefined;
  for (let attempts = 0; attempts < 4; attempts += 1) {
    try {
      fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | requiredNoFollow() | CLOEXEC, 0o600);
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      recoverStaleLock(root, lockPath, uid, currentClockMilliseconds(clock));
    }
  }
  if (fd === undefined) throw new KernelCompatLifecycleError("could not replace a stale kernel compatibility lifecycle lock");
  const lockStat = fstatSync(fd);
  try {
    if (!lockStat.isFile() || lockStat.uid !== uid || (lockStat.mode & 0o777) !== 0o600) {
      throw new KernelCompatLifecycleError("could not establish a safe lifecycle lock");
    }
    writeAll(fd, Buffer.from(`${canonicalJson({ schemaVersion: LOCK_SCHEMA_VERSION, ...identity })}\n`, "utf8"));
    fsyncSync(fd);
    fsyncDirectory(root);
    return operation();
  } finally {
    closeSync(fd);
    const current = tryLstat(lockPath);
    if (current !== undefined && current.isFile() && current.dev === lockStat.dev && current.ino === lockStat.ino && current.uid === uid) {
      unlinkSync(lockPath);
      fsyncDirectory(root);
    }
  }
}

function currentClockMilliseconds(clock: () => Date): number {
  const value = clock().getTime();
  if (!Number.isFinite(value)) throw new KernelCompatLifecycleError("lifecycle clock returned an invalid timestamp");
  return value;
}

function observeCurrentProcessIdentity(): ProcessIdentity {
  return { pid: process.pid, procStartTime: readLinuxProcessStartTime(process.pid, true) };
}

function readLinuxProcessStartTime(pid: number, required: boolean): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new KernelCompatLifecycleError("lifecycle lock pid is invalid");
  }
  let statText: string;
  try {
    statText = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (!required && isMissing(error)) return "";
    throw new KernelCompatLifecycleError("could not inspect Linux process identity for lifecycle lock recovery");
  }
  const closingParen = statText.lastIndexOf(")");
  if (closingParen < 0) throw new KernelCompatLifecycleError("could not parse Linux process identity for lifecycle lock recovery");
  const fields = statText.slice(closingParen + 2).trim().split(/\s+/);
  const startTime = fields[19];
  if (startTime === undefined || !INTEGER_PATTERN.test(startTime)) {
    throw new KernelCompatLifecycleError("could not parse Linux process start time for lifecycle lock recovery");
  }
  return startTime;
}

function recoverStaleLock(root: string, lockPath: string, uid: number, nowMilliseconds: number): void {
  const existing = readLockReceipt(lockPath, uid, nowMilliseconds);
  if (existing === undefined) return;
  if (existing.receipt !== undefined) {
    const observedStartTime = readLinuxProcessStartTime(existing.receipt.pid, false);
    if (observedStartTime !== "" && observedStartTime === existing.receipt.procStartTime) {
      throw new KernelCompatLifecycleError("kernel compatibility lifecycle is already running");
    }
  } else if (isIncompleteLockWithinGrace(existing.stat, nowMilliseconds)) {
    throw new KernelCompatLifecycleError("kernel compatibility lifecycle lock is incomplete and within the recovery grace period");
  }
  quarantineStaleLock(root, lockPath, uid, existing.stat);
}

function isIncompleteLockWithinGrace(stat: Stats, nowMilliseconds: number): boolean {
  const ageMilliseconds = nowMilliseconds - stat.mtimeMs;
  return !Number.isFinite(ageMilliseconds) || ageMilliseconds < LOCK_INCOMPLETE_GRACE_MS;
}

function quarantineStaleLock(root: string, lockPath: string, uid: number, expected: Stats): void {
  const before = tryLstat(lockPath);
  if (before === undefined) return;
  if (before.isSymbolicLink() || !before.isFile() || before.uid !== uid || (before.mode & 0o777) !== 0o600) {
    throw new KernelCompatLifecycleError("existing lifecycle lock is unsafe and cannot be recovered");
  }
  if (!sameFileSnapshot(before, expected)) {
    throw new KernelCompatLifecycleError("existing lifecycle lock changed during recovery");
  }
  const quarantinePath = path.join(root, `${LOCK_FILE}.stale-${randomBytes(8).toString("hex")}`);
  renameSync(lockPath, quarantinePath);
  const moved = lstatSync(quarantinePath);
  if (!moved.isFile() || moved.isSymbolicLink() || moved.uid !== uid || moved.dev !== before.dev || moved.ino !== before.ino) {
    throw new KernelCompatLifecycleError("lifecycle lock changed during stale-lock quarantine");
  }
  fsyncDirectory(root);
}

function readLockReceipt(lockPath: string, uid: number, nowMilliseconds: number): ExistingLock | undefined {
  const stat = tryLstat(lockPath);
  if (stat === undefined) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== uid) {
    throw new KernelCompatLifecycleError("existing lifecycle lock is unsafe and cannot be recovered");
  }
  if ((stat.mode & 0o777) !== 0o600) {
    if (isIncompleteLockWithinGrace(stat, nowMilliseconds)) {
      throw new KernelCompatLifecycleError("kernel compatibility lifecycle lock is incomplete and within the recovery grace period");
    }
    throw new KernelCompatLifecycleError("existing lifecycle lock is unsafe and cannot be recovered");
  }
  if (stat.size > MAX_LOCK_BYTES) return { stat };
  let parsed: unknown;
  try {
    const opened = openOwnedRegularFile(lockPath, "existing lifecycle lock", uid, false);
    try {
      if (!sameFileSnapshot(opened.before, stat)) {
        throw new KernelCompatLifecycleError("existing lifecycle lock changed while it was being opened");
      }
      if (opened.before.size > MAX_LOCK_BYTES) throw new KernelCompatLifecycleError("existing lifecycle lock exceeds the safe size limit");
      parsed = JSON.parse(readFileSync(opened.fd, "utf8"));
      assertStableFile(opened.fd, opened.before, "existing lifecycle lock");
    } finally {
      closeSync(opened.fd);
    }
  } catch (error) {
    if (error instanceof SyntaxError) return { stat };
    if (error instanceof KernelCompatLifecycleError) throw error;
    return { stat };
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== LOCK_SCHEMA_VERSION || typeof parsed.pid !== "number" ||
    !Number.isSafeInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.procStartTime !== "string" ||
    !INTEGER_PATTERN.test(parsed.procStartTime)) {
    return { stat };
  }
  return {
    stat,
    receipt: { schemaVersion: LOCK_SCHEMA_VERSION, pid: parsed.pid, procStartTime: parsed.procStartTime }
  };
}

function stableWrapperPathFor(root: string): string {
  return path.join(root, STABLE_WRAPPER_FILE);
}

function ensureStableActivationWrapper(root: string, pinDigest: string, uid: number): void {
  writeOrReplaceOwnedExecutable(root, ACTIVE_RESOLVER_FILE, renderActiveResolver(pinDigest), uid);
  writeOrReplaceOwnedExecutable(root, STABLE_WRAPPER_FILE, renderStableWrapper(), uid);
}

function writeOrReplaceOwnedExecutable(root: string, filename: string, content: string, uid: number): void {
  const target = path.join(root, filename);
  const existing = tryLstat(target);
  if (existing !== undefined) {
    assertOwnedRegularFile(target, `stable ${filename}`, uid, true, 0o500);
    const actual = readSmallTextFile(target, `stable ${filename}`, uid);
    if (actual === content) return;
  }
  const temporary = path.join(root, `.${filename}-${randomBytes(8).toString("hex")}`);
  try {
    writeNewFile(temporary, content, 0o500);
    renameSync(temporary, target);
    fsyncDirectory(root);
  } finally {
    const leftover = tryLstat(temporary);
    if (leftover !== undefined && leftover.isFile() && !leftover.isSymbolicLink() && leftover.uid === uid) unlinkSync(temporary);
  }
}

function commitActivationState(
  root: string,
  state: ActivationStateView,
  pinDigest: string,
  uid: number,
  hooks: KernelCompatLifecycleHooks
): void {
  const activationStates = ensureInternalDirectory(root, ACTIVATION_STATES_DIRECTORY, uid);
  const stateId = `activation-${randomBytes(12).toString("hex")}`;
  const temporaryState = mkdtempSync(path.join(activationStates, ".activation-stage-"), "utf8");
  chmodSync(temporaryState, 0o700);
  const complete: ActivationState = {
    schemaVersion: ACTIVATION_STATE_SCHEMA_VERSION,
    pinDigest,
    currentArtifactId: requireArtifactId(state.currentArtifactId),
    ...(state.previousArtifactId === undefined ? {} : { previousArtifactId: requireArtifactId(state.previousArtifactId) })
  };
  try {
    writeNewFile(path.join(temporaryState, "activation.json"), `${canonicalJson(complete)}\n`, 0o400);
    chmodSync(temporaryState, 0o500);
    fsyncDirectory(temporaryState);
    const finalStatePath = path.join(activationStates, stateId);
    renameSync(temporaryState, finalStatePath);
    fsyncDirectory(activationStates);

    hooks.beforeActivationCommit?.(Object.freeze({ ...state }));
    const temporaryReference = path.join(root, `.${ACTIVE_REFERENCE}-${randomBytes(8).toString("hex")}`);
    try {
      symlinkSync(`${ACTIVATION_STATES_DIRECTORY}/${stateId}`, temporaryReference);
      fsyncDirectory(root);
      renameSync(temporaryReference, path.join(root, ACTIVE_REFERENCE));
      fsyncDirectory(root);
    } finally {
      removeTemporarySymlink(root, temporaryReference, uid);
    }
    hooks.afterActivationCommit?.(Object.freeze({ ...state }));
  } finally {
    const leftover = tryLstat(temporaryState);
    if (leftover !== undefined && leftover.isDirectory() && !leftover.isSymbolicLink() && leftover.uid === uid) {
      removeDirectoryIfSafe(activationStates, temporaryState, ".activation-stage-", uid);
    }
  }
}

function removeTemporarySymlink(root: string, temporaryPath: string, uid: number): void {
  if (path.dirname(temporaryPath) !== root) return;
  const stat = tryLstat(temporaryPath);
  if (stat !== undefined && stat.isSymbolicLink() && stat.uid === uid) unlinkSync(temporaryPath);
}

function requireActiveState(root: string, uid: number, pinDigest: string): ActivationState {
  const active = readActiveState(root, uid, pinDigest);
  if (active === undefined) throw new KernelCompatLifecycleError("active compatibility release is not set");
  return active;
}

function readActiveState(root: string, uid: number, expectedPinDigest?: string): ActivationState | undefined {
  const reference = readActiveStateReference(root, uid);
  if (reference === undefined) return undefined;
  const state = readActivationStateFile(reference.stateDirectory, uid);
  if (expectedPinDigest !== undefined && state.pinDigest !== expectedPinDigest) {
    throw new KernelCompatLifecycleError("active compatibility state uses stale or unknown kernel compatibility pins");
  }
  return state;
}

function readActiveStateReference(root: string, uid: number): ActiveStateReference | undefined {
  const referencePath = path.join(root, ACTIVE_REFERENCE);
  const linkStat = tryLstat(referencePath);
  if (linkStat === undefined) return undefined;
  if (!linkStat.isSymbolicLink() || linkStat.uid !== uid) {
    throw new KernelCompatLifecycleError("active compatibility state must be a current-user-owned symbolic link");
  }
  const target = readlinkSync(referencePath);
  const prefix = `${ACTIVATION_STATES_DIRECTORY}/`;
  if (path.isAbsolute(target) || !target.startsWith(prefix) || target.slice(prefix.length).includes("/")) {
    throw new KernelCompatLifecycleError("active compatibility state points outside managed activation states");
  }
  const stateId = requireIdentifier("activation state id", target.slice(prefix.length));
  const states = safePathUnderDirectory(root, ACTIVATION_STATES_DIRECTORY, "activation states directory", true);
  assertRealDirectory(states, "activation states directory", uid, 0o700);
  const stateDirectory = safePathUnderDirectory(states, stateId, "activation state directory", true);
  assertRealDirectory(stateDirectory, "activation state directory", uid, 0o500);
  return { stateId, stateDirectory };
}

function readActivationStateFile(stateDirectory: string, uid: number): ActivationState {
  const statePath = safePathUnderDirectory(stateDirectory, "activation.json", "activation state", true);
  let parsed: unknown;
  try {
    const opened = openOwnedRegularFile(statePath, "activation state", uid, false);
    try {
      if ((opened.before.mode & 0o777) !== 0o400) {
        throw new KernelCompatLifecycleError("activation state must be a current-user-owned regular file with mode 0400");
      }
      if (opened.before.size > MAX_ACTIVATION_STATE_BYTES) {
        throw new KernelCompatLifecycleError("activation state exceeds the safe size limit");
      }
      parsed = JSON.parse(readFileSync(opened.fd, "utf8"));
      assertStableFile(opened.fd, opened.before, "activation state");
    } finally {
      closeSync(opened.fd);
    }
  } catch (error) {
    if (error instanceof KernelCompatLifecycleError) throw error;
    throw new KernelCompatLifecycleError("activation state is not valid JSON");
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== ACTIVATION_STATE_SCHEMA_VERSION) {
    throw new KernelCompatLifecycleError("activation state schema is unsupported");
  }
  const currentArtifactId = requireArtifactIdValue(parsed.currentArtifactId, "activation current artifact id");
  const previousArtifactId = parsed.previousArtifactId === undefined
    ? undefined
    : requireArtifactIdValue(parsed.previousArtifactId, "activation previous artifact id");
  const pinDigest = requireDigestValue(parsed.pinDigest, "activation pin digest");
  if (previousArtifactId === currentArtifactId) {
    throw new KernelCompatLifecycleError("activation state cannot use the same current and previous artifact");
  }
  return {
    schemaVersion: ACTIVATION_STATE_SCHEMA_VERSION,
    pinDigest,
    currentArtifactId,
    ...(previousArtifactId === undefined ? {} : { previousArtifactId })
  };
}

function releasePathFor(root: string, artifactId: string, uid: number): string {
  const releases = safePathUnderDirectory(root, RELEASES_DIRECTORY, "managed releases directory", true);
  assertRealDirectory(releases, "managed releases directory", uid, 0o700);
  const releasePath = safePathUnderDirectory(releases, requireArtifactId(artifactId), "prepared release", true);
  assertRealDirectory(releasePath, "prepared release", uid, 0o500);
  return releasePath;
}

function cleanupUnlocked(root: string, uid: number, options: CleanupOptions): CleanupResult {
  const removedArtifactIds: string[] = [];
  const removedStagingEntries: string[] = [];
  const removedActivationStateDirectories: string[] = [];
  const removedStaleLockQuarantineFiles: string[] = [];
  const skippedEntries: string[] = [];
  // Read without enforcing the current pin so stale builds still protect their live pair.
  const activeReference = readActiveStateReference(root, uid);
  const active = activeReference === undefined ? undefined : readActivationStateFile(activeReference.stateDirectory, uid);
  const protectedIds = new Set([active?.currentArtifactId, active?.previousArtifactId].filter((value): value is string => value !== undefined));
  const releases = safePathUnderDirectory(root, RELEASES_DIRECTORY, "managed releases directory", false);
  if (tryLstat(releases) !== undefined) {
    assertRealDirectory(releases, "managed releases directory", uid, 0o700);
    for (const entry of readdirSync(releases, { withFileTypes: true })) {
      if (!IDENTIFIER_PATTERN.test(entry.name)) {
        skippedEntries.push(`release:${entry.name}`);
        continue;
      }
      const candidate = path.join(releases, entry.name);
      const stat = lstatSync(candidate);
      if (!entry.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) {
        skippedEntries.push(`release:${entry.name}`);
        continue;
      }
      if (protectedIds.has(entry.name)) continue;
      if (!options.removeUnreferenced) {
        skippedEntries.push(`release:${entry.name}`);
        continue;
      }
      try {
        const receipt = readReceipt(candidate, uid);
        if (receipt.artifactId !== entry.name) throw new KernelCompatLifecycleError("artifact id mismatch");
        makeTreeWritableForRemoval(candidate, uid);
        rmSync(candidate, { recursive: true, force: false, maxRetries: 0 });
        removedArtifactIds.push(entry.name);
      } catch {
        skippedEntries.push(`release:${entry.name}`);
      }
    }
    fsyncDirectory(releases);
  }

  cleanupOrphanActivationStateDirectories(
    root,
    uid,
    activeReference?.stateId,
    removedActivationStateDirectories,
    skippedEntries
  );

  const staging = safePathUnderDirectory(root, STAGING_DIRECTORY, "staging directory", false);
  if (tryLstat(staging) !== undefined) {
    assertRealDirectory(staging, "staging directory", uid, 0o700);
    for (const entry of readdirSync(staging, { withFileTypes: true })) {
      if (!entry.name.startsWith("kernel-compat-stage-")) {
        skippedEntries.push(`staging:${entry.name}`);
        continue;
      }
      const candidate = path.join(staging, entry.name);
      const stat = lstatSync(candidate);
      if (!entry.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) {
        skippedEntries.push(`staging:${entry.name}`);
        continue;
      }
      try {
        makeTreeWritableForRemoval(candidate, uid);
        rmSync(candidate, { recursive: true, force: false, maxRetries: 0 });
        removedStagingEntries.push(entry.name);
      } catch {
        skippedEntries.push(`staging:${entry.name}`);
      }
    }
    fsyncDirectory(staging);
  }
  cleanupStaleLockQuarantineFiles(root, uid, removedStaleLockQuarantineFiles, skippedEntries);
  return {
    removedArtifactIds,
    removedStagingEntries,
    removedActivationStateDirectories,
    removedStaleLockQuarantineFiles,
    skippedEntries
  };
}

function cleanupOrphanActivationStateDirectories(
  root: string,
  uid: number,
  activeStateId: string | undefined,
  removed: string[],
  skippedEntries: string[]
): void {
  const states = safePathUnderDirectory(root, ACTIVATION_STATES_DIRECTORY, "activation states directory", false);
  if (tryLstat(states) === undefined) return;
  assertRealDirectory(states, "activation states directory", uid, 0o700);
  for (const entry of readdirSync(states, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name === activeStateId) continue;
    if (!MANAGED_ACTIVATION_STATE_PATTERN.test(entry.name)) {
      skippedEntries.push(`activation-state:${entry.name}`);
      continue;
    }
    const candidate = path.join(states, entry.name);
    const stat = lstatSync(candidate);
    if (!entry.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid) {
      skippedEntries.push(`activation-state:${entry.name}`);
      continue;
    }
    try {
      makeTreeWritableForRemoval(candidate, uid);
      rmSync(candidate, { recursive: true, force: false, maxRetries: 0 });
      removed.push(entry.name);
    } catch {
      skippedEntries.push(`activation-state:${entry.name}`);
    }
  }
  fsyncDirectory(states);
}

function cleanupStaleLockQuarantineFiles(
  root: string,
  uid: number,
  removed: string[],
  skippedEntries: string[]
): void {
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    if (!STALE_LOCK_QUARANTINE_PATTERN.test(entry.name)) continue;
    const candidate = path.join(root, entry.name);
    const stat = lstatSync(candidate);
    if (!entry.isFile() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o777) !== 0o600) {
      skippedEntries.push(`stale-lock:${entry.name}`);
      continue;
    }
    try {
      unlinkSync(candidate);
      removed.push(entry.name);
    } catch {
      skippedEntries.push(`stale-lock:${entry.name}`);
    }
  }
  if (removed.length > 0) fsyncDirectory(root);
}

function listSafeStagingEntries(root: string, uid: number, issues: string[]): string[] {
  try {
    const staging = safePathUnderDirectory(root, STAGING_DIRECTORY, "staging directory", false);
    if (tryLstat(staging) === undefined) return [];
    assertRealDirectory(staging, "staging directory", uid, 0o700);
    return readdirSync(staging, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("kernel-compat-stage-"))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    issues.push(`staging: ${messageFor(error)}`);
    return [];
  }
}

function removeDirectoryIfSafe(parent: string, directory: string, requiredPrefix: string, uid: number): void {
  try {
    if (path.dirname(directory) !== parent || !path.basename(directory).startsWith(requiredPrefix)) return;
    const stat = tryLstat(directory);
    if (stat !== undefined && stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === uid) {
      makeTreeWritableForRemoval(directory, uid);
      rmSync(directory, { recursive: true, force: false, maxRetries: 0 });
      fsyncDirectory(parent);
    }
  } catch {
    // Preserve a failed stage for explicit safe cleanup rather than hiding the primary result.
  }
}

function makeTreeWritableForRemoval(directory: string, uid: number): void {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink()) {
    if (stat.uid !== uid) throw new KernelCompatLifecycleError("cleanup target contains a foreign-owned symbolic link");
    return;
  }
  if (!stat.isDirectory() || stat.uid !== uid) {
    throw new KernelCompatLifecycleError("cleanup target is not a safe current-user-owned directory");
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    const child = lstatSync(candidate);
    if (child.uid !== uid) throw new KernelCompatLifecycleError("cleanup target contains a foreign-owned entry");
    if (child.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      makeTreeWritableForRemoval(candidate, uid);
    } else if (entry.isFile()) {
      chmodSync(candidate, 0o600);
    } else {
      throw new KernelCompatLifecycleError("cleanup target contains a special filesystem entry");
    }
  }
  chmodSync(directory, 0o700);
}

function fsyncFile(filePath: string): void {
  const fd = openSync(filePath, constants.O_RDONLY | requiredNoFollow() | CLOEXEC);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | DIRECTORY | requiredNoFollow() | CLOEXEC);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function tryLstat(filePath: string): Stats | undefined {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isNodeError(error) && error.code === "EEXIST";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "unknown kernel compatibility error";
}

function renderReleaseWrapperVerifier(expectedPinDigest: string): string {
  return [
    "#!/usr/bin/env node",
    "import { createHash } from 'node:crypto';",
    "import { lstatSync, readFileSync } from 'node:fs';",
    "import path from 'node:path';",
    `const EXPECTED_PIN_DIGEST = ${JSON.stringify(expectedPinDigest)};`,
    "const MAX_SMALL_FILE_BYTES = 16 * 1024 * 1024;",
    "function fail(message) { process.stderr.write('agy-acp kernel compatibility wrapper refused to run: ' + message + '\\n'); process.exit(1); }",
    "function safeRelative(value) { return typeof value === 'string' && value.length > 0 && !value.includes('\\0') && !value.includes('\\\\') && !path.isAbsolute(value) && path.posix.normalize(value) === value && !value.split('/').some((part) => part.length === 0 || part === '.' || part === '..'); }",
    "function safePath(root, relative, label) { if (!safeRelative(relative)) throw new Error(label + ' has an unsafe relative path'); const resolvedRoot = path.resolve(root); let cursor = resolvedRoot; for (const part of relative.split('/')) { cursor = path.join(cursor, part); const stat = lstatSync(cursor); if (stat.isSymbolicLink()) throw new Error(label + ' traverses a symbolic link'); if (cursor !== path.resolve(resolvedRoot, relative) && !stat.isDirectory()) throw new Error(label + ' has a non-directory parent'); } return cursor; }",
    "function ownedFile(filePath, label, uid, executable, exactMode) { const stat = lstatSync(filePath); if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== uid || (stat.mode & 0o022) !== 0) throw new Error(label + ' is not a safe current-user-owned regular file'); if (executable && (stat.mode & 0o111) === 0) throw new Error(label + ' is not executable'); if (exactMode !== undefined && (stat.mode & 0o777) !== exactMode) throw new Error(label + ' has unsafe permissions'); return stat; }",
    "function smallDigest(filePath, label, uid, executable) { const stat = ownedFile(filePath, label, uid, executable); if (stat.size > MAX_SMALL_FILE_BYTES) throw new Error(label + ' exceeds the small-file limit'); return { sha256: createHash('sha256').update(readFileSync(filePath)).digest('hex'), bytes: stat.size }; }",
    "function sameDigest(actual, expected, label) { if (!expected || typeof expected.sha256 !== 'string' || !Number.isSafeInteger(expected.bytes) || actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw new Error(label + ' postimage does not match the receipt'); }",
    "function main() { const uid = typeof process.getuid === 'function' ? process.getuid() : undefined; if (uid === undefined || uid === 0) throw new Error('root or non-POSIX execution is refused'); const release = path.resolve(process.argv[2] ?? ''); const releaseStat = lstatSync(release); if (releaseStat.isSymbolicLink() || !releaseStat.isDirectory() || releaseStat.uid !== uid || (releaseStat.mode & 0o777) !== 0o500) throw new Error('release directory is unsafe'); const receiptPath = safePath(release, 'receipt.json', 'receipt'); const receiptStat = ownedFile(receiptPath, 'receipt', uid, false, 0o600); if (receiptStat.size > 64 * 1024) throw new Error('receipt exceeds the safe size limit'); const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')); if (receipt.schemaVersion !== 2 || receipt.pinDigest !== EXPECTED_PIN_DIGEST) throw new Error('receipt is stale or invalid'); if (!receipt.layout || receipt.layout.runfilesRelativePath !== 'agy_acp_server.runfiles' || receipt.layout.kernelExecutableRelativePath !== 'agy_acp_server' || receipt.layout.externalHarnessRelativePath !== 'localharness_external' || !receipt.postimages || !receipt.wrapper) throw new Error('receipt layout is invalid'); const runfiles = safePath(release, receipt.layout.runfilesRelativePath, 'runfiles'); const runfilesStat = lstatSync(runfiles); if (runfilesStat.isSymbolicLink() || !runfilesStat.isDirectory() || runfilesStat.uid !== uid || (runfilesStat.mode & 0o777) !== 0o500) throw new Error('runfiles directory is unsafe'); for (const name of ['modelSelection', 'proxyServer', 'serverControl', 'compatModule']) { const postimage = receipt.postimages[name]; if (!postimage || !safeRelative(postimage.relativePath)) throw new Error(name + ' receipt postimage is invalid'); sameDigest(smallDigest(safePath(runfiles, postimage.relativePath, name), name, uid, false), postimage, name); } const wrapper = safePath(release, receipt.wrapper.relativePath, 'wrapper'); sameDigest(smallDigest(wrapper, 'wrapper', uid, true), { sha256: receipt.wrapper.sha256, bytes: receipt.wrapper.bytes }, 'wrapper'); const verifier = safePath(release, receipt.wrapper.verifierRelativePath, 'wrapper verifier'); sameDigest(smallDigest(verifier, 'wrapper verifier', uid, true), { sha256: receipt.wrapper.verifierSha256, bytes: receipt.wrapper.verifierBytes }, 'wrapper verifier'); ownedFile(safePath(release, 'agy_acp_server', 'kernel executable'), 'kernel executable', uid, true, 0o500); ownedFile(safePath(release, 'localharness_external', 'external harness'), 'external harness', uid, true, 0o500); for (const [name, relativePath] of Object.entries(receipt.layout.importerEnvironment ?? {})) { if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || !safeRelative(relativePath)) throw new Error('importer environment is invalid'); const importer = safePath(runfiles, relativePath, 'importer environment'); const importerStat = lstatSync(importer); if (importerStat.isSymbolicLink() || (!importerStat.isFile() && !importerStat.isDirectory()) || importerStat.uid !== uid) throw new Error('importer environment is unsafe'); } }",
    "try { main(); } catch (error) { fail(error instanceof Error ? error.message : 'verification failed'); }"
  ].join("\n") + "\n";
}

function renderReleaseWrapper(layout: KernelCompatLayout): string {
  const importerExports = Object.entries(layout.importerEnvironment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, relativePath]) => `export ${name}=\"$release_dir/${RUNFILES_DIRECTORY}/${shellPath(relativePath)}\"`);
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [ \"$(id -u)\" -eq 0 ]; then",
    "  printf '%s\\n' 'agy-acp kernel compatibility wrapper refuses root mode' >&2",
    "  exit 1",
    "fi",
    "release_dir=\"$(cd -- \"$(dirname -- \"${BASH_SOURCE[0]}\")\" && pwd -P)\"",
    `node \"$release_dir/${RELEASE_VERIFIER_FILE}\" \"$release_dir\"`,
    `export ANTIGRAVITY_HARNESS_PATH=\"$release_dir/${EXTERNAL_HARNESS_FILE}\"`,
    "export PYTHONDONTWRITEBYTECODE=1",
    `export PYTHONPATH=\"$release_dir/${RUNFILES_DIRECTORY}\${PYTHONPATH:+:$PYTHONPATH}\"`,
    ...importerExports,
    `exec \"$release_dir/${KERNEL_EXECUTABLE_FILE}\" \"--uid=\" \"$@\"`
  ].join("\n") + "\n";
}

function renderStableWrapper(): string {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "if [ \"$(id -u)\" -eq 0 ]; then",
    "  printf '%s\\n' 'agy-acp active compatibility wrapper refuses root mode' >&2",
    "  exit 1",
    "fi",
    "state_root=\"$(cd -- \"$(dirname -- \"${BASH_SOURCE[0]}\")\" && pwd -P)\"",
    `release_wrapper=\"$(node \"$state_root/${ACTIVE_RESOLVER_FILE}\" \"$state_root\")\"`,
    "exec \"$release_wrapper\" \"$@\""
  ].join("\n") + "\n";
}

function renderActiveResolver(expectedPinDigest: string): string {
  return [
    "#!/usr/bin/env node",
    "import { lstatSync, readFileSync, readlinkSync } from 'node:fs';",
    "import path from 'node:path';",
    `const EXPECTED_PIN_DIGEST = ${JSON.stringify(expectedPinDigest)};`,
    "function fail(message) { process.stderr.write('agy-acp active compatibility wrapper refused to run: ' + message + '\\n'); process.exit(1); }",
    "function identifier(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value); }",
    "function ownedDirectory(filePath, label, uid, mode) { const stat = lstatSync(filePath); if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o777) !== mode) throw new Error(label + ' is unsafe'); }",
    "function ownedFile(filePath, label, uid, mode, executable) { const stat = lstatSync(filePath); if (stat.isSymbolicLink() || !stat.isFile() || stat.uid !== uid || (stat.mode & 0o777) !== mode || (stat.mode & 0o022) !== 0 || (executable && (stat.mode & 0o111) === 0)) throw new Error(label + ' is unsafe'); }",
    "function safeChild(root, name, label) { if (!identifier(name)) throw new Error(label + ' is invalid'); const result = path.resolve(root, name); if (path.dirname(result) !== path.resolve(root)) throw new Error(label + ' escapes the state root'); return result; }",
    "function main() { const uid = typeof process.getuid === 'function' ? process.getuid() : undefined; if (uid === undefined || uid === 0) throw new Error('root or non-POSIX execution is refused'); const root = path.resolve(process.argv[2] ?? ''); ownedDirectory(root, 'state root', uid, 0o700); const active = path.join(root, 'active'); const activeStat = lstatSync(active); if (!activeStat.isSymbolicLink() || activeStat.uid !== uid) throw new Error('active state reference is unsafe'); const target = readlinkSync(active); const prefix = 'activation-states/'; if (path.isAbsolute(target) || !target.startsWith(prefix) || target.slice(prefix.length).includes('/') || !identifier(target.slice(prefix.length))) throw new Error('active state reference escapes managed activation states'); const states = path.join(root, 'activation-states'); ownedDirectory(states, 'activation states directory', uid, 0o700); const stateDirectory = safeChild(states, target.slice(prefix.length), 'activation state'); ownedDirectory(stateDirectory, 'activation state', uid, 0o500); const statePath = path.join(stateDirectory, 'activation.json'); ownedFile(statePath, 'activation state', uid, 0o400, false); const stateStat = lstatSync(statePath); if (stateStat.size > 16 * 1024) throw new Error('activation state exceeds the safe size limit'); const state = JSON.parse(readFileSync(statePath, 'utf8')); if (!state || state.schemaVersion !== 1 || state.pinDigest !== EXPECTED_PIN_DIGEST || !identifier(state.currentArtifactId) || (state.previousArtifactId !== undefined && !identifier(state.previousArtifactId))) throw new Error('activation state is stale or invalid'); const releases = path.join(root, 'releases'); ownedDirectory(releases, 'releases directory', uid, 0o700); const release = safeChild(releases, state.currentArtifactId, 'current release'); ownedDirectory(release, 'current release', uid, 0o500); const wrapper = path.join(release, 'agy-acp-kernel-compat'); ownedFile(wrapper, 'current release wrapper', uid, 0o500, true); process.stdout.write(wrapper + '\\n'); }",
    "try { main(); } catch (error) { fail(error instanceof Error ? error.message : 'resolution failed'); }"
  ].join("\n") + "\n";
}

function shellPath(relativePath: string): string {
  assertSafeRelativePath("wrapper path", relativePath);
  return relativePath;
}
