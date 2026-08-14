import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [command, databasePath, eventId] = process.argv.slice(2);
if (
  (command !== "hold" &&
    command !== "try" &&
    command !== "claim-and-crash" &&
    command !== "ack-and-crash" &&
    command !== "list-recoverable") ||
  !databasePath
) {
  throw new Error(
    "usage: admission-controller-child.mjs <hold|try|claim-and-crash|ack-and-crash|list-recoverable> <databasePath> [event-id]"
  );
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { AdmissionController, DURABLE_DELIVERY_PROTOCOL } = await import(
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
  ...(command === "list-recoverable"
    ? {}
    : {
        encryptionKey: Buffer.alloc(32, 1),
        contentFingerprintKey: Buffer.alloc(32, 2),
        claimTokenKey: Buffer.alloc(32, 3)
      })
});

if (command === "list-recoverable") {
  process.stdout.write(`${JSON.stringify(controller.listRecoverableDispatches())}\n`);
  controller.close();
} else if (command === "claim-and-crash" || command === "ack-and-crash") {
  if (!eventId) throw new Error(`${command} requires an event ID`);
  const claim = controller.claimPendingDeliveryAtomically({
    eventId,
    ownerInstanceId: "crashed-worker",
    now: 2_000,
    leaseMs: 10
  });
  if (!claim) throw new Error("crashed worker did not receive a delivery claim");
  if (command === "ack-and-crash") {
    controller.acknowledgeDelivery(
      {
        v: 1,
        eventId: claim.eventId,
        sessionId: claim.sessionId,
        claimGeneration: claim.claimGeneration,
        claimToken: claim.claimToken
      },
      2_001
    );
  }
  process.exit(0);
} else if (command === "hold") {
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
    controller.markProviderTerminal(lease, 1_005, terminalObservations(), terminalDelivery("held", 1_005));
    controller.release(lease, 1_006);
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
    controller.markProviderTerminal(lease, 1_008, terminalObservations(), terminalDelivery("try", 1_008));
    controller.release(lease, 1_009);
  }
  controller.close();
  process.stdout.write(`${JSON.stringify({ admittedRequestId: lease?.requestId ?? null })}\n`);
}

function terminalObservations() {
  return {
    outcome: "completed",
    conversationId: "process-test-conversation",
    status: "SUCCESS",
    streamObservedAt: 1_010,
    sqliteObservedAt: 1_011,
    failure: null
  };
}

function terminalDelivery(requestId, now) {
  return {
    eventId: `terminal-${requestId}`,
    requestId,
    fingerprint: `terminal-${requestId}-fingerprint`,
    payload: `terminal:${requestId}`,
    sequence: 0,
    now,
    expiresAt: now + 60_000,
    protocol: DURABLE_DELIVERY_PROTOCOL
  };
}
