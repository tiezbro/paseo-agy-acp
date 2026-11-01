import { AgyTerminalProviderError } from "../admission/dispatch-boundary.js";
import { classifyProviderFailure } from "../admission/errors.js";
import { isRecord, jsonRpcError, type JsonRpcFailure, type JsonRpcId } from "./json-rpc.js";

export function sessionUpdateShowsVisibleOutput(params: unknown): boolean {
  if (!isRecord(params)) return false;
  const update = isRecord(params.update) ? params.update : params;
  const kind =
    (typeof update.sessionUpdate === "string" && update.sessionUpdate) ||
    (typeof update.session_update === "string" && update.session_update) ||
    (typeof update.type === "string" && update.type) ||
    "";
  if (["tool_call", "tool_call_update", "tool", "tool_update"].includes(kind)) return true;
  // 同时兼容单块和块数组；未知扩展块保留透传语义，不因本地类型表落后而报空轮次。
  const blocks = Array.isArray(update.content) ? update.content : [update.content];
  return blocks.some(block => {
    if (!isRecord(block)) return false;
    if (block.type === "text" || block.type === undefined) {
      return typeof block.text === "string" && block.text.trim().length > 0;
    }
    if (typeof block.type !== "string" || !block.type.trim()) return false;
    // 非文本块必须携带负载；仅有 type 或 _meta 不算输出。
    return Object.keys(block).some(key => key !== "type" && key !== "_meta");
  });
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

/** 只读取结构化证据，绝不从用户/模型文本猜测错误类别。 */
export function officialResponseError(response: JsonRpcFailure): AgyTerminalProviderError {
  const data = isRecord(response.error.data) ? response.error.data : {};
  const nested = isRecord(data.error) ? data.error : data;
  const httpStatus = [nested.httpStatus, nested.status, nested.code, data.httpStatus, data.status]
    .find((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);
  const code = typeof nested.code === "string" ? nested.code : typeof nested.status === "string" ? nested.status : undefined;
  const details = Array.isArray(nested.details) ? nested.details : [];
  const detail = details.find(item => isRecord(item) && typeof item.reason === "string");
  const reason = typeof nested.reason === "string" ? nested.reason : isRecord(detail) && typeof detail.reason === "string" ? detail.reason : undefined;
  return new AgyTerminalProviderError("official kernel returned a JSON-RPC error", [], null, "",
    classifyProviderFailure({ httpStatus, code, reason }));
}
