import type { Readable, Writable } from "node:stream";
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
  const child = spawnOfficialKernel(env);
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
