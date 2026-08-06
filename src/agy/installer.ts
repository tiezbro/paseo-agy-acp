// Download and install the agy CLI from GitHub Releases when it is not already
// on the machine. Used during ACP initialize (and as a prompt-time fallback).

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

export const DEFAULT_AGY_RELEASES_API =
  "https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest";

const BINARY_NAMES = ["agy", "agy.exe", "antigravity", "antigravity.exe"] as const;

export interface EnsureAgyOptions {
  env?: NodeJS.ProcessEnv;
  installBinDir?: string;
  releasesApiUrl?: string;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  fetchImpl?: typeof fetch;
}

function configuredAgyPath(env: NodeJS.ProcessEnv): string | undefined {
  return optional(env.AGY_BIN);
}


export function defaultInstallBinDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const home = optional(env.HOME) ?? optional(env.USERPROFILE);
  return home ? path.join(home, ".local", "bin") : undefined;
}

export function installedAgyPath(installBinDir: string): string {
  const name = process.platform === "win32" ? "agy.exe" : "agy";
  return path.join(installBinDir, name);
}

/** Map this process to a GitHub release asset file name. */
export function releaseAssetName(platform = process.platform, arch = process.arch): string {
  const osName = platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";
  const cpu = arch === "arm64" ? "arm64" : "x64";
  const ext = platform === "win32" ? "zip" : "tar.gz";
  return `agy_cli_${osName}_${cpu}.${ext}`;
}

/** Return true when `agyPath` points at an executable file. */
export function isExecutableFile(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Prepend a directory to `PATH` so bare `agy` resolves there. */
export function prependPathDir(env: NodeJS.ProcessEnv, dir: string): void {
  const current = optional(env.PATH) ?? optional(env.Path);
  const key = env.PATH !== undefined || env.Path === undefined ? "PATH" : "Path";
  env[key] = current ? `${dir}${path.delimiter}${current}` : dir;
}

/** Resolve the first usable agy executable from the install dir or PATH. */
export async function resolveAgyExecutable(options: EnsureAgyOptions = {}): Promise<string | null> {
  const env = options.env ?? process.env;
  const configured = configuredAgyPath(env);
  if (configured) {
    return isExecutableFile(configured) ? configured : null;
  }
  const installBinDir = options.installBinDir ?? defaultInstallBinDir(env);
  const command = process.platform === "win32" ? "agy.exe" : "agy";

  if (installBinDir) {
    const installed = installedAgyPath(installBinDir);
    if (isExecutableFile(installed)) {
      return installed;
    }
  }

  if (await commandExists(command, env)) {
    return command;
  }
  return null;
}

/**
 * Install agy from GitHub Releases when no executable is available on PATH.
 * Returns the installed absolute path, an existing path, or null on failure.
 */
export async function ensureAgyInstalled(options: EnsureAgyOptions = {}): Promise<string | null> {
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const warn = options.warn ?? (() => {});
  const fetchImpl = options.fetchImpl ?? fetch;

  const existing = await resolveAgyExecutable(options);
  if (existing) {
    return existing;
  }

  const configured = configuredAgyPath(env);
  if (configured) {
    warn(`[agy-acp] WARN: configured agy binary is not executable: ${configured}`);
    return null;
  }

  const installBinDir = options.installBinDir ?? defaultInstallBinDir(env);
  if (!installBinDir) {
    warn("[agy-acp] WARN: cannot determine install directory (HOME is unset).");
    return null;
  }

  const assetName = releaseAssetName();
  const releasesApiUrl = options.releasesApiUrl ?? DEFAULT_AGY_RELEASES_API;
  log(`[agy-acp] agy not found — installing latest release (${assetName})...`);

  let release: GitHubRelease;
  try {
    release = await fetchLatestRelease(releasesApiUrl, fetchImpl);
  } catch (error) {
    warn(`[agy-acp] WARN: failed to fetch release metadata: ${(error as Error).message}`);
    return null;
  }

  const asset = release.assets.find((entry) => entry.name === assetName);
  if (!asset) {
    warn(
      `[agy-acp] WARN: release ${release.tag_name} has no asset ${assetName} for ` +
        `${process.platform}-${process.arch}.`
    );
    return null;
  }

  const expectedDigest = parseSha256Digest(asset.digest);
  if (!expectedDigest) {
    warn(`[agy-acp] WARN: release asset ${asset.name} has no valid SHA256 digest; refusing to install.`);
    return null;
  }

  let archiveBytes: Buffer;
  try {
    archiveBytes = await downloadAsset(asset.browser_download_url, fetchImpl);
  } catch (error) {
    warn(`[agy-acp] WARN: failed to download ${asset.name}: ${(error as Error).message}`);
    return null;
  }

  const actual = sha256Hex(archiveBytes);
  if (actual !== expectedDigest) {
    warn(
      `[agy-acp] WARN: SHA256 mismatch for ${asset.name}\n` +
        `  expected: ${expectedDigest}\n` +
        `  got:      ${actual}`
    );
    return null;
  }

  const dest = installedAgyPath(installBinDir);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-install-"));
  try {
    const archivePath = path.join(tmpDir, asset.name);
    fs.writeFileSync(archivePath, archiveBytes);

    const extractDir = path.join(tmpDir, "extracted");
    fs.mkdirSync(extractDir);
    if (asset.name.endsWith(".zip")) {
      await extractZip(archivePath, extractDir);
    } else {
      await extractTarGz(archivePath, extractDir);
    }

    const found = findBinary(extractDir, BINARY_NAMES);
    if (!found) {
      warn(`[agy-acp] WARN: could not locate agy binary inside ${asset.name}.`);
      return null;
    }

    fs.mkdirSync(installBinDir, { recursive: true });
    fs.copyFileSync(found, dest);
    if (process.platform !== "win32") {
      fs.chmodSync(dest, 0o755);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  prependPathDir(env, installBinDir);
  log(`[agy-acp] agy ${release.tag_name} installed → ${dest}`);
  return dest;
}

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
  digest?: string | null;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubReleaseAsset[];
}

async function fetchLatestRelease(apiUrl: string, fetchImpl: typeof fetch): Promise<GitHubRelease> {
  const response = await fetchImpl(apiUrl, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "agy-acp"
    }
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return await response.json() as GitHubRelease;
}

async function downloadAsset(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function parseSha256Digest(digest: string | null | undefined): string | undefined {
  if (!digest?.startsWith("sha256:")) {
    return undefined;
  }
  return digest.slice("sha256:".length).toLowerCase();
}

function sha256Hex(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function extractTarGz(archive: string, destDir: string): Promise<void> {
  await runCommand("tar", ["-xzf", archive, "-C", destDir]);
}

async function extractZip(archive: string, destDir: string): Promise<void> {
  if (process.platform === "win32") {
    await runCommand("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destDir}' -Force`
    ]);
    return;
  }
  await runCommand("tar", ["-xf", archive, "-C", destDir]);
}

async function runCommand(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  const [code] = await once(child, "exit") as [number | null];
  if (code) {
    const stderr = child.stderr ? await readStream(child.stderr) : "";
    throw new Error(`${command} exited ${code}: ${stderr.trim()}`);
  }
}

function findBinary(dir: string, names: readonly string[], maxDepth = 3): string | null {
  if (maxDepth < 0) {
    return null;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && names.includes(entry.name as typeof BINARY_NAMES[number])) {
      return full;
    }
    if (entry.isDirectory()) {
      const nested = findBinary(full, names, maxDepth - 1);
      if (nested) {
        return nested;
      }
    }
  }
  return null;
}

async function commandExists(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const pathEnv = optional(env.PATH) ?? optional(env.Path);
  if (!pathEnv) {
    return false;
  }
  for (const dir of pathEnv.split(path.delimiter)) {
    if (isExecutableFile(path.join(dir, command))) {
      return true;
    }
  }
  return false;
}

function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}