// ACP session/resume: reattach to a session without replaying history (v1), or
// optionally replay from the start (v2 `replayFrom: { type: "start" }`, which
// replaces v1 `session/load`).
// Docs: https://agentclientprotocol.com/protocol/v1/session-setup

import * as v1 from "@agentclientprotocol/sdk";
import type {
  AgentContext as V1AgentContext,
  ResumeSessionRequest as V1ResumeSessionRequest,
  ResumeSessionResponse as V1ResumeSessionResponse
} from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import type {
  AgentContext as V2AgentContext,
  ResumeSessionRequest as V2ResumeSessionRequest,
  ResumeSessionResponse as V2ResumeSessionResponse
} from "@agentclientprotocol/sdk/experimental/v2";
import type { ClientToolCallNameCapability } from "../initialize.js";
import { sessionConfigOptionsV1, sessionConfigOptionsV2 } from "./config-options.js";
import { sessionModeState } from "./modes.js";
import type { StoredSession } from "./store.js";
import type { SessionState } from "./types.js";
import { createTerminalOutputTracker, createToolCallContentTracker, expandSessionUpdateToV2 } from "./update-wire.js";

export interface ResumeSessionDeps {
  requireAuthenticated(cwd?: string): Promise<void>;
  reloadSession(
    sessionId: string,
    cwd: string | undefined,
    additionalDirectories: string[] | undefined
  ): Promise<{ session: SessionState; cwd: string; stored: StoredSession }>;
  replayConversation(
    session: SessionState,
    conversationId: string,
    cwd: string,
    emit: (update: v1.SessionUpdate) => Promise<void>,
    replayFrom?: unknown,
    v2UserMessageIdsByStep?: Record<string, string>
  ): Promise<void>;
}

/** v1 `session/resume`: reattach without replaying history. */
export async function handleResumeSessionV1(
  params: V1ResumeSessionRequest,
  client: V1AgentContext | undefined,
  deps: ResumeSessionDeps & {
    notifyAvailableCommandsV1(client: V1AgentContext, sessionId: string): Promise<void>;
  }
): Promise<V1ResumeSessionResponse> {
  await deps.requireAuthenticated(params.cwd);
  const { session } = await deps.reloadSession(params.sessionId, params.cwd, params.additionalDirectories);
  if (client) {
    await deps.notifyAvailableCommandsV1(client, params.sessionId);
  }
  return {
    modes: sessionModeState(session.agy.config.mode),
    configOptions: sessionConfigOptionsV1(session)
  };
}

/**
 * v2 `session/resume`: optional `replayFrom` cursor replaces v1
 * `session/load`. Omitting `replayFrom` reattaches without history.
 */
export async function handleResumeSessionV2(
  params: V2ResumeSessionRequest,
  client: V2AgentContext,
  deps: ResumeSessionDeps & {
    clientToolCallNameV2?(client: V2AgentContext): ClientToolCallNameCapability | undefined;
    notifyAvailableCommandsV2(client: V2AgentContext, sessionId: string): Promise<void>;
  }
): Promise<V2ResumeSessionResponse> {
  await deps.requireAuthenticated(params.cwd);
  const { session, cwd, stored } = await deps.reloadSession(
    params.sessionId,
    params.cwd,
    params.additionalDirectories
  );

  const replayFrom = params.replayFrom ?? null;
  if (replayFrom != null) {
    if (stored.conversationId) {
      const terminalTracker = createTerminalOutputTracker();
      const toolContentTracker = createToolCallContentTracker();
      const clientToolCallName = deps.clientToolCallNameV2?.(client);
      await deps.replayConversation(
        session,
        stored.conversationId,
        cwd,
        async (update) => {
          for (const v2Update of expandSessionUpdateToV2(
            update,
            terminalTracker,
            toolContentTracker,
            { clientToolCallName }
          )) {
            await client.notify(v2.methods.client.session.update, {
              sessionId: params.sessionId,
              update: v2Update
            });
          }
        },
        replayFrom,
        session.v2UserMessageIdsByStep
      );
    }
  }

  await deps.notifyAvailableCommandsV2(client, params.sessionId);

  return { configOptions: sessionConfigOptionsV2(session) };
}
