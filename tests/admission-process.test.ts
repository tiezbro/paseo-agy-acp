import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stateDirs: string[] = [];

const CHILD_SCRIPT = `
import path from "node:path";
import { pathToFileURL } from "node:url";

const [command, databasePath, repositoryRoot] = process.argv.slice(1);
if ((command !== "hold" && command !== "try") || !databasePath || !repositoryRoot) {
  throw new Error("usage: admission-child <hold|try> <databasePath> <repositoryRoot>");
}

const { AdmissionController } = await import(
  pathToFileURL(path.join(repositoryRoot, "dist/Admission Controller/controller.js")).href
);
const controller = new AdmissionController({
  databasePath,
  policy: {
    maxActiveTurns: 1,
    maxConcurrentStarts: 1,
    minStartIntervalMs: 0,
    queueTimeoutMs: 30 * 60_000,
    capacityCooldownMs: 30_000
  },
  encryptionKey: Buffer.alloc(32, 1),
  contentFingerprintKey: Buffer.alloc(32, 2)
});

if (command === "hold") {
  controller.enqueueWithPayload({
    requestId: "held",
    sessionId: "held-session",
    agentId: "held-agent",
    fingerprint: "held-fingerprint",
    provider: "antigravity",
    model: "claude-opus-4-6-thinking",
    now: 1_000
  }, "held prompt", 61_000);
  const lease = controller.admitNext(1_001, "holder");
  if (!lease) throw new Error("holder did not receive a lease");
  controller.markStarting(lease, 1_002);
  controller.markDispatchIntent(lease, 1_003);
  controller.markActive(lease, 1_004);

  process.stdout.write("held\\n");
  process.stdin.resume();
  process.stdin.once("end", () => {
    controller.completeLiveTurn(lease, 1_005, { outcome: "completed" });
    controller.close();
  });
} else {
  controller.enqueueWithPayload({
    requestId: "try",
    sessionId: "try-session",
    agentId: "try-agent",
    fingerprint: "try-fingerprint",
    provider: "antigravity",
    model: "claude-opus-4-6-thinking",
    now: 1_003
  }, "try prompt", 61_003);
  const lease = controller.admitNext(1_004, "contender");
  if (lease) {
    controller.markStarting(lease, 1_005);
    controller.markDispatchIntent(lease, 1_006);
    controller.markActive(lease, 1_007);
    controller.completeLiveTurn(lease, 1_008, { outcome: "completed" });
  }
  controller.close();
  process.stdout.write(\`\${JSON.stringify({ admittedRequestId: lease?.requestId ?? null })}\\n\`);
}
`;

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
    const holder = spawn(process.execPath, ["--input-type=module", "-e", CHILD_SCRIPT, "hold", databasePath, repositoryRoot], {
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
    execFileSync(process.execPath, ["--input-type=module", "-e", CHILD_SCRIPT, command, databasePath, repositoryRoot], {
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
