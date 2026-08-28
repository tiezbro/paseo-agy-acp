import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

describe("published package content", () => {
  it("contains the P3 CLI and self-owned assets without kernel artifacts", () => {
    const manifest = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8")) as {
      bin?: Record<string, string>;
    };
    expect(manifest.bin?.["agy-acp-prepare-official-kernel-compat"]).toBe(
      "scripts/prepare-official-kernel-compat.mjs"
    );

    const packedPaths = npmPackDryRunPaths();
    expect(packedPaths).toEqual(expect.arrayContaining([
      "scripts/prepare-official-kernel-compat.mjs",
      "assets/official-kernel-compat/rc01/paseo_model_compat.py",
      "dist/ACP Connector/official-kernel/kernel-compat-lifecycle.js",
      "dist/ACP Connector/official-kernel/kernel-compat-pins.js",
      "dist/ACP Connector/official-kernel/kernel-compat-rc01-recipe.js"
    ]));

    const prohibited = packedPaths.filter((entry) => (
      /(^|\/)[^/]*\.par$/i.test(entry) ||
      /(^|\/)[^/]*\.elf$/i.test(entry) ||
      /(^|\/)localharness_external(?:\/|$)/i.test(entry) ||
      /(^|\/)[^/]*\.runfiles(?:\/|$)/i.test(entry) ||
      /(^|\/)receipt(?:\.json)?$/i.test(entry) ||
      /(^|\/)[^/]*token[^/]*$/i.test(entry) ||
      /(^|\/)tmp(?:\/|$)/i.test(entry) ||
      /(^|\/)[^/]*probe[^/]*$/i.test(entry) ||
      /(^|\/)[^/]*proprietary[^/]*$/i.test(entry)
    ));
    expect(prohibited).toEqual([]);

    const allowed = packedPaths.filter((entry) => !isExpectedPublishedPath(entry));
    expect(allowed).toEqual([]);
  });
});

function npmPackDryRunPaths(): string[] {
  const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, npm_config_color: "false" }
  });
  expect(result.status).toBe(0);
  const payload = JSON.parse(result.stdout) as Array<{ files?: Array<{ path: string }> }>;
  expect(payload).toHaveLength(1);
  expect(payload[0].files).toBeDefined();
  return payload[0].files?.map((file) => file.path).sort() ?? [];
}

function isExpectedPublishedPath(entry: string): boolean {
  return entry === "package.json" ||
    entry === "README.md" ||
    entry === "README.zh-CN.md" ||
    entry === "CHANGELOG.md" ||
    entry === "LICENSE" ||
    entry === "scripts/prepare-admission-state-dir.mjs" ||
    entry === "scripts/prepare-official-kernel-compat.mjs" ||
    entry === "assets/official-kernel-compat/rc01/paseo_model_compat.py" ||
    /^dist\/(?:ACP Connector|Admission Controller)\/.+\.(?:js|d\.ts|js\.map)$/.test(entry);
}
