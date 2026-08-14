// ACP fs/write_text_file: ask the client to write a file through its own
// buffer/view, so its native diff/review UI tracks the change.
// Docs: https://agentclientprotocol.com/protocol/v1/file-system#writing-files

import * as v1 from "@agentclientprotocol/sdk";
import type { AgentContext as V1AgentContext } from "@agentclientprotocol/sdk";

export async function writeTextFile(
  client: V1AgentContext,
  sessionId: string,
  path: string,
  content: string
): Promise<void> {
  await client.request(v1.methods.client.fs.writeTextFile, { sessionId, path, content });
}
