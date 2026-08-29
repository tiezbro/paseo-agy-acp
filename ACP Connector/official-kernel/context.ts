import { isRecord } from "./json-rpc.js";
import {
  readPaseoDaemonAppendSystemPrompt,
  wrapPaseoDaemonContextBlock
} from "../acp/session/paseo-context.js";

function prependTextBlock(prompt: unknown, text: string): unknown {
  const block = { type: "text", text };
  if (Array.isArray(prompt)) return [block, ...prompt];
  if (typeof prompt === "string") return `${text}\n\n${prompt}`;
  return [block];
}

export async function injectPaseoContext(
  params: unknown,
  environment: NodeJS.ProcessEnv = process.env
): Promise<unknown> {
  if (!isRecord(params)) return params;
  const append = await readPaseoDaemonAppendSystemPrompt(environment);
  if (!append) return params;
  return {
    ...params,
    prompt: prependTextBlock(params.prompt, wrapPaseoDaemonContextBlock(append))
  };
}

export function extractPromptText(params: unknown): string {
  if (!isRecord(params)) return "";
  const prompt = params.prompt;
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block) => {
      if (!isRecord(block)) return "";
      if (typeof block.text === "string") return block.text;
      if (isRecord(block.content) && typeof block.content.text === "string") return block.content.text;
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

export function extractSessionId(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  return typeof params.sessionId === "string"
    ? params.sessionId
    : typeof params.session_id === "string"
      ? params.session_id
      : undefined;
}

export function extractCwd(params: unknown): string | undefined {
  if (!isRecord(params)) return undefined;
  return typeof params.cwd === "string" && params.cwd.trim().length > 0
    ? params.cwd.trim()
    : undefined;
}

