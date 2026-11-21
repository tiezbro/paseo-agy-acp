import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createKernelStderrFilter } from "../ACP Connector/official-kernel/kernel-stderr.js";
import { createKernelEventFilter, KERNEL_EVENT_PREFIX, type KernelEvent } from "../ACP Connector/official-kernel/kernel-events.js";

const DESCRIPTION = "Output only. The original name of the uploaded file, taken from the " +
  "`Content-Disposition` header on upload. Between 1 and 255 characters. Control characters and the characters " +
  "`<>:\"|?*\\/` are not accepted.";
const WARNING = String.raw`SyntaxWarning: "\/" is an invalid escape sequence. Such sequences will not work in the future. Did you mean "\\/"? A raw string is also an option.`;
const FILE = "/kernel/agy_acp_server.runfiles/google3/third_party/py/google/genai/types.py";
const header = `${FILE}:18270: ${WARNING}\n`;
const source = `  description="""${DESCRIPTION}""",\n`;

async function filtered(chunks: Array<string | Buffer>): Promise<string> {
  const filter = createKernelStderrFilter();
  let output = "";
  filter.setEncoding("utf8");
  filter.on("data", chunk => { output += chunk; });
  const done = once(filter, "end");
  for (const chunk of chunks) filter.write(chunk);
  filter.end();
  await done;
  return output;
}

describe("官方依赖 stderr 告警过滤", () => {
  it.each([
    FILE,
    "/Users/test/kernel/google3/third_party/py/google/genai/types.py",
    "C:\\kernel\\google3\\third_party\\py\\google\\genai\\types.py"
  ])("精确过滤两处说明字符串，支持路径 %s 及 CRLF", async file => {
    const text = `before\r\n${file}:18270: ${WARNING}\r\n${source.trimEnd()}\r\n` +
      `${file}:18308: ${WARNING}\r\n  """${DESCRIPTION}"""\r\nafter\r\n`;
    expect(await filtered([text])).toBe("before\r\nafter\r\n");
  });

  it("警告及 UTF-8 正文在任意字节处分块，授权链接仍完整保留", async () => {
    const prompt = "授权🙂 https://accounts.example/authorize\n";
    const wire = Buffer.from(header + source + prompt, "utf8");
    for (let split = 1; split < wire.length; split++) {
      expect(await filtered([wire.subarray(0, split), wire.subarray(split)])).toBe(prompt);
    }
    expect(await filtered(Array.from(wire, byte => Buffer.from([byte])))).toBe(prompt);
  });

  it.each([
    header.replace("google/genai/types.py", "other/types.py") + source,
    header.replace("SyntaxWarning", "SyntaxError") + source,
    header.replace('"\\/"', '"\\d"') + source,
    "RuntimeError: " + header + source,
    header + "Open the following link to authenticate the ACP server: https://accounts.example/authorize\n",
    header + "Traceback (most recent call last):\nRuntimeError: real failure\n",
    header + source.replace("uploaded file", "different content"),
    source,
    header,
    header.trimEnd(),
    "ordinary partial stderr 你好🙂"
  ])("未知、残缺或独立告警原样保留：%s", async text => {
    expect(await filtered([text])).toBe(text);
  });

  it("超长行不无限缓冲，也不将其中的路径片段误认成独立告警", async () => {
    const prefix = "x".repeat(9000);
    const filter = createKernelStderrFilter();
    let output = "";
    filter.on("data", chunk => { output += String(chunk); });
    filter.write(prefix);
    expect(output).toBe(prefix);
    const done = once(filter, "end");
    filter.end(header + source);
    await done;
    expect(output).toBe(prefix + header + source);
    expect(await filtered([header, prefix, "\n", header, source, "tail"])).toBe(header + prefix + "\ntail");
  });

  it("过滤无换行的已知源行，保留后续内核事件交付", async () => {
    expect(await filtered([header, source.trimEnd()])).toBe("");
    const events: KernelEvent[] = [];
    const warnings = createKernelStderrFilter();
    const eventFilter = createKernelEventFilter(event => events.push(event));
    let output = "";
    warnings.pipe(eventFilter).on("data", chunk => { output += String(chunk); });
    const done = once(eventFilter, "end");
    const event = { v: 1 as const, event: "backend_http_error" as const, session: "s", httpStatus: 503 };
    warnings.end(header + source + KERNEL_EVENT_PREFIX + JSON.stringify(event) + "\nRuntimeError: retained\n");
    await done;
    expect(events).toEqual([event]);
    expect(output).toBe("RuntimeError: retained\n");
  });
});
