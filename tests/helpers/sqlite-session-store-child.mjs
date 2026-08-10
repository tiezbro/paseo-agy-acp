import { pathToFileURL } from "node:url";

const [databasePath, sessionId, storeModule] = process.argv.slice(2);
if (!databasePath || !sessionId || !storeModule) {
  throw new Error("usage: sqlite-session-store-child.mjs <database-path> <session-id> <store-module>");
}

const { SQLiteSessionStore } = await import(pathToFileURL(storeModule).href);
const store = new SQLiteSessionStore(databasePath);

process.stdout.write("ready\n");
await new Promise((resolve, reject) => {
  process.stdin.once("data", (chunk) => {
    if (chunk.toString("utf8").trim() === "go") resolve();
    else reject(new Error("expected start signal"));
  });
  process.stdin.once("error", reject);
});

for (let cursor = 0; cursor < 80; cursor += 1) {
  await store.persist(sessionId, {
    cwd: `/workers/${sessionId}`,
    additionalDirectories: [`/workers/${sessionId}/shared`],
    conversationId: `conversation-${sessionId}`,
    lastStepIdx: cursor,
    model: `model-${sessionId}`,
    reasoningEffort: "high",
    mode: "plan",
    v2UserMessageIdsByStep: { [String(cursor)]: `message-${sessionId}-${cursor}` },
    updatedAt: new Date(1_700_000_000_000 + cursor).toISOString()
  });
}

store.close();
process.stdout.write("done\n");
