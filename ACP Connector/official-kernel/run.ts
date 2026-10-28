import type { Readable, Writable } from "node:stream";
import {
  assertAdmissionPlatformSupported,
  parseAdmissionRuntimeConfig
} from "../../Admission Controller/runtime-config.js";
import { isAdmissionDiscoveryEnvironment, isAdmissionEnabled } from "./admission-fence.js";
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
  // Reject an unsupported Admission platform before the managed kernel download
  // and before a kernel child is spawned, so a misconfiguration cannot leave a
  // half-started provider behind. Discovery runs without an agent identity and
  // skips Admission entirely.
  if (isAdmissionEnabled(env) && !isAdmissionDiscoveryEnvironment(env)) {
    parseAdmissionRuntimeConfig(env);
    assertAdmissionPlatformSupported();
  }
  const binary = await ensureManagedOfficialKernel(env);
  const child = spawnOfficialKernel({ ...env, PASEO_AGY_ACP_OFFICIAL_BIN: binary });
  const proxy = new OfficialKernelProxy({
    child,
    stdin: (options.stdin ?? process.stdin) as Readable,
    stdout: (options.stdout ?? process.stdout) as Writable,
    env,
    version: options.version
  });
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
  }
}
