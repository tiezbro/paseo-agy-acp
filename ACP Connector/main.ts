#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolveAcpKernel } from "./official-kernel/kernel.js";
import { runOfficialLogin } from "./official-kernel/login.js";
import { runOfficialKernel } from "./official-kernel/run.js";
import { inspectOfficialKernel, prepareOfficialKernel } from "./official-kernel/kernel-commands.js";
import { queryOfficialQuota } from "./official-kernel/usage.js";

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
} else if (argv.includes("--doctor") || argv.includes("--prepare-kernel")) {
  try {
    resolveAcpKernel(process.env, argv);
    const report = argv.includes("--prepare-kernel")
      ? await prepareOfficialKernel(process.env, version)
      : await inspectOfficialKernel(process.env, version);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.ready ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else if (argv.includes("--usage")) {
  try {
    const report = await queryOfficialQuota(process.env);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
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
