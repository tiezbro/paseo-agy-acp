import { describe, expect, it } from "vitest";
import { SystemMessageFolder } from "../ACP Connector/official-kernel/system-message-fold.js";
import type { JsonRpcMessage } from "../ACP Connector/official-kernel/json-rpc.js";

function chunk(text: string, sessionId = "test-session", messageId = "test-message"): JsonRpcMessage {
  return {
    jsonrpc: "2.0", method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } } }
  };
}

function updates(messages: JsonRpcMessage[]): Array<{ sessionUpdate: string; content: { text: string } }> {
  return messages.map(message => (message as { params: { update: { sessionUpdate: string; content: { text: string } } } }).params.update);
}

const event = "<SYSTEM_MESSAGE>\n[Message] timestamp=2026-01-01T00:00:00Z sender=test-task content=Task finished\n</SYSTEM_MESSAGE>";

describe("系统消息折叠回归", () => {
  it("提到标签后仍然将 Markdown 作为正文输出", () => {
    const folder = new SystemMessageFolder();
    const text = "测试任务已启动，将触发系统的 `<SYSTEM_MESSAGE>` 通知。\n\n### 测试结果\n\n**任务完成**";
    const output = updates(folder.transform(chunk(text)));
    expect(output.every(update => update.sessionUpdate === "agent_message_chunk")).toBe(true);
    expect(output.map(update => update.content.text).join("")).toBe(text);
  });

  it.each(["```text", "~~~~text", "````text"])("保留 %s 中的系统消息示例", fence => {
    const folder = new SystemMessageFolder();
    const closing = fence.replace("text", "");
    const text = `${fence}\n${event}\n${closing}\n\n### 正文`;
    const output = updates(folder.transform(chunk(text)));
    expect(output.every(update => update.sessionUpdate === "agent_message_chunk")).toBe(true);
    expect(output.map(update => update.content.text).join("")).toBe(text);
  });

  it("未闭合事件不会将后续正文提前发为 Thinking", () => {
    const folder = new SystemMessageFolder();
    const output = updates(folder.transform(chunk("<SYSTEM_MESSAGE>\n[Message] sender=test-task\n\n### 普通回答")));
    expect(output.some(update => update.sessionUpdate === "agent_thought_chunk")).toBe(false);
  });

  it("任意分块位置都只折叠完整事件，并保留事件前后的正文", () => {
    const preface = "The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n";
    const folded = preface + event;
    const text = `### 开始\n\n${folded}\n\n### 完成\n\n**成功**`;
    for (let split = 1; split < text.length; split++) {
      const folder = new SystemMessageFolder();
      const output = updates([
        ...folder.transform(chunk(text.slice(0, split))),
        ...folder.transform(chunk(text.slice(split))),
        ...folder.finish("test-session")
      ]);
      expect(output.map(update => update.content.text).join(""), `split=${split}`).toBe(text);
      expect(output.filter(update => (update as { _meta?: Record<string, unknown> })._meta?.["paseo.dev/messageKind"] === "system").map(update => update.content.text).join(""), `split=${split}`).toBe(folded);
    }
  });

  it("逐字符分块保留代码示例和后续事件", () => {
    const folder = new SystemMessageFolder();
    const text = `~~~text\n${event}\n~~~\n\n${event}\n\n### 正文`;
    const output = updates([...Array.from(text).flatMap(char => folder.transform(chunk(char))), ...folder.finish("test-session")]);
    expect(output.map(update => update.content.text).join("")).toBe(text);
    expect(output.filter(update => (update as { _meta?: Record<string, unknown> })._meta?.["paseo.dev/messageKind"] === "system").map(update => update.content.text).join("")).toBe(event);
  });

  it.each(["T", "<SYSTEM_", "```", "<SYSTEM_MESSAGE>\n[Message] sender=test-task\n\n### 正文"])("结束时刷新未完成片段 %s", text => {
    const folder = new SystemMessageFolder();
    const output = updates([...folder.transform(chunk(text)), ...folder.finish("test-session")]);
    expect(output.every(update => update.sessionUpdate === "agent_message_chunk")).toBe(true);
    expect(output.map(update => update.content.text).join("")).toBe(text);
    expect(folder.finish("test-session")).toEqual([]);
    const next = updates(folder.transform(chunk("下一轮正文")));
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ sessionUpdate: "agent_message_chunk", content: { text: "下一轮正文" } });
  });

  it("切换 messageId 时将旧消息未闭合片段还给旧消息", () => {
    const folder = new SystemMessageFolder();
    expect(folder.transform(chunk("<SYSTEM_", "test-session", "old"))).toEqual([]);
    expect(folder.transform(chunk("### 新消息", "test-session", "new"))).toEqual([
      chunk("<SYSTEM_", "test-session", "old"), chunk("### 新消息", "test-session", "new")
    ]);
  });

  it("保留原生 Thinking，并在它之前刷新待定正文", () => {
    const folder = new SystemMessageFolder();
    folder.transform(chunk("<SYSTEM_"));
    const thought: JsonRpcMessage = {
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId: "test-session", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "### 原生思考" } } }
    };
    expect(folder.transform(thought)).toEqual([chunk("<SYSTEM_"), thought]);
  });

  it("超长未闭合事件按正文释放，避免无限等待", () => {
    const folder = new SystemMessageFolder();
    const text = "<SYSTEM_MESSAGE>\n[Message] sender=test-task content=" + "a".repeat(65536);
    const output = updates(folder.transform(chunk(text)));
    expect(output.every(update => update.sessionUpdate === "agent_message_chunk")).toBe(true);
    expect(output.map(update => update.content.text).join("")).toBe(text);
    expect(folder.transform(chunk("\n\n### 后续正文"))).toEqual([chunk("\n\n### 后续正文")]);
  });
});
