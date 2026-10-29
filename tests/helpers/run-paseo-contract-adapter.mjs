import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OfficialKernelProxy } from "../../dist/ACP Connector/official-kernel/proxy.js";

const child = spawn(process.execPath, [fileURLToPath(new URL("./paseo-contract-kernel.mjs", import.meta.url))], {
  env: process.env, stdio: ["pipe", "pipe", "pipe"]
});
child.stderr.pipe(process.stderr);
const proxy = new OfficialKernelProxy({ child, stdin: process.stdin, stdout: process.stdout,
  env: process.env, version: "2.7.1" });
const stop = () => proxy.close();
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
try {
  await proxy.start();
} finally {
  process.off("SIGTERM", stop);
  process.off("SIGINT", stop);
  process.stdin.destroy();
}
