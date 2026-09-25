import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OfficialKernelCompatLifecycle } from "./kernel-compat-lifecycle.js";
import { PRODUCTION_KERNEL_COMPAT_PINS } from "./kernel-compat-pins.js";
import { RC01_KERNEL_COMPAT_PATCH_PLAN } from "./kernel-compat-rc01-recipe.js";

const MANAGED_ARTIFACT_PREFIX = "1.2.1-adbf34295671-";

export interface OfficialKernelDownload {
  readonly id: string;
  readonly url: string;
  readonly binaryName: string;
  readonly compat: boolean;
}

const OFFICIAL_KERNEL_DOWNLOADS: Readonly<Record<string, OfficialKernelDownload>> = Object.freeze({
  "linux-x64": Object.freeze({
    id: "linux-x64",
    url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.2.1-linux-x86_64.zip",
    binaryName: "agy_acp_server.par",
    compat: true
  }),
  "linux-arm64": Object.freeze({
    id: "linux-arm64",
    url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.2.1-linux-arm64.zip",
    binaryName: "agy_acp_server.par",
    compat: false
  }),
  "darwin-arm64": Object.freeze({
    id: "darwin-arm64",
    url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.2.1-darwin-arm64.zip",
    binaryName: "agy_acp_server.par",
    compat: false
  }),
  "darwin-x64": Object.freeze({
    id: "darwin-x64",
    url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.2.1-darwin-x86_64.zip",
    binaryName: "agy_acp_server.par",
    compat: false
  }),
  "win32-x64": Object.freeze({
    id: "win32-x64",
    url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.2.1-windows-x86_64.zip",
    binaryName: "agy_acp_server.exe",
    compat: false
  }),
  "win32-arm64": Object.freeze({
    id: "win32-arm64",
    url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.2.1-windows-arm64.zip",
    binaryName: "agy_acp_server.exe",
    compat: false
  })
});

export function officialKernelDownload(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): OfficialKernelDownload {
  const download = OFFICIAL_KERNEL_DOWNLOADS[`${platform}-${arch}`];
  if (download === undefined) {
    throw new Error(`no official Antigravity ACP 1.2.1 download for ${platform} ${arch}`);
  }
  return download;
}

export function managedOfficialKernelRoot(home = homedir()): string {
  return path.join(home, ".local", "opt", "agy-acp-server-1.2.1");
}

export function managedCompatRoot(home = homedir()): string {
  return path.join(home, ".local", "opt", "paseo-agy-acp-kernel-compat");
}

export function managedStableWrapper(home = homedir()): string {
  return path.join(managedCompatRoot(home), "agy-acp-kernel-compat-active");
}

export function usesManagedOfficialKernel(configured: string | undefined, home = homedir()): boolean {
  const value = configured?.trim() ?? "";
  if (value.length === 0) return true;
  const normalized = path.resolve(value);
  const managed = [
    managedStableWrapper(home),
    path.join(managedOfficialKernelRoot(home), "agy-acp-server-canary"),
    path.join(home, ".local", "opt", "agy-acp-server-agy_acp_server_20260818_01_RC01", "agy-acp-server-canary")
  ];
  return managed.includes(normalized);
}

export async function ensureManagedOfficialKernel(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  const configured = environment.PASEO_AGY_ACP_OFFICIAL_BIN?.trim();
  if (!usesManagedOfficialKernel(configured)) return configured ?? "";
  const download = officialKernelDownload();
  const home = environment.HOME?.trim() || homedir();
  const officialRoot = managedOfficialKernelRoot(home);
  if (download.compat) {
    const wrapper = managedStableWrapper(home);
    if (await currentManagedWrapper(home)) return wrapper;
    await ensureOfficialPayload(officialRoot, download);
    const lifecycle = new OfficialKernelCompatLifecycle({ stateRoot: managedCompatRoot(home) });
    const prepared = await lifecycle.prepare({
      parPath: path.join(officialRoot, download.binaryName),
      externalHarnessPath: path.join(officialRoot, "localharness_external"),
      compatModulePath: compatModulePath(),
      patchPlan: RC01_KERNEL_COMPAT_PATCH_PLAN
    });
    await lifecycle.activate(prepared.artifactId);
    process.stderr.write(`paseo-agy-acp is using the managed 1.2.1 kernel at ${wrapper}\n`);
    return wrapper;
  }
  return ensureStockOfficialBinary(officialRoot, download);
}

async function currentManagedWrapper(home: string): Promise<boolean> {
  const lifecycle = new OfficialKernelCompatLifecycle({ stateRoot: managedCompatRoot(home) });
  try {
    const status = await lifecycle.status();
    return status.current?.verified === true && status.current.artifactId.startsWith(MANAGED_ARTIFACT_PREFIX) && existsSync(managedStableWrapper(home));
  } catch {
    return false;
  }
}

async function ensureStockOfficialBinary(root: string, download: OfficialKernelDownload): Promise<string> {
  const binaryPath = path.join(root, download.binaryName);
  if (!existsSync(binaryPath)) await ensureOfficialPayload(root, download);
  process.stderr.write(`paseo-agy-acp is using the official 1.2.1 kernel at ${binaryPath}\n`);
  return binaryPath;
}

async function ensureOfficialPayload(root: string, download: OfficialKernelDownload): Promise<void> {
  mkdirSync(root, { recursive: true, mode: 0o755 });
  const binaryPath = path.join(root, download.binaryName);
  const harnessPath = path.join(root, "localharness_external");
  if (download.compat && existsSync(binaryPath) && existsSync(harnessPath)) {
    if (
      (await sha256File(binaryPath)) === PRODUCTION_KERNEL_COMPAT_PINS.parSha256 &&
      (await sha256File(harnessPath)) === PRODUCTION_KERNEL_COMPAT_PINS.externalHarnessSha256
    ) {
      return;
    }
  } else if (!download.compat && existsSync(binaryPath)) {
    return;
  }
  const zipPath = path.join(root, "agy-acp-server.zip.partial");
  process.stderr.write(`Downloading the official Antigravity ACP kernel 1.2.1 for ${download.id}\n${download.url}\n`);
  await downloadFile(download.url, zipPath);
  const finalZip = path.join(root, "agy-acp-server.zip");
  renameSync(zipPath, finalZip);
  extractZip(finalZip, root);
  if (process.platform !== "win32") {
    chmodSync(binaryPath, 0o755);
    if (existsSync(harnessPath)) chmodSync(harnessPath, 0o755);
  }
  if (download.compat) {
    const wrapper = path.join(root, "agy-acp-server-canary");
    await writeFileText(wrapper, "#!/bin/bash\nset -euo pipefail\ncd \"$(dirname \"$(readlink -f \"$0\")\")\"\nexec ./agy_acp_server.par --uid= \"$@\"\n");
    chmodSync(wrapper, 0o755);
  }
}

function extractZip(zipPath: string, root: string): void {
  const extracted = process.platform === "win32"
    ? spawnSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${root}'`], { stdio: "inherit" })
    : spawnSync("python3", ["-c", "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", zipPath, root], { stdio: "inherit" });
  if (extracted.status !== 0) throw new Error("official kernel archive could not be extracted");
}

function compatModulePath(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(directory, "assets", "official-kernel-compat", "rc01", "paseo_model_compat.py");
    if (existsSync(candidate)) return candidate;
    directory = path.dirname(directory);
  }
  throw new Error("bundled kernel compatibility module is missing from the package");
}

async function downloadFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || response.body === null) throw new Error(`official kernel download failed with HTTP ${response.status}`);
  const { open } = await import("node:fs/promises");
  const handle = await open(destination, "w", 0o644);
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) await handle.write(value);
    }
  } finally {
    await handle.close();
  }
}

async function sha256File(filePath: string): Promise<string> {
  const { open } = await import("node:fs/promises");
  const handle = await open(filePath, "r");
  try {
    const hash = createHash("sha256");
    const stream = handle.createReadStream();
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function writeFileText(filePath: string, contents: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(filePath, contents, { mode: 0o755 });
}
