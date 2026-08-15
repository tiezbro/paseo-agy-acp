import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [command, databasePath] = process.argv.slice(2);
if ((command !== "hold" && command !== "try") || !databasePath) {
  throw new Error("usage: admission-controller-child.mjs <hold|try> <databasePath>");
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
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
  const input = {
    requestId: "held",
    sessionId: "held-session",
    parentId: "held-parent",
    fingerprint: "held-fingerprint",
    provider: "antigravity",
    model: "claude-opus-4-6-thinking",
    now: 1_000
  };
  controller.enqueueWithPayload(input, "held prompt", 61_000);
  const lease = controller.admitNext(1_001, "holder");
  if (!lease) throw new Error("holder did not receive a lease");
  controller.markStarting(lease, 1_002);
  controller.markDispatchIntent(lease, 1_003);
  controller.markActive(lease, 1_004);

  process.stdout.write("held\n");
  process.stdin.resume();
  process.stdin.once("end", () => {
    controller.completeLiveTurn(lease, 1_005, { outcome: "completed" });
    controller.close();
  });
} else {
  const input = {
    requestId: "try",
    sessionId: "try-session",
    parentId: "try-parent",
    fingerprint: "try-fingerprint",
    provider: "antigravity",
    model: "claude-opus-4-6-thinking",
    now: 1_003
  };
  controller.enqueueWithPayload(input, "try prompt", 61_003);
  const lease = controller.admitNext(1_004, "contender");
  if (lease) {
    controller.markStarting(lease, 1_005);
    controller.markDispatchIntent(lease, 1_006);
    controller.markActive(lease, 1_007);
    controller.completeLiveTurn(lease, 1_008, { outcome: "completed" });
  }
  controller.close();
  process.stdout.write(`${JSON.stringify({ admittedRequestId: lease?.requestId ?? null })}\n`);
}
