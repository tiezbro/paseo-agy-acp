import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
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

const MANAGED_ARTIFACT_PREFIX = "1.4.5-7e7019c8989c-";

export interface OfficialKernelDownload {
  readonly id: string;
  readonly url: string;
  readonly sha256: string;
  readonly binaryName: string;
  readonly compat: boolean;
}

const OFFICIAL_KERNEL_DOWNLOADS: Readonly<Record<string, OfficialKernelDownload>> = Object.freeze({
  "linux-x64": Object.freeze({
    id: "linux-x64",
    url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-x86_64.zip",
    sha256: "923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b",
    binaryName: "agy_acp_server.par",
    compat: true
  }),
  "linux-arm64": Object.freeze({
    id: "linux-arm64",
    url: "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-1.4.5-linux-arm64.zip",
    sha256: "7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056",
    binaryName: "agy_acp_server.par",
    compat: false
  }),
  "darwin-arm64": Object.freeze({
    id: "darwin-arm64",
    url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-arm64.zip",
    sha256: "886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284",
    binaryName: "agy_acp_server.par",
    compat: false
  }),
  "darwin-x64": Object.freeze({
    id: "darwin-x64",
    url: "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-1.4.5-darwin-x86_64.zip",
    sha256: "b39f3573c03b9acb9df028853f647527f1f3133f32bd77e78b796e48a205114a",
    binaryName: "agy_acp_server.par",
    compat: false
  }),
  "win32-x64": Object.freeze({
    id: "win32-x64",
    url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.5-windows-x86_64.zip",
    sha256: "d24f4c73c9f96d4f44384e281c855a56c72d8eaa9c5b0fad7ccb1635c6b63f50",
    binaryName: "agy_acp_server.exe",
    compat: false
  }),
  "win32-arm64": Object.freeze({
    id: "win32-arm64",
    url: "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.5-windows-arm64.zip",
    sha256: "ab0a9aac8349e08ef289be6d16da8f89e3abe60eba5158032ef78c4a1220261c",
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
    throw new Error(`no official Antigravity ACP 1.4.5 download for ${platform} ${arch}`);
  }
  return download;
}

export function managedOfficialKernelRoot(home = homedir()): string {
  return path.join(home, ".local", "opt", "agy-acp-server-1.4.5");
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
  const home = environment.HOME?.trim() || homedir();
  if (!usesManagedOfficialKernel(configured, home)) return configured ?? "";
  const download = officialKernelDownload();
  const officialRoot = managedOfficialKernelRoot(home);
  return withManagedKernelInstallLock(`${officialRoot}.install-lock`, async () => {
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
      process.stderr.write(`paseo-agy-acp is using the managed 1.4.5 kernel at ${wrapper}\n`);
      return wrapper;
    }
    return ensureStockOfficialBinary(officialRoot, download);
  });
}

/** 跨进程互斥覆盖下载、prepare 和 activate；只回收确认已退出的本机进程锁。 */
export async function withManagedKernelInstallLock<T>(lockPath: string, action: () => Promise<T>, timeoutMs = 180_000): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o755 });
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try { await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid }), "utf8"); }
      catch (error) { await rm(lockPath, { recursive: true, force: true }); throw error; }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // 回收者自身互斥并重读 owner，避免旧等待者误删随后新建的锁。
      const reaper = `${lockPath}.reaper`;
      let reaping = false;
      try {
        await mkdir(reaper, { mode: 0o700 });
        reaping = true;
        const owner = JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")) as { pid?: unknown };
        if (typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); }
          catch (probe) {
            if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
              await rm(lockPath, { recursive: true, force: true });
            }
          }
        }
      } catch { /* owner 正在写入、其他回收者工作或损坏时不擅自抢占。 */ }
      finally { if (reaping) await rm(reaper, { recursive: true, force: true }); }
      if (Date.now() >= deadline) throw new Error("等待官方内核安装锁超时；请检查是否仍有安装进程运行");
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    }
  }
  try { return await action(); }
  finally { await rm(lockPath, { recursive: true, force: true }); }
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
  process.stderr.write(`paseo-agy-acp is using the official 1.4.5 kernel at ${binaryPath}\n`);
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
  const stage = await mkdtemp(`${root}.install-`);
  const zipPath = path.join(stage, "agy-acp-server.zip.partial");
  try {
    process.stderr.write(`Downloading the official Antigravity ACP kernel 1.4.5 for ${download.id}\n${download.url}\n`);
    await downloadFile(download.url, zipPath);
    if ((await sha256File(zipPath)) !== download.sha256) {
      throw new Error(`official kernel archive checksum mismatch for ${download.id}`);
    }
    const finalZip = path.join(stage, "agy-acp-server.zip");
    renameSync(zipPath, finalZip);
    extractZip(finalZip, stage);
    const stagedBinary = path.join(stage, download.binaryName);
    const stagedHarness = path.join(stage, "localharness_external");
    if (!existsSync(stagedBinary)) throw new Error("official kernel archive is missing the executable");
    if (download.compat && (
      await sha256File(stagedBinary) !== PRODUCTION_KERNEL_COMPAT_PINS.parSha256 ||
      await sha256File(stagedHarness) !== PRODUCTION_KERNEL_COMPAT_PINS.externalHarnessSha256
    )) throw new Error("official kernel extracted payload checksum mismatch");
    if (process.platform !== "win32") {
      chmodSync(stagedBinary, 0o755);
      if (existsSync(stagedHarness)) chmodSync(stagedHarness, 0o755);
    }
    if (download.compat) {
      const wrapper = path.join(stage, "agy-acp-server-canary");
      await writeFileText(wrapper, "#!/bin/bash\nset -euo pipefail\ncd \"$(dirname \"$(readlink -f \"$0\")\")\"\nexec ./agy_acp_server.par --uid= \"$@\"\n");
      chmodSync(wrapper, 0o755);
    }
    // 提交失败时回滚旧目录；成功后仅清理空旧目录，保留既有数据供人工检查。
    const previous = `${stage}.previous`;
    await rename(root, previous);
    try { await rename(stage, root); }
    catch (error) { await rename(previous, root); throw error; }
    try { await rmdir(previous); }
    catch { process.stderr.write(`Previous managed kernel files retained at ${previous}\n`); }
  } finally { await rm(stage, { recursive: true, force: true }); }
}

function extractZip(zipPath: string, root: string): void {
  const extracted = process.platform === "win32"
    ? spawnSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${root}'`], { stdio: "inherit", timeout: 60_000 })
    : spawnSync("python3", ["-c", "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])", zipPath, root], { stdio: "inherit", timeout: 60_000 });
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
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || response.body === null) throw new Error(`official kernel download failed with HTTP ${response.status}`);
  const { open } = await import("node:fs/promises");
  const handle = await open(destination, "w", 0o644);
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value !== undefined) await handle.writeFile(value);
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
