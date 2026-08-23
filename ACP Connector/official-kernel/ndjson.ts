import { isJsonRpcMessage, type JsonRpcMessage } from "./json-rpc.js";

export function encodeNdjson(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function createNdjsonParser(onMessage: (message: JsonRpcMessage) => void, onInvalid?: (line: string) => void) {
  let buffer = "";
  return (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "").trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        try {
          const parsed: unknown = JSON.parse(line);
          if (isJsonRpcMessage(parsed)) onMessage(parsed);
          else onInvalid?.(line);
        } catch {
          onInvalid?.(line);
        }
      }
      newline = buffer.indexOf("\n");
    }
  };
}
