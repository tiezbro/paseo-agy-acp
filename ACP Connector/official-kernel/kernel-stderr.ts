import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";

const MAX_PENDING_CHARACTERS = 8 * 1024;
const GENAI_TYPES_PATH = /^(?:\/|[A-Za-z]:[/\\]|\\\\).+[/\\]google3[/\\]third_party[/\\]py[/\\]google[/\\]genai[/\\]types\.py:[1-9]\d*: /;
const INVALID_ESCAPE_WARNING = String.raw`SyntaxWarning: "\/" is an invalid escape sequence. Such sequences will not work in the future. Did you mean "\\/"? A raw string is also an option.`;
const UPLOAD_DESCRIPTION = "Output only. The original name of the uploaded file, taken from the " +
  "`Content-Disposition` header on upload. Between 1 and 255 characters. Control characters and the characters " +
  "`<>:\"|?*\\/` are not accepted.";

/** 仅过滤官方依赖已知的两行说明字符串警告；其余 stderr 原样保留。 */
export function createKernelStderrFilter(): Transform {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let warning: string | undefined;
  let overflowing = false;
  const deliver = (line: string, push: (text: string) => void): void => {
    const text = line.replace(/\r?\n$/, "");
    if (warning !== undefined) {
      const source = text.trim();
      if (source === `description="""${UPLOAD_DESCRIPTION}""",` || source === `"""${UPLOAD_DESCRIPTION}"""`) {
        warning = undefined;
        return;
      }
      push(warning);
      warning = undefined;
    }
    if (GENAI_TYPES_PATH.test(text) && text.endsWith(INVALID_ESCAPE_WARNING)) warning = line;
    else push(line);
  };
  return new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      const push = (text: string) => { this.push(text); };
      pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        if (overflowing) {
          push(line);
          overflowing = false;
        } else deliver(line, push);
      }
      if (pending.length > MAX_PENDING_CHARACTERS) {
        if (warning !== undefined) push(warning);
        warning = undefined;
        push(pending);
        pending = "";
        overflowing = true;
      }
      callback();
    },
    flush(callback) {
      pending += decoder.end();
      if (overflowing) this.push(pending);
      else if (pending.length > 0) deliver(pending, text => { this.push(text); });
      if (warning !== undefined) this.push(warning);
      callback();
    }
  });
}
