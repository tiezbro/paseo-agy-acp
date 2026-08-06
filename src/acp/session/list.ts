// ACP session/list handler: list persisted session bindings from disk store.
// Docs: https://agentclientprotocol.com/protocol/v1/session-list

import type { ListSessionsRequest, ListSessionsResponse } from "@agentclientprotocol/sdk/experimental/v2";
import type { SessionStore } from "./store.js";

export async function handleListSessions(
  params: ListSessionsRequest = {},
  store: SessionStore
): Promise<ListSessionsResponse> {
  const listed = await store.list({ cwd: params.cwd ?? null });
  return {
    sessions: listed.map((entry) => ({
      sessionId: entry.sessionId,
      cwd: entry.cwd,
      additionalDirectories: entry.additionalDirectories,
      updatedAt: entry.updatedAt
    }))
  };
}
