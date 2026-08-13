// ACP fs/read_text_file: ask the client to read a file, so its own buffer/view
// (e.g. an editor's open document) is the source of truth for later diffing.
// Docs: https://agentclientprotocol.com/protocol/v1/file-system#reading-files

import * as v1 from "@agentclientprotocol/sdk";
import type { AgentContext as V1AgentContext } from "@agentclientprotocol/sdk";

export async function readTextFile(client: V1AgentContext, sessionId: string, path: string): Promise<void> {
  await client.request(v1.methods.client.fs.readTextFile, { sessionId, path });
}
