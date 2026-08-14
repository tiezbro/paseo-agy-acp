#!/usr/bin/env node
import { runInteractiveAgyLogin } from "./agy/auth.js";
import { runAcp } from "./agent.js";

const argv = process.argv;

// Terminal auth method (`type: "terminal"`, args: ["--login"]) re-invokes this
// binary so the user can complete agy's interactive login (API key or web code).
if (argv.includes("--login")) {
  const code = await runInteractiveAgyLogin({ argv, env: process.env });
  process.exit(code);
}

runAcp({ argv });
