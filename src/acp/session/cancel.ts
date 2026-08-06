// ACP session/cancel (notification): abort the active prompt turn, if any.
// Docs: https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation

import type { SessionState } from "./types.js";
import { turnsOf } from "./turn-scheduler.js";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";

function cancelQueuedV2Prompt(
  item: Extract<SessionState["promptQueue"][number], { version: "v2" }>
): void {
  item.controller.abort();
  try {
    void item.client.notify(v2.methods.client.session.update, {
      sessionId: item.params.sessionId,
      update: {
        sessionUpdate: "state_update",
        state: "idle",
        stopReason: "cancelled"
      }
    }).catch(() => {});
  } catch {
    // Cancellation notifications are best effort during teardown.
  }
}

export function cancelQueuedPrompts(session: SessionState): void {
  if (!Array.isArray(session.promptQueue)) return;
  const items = session.promptQueue.splice(0, session.promptQueue.length);
  for (const item of items) {
    if (item.version === "v1") {
      item.detachQueueCancel?.();
      item.resolve({ stopReason: "cancelled" });
    } else {
      cancelQueuedV2Prompt(item);
    }
  }
}

export async function handleCancel(
  sessionId: string,
  sessions: Map<string, SessionState>,
  meta?: Record<string, unknown> | null
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;

  const queuedPromptId = typeof meta?.["agy-acp/queuedPromptId"] === "string"
    ? meta["agy-acp/queuedPromptId"]
    : undefined;

  if (queuedPromptId) {
    const idx = session.promptQueue.findIndex((q) => q.id === queuedPromptId);
    if (idx >= 0) {
      const [removed] = session.promptQueue.splice(idx, 1);
      if (removed.version === "v1") {
        removed.detachQueueCancel?.();
        removed.resolve({ stopReason: "cancelled" });
      } else {
        cancelQueuedV2Prompt(removed);
      }
      return;
    }
    // The item may already have left the FIFO and claimed the turn slot: abort
    // exactly that claim — never unrelated turns or steer reservations. A
    // stale id matches nothing and must not fall back to a global abort.
    const claimed = turnsOf(session).activeClaim;
    if (claimed?.tag === queuedPromptId) {
      claimed.abort();
    }
    return;
  }

  // Aborts the running turn *and* any steer holding a reservation — a steer
  // waiting for the previous turn to stop is still the user's turn to cancel.
  turnsOf(session).abortAll();
  await session.agy.cancel();
}
