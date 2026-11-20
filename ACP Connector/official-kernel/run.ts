import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { ensureManagedOfficialKernel } from "./ensure-managed-kernel.js";
import { createKernelEventFilter, KERNEL_EVENT_DIRECTORY_ENV, KERNEL_EVENT_ENV } from "./kernel-events.js";
import { OfficialKernelProxy } from "./proxy.js";
import { spawnOfficialKernel } from "./spawn.js";

export interface RunOfficialKernelOptions {
  env?: NodeJS.ProcessEnv;
  stdin?: Readable;
  stdout?: Writable;
  version: string;
}

export async function runOfficialKernel(options: RunOfficialKernelOptions): Promise<void> {
  const env = options.env ?? process.env;
  const binary = await ensureManagedOfficialKernel(env);
  const eventDirectory = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-acp-kernel-events-"));
  const child = spawnOfficialKernel({
    ...env,
    PASEO_AGY_ACP_OFFICIAL_BIN: binary,
    [KERNEL_EVENT_ENV]: env[KERNEL_EVENT_ENV] ?? "1",
    [KERNEL_EVENT_DIRECTORY_ENV]: eventDirectory
  });
  const proxy = new OfficialKernelProxy({
    child,
    stdin: (options.stdin ?? process.stdin) as Readable,
    stdout: (options.stdout ?? process.stdout) as Writable,
    env,
    version: options.version,
    kernelEventDirectory: eventDirectory
  });
  const stderr = createKernelEventFilter(event => proxy.observeKernelEvent(event));
  child.stderr.pipe(stderr).pipe(process.stderr);
  const stop = () => proxy.close();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await proxy.start();
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    stderr.destroy();
    rmSync(eventDirectory, { recursive: true, force: true });
  }
}
