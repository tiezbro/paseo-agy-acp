interface CarouselUnrollState {
  inCarousel: boolean;
  buffer: string;
}

const SLIDE_REGEX = /[ \t]*<!--\s*slide\s*-->[ \t]*/gi;

export class CarouselUnroller {
  readonly #states = new Map<string, CarouselUnrollState>();

  reset(sessionId?: string): void {
    if (sessionId) {
      this.#states.delete(sessionId);
    } else {
      this.#states.clear();
    }
  }

  unroll(text: string, sessionId: string = "__default__"): string {
    let state = this.#states.get(sessionId);
    if (!state) {
      state = { inCarousel: false, buffer: "" };
      this.#states.set(sessionId, state);
    }

    const fullText = state.buffer + text;
    state.buffer = "";

    let result = "";
    let cursor = 0;

    while (cursor < fullText.length) {
      if (!state.inCarousel) {
        const remaining = fullText.slice(cursor);
        const match = remaining.match(/````carousel/i);
        if (!match || match.index === undefined) {
          const holdBack = this.#findTrailingPrefix(remaining, "````carousel");
          if (holdBack > 0) {
            result += remaining.slice(0, remaining.length - holdBack);
            state.buffer = remaining.slice(remaining.length - holdBack);
          } else {
            result += remaining;
          }
          break;
        }

        const matchIdx = cursor + match.index;
        result += fullText.slice(cursor, matchIdx);

        // Find newline after ````carousel
        const newlineIdx = fullText.indexOf("\n", matchIdx);
        if (newlineIdx === -1) {
          state.buffer = fullText.slice(matchIdx);
          break;
        }

        state.inCarousel = true;
        cursor = newlineIdx + 1;
      } else {
        const remaining = fullText.slice(cursor);
        const endMatch = remaining.match(/````/);
        if (!endMatch || endMatch.index === undefined) {
          const holdBack = this.#findTrailingPrefix(remaining, "````");
          let content = remaining;
          if (holdBack > 0) {
            content = remaining.slice(0, remaining.length - holdBack);
            state.buffer = remaining.slice(remaining.length - holdBack);
          }
          result += this.#cleanCarouselContent(content);
          break;
        }

        const endIdx = cursor + endMatch.index;
        const carouselBody = fullText.slice(cursor, endIdx);
        result += this.#cleanCarouselContent(carouselBody);

        let afterEnd = endIdx + 4;
        if (fullText.startsWith("\r\n", afterEnd)) {
          afterEnd += 2;
        } else if (fullText.startsWith("\n", afterEnd)) {
          afterEnd += 1;
        }

        state.inCarousel = false;
        cursor = afterEnd;
      }
    }

    return result;
  }

  #cleanCarouselContent(content: string): string {
    // Replace <!-- slide --> with empty/newline separation without generating redundant blank lines
    return content.replace(SLIDE_REGEX, "");
  }

  #findTrailingPrefix(str: string, target: string): number {
    const maxLen = Math.min(target.length - 1, str.length);
    for (let len = maxLen; len > 0; len--) {
      if (str.toLowerCase().endsWith(target.slice(0, len).toLowerCase())) {
        return len;
      }
    }
    return 0;
  }
}
