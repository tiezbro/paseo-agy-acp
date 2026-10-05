import { isRecord, type JsonRpcMessage } from "./json-rpc.js";
import { CarouselUnroller } from "./carousel-unroll.js";

const SYSTEM_MESSAGE_START_PREFIX = "The following is a <SYSTEM_MESSAGE>";
const SYSTEM_MESSAGE_TAG_START = "<SYSTEM_MESSAGE>";
const SYSTEM_MESSAGE_TAG_END = "</SYSTEM_MESSAGE>";

interface StreamFoldState {
  inSystemMessage: boolean;
  buffer: string;
}

export class SystemMessageFolder {
  readonly #states = new Map<string, StreamFoldState>();
  readonly #carouselUnroller = new CarouselUnroller();

  reset(sessionId?: string): void {
    if (sessionId) {
      this.#states.delete(sessionId);
      this.#carouselUnroller.reset(sessionId);
    } else {
      this.#states.clear();
      this.#carouselUnroller.reset();
    }
  }

  transform(message: JsonRpcMessage): JsonRpcMessage[] {
    if (
      !isRecord(message) ||
      message.method !== "session/update" ||
      !isRecord(message.params) ||
      !isRecord(message.params.update)
    ) {
      return [message];
    }

    const update = message.params.update;
    const sessionUpdate = update.sessionUpdate;
    if (sessionUpdate !== "agent_message_chunk" && sessionUpdate !== "agent_message") {
      return [message];
    }

    const content = update.content;
    if (!isRecord(content) || content.type !== "text" || typeof content.text !== "string") {
      return [message];
    }

    const sessionId = typeof message.params.sessionId === "string" ? message.params.sessionId : "__default__";
    let state = this.#states.get(sessionId);
    if (!state) {
      state = { inSystemMessage: false, buffer: "" };
      this.#states.set(sessionId, state);
    }

    const rawText = state.buffer + content.text;
    state.buffer = "";

    const segments = this.#splitText(rawText, state);
    if (segments.length === 0) {
      return [];
    }

    const results: JsonRpcMessage[] = [];
    const baseParams = message.params as Record<string, unknown>;
    const baseUpdate = update as Record<string, unknown>;
    const originalMessageId = typeof baseUpdate.messageId === "string" ? baseUpdate.messageId : undefined;

    for (const segment of segments) {
      if (segment.text.length === 0) continue;

      if (segment.isSystem) {
        const thoughtMessageId = originalMessageId
          ? `${originalMessageId}:system-folded`
          : "system-folded";

        results.push({
          ...message,
          params: {
            ...baseParams,
            update: {
              ...baseUpdate,
              sessionUpdate: "agent_thought_chunk",
              messageId: thoughtMessageId,
              content: {
                ...content,
                text: segment.text,
              },
            },
          },
        });
      } else {
        const unrolledText = this.#carouselUnroller.unroll(segment.text, sessionId);
        if (unrolledText.length === 0) continue;

        results.push({
          ...message,
          params: {
            ...baseParams,
            update: {
              ...baseUpdate,
              content: {
                ...content,
                text: unrolledText,
              },
            },
          },
        });
      }
    }

    return results;
  }

  #splitText(
    text: string,
    state: StreamFoldState
  ): Array<{ isSystem: boolean; text: string }> {
    const segments: Array<{ isSystem: boolean; text: string }> = [];
    let cursor = 0;

    while (cursor < text.length) {
      if (!state.inSystemMessage) {
        let startIdx = text.indexOf(SYSTEM_MESSAGE_START_PREFIX, cursor);
        const tagIdx = text.indexOf(SYSTEM_MESSAGE_TAG_START, cursor);

        if (startIdx === -1 || (tagIdx !== -1 && tagIdx < startIdx)) {
          startIdx = tagIdx;
        }

        if (startIdx === -1) {
          // Check for trailing partial prefix at the end of text
          const remaining = text.slice(cursor);
          const holdBack = this.#findTrailingPrefixLength(remaining);
          if (holdBack > 0) {
            const emitLen = remaining.length - holdBack;
            if (emitLen > 0) {
              segments.push({ isSystem: false, text: remaining.slice(0, emitLen) });
            }
            state.buffer = remaining.slice(emitLen);
          } else {
            segments.push({ isSystem: false, text: remaining });
          }
          break;
        }

        // Emit any regular text before the start of system message
        if (startIdx > cursor) {
          segments.push({ isSystem: false, text: text.slice(cursor, startIdx) });
        }

        state.inSystemMessage = true;
        cursor = startIdx;
      } else {
        // Look for end tag
        const endTagIdx = text.indexOf(SYSTEM_MESSAGE_TAG_END, cursor);
        if (endTagIdx === -1) {
          // No end tag in this chunk. Check for trailing partial prefix of </SYSTEM_MESSAGE>
          const remaining = text.slice(cursor);
          const holdBack = this.#findTrailingEndPrefixLength(remaining);
          if (holdBack > 0) {
            const emitLen = remaining.length - holdBack;
            if (emitLen > 0) {
              segments.push({ isSystem: true, text: remaining.slice(0, emitLen) });
            }
            state.buffer = remaining.slice(emitLen);
          } else {
            segments.push({ isSystem: true, text: remaining });
          }
          break;
        }

        let endIdx = endTagIdx + SYSTEM_MESSAGE_TAG_END.length;
        // Optionally consume trailing newlines right after </SYSTEM_MESSAGE>
        if (text.startsWith("\r\n", endIdx)) {
          endIdx += 2;
        } else if (text.startsWith("\n", endIdx)) {
          endIdx += 1;
        }

        segments.push({ isSystem: true, text: text.slice(cursor, endIdx) });
        state.inSystemMessage = false;
        cursor = endIdx;
      }
    }

    return segments;
  }

  #findTrailingPrefixLength(str: string): number {
    const candidates = [SYSTEM_MESSAGE_START_PREFIX, SYSTEM_MESSAGE_TAG_START];
    let maxMatch = 0;
    for (const cand of candidates) {
      const maxLen = Math.min(cand.length - 1, str.length);
      for (let len = maxLen; len > 0; len--) {
        if (str.endsWith(cand.slice(0, len))) {
          if (len > maxMatch) maxMatch = len;
          break;
        }
      }
    }
    return maxMatch;
  }

  #findTrailingEndPrefixLength(str: string): number {
    const maxLen = Math.min(SYSTEM_MESSAGE_TAG_END.length - 1, str.length);
    for (let len = maxLen; len > 0; len--) {
      if (str.endsWith(SYSTEM_MESSAGE_TAG_END.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }
}
