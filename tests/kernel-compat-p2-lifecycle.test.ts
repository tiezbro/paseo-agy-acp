import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  KernelCompatLifecycleError,
  OfficialKernelCompatLifecycle,
  type KernelCompatLifecycleHooks,
  type KernelCompatPatchPlan
} from "../ACP Connector/official-kernel/kernel-compat-lifecycle.js";
import { PRODUCTION_KERNEL_COMPAT_PINS, type KernelCompatPins } from "../ACP Connector/official-kernel/kernel-compat-pins.js";
import {
  createKernelCompatP2Fixture,
  currentP2ProcessStartTime,
  removeKernelCompatP2Fixture,
  writeP2CompatModule,
  writeP2LifecycleLock,
  writeP2MalformedLifecycleLock,
  type KernelCompatP2Fixture
} from "./kernel-compat-p2-fixture.js";

const ACP_SERVER_DIRECTORY = "google3/cloud/developer_experience/antigravity_extensions/acp_server";
const RUNFILES_DIRECTORY = "agy_acp_server.runfiles";
const fixtures: KernelCompatP2Fixture[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) removeKernelCompatP2Fixture(fixture);
});

function fixture(options?: Parameters<typeof createKernelCompatP2Fixture>[0]): KernelCompatP2Fixture {
  const created = createKernelCompatP2Fixture(options);
  fixtures.push(created);
  return created;
}

function lifecycleFor(
  created: KernelCompatP2Fixture,
  pins: KernelCompatPins = created.pins,
  hooks?: KernelCompatLifecycleHooks,
  clock?: () => Date
): OfficialKernelCompatLifecycle {
  return new OfficialKernelCompatLifecycle({ stateRoot: created.stateRoot, pins, hooks, clock });
}

function runWrapper(wrapperPath: string, created: KernelCompatP2Fixture): ReturnType<typeof spawnSync> {
  return spawnSync(wrapperPath, ["--fixture"], {
    encoding: "utf8",
    env: { ...process.env, P2_KERNEL_OBSERVATION: created.observationPath }
  });
}

function observation(created: KernelCompatP2Fixture): {
  argv: string[];
  harness: string;
  noBytecode: string;
  pythonPath: string;
  binary: string;
} {
  return JSON.parse(readFileSync(created.observationPath, "utf8")) as {
    argv: string[];
    harness: string;
    noBytecode: string;
    pythonPath: string;
    binary: string;
  };
}

describe("P2 official kernel compatibility pins", () => {
  it("keeps the frozen RC01 hashes and real runfiles-relative target paths", () => {
    expect(PRODUCTION_KERNEL_COMPAT_PINS.parSha256).toBe("46b5925100903a23e0ec7da8b8a218c224494dfffeb3fd30fcd84e91acbc8b07");
    expect(PRODUCTION_KERNEL_COMPAT_PINS.externalHarnessSha256).toBe("8a8d8efc8dcf1f8cb87db6c932957ecf14684cd7d71ee5670b5515c16a685404");
    expect(PRODUCTION_KERNEL_COMPAT_PINS.targets.modelSelection).toMatchObject({
      relativePath: `${ACP_SERVER_DIRECTORY}/model_selection.py`,
      preimageSha256: "2dabcfcbb7e165cdd4fb73e05c08a8b01230837d818f39a0a13cd3cfbca87b71"
    });
    expect(PRODUCTION_KERNEL_COMPAT_PINS.targets.proxyServer).toMatchObject({
      relativePath: `${ACP_SERVER_DIRECTORY}/ccpa_connection/proxy_server.py`,
      preimageSha256: "e350a8c7bef2d9e3616c6980774527d100137275bec5da147781e87f587012de"
    });
    expect(PRODUCTION_KERNEL_COMPAT_PINS.targets.serverControl).toMatchObject({
      relativePath: `${ACP_SERVER_DIRECTORY}/server.py`,
      preimageSha256: "8ede74f3cec50e0a76796ef1af91840bab16b7ee36664a2499f07d3119013d7b",
      patchable: false
    });
  });
});

describe("P2 official kernel compatibility lifecycle", () => {
  it("prepares the adjacent binary/runfiles layout, preserves the verified main link, and is idempotent", async () => {
    const created = fixture();
    const lifecycle = lifecycleFor(created);
    const prepared = await lifecycle.prepare(created.prepareOptions);
    const runfiles = path.join(prepared.releasePath, RUNFILES_DIRECTORY);
    const receiptText = readFileSync(prepared.receiptPath, "utf8");
    const receipt = JSON.parse(receiptText) as { postimages: Record<string, { sha256: string }> };

    expect(prepared.reused).toBe(false);
    expect(statSync(created.parPath).mode & 0o777).toBe(0o775);
    expect(statSync(created.externalHarnessPath).mode & 0o777).toBe(0o775);
    expect(statSync(prepared.receiptPath).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(prepared.releasePath, "agy_acp_server")).mode & 0o777).toBe(0o500);
    expect(statSync(path.join(prepared.releasePath, "localharness_external")).mode & 0o777).toBe(0o500);
    expect(readlinkSync(path.join(runfiles, ACP_SERVER_DIRECTORY, "main"))).toBe("../../../../../../agy_acp_server");
    expect(realpathSync(path.join(runfiles, ACP_SERVER_DIRECTORY, "main"))).toBe(path.join(prepared.releasePath, "agy_acp_server"));
    expect(readFileSync(path.join(runfiles, `${ACP_SERVER_DIRECTORY}/model_selection.py`), "utf8")).toContain("is_catalog_model(model_id)");
    expect(readFileSync(path.join(runfiles, `${ACP_SERVER_DIRECTORY}/ccpa_connection/proxy_server.py`), "utf8")).toContain("transform_request(model_id, body)");
    expect(receipt.postimages.serverControl.sha256).toBe(created.pins.targets.serverControl.preimageSha256);
    expect(receiptText).not.toContain(created.parPath);
    expect(receiptText).not.toContain(created.externalHarnessPath);
    expect(receiptText).not.toContain(created.compatModulePath);
    await expect(lifecycle.verify(prepared.artifactId)).resolves.toMatchObject({ artifactId: prepared.artifactId });

    const receiptStat = statSync(prepared.receiptPath);
    const repeated = await lifecycle.prepare(created.prepareOptions);
    expect(repeated).toMatchObject({ artifactId: prepared.artifactId, reused: true });
    expect(statSync(prepared.receiptPath).mtimeMs).toBe(receiptStat.mtimeMs);
    expect(readFileSync(prepared.receiptPath, "utf8")).toBe(receiptText);
  });

  it("uses the per-release wrapper for smoke and the stable activation wrapper for runtime with exact --uid=", async () => {
    const created = fixture();
    const lifecycle = lifecycleFor(created);
    const prepared = await lifecycle.prepare(created.prepareOptions);

    const smoke = runWrapper(prepared.wrapperPath, created);
    expect(smoke.status, String(smoke.stderr ?? "")).toBe(0);
    expect(observation(created)).toMatchObject({
      argv: ["--uid=", "--fixture"],
      harness: path.join(prepared.releasePath, "localharness_external"),
      binary: path.join(prepared.releasePath, "agy_acp_server"),
      noBytecode: "1"
    });
    expect(observation(created).pythonPath).toContain(path.join(prepared.releasePath, RUNFILES_DIRECTORY));

    rmSync(created.observationPath, { force: true });
    const activated = await lifecycle.activate(prepared.artifactId);
    expect(activated.wrapperPath).toBe(prepared.stableWrapperPath);
    expect(runWrapper(prepared.stableWrapperPath, created).status).toBe(0);
    expect(observation(created).argv).toEqual(["--uid=", "--fixture"]);

    const patchedSource = path.join(prepared.releasePath, RUNFILES_DIRECTORY, `${ACP_SERVER_DIRECTORY}/model_selection.py`);
    chmodSync(patchedSource, 0o600);
    writeFileSync(patchedSource, "tampered\n", { mode: 0o400 });
    chmodSync(patchedSource, 0o400);
    rmSync(created.observationPath, { force: true });
    const rejected = runWrapper(prepared.wrapperPath, created);
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain("postimage does not match the receipt");
    expect(existsSync(created.observationPath)).toBe(false);
  });

  it.each(["absolute", "escape", "broken", "chained"] as const)("rejects an unsafe %s runfiles symlink", async (unsafeSymlink) => {
    const created = fixture({ unsafeSymlink });
    await expect(lifecycleFor(created).prepare(created.prepareOptions)).rejects.toThrow(/symbolic link|release root|broken|unsafe/i);
    expect(readdirSync(path.join(created.stateRoot, "releases"))).toEqual([]);
  });

  it("commits one activation state atomically and keeps the stable wrapper coherent across injected failures", async () => {
    const created = fixture();
    const base = lifecycleFor(created);
    const first = await base.prepare(created.prepareOptions);
    await base.activate(first.artifactId);
    writeP2CompatModule(created, "P2 compatibility module fixture v2\n");
    const second = await base.prepare(created.prepareOptions);

    const beforeCommit = lifecycleFor(created, created.pins, {
      beforeActivationCommit: () => {
        throw new Error("injected before activation commit");
      }
    });
    await expect(beforeCommit.activate(second.artifactId)).rejects.toThrow("injected before activation commit");
    expect((await base.status()).current?.artifactId).toBe(first.artifactId);
    const oldRuntime = runWrapper(first.stableWrapperPath, created);
    expect(oldRuntime.status, String(oldRuntime.stderr ?? "")).toBe(0);
    expect(observation(created).binary).toBe(path.join(first.releasePath, "agy_acp_server"));

    const afterCommit = lifecycleFor(created, created.pins, {
      afterActivationCommit: () => {
        throw new Error("injected after activation commit");
      }
    });
    await expect(afterCommit.activate(second.artifactId)).rejects.toThrow("injected after activation commit");
    const status = await base.status();
    expect(status).toMatchObject({
      current: { artifactId: second.artifactId, verified: true },
      previous: { artifactId: first.artifactId, verified: true }
    });
    expect(readlinkSync(path.join(created.stateRoot, "active"))).toMatch(/^activation-states\//);
    rmSync(created.observationPath, { force: true });
    expect(runWrapper(first.stableWrapperPath, created).status).toBe(0);
    expect(observation(created).binary).toBe(path.join(second.releasePath, "agy_acp_server"));
    expect(existsSync(path.join(created.stateRoot, "current"))).toBe(false);
    expect(existsSync(path.join(created.stateRoot, "previous"))).toBe(false);
  });

  it("rolls back by committing a new complete activation state", async () => {
    const created = fixture();
    const lifecycle = lifecycleFor(created);
    const first = await lifecycle.prepare(created.prepareOptions);
    await lifecycle.activate(first.artifactId);
    writeP2CompatModule(created, "P2 compatibility module fixture v2\n");
    const second = await lifecycle.prepare(created.prepareOptions);
    await lifecycle.activate(second.artifactId);

    const rollback = await lifecycle.rollback();
    expect(rollback).toMatchObject({ currentArtifactId: first.artifactId, previousArtifactId: second.artifactId });
    await expect(lifecycle.status()).resolves.toMatchObject({
      current: { artifactId: first.artifactId, verified: true },
      previous: { artifactId: second.artifactId, verified: true }
    });
  });

  it("refuses partial unpack, marker mismatches, hash mismatches, and overlarge patch plans before publication", async () => {
    const partial = fixture({ partialUnpack: true });
    await expect(lifecycleFor(partial).prepare(partial.prepareOptions)).rejects.toThrow(/proxyServer source is missing/);
    expect(readdirSync(path.join(partial.stateRoot, "releases"))).toEqual([]);

    const markerMismatch = fixture();
    const badPatchPlan: KernelCompatPatchPlan = {
      edits: markerMismatch.patchPlan.edits.map((edit, index) => index === 0
        ? { ...edit, find: "NOT_PRESENT_EXACT_MARKER" }
        : edit)
    };
    await expect(lifecycleFor(markerMismatch).prepare({ ...markerMismatch.prepareOptions, patchPlan: badPatchPlan }))
      .rejects.toThrow(/model-import.*exactly once; found 0/);

    const hashMismatch = fixture();
    chmodSync(hashMismatch.externalHarnessPath, 0o700);
    writeFileSync(hashMismatch.externalHarnessPath, "#!/usr/bin/env bash\nexit 1\n", { mode: 0o500 });
    chmodSync(hashMismatch.externalHarnessPath, 0o500);
    await expect(lifecycleFor(hashMismatch).prepare(hashMismatch.prepareOptions)).rejects.toThrow(/external harness hash/);

    const tooLarge = fixture();
    const largePlan: KernelCompatPatchPlan = {
      edits: tooLarge.patchPlan.edits.map((edit, index) => index === 0
        ? { ...edit, find: "x".repeat(65 * 1024) }
        : edit)
    };
    await expect(lifecycleFor(tooLarge).prepare({ ...tooLarge.prepareOptions, patchPlan: largePlan }))
      .rejects.toThrow(/byte limit/);

    const tooMany = fixture();
    await expect(lifecycleFor(tooMany).prepare({
      ...tooMany.prepareOptions,
      patchPlan: { edits: Array.from({ length: 17 }, () => tooMany.patchPlan.edits[0]) }
    })).rejects.toThrow(/edit count/);

    const nonExecutableHarness = fixture();
    chmodSync(nonExecutableHarness.externalHarnessPath, 0o400);
    await expect(lifecycleFor(nonExecutableHarness).prepare(nonExecutableHarness.prepareOptions))
      .rejects.toThrow(/external harness must be executable/);
  });

  it("rejects unsafe inputs and state roots before unpacking", async () => {
    const insecureRoot = fixture();
    mkdirSync(insecureRoot.stateRoot, { mode: 0o700 });
    chmodSync(insecureRoot.stateRoot, 0o755);
    await expect(lifecycleFor(insecureRoot).prepare(insecureRoot.prepareOptions)).rejects.toThrow(/mode 0700/);

    const linkedInput = fixture();
    const parLink = path.join(linkedInput.root, "official-par-link");
    symlinkSync(linkedInput.parPath, parLink);
    await expect(lifecycleFor(linkedInput).prepare({ ...linkedInput.prepareOptions, parPath: parLink })).rejects.toThrow(/symbolic link/);

    const worldWritableInput = fixture();
    chmodSync(worldWritableInput.parPath, 0o777);
    await expect(lifecycleFor(worldWritableInput).prepare(worldWritableInput.prepareOptions)).rejects.toThrow(/world-writable/);
  });

  it("refuses stale pins, preserves active releases, and cleans only orphaned lifecycle state", async () => {
    const created = fixture();
    const lifecycle = lifecycleFor(created);
    const first = await lifecycle.prepare(created.prepareOptions);
    await lifecycle.activate(first.artifactId);
    writeP2CompatModule(created, "P2 compatibility module fixture v2\n");
    const second = await lifecycle.prepare(created.prepareOptions);
    await lifecycle.activate(second.artifactId);
    writeP2CompatModule(created, "P2 compatibility module fixture v3\n");
    const third = await lifecycle.prepare(created.prepareOptions);

    const activationStates = path.join(created.stateRoot, "activation-states");
    const activeState = readlinkSync(path.join(created.stateRoot, "active")).replace("activation-states/", "");
    const orphanedState = readdirSync(activationStates).filter((entry) => entry !== activeState && entry.startsWith("activation-"));
    expect(orphanedState).toHaveLength(1);

    const defaultCleanup = await lifecycle.cleanup();
    expect(defaultCleanup.removedArtifactIds).toEqual([]);
    expect(defaultCleanup.removedActivationStateDirectories).toEqual(orphanedState);
    expect(readdirSync(activationStates)).toEqual([activeState]);
    const cleanup = await lifecycle.cleanup({ removeUnreferenced: true });
    expect(cleanup.removedArtifactIds).toEqual([third.artifactId]);
    expect(existsSync(first.releasePath)).toBe(true);
    expect(existsSync(second.releasePath)).toBe(true);

    const stalePins: KernelCompatPins = {
      ...created.pins,
      targets: {
        ...created.pins.targets,
        serverControl: { ...created.pins.targets.serverControl, preimageSha256: "f".repeat(64) }
      }
    };
    await expect(lifecycleFor(created, stalePins).verify(second.artifactId)).rejects.toThrow(/stale or unknown/);
  });

  it("blocks an active lock and safely quarantines dead or PID-reused lock receipts", async () => {
    const active = fixture();
    const activeLock = writeP2LifecycleLock(active, { pid: process.pid, procStartTime: currentP2ProcessStartTime() });
    await expect(lifecycleFor(active).prepare(active.prepareOptions)).rejects.toThrow(/already running/);
    expect(readFileSync(activeLock, "utf8")).toContain(`\"pid\":${process.pid}`);

    const dead = fixture();
    writeP2LifecycleLock(dead, { pid: 999_999_999, procStartTime: "1" });
    await expect(lifecycleFor(dead).prepare(dead.prepareOptions)).resolves.toMatchObject({ reused: false });
    expect(readdirSync(dead.stateRoot).some((entry) => entry.startsWith(".kernel-compat.lock.stale-"))).toBe(true);
    await expect(lifecycleFor(dead).cleanup()).resolves.toMatchObject({
      removedStaleLockQuarantineFiles: [expect.stringMatching(/^\.kernel-compat\.lock\.stale-/)]
    });
    expect(readdirSync(dead.stateRoot).some((entry) => entry.startsWith(".kernel-compat.lock.stale-"))).toBe(false);

    const reused = fixture();
    writeP2LifecycleLock(reused, { pid: process.pid, procStartTime: "0" });
    await expect(lifecycleFor(reused).status()).resolves.toMatchObject({ rootExists: true, rootSecure: true });
    await expect(lifecycleFor(reused).cleanup()).resolves.toMatchObject({
      removedArtifactIds: [],
      removedStaleLockQuarantineFiles: [expect.stringMatching(/^\.kernel-compat\.lock\.stale-/)]
    });
    expect(readdirSync(reused.stateRoot).some((entry) => entry.startsWith(".kernel-compat.lock.stale-"))).toBe(false);
  });

  it("treats a young incomplete lock as active but quarantines an old malformed lock", async () => {
    const now = new Date();
    const clock = () => new Date(now.getTime());

    const young = fixture();
    const youngLock = writeP2MalformedLifecycleLock(young, "", now);
    await expect(lifecycleFor(young, young.pins, undefined, clock).prepare(young.prepareOptions))
      .rejects.toThrow(/incomplete/);
    expect(readFileSync(youngLock, "utf8")).toBe("");
    expect(readdirSync(young.stateRoot).some((entry) => entry.startsWith(".kernel-compat.lock.stale-"))).toBe(false);

    const unreadable = fixture();
    const unreadableLock = writeP2MalformedLifecycleLock(unreadable, "{}\n", now);
    chmodSync(unreadableLock, 0o000);
    await expect(lifecycleFor(unreadable, unreadable.pins, undefined, clock).prepare(unreadable.prepareOptions))
      .rejects.toThrow(/incomplete/);
    expect(readdirSync(unreadable.stateRoot).some((entry) => entry.startsWith(".kernel-compat.lock.stale-"))).toBe(false);

    const old = fixture();
    writeP2MalformedLifecycleLock(old, "{not-json}\n", new Date(now.getTime() - 31_000));
    await expect(lifecycleFor(old, old.pins, undefined, clock).prepare(old.prepareOptions))
      .resolves.toMatchObject({ reused: false });
    expect(readdirSync(old.stateRoot).some((entry) => entry.startsWith(".kernel-compat.lock.stale-"))).toBe(true);
  });
});
