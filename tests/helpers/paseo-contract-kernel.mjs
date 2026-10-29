#!/usr/bin/env node
// 隔离契约内核：只执行测试协议，不接触 Google 账号或真实 Paseo daemon。
import { appendFileSync } from "node:fs";
import readline from "node:readline";

const sessions = new Map();
const pending = new Map();
const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const observe = value => appendFileSync(process.env.PASEO_CONTRACT_TRACE, `${JSON.stringify(value)}\n`, "utf8");
observe({ event: "kernel_started", pid: process.pid });

function state() {
  return { models: { currentModelId: "model-a", availableModels: [
    { modelId: "model-a", name: "Model A" }, { modelId: "model-b", name: "Model B" }
  ] } };
}

function finish(sessionId, text, stopReason = "end_turn") {
  const id = pending.get(sessionId);
  if (id === undefined) return;
  pending.delete(sessionId);
  if (text) write({ jsonrpc: "2.0", method: "session/update", params: { sessionId,
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
  write({ jsonrpc: "2.0", id, result: { stopReason } });
}

async function handle(message) {
  observe(message);
  const { method, params, id } = message;
  if (method === "initialize") {
    if (params?.clientCapabilities?.terminal !== true || !params.clientCapabilities.fs) {
      write({ jsonrpc: "2.0", id, error: { code: -32602, message: "expected Paseo clientCapabilities" } });
      return;
    }
    write({ jsonrpc: "2.0", id, result: { protocolVersion: 1,
      agentInfo: { name: "contract-kernel", version: "test" },
      agentCapabilities: { loadSession: process.env.PASEO_CONTRACT_RESUME !== "1",
        sessionCapabilities: { resume: {}, close: {} }, mcpCapabilities: { http: true, sse: true } }, authMethods: [] } });
  } else if (["session/new", "session/load", "session/resume"].includes(method)) {
    if (typeof params?.cwd !== "string" || !Array.isArray(params.mcpServers)) {
      write({ jsonrpc: "2.0", id, error: { code: -32602, message: "cwd and mcpServers are required" } });
      return;
    }
    const sessionId = params.sessionId ?? "contract-session";
    sessions.set(sessionId, params);
    write({ jsonrpc: "2.0", id, result: { sessionId, ...state() } });
  } else if (method === "session/set_model" || method === "session/close") {
    write({ jsonrpc: "2.0", id, result: {} });
  } else if (method === "session/prompt") {
    const { sessionId } = params;
    pending.set(sessionId, id);
    const text = params.prompt.filter(part => part.type === "text").map(part => part.text).join("\n");
    if (text === "permission" || text === "cancel") {
      write({ jsonrpc: "2.0", id: `permission:${sessionId}`, method: "session/request_permission", params: {
        sessionId, toolCall: { toolCallId: "permission-tool", title: "测试许可", status: "pending" },
        options: [{ optionId: "reject", name: "拒绝", kind: "reject_once" }] } });
    } else if (text === "tools") {
      const server = sessions.get(sessionId).mcpServers.find(entry => entry.name === "paseo");
      const headers = Object.fromEntries(server.headers.map(entry => [entry.name, entry.value]));
      const rpc = async (method, params) => {
        const response = await fetch(server.url, { method: "POST", headers: {
          ...headers, "content-type": "application/json", "mcp-protocol-version": "2026-07-28"
        }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error(`MCP status ${response.status}`);
        return response.json();
      };
      const initialized = await rpc("initialize", { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "contract", version: "1" } });
      const listed = await rpc("tools/list", {});
      const called = await rpc("tools/call", { name: "delegate_to_host", arguments: { host: "workstation-b", prompt: "执行隔离测试" } });
      finish(sessionId, JSON.stringify({ initialized, listed, called }));
    } else finish(sessionId, "contract-ok");
  } else if (method === "session/cancel") {
    finish(params.sessionId, undefined, "cancelled");
  } else if (typeof id === "string" && id.startsWith("permission:")) {
    // 取消先于许可答复到达时，不得再结束一次轮次。
    if (message.result?.outcome?.outcome === "selected") finish(id.slice("permission:".length), "permission rejected");
  }
}

readline.createInterface({ input: process.stdin }).on("line", line => {
  void handle(JSON.parse(line)).catch(error => {
    process.stderr.write(`${error.stack}\n`);
    process.exitCode = 1;
    process.stdin.destroy();
  });
});
