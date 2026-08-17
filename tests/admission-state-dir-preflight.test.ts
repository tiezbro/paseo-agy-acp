import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const preflightScript = path.join(repositoryRoot, "scripts/prepare-admission-state-dir.mjs");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Admission state directory preflight", () => {
  it("creates a missing state directory with exact owner-only permissions", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agy-acp-state-preflight-"));
    temporaryRoots.push(root);
    const stateDir = path.join(root, "account", "state");

    const result = spawnSync(process.execPath, [preflightScript, stateDir], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("admission state directory ready");
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
  });

  it.skipIf(process.platform === "win32")("rejects an existing permissive directory without changing it", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "agy-acp-state-preflight-"));
    temporaryRoots.push(root);
    const stateDir = path.join(root, "state");
    mkdirSync(stateDir, { mode: 0o700 });
    chmodSync(stateDir, 0o775);

    const result = spawnSync(process.execPath, [preflightScript, stateDir], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });

    expect(result.status).toBe(1);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("mode is 0775; expected 0700");
    expect(statSync(stateDir).mode & 0o777).toBe(0o775);
  });

  it("is exposed by the published package manifest", () => {
    const packageJson = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
      files?: string[];
    };

    expect(packageJson.bin?.["agy-acp-prepare-state"]).toBe("scripts/prepare-admission-state-dir.mjs");
    expect(packageJson.files).toContain("scripts/prepare-admission-state-dir.mjs");
  });
});
