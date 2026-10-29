import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { OfficialKernelProxy } from "../ACP Connector/official-kernel/proxy.js";
import { createNdjsonParser, encodeNdjson } from "../ACP Connector/official-kernel/ndjson.js";
import type { JsonRpcMessage } from "../ACP Connector/official-kernel/json-rpc.js";

describe("真实子进程 stdio 生命周期集成（fake kernel，无 daemon）", () => {
  it("cold load/resume、权限拒绝、取消及退出清理", async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./helpers/fake-lifecycle-acp-kernel.mjs", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"] });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const messages: JsonRpcMessage[] = [];
    stdout.on("data", createNdjsonParser(message => messages.push(message)));
    const running = new OfficialKernelProxy({ child, stdin, stdout, env: {}, version: "2.7.1" }).start();
    const send = (message: JsonRpcMessage) => stdin.write(encodeNdjson(message));
    const response = async (id: string | number) => {
      await vi.waitFor(() => expect(messages.some(message => "id" in message && message.id === id)).toBe(true));
      return messages.find(message => "id" in message && message.id === id);
    };
    try {
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } });
      expect(await response(1)).toMatchObject({ result: { agentInfo: { name: "agy-acp" } } });
      for (const [id, method] of [[2, "session/load"], [3, "session/resume"]] as const) {
        send({ jsonrpc: "2.0", id, method, params: { sessionId: "isolated", cwd: process.cwd(), mcpServers: [] } });
        expect(await response(id)).toMatchObject({ result: { sessionId: "isolated" } });
      }
      send({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: "isolated", prompt: [{ type: "text", text: "test" }] } });
      await response("permission:isolated");
      send({ jsonrpc: "2.0", id: "permission:isolated", result: { outcome: { outcome: "selected", optionId: "reject" } } });
      expect(await response(4)).toMatchObject({ result: { stopReason: "end_turn" } });
      expect(JSON.stringify(messages)).toContain("permission rejected");
      send({ jsonrpc: "2.0", id: 5, method: "session/prompt", params: { sessionId: "cancel", prompt: [{ type: "text", text: "test" }] } });
      await response("permission:cancel");
      send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "cancel" } });
      expect(await response(5)).toMatchObject({ result: { stopReason: "cancelled" } });
    } finally {
      stdin.end();
      child.kill("SIGTERM");
      await running;
    }
    expect(child.listenerCount("close")).toBe(0);
    expect(child.listenerCount("error")).toBe(0);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
});
