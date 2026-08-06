// ACP session/new: create a fresh agy-backed session.
// Docs: https://agentclientprotocol.com/protocol/v1/session-setup#creating-a-session

import type {
  AgentContext as V1AgentContext,
  NewSessionRequest as V1NewSessionRequest,
  NewSessionResponse as V1NewSessionResponse
} from "@agentclientprotocol/sdk";
import type {
  AgentContext as V2AgentContext,
  NewSessionRequest as V2NewSessionRequest,
  NewSessionResponse as V2NewSessionResponse
} from "@agentclientprotocol/sdk/experimental/v2";
import { sessionConfigOptionsV1, sessionConfigOptionsV2 } from "./config-options.js";
import { sessionModeState } from "./modes.js";
import type { SessionState } from "./types.js";

/**
 * Runs `fn` after the current request handler's response has gone out on the
 * wire. The ACP connection queues outbound messages in call order, so a
 * `setImmediate` — which only fires once the microtask queue (including the
 * response's own send) has drained — is enough to guarantee it lands second.
 */
function deferAfterResponse(fn: () => Promise<void>): void {
  setImmediate(() => {
    fn().catch(() => {
      // Connection may already be closed by the time this fires (client
      // disconnected right after session/new) — nothing left to notify.
    });
  });
}

export interface NewSessionDeps {
  requireAuthenticated(cwd?: string): Promise<void>;
  createSession(cwd: string | undefined, additionalDirectories: string[] | undefined): Promise<SessionState>;
}

export async function handleNewSessionV1(
  params: V1NewSessionRequest,
  client: V1AgentContext | undefined,
  deps: NewSessionDeps & {
    notifyAvailableCommandsV1(client: V1AgentContext, sessionId: string): Promise<void>;
  }
): Promise<V1NewSessionResponse> {
  await deps.requireAuthenticated(params.cwd);
  const session = await deps.createSession(params.cwd, params.additionalDirectories);
  if (client) {
    // Clients (e.g. Zed) only learn this sessionId from the `session/new`
    // response and register it then; a notification sent earlier targets a
    // session the client doesn't recognize yet and gets silently dropped.
    // Defer past the response so it's on the wire second, not first.
    deferAfterResponse(() => deps.notifyAvailableCommandsV1(client, session.sessionId));
  }
  return {
    sessionId: session.sessionId,
    modes: sessionModeState(session.agy.config.mode),
    configOptions: sessionConfigOptionsV1(session)
  };
}

export async function handleNewSessionV2(
  params: V2NewSessionRequest,
  client: V2AgentContext | undefined,
  deps: NewSessionDeps & {
    notifyAvailableCommandsV2(client: V2AgentContext, sessionId: string): Promise<void>;
  }
): Promise<V2NewSessionResponse> {
  await deps.requireAuthenticated(params.cwd);
  const session = await deps.createSession(params.cwd, params.additionalDirectories);
  // Draft v2 has no native session/set_mode surface; mode is the config option only.
  if (client) {
    // See handleNewSessionV1: must not resolve before the response is sent, or
    // the client drops it as a notification for an unknown session.
    deferAfterResponse(() => deps.notifyAvailableCommandsV2(client, session.sessionId));
  }
  return {
    sessionId: session.sessionId,
    configOptions: sessionConfigOptionsV2(session)
  };
}
