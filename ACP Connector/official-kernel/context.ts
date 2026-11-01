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

export function extractCwd(
  params: unknown,
  environment: NodeJS.ProcessEnv = process.env
): string | undefined {
  const cwd = isRecord(params) && typeof params.cwd === "string" ? params.cwd.trim() : "";
  return cwd || environment.PASEO_AGENT_CWD?.trim() || undefined;
}

/** 官方 1.4.5 原生 append 是会话快照；默认动态模式继续逐轮读取。 */
export class PaseoSessionContext {
  #nativeSupported = false;
  readonly #nativeSessions = new Set<string>();

  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  observeInitialize(result: unknown): void {
    const capabilities = isRecord(result) && isRecord(result.agentCapabilities) ? result.agentCapabilities : {};
    const meta = isRecord(capabilities._meta) ? capabilities._meta : {};
    const agy = isRecord(meta.antigravity) ? meta.antigravity : {};
    this.#nativeSupported = isRecord(agy.systemPrompt) && agy.systemPrompt.append === true;
  }

  async prepareSession(params: unknown): Promise<{ params: unknown; native: boolean }> {
    const native = this.#nativeSupported && this.environment.PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT === "1";
    if (!native || !isRecord(params)) return { params, native: false };
    const append = await readPaseoDaemonAppendSystemPrompt(this.environment);
    if (!append) return { params, native: true };
    const meta = isRecord(params._meta) ? params._meta : {};
    const agy = isRecord(meta.antigravity) ? meta.antigravity : {};
    const systemPrompt = isRecord(agy.systemPrompt) ? agy.systemPrompt : {};
    const prior = typeof systemPrompt.append === "string" ? systemPrompt.append : "";
    return {
      native: true,
      params: { ...params, _meta: { ...meta, antigravity: { ...agy, systemPrompt: {
        ...systemPrompt, append: [prior, append].filter(Boolean).join("\n\n")
      } } } }
    };
  }

  bindSession(sessionId: string, native: boolean): void {
    if (native) this.#nativeSessions.add(sessionId);
    else this.#nativeSessions.delete(sessionId);
  }

  forgetSession(sessionId: string): void { this.#nativeSessions.delete(sessionId); }

  async injectPrompt(params: unknown): Promise<unknown> {
    const sessionId = extractSessionId(params);
    if (sessionId && this.#nativeSessions.has(sessionId)) return params;
    return injectPaseoContext(params, this.environment);
  }
}
