import { pathToFileURL } from "node:url";

const [mode, databasePath, registryModule, ...args] = process.argv.slice(2);
if (!mode || !databasePath || !registryModule) {
  throw new Error("usage: active-session-registry-child.mjs <writer|takeover|advance> <database-path> <registry-module> ...");
}

const { ActiveSessionAdvanceError, ActiveSessionLeaseFenceError, ActiveSessionRegistry } = await import(
  pathToFileURL(registryModule).href
);
const registry = new ActiveSessionRegistry(databasePath);

process.stdout.write("ready\n");
await waitForStart();

try {
  if (mode === "writer") {
    const [suffix, ownerInstanceId] = args;
    if (!suffix || !ownerInstanceId) throw new Error("writer arguments are missing");
    const lease = registry.register({
      agentId: `agent-${suffix}`,
      sessionId: `session-${suffix}`,
      requestId: `request-${suffix}`,
      conversationId: null,
      cursor: -1,
      connectorIdentity: connectorIdentity(ownerInstanceId, suffix)
    });
    for (let cursor = 0; cursor < 80; cursor += 1) {
      registry.advance(lease, { conversationId: `conversation-${suffix}`, cursor });
    }
  } else if (mode === "takeover") {
    const [requestId, ownerInstanceId, leaseGeneration, replacementOwnerInstanceId] = args;
    if (!requestId || !ownerInstanceId || !leaseGeneration || !replacementOwnerInstanceId) {
      throw new Error("takeover arguments are missing");
    }
    try {
      registry.takeOverStale(
        { requestId, ownerInstanceId, leaseGeneration: Number(leaseGeneration) },
        connectorIdentity(replacementOwnerInstanceId, replacementOwnerInstanceId.slice(0, 8))
      );
    } catch (error) {
      if (!(error instanceof ActiveSessionLeaseFenceError)) throw error;
    }
  } else if (mode === "advance") {
    const [requestId, ownerInstanceId, leaseGeneration, conversationId, cursor] = args;
    if (!requestId || !ownerInstanceId || !leaseGeneration || !conversationId || !cursor) {
      throw new Error("advance arguments are missing");
    }
    try {
      registry.advance(
        { requestId, ownerInstanceId, leaseGeneration: Number(leaseGeneration) },
        { conversationId, cursor: Number(cursor) }
      );
      process.stdout.write("advanced\n");
    } catch (error) {
      if (error instanceof ActiveSessionAdvanceError) process.stdout.write("invalid\n");
      else if (error instanceof ActiveSessionLeaseFenceError) process.stdout.write("fenced\n");
      else throw error;
    }
  } else {
    throw new Error("unknown child mode");
  }
} finally {
  registry.close();
}

process.stdout.write("done\n");

function connectorIdentity(ownerInstanceId, suffix) {
  const pid = suffix === "left" ? 4222 : suffix === "right" ? 4333 : 4444;
  return {
    ownerInstanceId,
    createdAt: "2026-08-09T12:00:00.000Z",
    bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    pid,
    startTimeTicks: String(pid),
    pidNamespaceInode: 4026531836,
    ppid: 4000,
    pgrp: 4000,
    session: 4000
  };
}

function waitForStart() {
  return new Promise((resolve, reject) => {
    process.stdin.once("data", (chunk) => {
      if (chunk.toString("utf8").trim() === "go") resolve();
      else reject(new Error("expected start signal"));
    });
    process.stdin.once("error", reject);
  });
}
