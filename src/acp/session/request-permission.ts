// ACP session/request_permission: ask the client to approve/deny a pending
// tool call, racing the request against prompt-turn cancellation.
// Docs: https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission

import * as v1 from "@agentclientprotocol/sdk";
import type { AgentContext as V1AgentContext, SessionUpdate as V1SessionUpdate } from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import type { AgentContext as V2AgentContext } from "@agentclientprotocol/sdk/experimental/v2";
import type { ClientToolCallNameCapability } from "../initialize.js";
import { permissionOptions, parseAskQuestion, type PermissionChoice } from "../tool-calls/permissions.js";
import {
  buildElicitationRequestFromAskQuestion,
  encodeElicitationKeys,
  type ClientElicitationCapability,
  type ElicitationCreateResponseResult
} from "../tool-calls/elicitation.js";
import { expandSessionUpdateToV2, sessionUpdateToV2 } from "./update-wire.js";

/** v1 `session/request_permission` or `elicitation/create`: race request against turn cancellation. */
export async function requestPermissionV1(
  client: V1AgentContext,
  sessionId: string,
  toolCall: V1SessionUpdate,
  toolName: string | undefined,
  signal: AbortSignal | undefined,
  questionIndex?: number,
  clientElicitation?: ClientElicitationCapability,
  clientToolCallName?: ClientToolCallNameCapability
): Promise<PermissionChoice | "cancelled"> {
  if (signal?.aborted) return "cancelled";

  if (toolName === "ask_question" && clientElicitation?.form) {
    const elicitationParams = buildElicitationRequestFromAskQuestion(toolCall, sessionId, questionIndex);
    if (elicitationParams) {
      const response = (await racePermissionCancellation(
        client.request(v1.methods.client.elicitation.create, elicitationParams as any),
        signal
      )) as ElicitationCreateResponseResult | null;

      if (!response || signal?.aborted) return "cancelled";
      if (response.action === "decline" || response.action === "cancel") {
        return "agy-q-skip";
      }
      if (response.action === "accept") {
        const encoded = encodeElicitationKeys(toolCall, response.content, questionIndex);
        return encoded ? `pty-keys:${encoded}` : "agy-q-skip";
      }
      return "cancelled";
    }
  }

  const { sessionUpdate: _discriminator, ...requestToolCall } = toolCall as unknown as Record<string, unknown>;
  const toolCallPayload = { ...requestToolCall };
  if (clientToolCallName?.name !== true) {
    delete toolCallPayload.name;
  }
  if (toolName === "ask_question") {
    const ask = parseAskQuestion(toolCall);
    const qIdx = questionIndex ?? 0;
    if (ask && qIdx < ask.questions.length) {
      const q = ask.questions[qIdx];
      const origTitle = String(toolCallPayload.title ?? "Question");
      const qText = q.question || origTitle;
      toolCallPayload.title = ask.questions.length > 1 ? `[Question ${qIdx + 1}/${ask.questions.length}] ${qText}` : qText;
    }
  }

  const response = await racePermissionCancellation(
    client.request(v1.methods.client.session.requestPermission, {
      sessionId,
      toolCall: toolCallPayload as v1.ToolCallUpdate,
      options: permissionOptions(toolCall, toolName, questionIndex)
    }),
    signal
  );
  return selectedPermission(response, signal);
}

/** v2 `session/request_permission` or `elicitation/create`: race request against turn cancellation. */
export async function requestPermissionV2(
  client: V2AgentContext,
  sessionId: string,
  toolCall: V1SessionUpdate,
  toolName: string | undefined,
  signal: AbortSignal,
  questionIndex?: number,
  clientElicitation?: ClientElicitationCapability,
  clientToolCallName?: ClientToolCallNameCapability
): Promise<PermissionChoice | "cancelled"> {
  if (signal.aborted) return "cancelled";

  if (toolName === "ask_question" && clientElicitation?.form) {
    const elicitationParams = buildElicitationRequestFromAskQuestion(toolCall, sessionId, questionIndex);
    if (elicitationParams) {
      const response = (await racePermissionCancellation(
        client.request(v2.methods.client.elicitation.create, elicitationParams as any),
        signal
      )) as ElicitationCreateResponseResult | null;

      if (!response || signal.aborted) return "cancelled";
      if (response.action === "decline" || response.action === "cancel") {
        return "agy-q-skip";
      }
      if (response.action === "accept") {
        const encoded = encodeElicitationKeys(toolCall, response.content, questionIndex);
        return encoded ? `pty-keys:${encoded}` : "agy-q-skip";
      }
      return "cancelled";
    }
  }

  const options = { clientToolCallName };
  const expanded = expandSessionUpdateToV2(toolCall, undefined, undefined, options);
  const converted = (expanded.find((item) => {
    const kind = (item as unknown as { sessionUpdate?: string }).sessionUpdate;
    return kind === "tool_call_update" || kind === "tool_call";
  }) ?? sessionUpdateToV2(toolCall, options)) as unknown as Record<string, unknown>;
  const { sessionUpdate: _discriminator, ...requestToolCall } = converted;

  let title = String(requestToolCall.title ?? "Permission required");
  if (toolName === "ask_question") {
    const ask = parseAskQuestion(toolCall);
    const qIdx = questionIndex ?? 0;
    if (ask && ask.questions.length > 1 && qIdx < ask.questions.length) {
      const q = ask.questions[qIdx];
      title = `[Question ${qIdx + 1}/${ask.questions.length}] ${q.question || title}`;
    }
  }

  const response = await racePermissionCancellation(
    client.request(v2.methods.client.session.requestPermission, {
      sessionId,
      title,
      subject: { type: "tool_call", toolCall: requestToolCall as v2.ToolCallUpdate },
      options: permissionOptions(toolCall, toolName, questionIndex)
    }),
    signal
  );
  return selectedPermission(response, signal);
}

function selectedPermission(response: unknown, signal?: AbortSignal): PermissionChoice | "cancelled" {
  if (signal?.aborted || !response || typeof response !== "object") return "cancelled";
  const outcome = (response as { outcome?: unknown }).outcome;
  if (!outcome || typeof outcome !== "object" || (outcome as { outcome?: string }).outcome !== "selected") return "cancelled";
  const id = (outcome as { optionId?: string }).optionId;
  if (typeof id !== "string" || !id.trim()) return "cancelled";
  // Standard ACP ids, legacy agy-* ids, and ask_question option ids.
  if (
    id === "allow-once" ||
    id === "allow-always" ||
    id === "reject-once" ||
    id === "agy-allow-once" ||
    id === "agy-allow-conversation" ||
    id === "agy-allow-settings" ||
    id === "agy-reject-once" ||
    id.startsWith("agy-q-")
  ) {
    return id;
  }
  return "cancelled";
}

async function racePermissionCancellation<T>(request: Promise<T>, signal?: AbortSignal): Promise<T | null> {
  if (!signal) return request;
  if (signal.aborted) return null;
  // A client may eventually reject a request abandoned because the turn was
  // cancelled. Attach a handler now so that rejection is never unhandled.
  const guarded = request.then((value) => value, (error) => {
    if (signal.aborted) return null;
    throw error;
  });
  let abort!: () => void;
  const cancelled = new Promise<null>((resolve) => {
    abort = () => resolve(null);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([guarded, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
