import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [command, databasePath] = process.argv.slice(2);
if ((command !== "hold" && command !== "try") || !databasePath) {
  throw new Error("usage: admission-controller-child.mjs <hold|try> <databasePath>");
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { AdmissionController } = await import(pathToFileURL(path.join(repositoryRoot, "dist/admission/controller.js")).href);
const controller = new AdmissionController({
  databasePath,
  policy: {
    maxActiveTurns: 1,
    maxConcurrentStarts: 1,
    minStartIntervalMs: 0,
    queueTimeoutMs: 30 * 60_000,
    capacityCooldownMs: 30_000
  }
});

if (command === "hold") {
  controller.enqueue({
    requestId: "held",
    sessionId: "held-session",
    parentId: "held-parent",
    fingerprint: "held-fingerprint",
    provider: "antigravity",
    model: "claude-opus-4-6-thinking",
    now: 1_000
  });
  const lease = controller.admitNext(1_001, "holder");
  if (!lease) throw new Error("holder did not receive a lease");

  process.stdout.write("held\n");
  process.stdin.resume();
  process.stdin.once("end", () => {
    controller.release(lease.leaseId, 1_002, "completed");
    controller.close();
  });
} else {
  controller.enqueue({
    requestId: "try",
    sessionId: "try-session",
    parentId: "try-parent",
    fingerprint: "try-fingerprint",
    provider: "antigravity",
    model: "claude-opus-4-6-thinking",
    now: 1_003
  });
  const lease = controller.admitNext(1_004, "contender");
  if (lease) controller.release(lease.leaseId, 1_005, "completed");
  controller.close();
  process.stdout.write(`${JSON.stringify({ admittedRequestId: lease?.requestId ?? null })}\n`);
}
