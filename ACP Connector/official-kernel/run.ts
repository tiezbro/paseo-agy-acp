import type { Readable, Writable } from "node:stream";
import { ensureManagedOfficialKernel } from "./ensure-managed-kernel.js";
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
  const child = spawnOfficialKernel({ ...env, PASEO_AGY_ACP_OFFICIAL_BIN: binary });
  const proxy = new OfficialKernelProxy({
    child,
    stdin: (options.stdin ?? process.stdin) as Readable,
    stdout: (options.stdout ?? process.stdout) as Writable,
    env,
    version: options.version
  });
  try {
    await proxy.start();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
}
