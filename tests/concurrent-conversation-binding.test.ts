import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { conversationSnapshot } from "../ACP Connector/agy/db/scan.js";
import { StreamPoller, type StreamOptions } from "../ACP Connector/agy/db/streaming.js";
import { createConversationDb, insertStep } from "./fixtures/conversation-db.js";
import { encodeStepPayload } from "./fixtures/step-encoder.js";

const tempDirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("concurrent fresh conversation binding", () => {
  it.runIf(process.platform === "linux")(
    "binds the conversation database opened by this agy process instead of a competitor",
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-conversation-binding-"));
      tempDirs.push(root);
      const conversations = path.join(root, "conversations");
      const staging = path.join(root, "staging");
      fs.mkdirSync(conversations);
      fs.mkdirSync(staging);
      const before = conversationSnapshot(conversations);

      createCompletedConversation(staging, "owned", "OWNED_RESPONSE");
      const holder = await holdOpen(path.join(staging, "owned.db"));
      children.push(holder);

      createCompletedConversation(conversations, "competitor", "COMPETITOR_RESPONSE");
      const poller = new StreamPoller({
        dir: conversations,
        conversationId: null,
        baseStepIdx: -1,
        skipNarration: false,
        snapshot: before,
        processId: holder.pid
      } as StreamOptions & { processId: number });

      const updates = [...poller.poll()];
      fs.renameSync(
        path.join(staging, "owned.db"),
        path.join(conversations, "owned.db")
      );
      updates.push(...poller.poll());

      expect(poller.conversationId).toBe("owned");
      expect(JSON.stringify(updates)).toContain("OWNED_RESPONSE");
      expect(JSON.stringify(updates)).not.toContain("COMPETITOR_RESPONSE");
      poller.close();
    }
  );
});

function createCompletedConversation(dir: string, id: string, response: string): void {
  const db = createConversationDb(dir, id);
  insertStep(db, {
    idx: 0,
    stepType: 14,
    status: 3,
    stepPayload: encodeStepPayload({ userPrompt: `${id} prompt` })
  });
  insertStep(db, {
    idx: 1,
    stepType: 15,
    status: 3,
    stepPayload: encodeStepPayload({ agentText: response })
  });
  db.close();
}

async function holdOpen(file: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import fs from 'node:fs'; fs.openSync(process.argv[1], 'r'); process.stdout.write('READY\\n'); process.stdin.resume();",
      file
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  );
  const [chunk] = await once(child.stdout, "data") as [Buffer];
  expect(chunk.toString("utf8")).toBe("READY\n");
  return child;
}
