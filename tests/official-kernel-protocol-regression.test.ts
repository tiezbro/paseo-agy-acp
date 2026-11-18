import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createNdjsonParser, encodeNdjson } from "../ACP Connector/official-kernel/ndjson.js";
import type { JsonRpcMessage } from "../ACP Connector/official-kernel/json-rpc.js";
import { OfficialKernelProxy } from "../ACP Connector/official-kernel/proxy.js";


function harness(env: NodeJS.ProcessEnv = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: process.pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true)
  });
  const input = new PassThrough(); const output = new PassThrough();
  const messages: JsonRpcMessage[] = []; const forwarded: JsonRpcMessage[] = [];
  output.on("data", createNdjsonParser(message => messages.push(message)));
  child.stdin.on("data", createNdjsonParser(message => forwarded.push(message)));
  const proxy = new OfficialKernelProxy({ child: child as unknown as ChildProcessWithoutNullStreams, stdin: input, stdout: output, env, version: "test" });
  const running = proxy.start();
  return { child, input, messages, forwarded, running,
    send(message: JsonRpcMessage) { input.write(encodeNdjson(message)); },
    reply(message: JsonRpcMessage) { child.stdout.write(encodeNdjson(message)); },
    async close() { child.emit("close", 0); await running; }
  };
}

const prompt = (id: number) => ({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId: "s", prompt: "hello" } });

describe("官方内核协议回归", () => {
  it("UTF-8 中文和 emoji 可在任意字节处分块", () => {
    const wire = Buffer.from(encodeNdjson({ id: 1, result: { text: "你好🙂" } }), "utf8");
    for (let split = 1; split < wire.length; split++) {
      const messages: JsonRpcMessage[] = []; const parse = createNdjsonParser(message => messages.push(message));
      parse(wire.subarray(0, split)); parse(wire.subarray(split)); parse.end();
      expect(messages).toEqual([{ id: 1, result: { text: "你好🙂" } }]);
    }
  });
  it("超限行只报告一次并恢复下一行，EOF 截断可观测，回调异常不被当成解析错误", () => {
    const messages: JsonRpcMessage[] = []; const invalid = vi.fn();
    const parse = createNdjsonParser(message => messages.push(message), invalid, { maxMessageBytes: 24 });
    parse("x".repeat(30)); parse("x".repeat(30)); parse("\n{\"id\":1,\"result\":{}}\n");
    expect(invalid).toHaveBeenCalledOnce(); expect(messages).toHaveLength(1);
    parse("{"); parse.end(); expect(invalid).toHaveBeenCalledTimes(2);
    expect(() => createNdjsonParser(() => { throw new Error("handler"); }, invalid)("{\"result\":{}}\n")).toThrow("handler");
    expect(invalid).toHaveBeenCalledTimes(2);
  });
  it("prompt 紧随 cancel 不会在取消后派发", async () => {
    const h = harness();
    try {
      h.send(prompt(1)); h.send({ method: "session/cancel", params: { sessionId: "s" } });
      await vi.waitFor(() => expect(h.messages).toContainEqual({ jsonrpc: "2.0", id: 1, result: { stopReason: "cancelled" } }));
      expect(h.forwarded.filter(message => "method" in message && message.method === "session/prompt")).toHaveLength(0);
    } finally { await h.close(); }
  });
  it.each([false, true])("取消后原生 end_turn 统一为 cancelled，正文=%s", async visible => {
    const h = harness();
    try {
      h.send(prompt(1));
      await vi.waitFor(() => expect(h.forwarded.some(m => "method" in m && m.method === "session/prompt")).toBe(true));
      h.send({ method: "session/cancel", params: { sessionId: "s" } });
      await vi.waitFor(() => expect(h.forwarded.some(m => "method" in m && m.method === "session/cancel")).toBe(true));
      if (visible) h.reply({ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "cancel acknowledged" } } } });
      h.reply({ id: 1, result: { stopReason: "end_turn", _meta: { retained: true } } });
      await vi.waitFor(() => expect(h.messages.filter(m => "id" in m && m.id === 1)).toEqual([
        { id: 1, result: { stopReason: "cancelled", _meta: { retained: true } } }
      ]));
      h.send(prompt(2));
      await vi.waitFor(() => expect(h.forwarded.some(m => "id" in m && m.id === 2)).toBe(true));
      h.reply({ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "next turn completed" } } } });
      h.reply({ id: 2, result: { stopReason: "end_turn" } });
      await vi.waitFor(() => expect(h.messages).toContainEqual({ id: 2, result: { stopReason: "end_turn" } }));
    } finally { await h.close(); }
  });

  it("取消后明确的 RPC 错误仍然保留错误语义", async () => {
    const h = harness();
    try {
      h.send(prompt(1));
      await vi.waitFor(() => expect(h.forwarded).toHaveLength(1));
      h.send({ method: "session/cancel", params: { sessionId: "s" } });
      const failure = { id: 1, error: { code: -32000, message: "provider failed" } };
      h.reply(failure);
      await vi.waitFor(() => expect(h.messages).toContainEqual(failure));
    } finally { await h.close(); }
  });

  it("同 session 并发请求不会覆盖 claim", async () => {
    const h = harness();
    try {
      h.send(prompt(1)); h.send(prompt(2));
      await vi.waitFor(() => expect(h.messages).toContainEqual(expect.objectContaining({ id: 2, error: expect.anything() })));
      h.send({ method: "session/cancel", params: { sessionId: "s" } });
      await vi.waitFor(() => expect(h.forwarded.length).toBeGreaterThan(0));
      h.reply({ id: 1, result: { stopReason: "cancelled" } });
    } finally { await h.close(); }
  });
  it("结构化 RPC 错误及元数据原样透传，客户端只收到一次终态", async () => {
    const h = harness();
    try {
      h.send(prompt(1));
      await vi.waitFor(() => expect(h.forwarded).toHaveLength(1));
      const error = { id: 1, error: { code: -32000, message: "provider failed", data: { httpStatus: 503, code: "MODEL_CAPACITY_EXHAUSTED" } } };
      h.reply(error);
      await vi.waitFor(() => expect(h.messages.filter(message => "id" in message && message.id === 1)).toEqual([error]));
    } finally { await h.close(); }
  });
  it("EOF 会结束内核输入、TERM 后升级 KILL，并等 close 才完成", async () => {
    vi.useFakeTimers(); const h = harness(); let done = false;
    void h.running.then(() => { done = true; });
    try {
      h.input.end(); await vi.advanceTimersByTimeAsync(0);
      expect(h.child.kill).toHaveBeenCalledWith("SIGTERM"); expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.child.kill).toHaveBeenCalledWith("SIGKILL"); expect(done).toBe(false);
      await h.close(); expect(done).toBe(true);
    } finally { vi.useRealTimers(); await h.close(); }
  });
});
