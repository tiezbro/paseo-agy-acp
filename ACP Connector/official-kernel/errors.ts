import { isRecord, jsonRpcError, type JsonRpcFailure, type JsonRpcId } from "./json-rpc.js";

const VISIBLE_UPDATE_KINDS = new Set([
  "agent_message_chunk",
  "agent_message",
  "message",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update"
]);

export function sessionUpdateShowsVisibleOutput(params: unknown): boolean {
  if (!isRecord(params)) return false;
  const update = isRecord(params.update) ? params.update : params;
  const kind =
    (typeof update.sessionUpdate === "string" && update.sessionUpdate) ||
    (typeof update.session_update === "string" && update.session_update) ||
    (typeof update.type === "string" && update.type) ||
    "";
  if (VISIBLE_UPDATE_KINDS.has(kind)) return true;
  if (isRecord(update.content) && typeof update.content.text === "string" && update.content.text.trim()) {
    return true;
  }
  return false;
}

export function isSuccessfulEndTurn(result: unknown): boolean {
  if (!isRecord(result)) return false;
  const stop =
    (typeof result.stopReason === "string" && result.stopReason) ||
    (typeof result.stop_reason === "string" && result.stop_reason) ||
    "end_turn";
  return stop === "end_turn" || stop === "end_of_turn";
}

export function shouldRejectBlankTurn(result: unknown, sawVisibleOutput: boolean): boolean {
  return !sawVisibleOutput && isSuccessfulEndTurn(result);
}

export function blankTurnError(id: JsonRpcId): JsonRpcFailure {
  return jsonRpcError(
    id,
    "official kernel completed the turn without visible assistant output",
    -32000
  );
}
