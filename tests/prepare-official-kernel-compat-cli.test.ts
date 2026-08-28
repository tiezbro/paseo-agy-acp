import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const sourceCli = path.join(repositoryRoot, "scripts", "prepare-official-kernel-compat.mjs");
const sourceRecipe = path.join(
  repositoryRoot,
  "dist",
  "ACP Connector",
  "official-kernel",
  "kernel-compat-rc01-recipe.js"
);
const sourceCompatModule = path.join(
  repositoryRoot,
  "assets",
  "official-kernel-compat",
  "rc01",
  "paseo_model_compat.py"
);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("prepare official kernel compatibility CLI", () => {
  it("prints help without loading a lifecycle module", () => {
    const result = runCli(sourceCli, ["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "usage: agy-acp-prepare-official-kernel-compat <prepare|verify|activate|rollback|status|cleanup> [options]\n"
    );
    expect(result.stderr).toBe("");
  });

  it("reports a missing state root without creating it", () => {
    const root = createTemporaryRoot();
    const absentRoot = path.join(root, "missing-state-root");
    const result = runCli(sourceCli, ["status", "--state-root", absentRoot]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      stateRoot: absentRoot,
      rootExists: false,
      rootSecure: false,
      stagingEntries: [],
      issues: []
    });
    expect(existsSync(absentRoot)).toBe(false);
  });

  it.each([
    [["status", "--unknown"], "unknown option --unknown"],
    [["status", "--state-root", "/one", "--state-root", "/two"], "--state-root may be provided once"],
    [["prepare", "--activate", "--activate"], "--activate may be provided once"],
    [["status", "--state-root"], "--state-root requires a value"],
    [["prepare", "--par"], "--par requires a value"]
  ] as const)("keeps parser failures deterministic for %j", (args, message) => {
    const result = runCli(sourceCli, args);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`agy-acp kernel compatibility lifecycle failed: ${message}\n`);
  });

  it("uses packaged RC01 defaults and stages the bundled Python module privately", () => {
    const fixture = createPackageFixture();
    const observationPath = path.join(fixture.root, "observation.json");
    const stateRoot = path.join(fixture.root, "state");
    const result = runCli(fixture.cliPath, ["prepare", "--state-root", stateRoot], {
      AGY_ACP_P3_OBSERVATION_PATH: observationPath
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ prepared: { artifactId: "p3-fake", reused: false } });
    const observation = readObservation(observationPath);
    expect(observation.stateRoot).toBe(stateRoot);
    expect(observation.options.parPath).toBe(path.join(
      os.homedir(),
      ".local",
      "opt",
      "agy-acp-server-agy_acp_server_20260818_01_RC01",
      "agy_acp_server.par"
    ));
    expect(observation.options.externalHarnessPath).toBe(path.join(
      os.homedir(),
      ".local",
      "opt",
      "agy-acp-server-agy_acp_server_20260818_01_RC01",
      "localharness_external"
    ));
    expect(observation.compatibilityModule.mode).toBe(0o400);
    expect(observation.compatibilityModule.directoryMode).toBe(0o700);
    expect(observation.compatibilityModule.content).toBe(readFileSync(sourceCompatModule, "utf8"));
    expect(observation.options.patchPlan.edits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "rc01-model-selection-catalog",
        find: "if not ccpa_id.startswith(\"gemini\"):",
        replacement: "if not is_catalog_model(ccpa_id):"
      }),
      expect.objectContaining({
        id: "rc01-proxy-server-transform",
        find: "    model = match.group(1)\n",
        replacement:
          "    model = match.group(1)\n" +
          "    incoming_json = transform_request(model, incoming_json)\n"
      })
    ]));
    expect(existsSync(observation.compatibilityModule.path)).toBe(false);
    expect(existsSync(observation.compatibilityModule.directory)).toBe(false);
  });

  it("cleans the private compatibility staging directory when prepare fails", () => {
    const fixture = createPackageFixture();
    const observationPath = path.join(fixture.root, "failed-observation.json");
    const result = runCli(fixture.cliPath, ["prepare", "--state-root", path.join(fixture.root, "state")], {
      AGY_ACP_P3_OBSERVATION_PATH: observationPath,
      AGY_ACP_P3_FAIL_PREPARE: "1"
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("agy-acp kernel compatibility lifecycle failed: P3 test prepare failure\n");
    const observation = readObservation(observationPath);
    expect(existsSync(observation.compatibilityModule.path)).toBe(false);
    expect(existsSync(observation.compatibilityModule.directory)).toBe(false);
  });

  it("accepts safe absolute module and patch overrides, then rejects unsafe override paths", () => {
    const fixture = createPackageFixture();
    const observationPath = path.join(fixture.root, "override-observation.json");
    const customModule = path.join(fixture.root, "custom-compat.py");
    const customPlan = path.join(fixture.root, "custom-plan.json");
    writeFileSync(customModule, "CUSTOM_COMPAT = True\n", { mode: 0o400 });
    chmodSync(customModule, 0o400);
    writeFileSync(customPlan, JSON.stringify({ edits: [{ id: "custom", target: "modelSelection" }] }), { mode: 0o400 });
    chmodSync(customPlan, 0o400);

    const successful = runCli(fixture.cliPath, [
      "prepare",
      "--state-root", path.join(fixture.root, "state"),
      "--compat-module", customModule,
      "--patch-plan", customPlan,
      "--par", "/opt/custom/agy_acp_server.par",
      "--external-harness", "/opt/custom/localharness_external"
    ], { AGY_ACP_P3_OBSERVATION_PATH: observationPath });

    expect(successful.status).toBe(0);
    const observation = readObservation(observationPath);
    expect(observation.compatibilityModule.content).toBe("CUSTOM_COMPAT = True\n");
    expect(observation.options.patchPlan).toEqual({ edits: [{ id: "custom", target: "modelSelection" }] });
    expect(observation.options.parPath).toBe("/opt/custom/agy_acp_server.par");
    expect(observation.options.externalHarnessPath).toBe("/opt/custom/localharness_external");

    const unsafeModule = path.join(fixture.root, "unsafe-compat.py");
    writeFileSync(unsafeModule, "UNSAFE = True\n", { mode: 0o664 });
    chmodSync(unsafeModule, 0o664);
    const rejectedModule = runCli(fixture.cliPath, [
      "prepare",
      "--state-root", path.join(fixture.root, "other-state"),
      "--compat-module", unsafeModule
    ], { AGY_ACP_P3_OBSERVATION_PATH: observationPath });
    expect(rejectedModule.status).toBe(1);
    expect(rejectedModule.stderr).toBe(
      "agy-acp kernel compatibility lifecycle failed: compatibility module override must not be group- or world-writable\n"
    );

    const linkedPlan = path.join(fixture.root, "linked-plan.json");
    symlinkSync(customPlan, linkedPlan);
    const rejectedPlan = runCli(fixture.cliPath, [
      "prepare",
      "--state-root", path.join(fixture.root, "third-state"),
      "--patch-plan", linkedPlan
    ], { AGY_ACP_P3_OBSERVATION_PATH: observationPath });
    expect(rejectedPlan.status).toBe(1);
    expect(rejectedPlan.stderr).toBe(
      "agy-acp kernel compatibility lifecycle failed: patch plan must not traverse a symbolic link\n"
    );
  });

  it("reports a missing packaged lifecycle module before performing a lifecycle operation", () => {
    const root = createTemporaryRoot();
    const scripts = path.join(root, "scripts");
    mkdirSync(scripts, { recursive: true, mode: 0o700 });
    const copiedCli = path.join(scripts, "prepare-official-kernel-compat.mjs");
    copyFileSync(sourceCli, copiedCli);

    const result = runCli(copiedCli, ["status", "--state-root", path.join(root, "state")]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "agy-acp kernel compatibility lifecycle failed: built lifecycle module is missing; run npm run build before invoking this command\n"
    );
  });
});

function createPackageFixture(): { root: string; cliPath: string } {
  const root = createTemporaryRoot();
  const scriptsDirectory = path.join(root, "scripts");
  const lifecycleDirectory = path.join(root, "dist", "ACP Connector", "official-kernel");
  const assetDirectory = path.join(root, "assets", "official-kernel-compat", "rc01");
  mkdirSync(scriptsDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(lifecycleDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(assetDirectory, { recursive: true, mode: 0o700 });
  const cliPath = path.join(scriptsDirectory, "prepare-official-kernel-compat.mjs");
  copyFileSync(sourceCli, cliPath);
  copyFileSync(sourceRecipe, path.join(lifecycleDirectory, "kernel-compat-rc01-recipe.js"));
  writeFileSync(path.join(lifecycleDirectory, "kernel-compat-lifecycle.js"), FAKE_LIFECYCLE_MODULE, { mode: 0o400 });
  const packagedCompat = path.join(assetDirectory, "paseo_model_compat.py");
  copyFileSync(sourceCompatModule, packagedCompat);
  chmodSync(packagedCompat, 0o664);
  return { root, cliPath };
}

function createTemporaryRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-acp-p3-"));
  temporaryRoots.push(root);
  return root;
}

function runCli(cliPath: string, args: readonly string[], environment: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...environment }
  });
}

function readObservation(observationPath: string): {
  stateRoot: string;
  options: {
    parPath: string;
    externalHarnessPath: string;
    compatModulePath: string;
    patchPlan: { edits: unknown[] };
  };
  compatibilityModule: { path: string; directory: string; mode: number; directoryMode: number; content: string };
} {
  return JSON.parse(readFileSync(observationPath, "utf8")) as {
    stateRoot: string;
    options: {
      parPath: string;
      externalHarnessPath: string;
      compatModulePath: string;
      patchPlan: { edits: unknown[] };
    };
    compatibilityModule: { path: string; directory: string; mode: number; directoryMode: number; content: string };
  };
}

const FAKE_LIFECYCLE_MODULE = String.raw`
import { lstatSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export class OfficialKernelCompatLifecycle {
  constructor(options) {
    this.stateRoot = options.stateRoot;
  }

  async prepare(options) {
    const observationPath = process.env.AGY_ACP_P3_OBSERVATION_PATH;
    if (!observationPath) throw new Error("P3 test observation path is required");
    const compatibilityModule = lstatSync(options.compatModulePath);
    const directory = path.dirname(options.compatModulePath);
    const directoryStat = statSync(directory);
    writeFileSync(observationPath, JSON.stringify({
      stateRoot: this.stateRoot,
      options,
      compatibilityModule: {
        path: options.compatModulePath,
        directory,
        mode: compatibilityModule.mode & 0o777,
        directoryMode: directoryStat.mode & 0o777,
        content: readFileSync(options.compatModulePath, "utf8")
      }
    }));
    if (process.env.AGY_ACP_P3_FAIL_PREPARE === "1") throw new Error("P3 test prepare failure");
    return { artifactId: "p3-fake", reused: false };
  }

  async activate(artifactId) {
    return { changed: true, currentArtifactId: artifactId };
  }

  async verify() {
    return { artifactId: "p3-fake" };
  }

  async rollback() {
    return { changed: false, currentArtifactId: "p3-fake" };
  }

  async status() {
    return { stateRoot: this.stateRoot, rootExists: false, rootSecure: false, stagingEntries: [], issues: [] };
  }

  async cleanup() {
    return { removedArtifactIds: [], removedStagingEntries: [], removedActivationStateDirectories: [], removedStaleLockQuarantineFiles: [], skippedEntries: [] };
  }
}
`;
