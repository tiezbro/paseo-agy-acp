// ACP session/delete logic: purge persisted session state and clean up active session resources.
// Docs: https://agentclientprotocol.com/protocol/v1/session-delete

import type { DeleteSessionRequest, DeleteSessionResponse } from "@agentclientprotocol/sdk";
import type { SessionStore } from "./store.js";
import type { SessionState } from "./types.js";
import { cancelQueuedPrompts } from "./cancel.js";
import { turnsOf, type TurnScheduler } from "./turn-scheduler.js";

export interface SessionDeleteTarget {
  turns?: TurnScheduler;
  agy: { close(): Promise<void> };
}

/**
 * Handle `session/delete` for an active or persisted session:
 * 1. Aborts any active prompt in progress.
 * 2. Closes the agy backend process for this session.
 * 3. Removes the session binding from the SessionStore.
 */
export async function handleDeleteSession(
  params: DeleteSessionRequest,
  activeSessions: Map<string, SessionDeleteTarget>,
  store: SessionStore
): Promise<DeleteSessionResponse> {
  const session = activeSessions.get(params.sessionId);
  activeSessions.delete(params.sessionId);
  if (session) {
    (session as SessionState).closed = true;
    // Abort running turns and steer reservations before touching the backend.
    turnsOf(session as SessionState).close();
    cancelQueuedPrompts(session as SessionState);
  }
  await session?.agy.close();
  await store.delete(params.sessionId);
  return {};
}
