import { isRecord, type JsonRpcMessage } from "./json-rpc.js";
import { CarouselUnroller } from "./carousel-unroll.js";

const SYSTEM_MESSAGE_START_PREFIX = "The following is a <SYSTEM_MESSAGE>";
const SYSTEM_MESSAGE_TAG_START = "<SYSTEM_MESSAGE>";
const SYSTEM_MESSAGE_TAG_END = "</SYSTEM_MESSAGE>";
const MAX_PENDING_LENGTH = 64 * 1024;

interface StreamFoldState {
  buffer: string;
  line: string;
  fence?: { marker: string; length: number };
  disabled: boolean;
  messageId?: string;
  outputMessageId?: string;
  template: JsonRpcMessage;
}

interface TextSegment {
  isSystem: boolean;
  text: string;
}

export class SystemMessageFolder {
  readonly #states = new Map<string, StreamFoldState>();
  readonly #carouselUnroller = new CarouselUnroller();
  readonly #usedMessageIds = new Map<string, Set<string>>();
  #messageSequence = 0;

  reset(sessionId?: string): void {
    if (sessionId) {
      this.#states.delete(sessionId);
      this.#carouselUnroller.reset(sessionId);
    } else {
      this.#states.clear();
      this.#carouselUnroller.reset();
    }
  }

  // 结束、取消或切换消息时，未确认的片段必须还给正文，不能直接丢弃。
  finish(sessionId?: string): JsonRpcMessage[] {
    const results: JsonRpcMessage[] = [];
    const sessionIds = sessionId === undefined ? [...this.#states.keys()] : [sessionId];
    for (const id of sessionIds) {
      const state = this.#states.get(id);
      if (!state) continue;
      const text = this.#carouselUnroller.unroll(state.buffer, id) + this.#carouselUnroller.finish(id);
      if (text) results.push(this.#withText(state.template, text, false, state.outputMessageId));
      this.#states.delete(id);
    }
    return results;
  }

  transform(message: JsonRpcMessage): JsonRpcMessage[] {
    if (
      !isRecord(message) || message.method !== "session/update" ||
      !isRecord(message.params) || !isRecord(message.params.update) ||
      typeof message.params.sessionId !== "string"
    ) return [message];

    const sessionId = message.params.sessionId;
    const update = message.params.update;
    const content = update.content;
    if (
      (update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_message") ||
      !isRecord(content) || content.type !== "text" || typeof content.text !== "string"
    ) {
      // 保持工具事件、原生思考与缓冲正文的先后顺序，原生思考不做改写。
      return [...this.finish(sessionId), message];
    }

    const messageId = typeof update.messageId === "string" ? update.messageId : undefined;
    const results: JsonRpcMessage[] = [];
    let state = this.#states.get(sessionId);
    if (state && state.messageId !== messageId) {
      results.push(...this.finish(sessionId));
      state = undefined;
    }
    if (!state) {
      state = {
        buffer: "", line: "", disabled: false, messageId, template: message,
        outputMessageId: this.#allocateMessageId(sessionId, messageId)
      };
      this.#states.set(sessionId, state);
    }
    state.template = message;
    const rawText = state.buffer + content.text;
    state.buffer = "";
    for (const segment of this.#splitText(rawText, state)) {
      const text = segment.isSystem ? segment.text : this.#carouselUnroller.unroll(segment.text, sessionId);
      if (text) results.push(this.#withText(message, text, segment.isSystem, state.outputMessageId));
      if (segment.isSystem) state.outputMessageId = this.#allocateMessageId(sessionId, messageId);
    }
    if (update.sessionUpdate === "agent_message") results.push(...this.finish(sessionId));
    return results;
  }

  // Paseo 会按显式 messageId 拼接正文；独立消息不能复用内核的旧 ID。
  #allocateMessageId(sessionId: string, messageId?: string): string | undefined {
    let usedIds = this.#usedMessageIds.get(sessionId);
    if (!usedIds) {
      usedIds = new Set<string>();
      this.#usedMessageIds.set(sessionId, usedIds);
    }
    // 空字符串记录首次无 ID 的流；之后必须显式结束 Paseo 的备用 ID。
    let outputId = messageId || "";
    while (usedIds.has(outputId)) outputId = `${messageId || "system"}:paseo-segment:${++this.#messageSequence}`;
    usedIds.add(outputId);
    return outputId || undefined;
  }

  #withText(message: JsonRpcMessage, text: string, isSystem: boolean, messageId?: string): JsonRpcMessage {
    const params = ("params" in message ? message.params : {}) as Record<string, unknown>;
    const update = params.update as Record<string, unknown>;
    const content = update.content as Record<string, unknown>;
    return {
      ...message,
      params: {
        ...params,
        update: {
          ...update,
          ...(messageId === undefined ? {} : { messageId }),
          ...(isSystem ? {
            _meta: { ...(isRecord(update._meta) ? update._meta : {}), "paseo.dev/messageKind": "system" },
            messageId: `${messageId ?? "system"}:system`
          } : {}),
          content: { ...content, text }
        }
      }
    };
  }

  #splitText(text: string, state: StreamFoldState): TextSegment[] {
    const segments: TextSegment[] = [];
    let ordinary = "";
    for (let cursor = 0; cursor < text.length;) {
      // 只识别代码块外、行首的事件封套，正文中的标签引用不参与识别。
      if (!state.disabled && !state.fence && /^ {0,3}$/.test(state.line)) {
        const remaining = text.slice(cursor);
        const candidates = [SYSTEM_MESSAGE_START_PREFIX, SYSTEM_MESSAGE_TAG_START];
        if (candidates.some(prefix => remaining.startsWith(prefix) || prefix.startsWith(remaining))) {
          const length = this.#eventLength(remaining);
          if (length === undefined && remaining.length <= MAX_PENDING_LENGTH) {
            state.buffer = remaining;
            break;
          }
          if (length === undefined) state.disabled = true;
          if (length !== undefined && length > 0) {
            if (ordinary) segments.push({ isSystem: false, text: ordinary });
            ordinary = "";
            const event = remaining.slice(0, length);
            segments.push({ isSystem: true, text: event });
            for (const char of event) this.#advanceLine(char, state);
            cursor += length;
            continue;
          }
        }
      }
      const char = text[cursor++];
      ordinary += char;
      this.#advanceLine(char, state);
    }
    if (ordinary) segments.push({ isSystem: false, text: ordinary });
    return segments;
  }

  // undefined 表示需要更多分块；0 表示普通文本。确认闭合后才标记为系统信息。
  #eventLength(text: string): number | undefined {
    let opening = 0;
    if (text.startsWith(SYSTEM_MESSAGE_START_PREFIX)) {
      const newline = text.indexOf("\n");
      if (newline === -1) return undefined;
      opening = newline + 1;
      while (opening < text.length && /\s/.test(text[opening])) opening++;
    } else if (SYSTEM_MESSAGE_START_PREFIX.startsWith(text)) {
      return undefined;
    }
    const rest = text.slice(opening);
    if (SYSTEM_MESSAGE_TAG_START.startsWith(rest)) return undefined;
    if (!rest.startsWith(SYSTEM_MESSAGE_TAG_START)) return 0;
    const bodyStart = opening + SYSTEM_MESSAGE_TAG_START.length;
    const body = text.slice(bodyStart).trimStart();
    if ("[Message]".startsWith(body)) return undefined;
    if (!/^\[Message\]\s/.test(body)) return 0;
    const end = text.indexOf(SYSTEM_MESSAGE_TAG_END, bodyStart);
    const nested = text.indexOf(SYSTEM_MESSAGE_TAG_START, bodyStart);
    if (nested !== -1 && (end === -1 || nested < end)) return 0;
    if (end === -1) return undefined;
    return end + SYSTEM_MESSAGE_TAG_END.length;
  }

  #advanceLine(char: string, state: StreamFoldState): void {
    if (char !== "\n") {
      // 行上下文只用于判定缩进与围栏，避免超长正文行占用无限内存。
      if (state.line.length < 1024) state.line += char;
      return;
    }
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(state.line.replace(/\r$/, ""));
    if (fence) {
      const marker = fence[1][0];
      if (state.fence) {
        if (marker === state.fence.marker && fence[1].length >= state.fence.length && /^\s*$/.test(fence[2])) {
          state.fence = undefined;
        }
      } else if (marker === "~" || !fence[2].includes("`")) {
        state.fence = { marker, length: fence[1].length };
      }
    }
    state.line = "";
  }
}
