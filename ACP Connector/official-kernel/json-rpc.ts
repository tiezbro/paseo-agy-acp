export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc?: string;
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc?: string;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc?: string;
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc?: string;
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonRpcMessage(value: unknown): value is JsonRpcMessage {
  return isRecord(value) && (typeof value.method === "string" || "result" in value || "error" in value);
}

export function isJsonRpcRequest(value: JsonRpcMessage): value is JsonRpcRequest {
  return "method" in value && typeof value.method === "string" && "id" in value && value.id !== undefined;
}

export function isJsonRpcNotification(value: JsonRpcMessage): value is JsonRpcNotification {
  return "method" in value && typeof value.method === "string" && !("id" in value);
}

export function isJsonRpcSuccess(value: JsonRpcMessage): value is JsonRpcSuccess {
  return "id" in value && "result" in value && !("method" in value);
}

export function isJsonRpcFailure(value: JsonRpcMessage): value is JsonRpcFailure {
  return "id" in value && "error" in value && !("method" in value);
}

export function jsonRpcError(
  id: JsonRpcId,
  message: string,
  code = -32000,
  data?: unknown
): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: data === undefined ? { code, message } : { code, message, data }
  };
}
