import { describe, expect, it } from "vitest";
import { SystemMessageFolder } from "../ACP Connector/official-kernel/system-message-fold.js";
import type { JsonRpcMessage } from "../ACP Connector/official-kernel/json-rpc.js";

function textMessage(text: string, messageId = "shared", sessionId = "session"): JsonRpcMessage {
  return {
    jsonrpc: "2.0", method: "session/update",
    params: { sessionId, update: { sessionUpdate: "agent_message_chunk", messageId, content: { type: "text", text } } }
  };
}

function update(message: JsonRpcMessage) {
  return (message as { params: { update: { messageId?: string; sessionUpdate: string; content: { text: string } } } }).params.update;
}

describe("独立正文消息的 ID", () => {
  it("没有原生 ID 时，工具完成后的正文也会结束 Paseo 的备用消息", () => {
    const folder = new SystemMessageFolder();
    const first = textMessage("Background task started.");
    delete (first as { params: { update: { messageId?: string } } }).params.update.messageId;
    expect(folder.transform(first)).toEqual([first]);
    folder.transform({
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: "task", status: "completed" } }
    });
    const second = textMessage("### Task result");
    delete (second as { params: { update: { messageId?: string } } }).params.update.messageId;
    const output = folder.transform(second);
    expect(update(output[0]).messageId).toBeTruthy();
    expect(update(output[0]).content.text).toBe("### Task result");
    const continuation = textMessage("\n\n**Success**");
    delete (continuation as { params: { update: { messageId?: string } } }).params.update.messageId;
    expect(update(folder.transform(continuation)[0]).messageId).toBe(update(output[0]).messageId);
  });

  it("工具完成前后复用的原生 ID 不会粘连提示与 Markdown 标题", () => {
    const folder = new SystemMessageFolder();
    const first = folder.transform(textMessage("Background task started."));
    const completed: JsonRpcMessage = {
      jsonrpc: "2.0", method: "session/update",
      params: { sessionId: "session", update: { sessionUpdate: "tool_call_update", toolCallId: "task", status: "completed" } }
    };
    expect(folder.transform(completed)).toEqual([completed]);
    const second = folder.transform(textMessage("### Task result\n\n**Success**"));
    expect(update(first[0]).messageId).not.toBe(update(second[0]).messageId);
    expect(update(second[0]).content.text).toBe("### Task result\n\n**Success**");
  });

  it("回合结束后复用的原生 ID 对应新的正文消息", () => {
    const folder = new SystemMessageFolder();
    const first = folder.transform(textMessage("First turn."));
    folder.finish("session");
    const second = folder.transform(textMessage("### Second turn"));
    expect(update(first[0]).messageId).not.toBe(update(second[0]).messageId);
  });

  it("系统事件前后的正文各自使用独立 ID", () => {
    const folder = new SystemMessageFolder();
    const output = folder.transform(textMessage("Intro.\n<SYSTEM_MESSAGE>\n[Message] sender=test-task content=ok\n</SYSTEM_MESSAGE>\n\n### Result"));
    expect(output.map(message => update(message).sessionUpdate)).toEqual(["agent_message_chunk", "agent_message_chunk", "agent_message_chunk"]);
    expect(update(output[0]).messageId).not.toBe(update(output[2]).messageId);
  });

  it("同一消息的流式代码片段保留相同 ID 和原始字符", () => {
    const folder = new SystemMessageFolder();
    const chunks = ["```ts\nconst ", "value = ", "1;\n```\n"];
    const output = chunks.flatMap(text => folder.transform(textMessage(text)));
    expect(new Set(output.map(message => update(message).messageId)).size).toBe(1);
    expect(output.map(message => update(message).content.text).join("")).toBe(chunks.join(""));
  });

  it("切换其他原生 ID 再返回旧 ID 时也分配新消息", () => {
    const folder = new SystemMessageFolder();
    const first = folder.transform(textMessage("A", "a"));
    folder.transform(textMessage("B", "b"));
    const third = folder.transform(textMessage("C", "a"));
    expect(update(first[0]).messageId).not.toBe(update(third[0]).messageId);
  });

  it("不同会话中的原生 ID 相互独立", () => {
    const folder = new SystemMessageFolder();
    const a = textMessage("A", "shared", "a");
    const b = textMessage("B", "shared", "b");
    expect(folder.transform(a)).toEqual([a]);
    expect(folder.transform(b)).toEqual([b]);
  });
});
