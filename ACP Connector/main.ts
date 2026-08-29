#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolveAcpKernel } from "./official-kernel/kernel.js";
import { runOfficialLogin } from "./official-kernel/login.js";
import { runOfficialKernel } from "./official-kernel/run.js";

const argv = process.argv;
const require = createRequire(import.meta.url);
const packageJson = require(
  existsSync(new URL("../package.json", import.meta.url))
    ? "../package.json"
    : "../../package.json"
) as { version?: string };

const version = packageJson.version ?? "0.0.0";

if (argv.includes("--version")) {
  process.stdout.write(`${version}\n`);
} else if (argv.includes("--login")) {
  const code = await runOfficialLogin(process.env, version);
  process.exit(code);
} else {
  try {
    resolveAcpKernel(process.env, argv);
    await runOfficialKernel({ env: process.env, version });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  }
}
