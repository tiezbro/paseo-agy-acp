import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workerPath = path.join(repositoryRoot, "tests/helpers/admission-controller-child.mjs");
const stateDirs: string[] = [];

beforeAll(() => {
  execFileSync(process.execPath, [path.join(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], {
    cwd: repositoryRoot,
    stdio: "inherit"
  });
});

afterEach(() => {
  for (const stateDir of stateDirs.splice(0)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

describe("AdmissionController process boundary", () => {
  it("enforces one active lease across independent connector processes", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-process-"));
    stateDirs.push(stateDir);
    const databasePath = path.join(stateDir, "runtime.sqlite");
    const holder = spawn(process.execPath, [workerPath, "hold", databasePath], {
      cwd: repositoryRoot,
      stdio: "pipe"
    });
    await waitForLine(holder, "held");

    expect(runWorker("try", databasePath)).toEqual({ admittedRequestId: null });

    holder.stdin.end();
    await once(holder, "exit");

    expect(runWorker("try", databasePath)).toEqual({ admittedRequestId: "try" });
  });
});

function runWorker(command: "try", databasePath: string): { admittedRequestId: string | null } {
  return JSON.parse(
    execFileSync(process.execPath, [workerPath, command, databasePath], {
      cwd: repositoryRoot,
      encoding: "utf8"
    })
  ) as { admittedRequestId: string | null };
}

function waitForLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes(`${expected}\n`)) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`admission child exited before ${expected}: ${code}`)));
  });
}
