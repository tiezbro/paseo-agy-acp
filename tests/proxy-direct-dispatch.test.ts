import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { OfficialKernelProxy } from "../ACP Connector/official-kernel/proxy.js";
import { createNdjsonParser, encodeNdjson } from "../ACP Connector/official-kernel/ndjson.js";
import type { JsonRpcMessage } from "../ACP Connector/official-kernel/json-rpc.js";

it("旧调度环境不阻止独立会话立即派发，不创建账本，取消只作用于目标会话", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "acp-direct-"));
  const state = path.join(directory, "unused-state");
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: process.pid
  });
  const stdin = new PassThrough(), stdout = new PassThrough();
  const forwarded: JsonRpcMessage[] = [], received: JsonRpcMessage[] = [];
  child.stdin.on("data", createNdjsonParser(message => forwarded.push(message)));
  stdout.on("data", createNdjsonParser(message => received.push(message)));
  const proxy = new OfficialKernelProxy({ child: child as unknown as ChildProcessWithoutNullStreams,
    stdin, stdout, version: "test", env: {
      HOME: directory, AGY_ACP_ADMISSION_ENABLED: "true", AGY_ACP_STATE_DIR: state,
      AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS: "1", AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS: "1",
      AGY_ACP_ADMISSION_MIN_START_INTERVAL_MS: "60000"
    } });
  const running = proxy.start();
  const send = (message: JsonRpcMessage) => stdin.write(encodeNdjson(message));
  const reply = (message: JsonRpcMessage) => child.stdout.write(encodeNdjson(message));
  try {
    // No completion is sent until all twelve requests have reached the kernel.
    for (let id = 1; id <= 12; id++) send({ id, method: "session/prompt", params: { sessionId: `s${id}`, prompt: "hello" } });
    await vi.waitFor(() => expect(forwarded.filter(m => "method" in m && m.method === "session/prompt")).toHaveLength(12), { timeout: 1000 });
    expect(existsSync(state)).toBe(false);
    send({ method: "session/cancel", params: { sessionId: "s1" } });
    for (let id = 1; id <= 12; id++) {
      reply({ method: "session/update", params: { sessionId: `s${id}`, update: {
        sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "official thinking summary" }
      } } });
      reply({ id, result: { stopReason: "end_turn", _meta: { native: true } } });
    }
    await vi.waitFor(() => expect(received.filter(m => "id" in m)).toHaveLength(12));
    expect(received.filter(m => "id" in m)).toEqual(Array.from({ length: 12 }, (_, index) => ({
      id: index + 1, result: { stopReason: index === 0 ? "cancelled" : "end_turn", _meta: { native: true } }
    })));
    expect(received.filter(m => "method" in m && m.method === "session/update")).toHaveLength(12);
    expect(existsSync(state)).toBe(false);
  } finally {
    child.emit("close", 0);
    await running;
    rmSync(directory, { recursive: true, force: true });
  }
});
