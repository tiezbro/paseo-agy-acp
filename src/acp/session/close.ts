// ACP session/close handler: close active session and terminate background process.
// Docs: https://agentclientprotocol.com/rfds/session-close

import type { CloseSessionRequest, CloseSessionResponse } from "@agentclientprotocol/sdk";
import type { SessionDeleteTarget } from "./delete.js";

import type { SessionState } from "./types.js";
import { cancelQueuedPrompts } from "./cancel.js";
import { turnsOf } from "./turn-scheduler.js";

export async function handleCloseSession(
  params: CloseSessionRequest,
  activeSessions: Map<string, SessionDeleteTarget>
): Promise<CloseSessionResponse> {
  const session = activeSessions.get(params.sessionId);
  activeSessions.delete(params.sessionId);
  if (session) {
    (session as SessionState).closed = true;
    // Abort running turns and steer reservations before touching the backend,
    // so a stalled client transport cannot delay teardown.
    turnsOf(session as SessionState).close();
    cancelQueuedPrompts(session as SessionState);
    await session.agy.close();
  }
  return {};
}
