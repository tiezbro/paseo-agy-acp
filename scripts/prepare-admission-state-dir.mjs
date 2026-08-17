#!/usr/bin/env node

import { closeSync, constants, fstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

function fail(message) {
  process.stderr.write(`agy-acp admission state preflight failed: ${message}\n`);
  process.exitCode = 1;
}

function modeText(mode) {
  return (mode & 0o777).toString(8).padStart(4, "0");
}

function prepareAdmissionStateDirectory(input) {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("provide an absolute directory path or set AGY_ACP_STATE_DIR");
  }
  if (!path.isAbsolute(input)) {
    throw new Error("AGY_ACP_STATE_DIR must be an absolute path");
  }

  mkdirSync(input, { recursive: true, mode: 0o700 });
  const flags = constants.O_RDONLY |
    (constants.O_CLOEXEC ?? 0) |
    (constants.O_DIRECTORY ?? 0) |
    (constants.O_NOFOLLOW ?? 0);

  let directory;
  try {
    directory = openSync(input, flags);
  } catch {
    throw new Error("AGY_ACP_STATE_DIR must be a real directory and not a symbolic link");
  }

  try {
    const stat = fstatSync(directory);
    if (!stat.isDirectory()) {
      throw new Error("AGY_ACP_STATE_DIR must be a real directory");
    }
    const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (currentUid !== undefined && stat.uid !== currentUid) {
      throw new Error("AGY_ACP_STATE_DIR must be owned by the current user");
    }
    if ((stat.mode & 0o777) !== 0o700) {
      throw new Error(
        `AGY_ACP_STATE_DIR mode is ${modeText(stat.mode)}; expected 0700. ` +
        `Run chmod 700 -- ${JSON.stringify(input)} and rerun the preflight`
      );
    }
  } finally {
    closeSync(directory);
  }
}

const stateDir = process.argv[2] ?? process.env.AGY_ACP_STATE_DIR;
try {
  prepareAdmissionStateDirectory(stateDir);
  process.stdout.write(`admission state directory ready: ${JSON.stringify(stateDir)} mode=0700\n`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
