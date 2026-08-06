import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_AGY_RELEASES_API,
  ensureAgyInstalled,
  installedAgyPath,
  releaseAssetName,
  resolveAgyExecutable
} from "../src/agy/installer.js";

describe("releaseAssetName", () => {
  it("maps platform and arch to GitHub asset names", () => {
    expect(releaseAssetName("darwin", "arm64")).toBe("agy_cli_mac_arm64.tar.gz");
    expect(releaseAssetName("linux", "x64")).toBe("agy_cli_linux_x64.tar.gz");
    expect(releaseAssetName("win32", "x64")).toBe("agy_cli_windows_x64.zip");
  });
});

describe("ensureAgyInstalled", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips download when agy is already on PATH", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-installer-existing-"));
    dirs.push(dir);
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const agyPath = path.join(binDir, "agy");
    fs.writeFileSync(agyPath, "#!/bin/sh\nexit 0\n", "utf-8");
    fs.chmodSync(agyPath, 0o755);

    const fetchImpl = async () => {
      throw new Error("fetch should not be called");
    };

    const resolved = await ensureAgyInstalled({
      env: { HOME: dir, PATH: binDir },
      fetchImpl
    });

    expect(resolved).toBe("agy");
  });

  it("uses an explicit agy binary without downloading", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-installer-explicit-"));
    dirs.push(dir);
    const agyPath = path.join(dir, "custom-agy");
    fs.writeFileSync(agyPath, "#!/bin/sh\nexit 0\n", "utf-8");
    fs.chmodSync(agyPath, 0o755);

    const resolved = await ensureAgyInstalled({
      env: { HOME: dir, AGY_BIN: agyPath },
      fetchImpl: async () => {
        throw new Error("fetch should not be called");
      }
    });

    expect(resolved).toBe(agyPath);
  });

  it("refuses to install an asset without a SHA256 digest", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-installer-no-digest-"));
    dirs.push(dir);
    const warnings: string[] = [];
    const archiveBytes = buildTarGz({ agy: "#!/bin/sh\nexit 0\n" });
    const assetName = releaseAssetName(process.platform, process.arch);
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input) === DEFAULT_AGY_RELEASES_API) {
        return new Response(JSON.stringify({
          tag_name: "1.0.14",
          assets: [{
            name: assetName,
            browser_download_url: "https://example.test/agy.tar.gz"
          }]
        }), { status: 200 });
      }
      return new Response(new Uint8Array(archiveBytes), { status: 200 });
    };

    const resolved = await ensureAgyInstalled({
      env: { HOME: dir, PATH: "" },
      installBinDir: path.join(dir, "bin"),
      fetchImpl,
      warn: (message) => warnings.push(message)
    });

    expect(resolved).toBeNull();
    expect(warnings.some((message) => message.includes("has no valid SHA256 digest"))).toBe(true);
  });

  it("downloads the latest GitHub release asset when agy is missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-installer-download-"));
    dirs.push(dir);
    const installBinDir = path.join(dir, "bin");
    const env: NodeJS.ProcessEnv = { HOME: dir };

    const fakeBinary = "#!/bin/sh\nexit 0\n";
    const archiveBytes = buildTarGz({ antigravity: fakeBinary });
    const digest = `sha256:${sha256Hex(archiveBytes)}`;
    const assetName = releaseAssetName(process.platform, process.arch);

    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url === DEFAULT_AGY_RELEASES_API) {
        return new Response(JSON.stringify({
          tag_name: "1.0.14",
          assets: [{
            name: assetName,
            browser_download_url: "https://example.test/agy.tar.gz",
            digest
          }]
        }), { status: 200 });
      }
      if (url === "https://example.test/agy.tar.gz") {
        return new Response(new Uint8Array(archiveBytes), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const resolved = await ensureAgyInstalled({
      env,
      installBinDir,
      fetchImpl
    });

    expect(resolved).toBe(installedAgyPath(installBinDir));
    expect(env.PATH?.split(path.delimiter)).toContain(installBinDir);
    expect(fs.existsSync(resolved!)).toBe(true);
    expect(await resolveAgyExecutable({ env, installBinDir })).toBe(resolved);
  });
});

function sha256Hex(bytes: Buffer): string {
  return spawnSync("shasum", ["-a", "256"], { input: bytes, encoding: "utf-8" })
    .stdout
    .trim()
    .split(/\s+/)[0]!;
}

function buildTarGz(files: Record<string, string>): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-installer-tar-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, contents, "utf-8");
      if (process.platform !== "win32") {
        fs.chmodSync(filePath, 0o755);
      }
    }
    const archivePath = path.join(dir, "archive.tar.gz");
    const result = spawnSync("tar", ["-czf", archivePath, "-C", dir, ...Object.keys(files)], {
      encoding: "utf-8"
    });
    if (result.status !== 0) {
      throw new Error(result.stderr || "tar failed");
    }
    return fs.readFileSync(archivePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}