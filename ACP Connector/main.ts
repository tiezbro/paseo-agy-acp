#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { runInteractiveAgyLogin } from "./agy/auth.js";
import { runAcp } from "./agent.js";

const argv = process.argv;
const require = createRequire(import.meta.url);
const packageJson = require(
  existsSync(new URL("../package.json", import.meta.url))
    ? "../package.json"
    : "../../package.json"
) as { version?: string };

// Terminal auth method (`type: "terminal"`, args: ["--login"]) re-invokes this
// binary so the user can complete agy's interactive login (API key or web code).
if (argv.includes("--version")) {
  process.stdout.write(`${packageJson.version ?? "0.0.0"}\n`);
} else if (argv.includes("--login")) {
  const code = await runInteractiveAgyLogin({ argv, env: process.env });
  process.exit(code);
} else {
  runAcp({ argv });
}
