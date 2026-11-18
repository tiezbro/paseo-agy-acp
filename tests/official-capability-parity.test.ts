import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { OfficialKernelProxy } from "../ACP Connector/official-kernel/proxy.js";
import { createNdjsonParser, encodeNdjson } from "../ACP Connector/official-kernel/ndjson.js";
import type { JsonRpcMessage } from "../ACP Connector/official-kernel/json-rpc.js";

// Transport contract only: these responses simulate the kernel, not model/UI support.
function harness() {
  const child = Object.assign(new EventEmitter(), { pid: process.pid,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const input = new PassThrough();
  const output = new PassThrough();
  const toKernel: JsonRpcMessage[] = [];
  const toClient: JsonRpcMessage[] = [];
  child.stdin.on("data", createNdjsonParser(message => toKernel.push(message)));
  output.on("data", createNdjsonParser(message => toClient.push(message)));
  const running = new OfficialKernelProxy({ child: child as unknown as ChildProcessWithoutNullStreams,
    stdin: input, stdout: output, env: {}, version: "test" }).start();
  return { toKernel, toClient,
    send(message: JsonRpcMessage) { input.write(encodeNdjson(message)); },
    reply(message: JsonRpcMessage) { child.stdout.write(encodeNdjson(message)); },
    async close() { child.emit("close", 0); await running; }
  };
}

describe("official capability transport parity", () => {
  it.each(["plan", "future_official_mode", "constructor", "__proto__"])("delegates mode %s validation to the kernel", async mode => {
    const h = harness();
    try {
      for (const [id, method, params] of [
        [1, "session/set_mode", { sessionId: "s", modeId: mode }],
        [2, "session/set_config_option", { sessionId: "s", configId: "mode", value: mode }]
      ] as const) {
        h.send({ jsonrpc: "2.0", id, method, params });
        await vi.waitFor(() => expect(h.toKernel).toContainEqual({ jsonrpc: "2.0", id, method, params }));
        const failure = { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown mode id: ${mode}` } };
        h.reply(failure);
        expect(h.toClient).toContainEqual(failure);
      }
    } finally { await h.close(); }
  });

  it.each(["session/new", "session/load", "session/resume", "session/set_config_option"])(
    "describes official mode permission policy in %s without changing mode ids", async method => {
      const h = harness();
      try {
        h.send({ jsonrpc: "2.0", id: 11, method, params: { sessionId: "s", cwd: process.cwd(), mcpServers: [] } });
        await vi.waitFor(() => expect(h.toKernel).toContainEqual(expect.objectContaining({ id: 11 })));
        const modes = ["default", "auto_edit", "yolo", "future_mode"].map(id => ({ id, name: id, _meta: { vendor: "kept" } }));
        const result = { sessionId: "s", modes: { currentModeId: "default", availableModes: modes },
          configOptions: [{ id: "mode", category: "mode", type: "select", currentValue: "default",
            options: modes.map(({ id, ...rest }) => ({ ...rest, value: id })) }] };
        h.reply({ jsonrpc: "2.0", id: 11, result });
        const policies = [false, false, true, undefined];
        const expectedModes = modes.map((mode, index) => ({ ...mode, _meta: { vendor: "kept",
          ...(policies[index] === undefined ? {} : { "paseo.dev/unattended": policies[index] }) } }));
        expect(h.toClient).toContainEqual({ jsonrpc: "2.0", id: 11, result: { ...result,
          modes: { ...result.modes, availableModes: expectedModes },
          configOptions: [{ ...result.configOptions[0], options: expectedModes.map(({ id, ...rest }) => ({ ...rest, value: id })) }] } });
      } finally { await h.close(); }
    });

  it("preserves negotiated capabilities, auth methods and vendor metadata", async () => {
    const h = harness();
    try {
      const params = { protocolVersion: 1, clientCapabilities: { terminal: true,
        fs: { readTextFile: true, writeTextFile: true }, auth: { _meta: { gateway: true } },
        _meta: { future: { supported: true } } } };
      h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params });
      await vi.waitFor(() => expect(h.toKernel).toContainEqual({ jsonrpc: "2.0", id: 1, method: "initialize", params }));
      const result = { protocolVersion: 1, agentCapabilities: { loadSession: true,
        auth: { logout: {} }, sessionCapabilities: { list: {}, resume: {}, additionalDirectories: {} },
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        _meta: { antigravity: { tier: true, systemPrompt: { append: true } } } },
        authMethods: [{ id: "oauth-personal", name: "Google" }, { id: "gateway", name: "Gateway", _meta: { gateway: { protocol: "google" } } }],
        _meta: { future: "preserved" } };
      h.reply({ jsonrpc: "2.0", id: 1, result });
      expect(h.toClient).toContainEqual(expect.objectContaining({ id: 1, result: expect.objectContaining(result) }));
    } finally { await h.close(); }
  });

  it.each(["authenticate", "logout", "session/list", "session/set_model", "session/set_config_option", "_future/method"])(
    "relays %s and its structured result without a local capability allowlist", async method => {
      const h = harness();
      try {
        const request = { jsonrpc: "2.0", id: 2, method, params: { sessionId: "s", configId: "thinking_level", value: "high", _meta: { future: true } } };
        h.send(request);
        await vi.waitFor(() => expect(h.toKernel).toContainEqual(request));
        const response = { jsonrpc: "2.0", id: 2, result: { _meta: { future: "value" }, nextCursor: "cursor" } };
        h.reply(response);
        expect(h.toClient).toContainEqual(response);
      } finally { await h.close(); }
    }
  );

  it.each(["session/new", "session/load", "session/resume"])("preserves additional directories and native context on %s", async method => {
    const h = harness();
    try {
      const params = { sessionId: "s", cwd: process.cwd(), additionalDirectories: ["/extra/project"], mcpServers: [],
        _meta: { antigravity: { systemPrompt: { append: "native context" } }, custom: true } };
      h.send({ jsonrpc: "2.0", id: 4, method, params });
      await vi.waitFor(() => expect(h.toKernel).toContainEqual(expect.objectContaining({ id: 4, method,
        params: expect.objectContaining({ sessionId: "s", cwd: params.cwd,
          additionalDirectories: params.additionalDirectories, _meta: params._meta }) })));
      h.reply({ jsonrpc: "2.0", id: 4, result: { sessionId: "s", _meta: { antigravity: { tier: "test" } } } });
      expect(h.toClient).toContainEqual({ jsonrpc: "2.0", id: 4,
        result: { sessionId: "s", _meta: { antigravity: { tier: "test" } } } });
    } finally { await h.close(); }
  });

  it("keeps multimodal prompt blocks and native configuration metadata intact", async () => {
    const h = harness();
    try {
      const request = { jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId: "s", prompt: [
        { type: "text", text: "compare these resources" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
        { type: "resource", resource: { uri: "file:///sample.txt", text: "context", mimeType: "text/plain" } },
        { type: "resource_link", uri: "file:///linked.txt", name: "linked.txt" }
      ], _meta: { antigravity: { custom: true } } } };
      h.send(request);
      await vi.waitFor(() => expect(h.toKernel).toContainEqual(request));
      h.reply({ jsonrpc: "2.0", id: 3, result: { stopReason: "cancelled" } });
    } finally { await h.close(); }
  });

  it.each(["agent_thought_chunk", "tool_call", "tool_call_update", "plan", "current_mode_update",
    "config_option_update", "session_info_update", "usage_update", "future_update"])(
    "preserves %s payloads including native metadata", async sessionUpdate => {
      const h = harness();
      try {
        const message = { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: {
          sessionUpdate, content: { type: "text", text: "native event" }, _meta: { antigravity: { native: true } }
        } } };
        h.reply(message);
        expect(h.toClient).toEqual([message]);
      } finally { await h.close(); }
    }
  );

  it.each(["session/request_permission", "fs/read_text_file", "fs/write_text_file", "terminal/create",
    "terminal/output", "terminal/wait_for_exit", "terminal/kill", "terminal/release", "_future/client_request"])(
    "preserves bidirectional %s requests and replies", async method => {
      const h = harness();
      try {
        const request = { jsonrpc: "2.0", id: "kernel-1", method,
          params: { sessionId: "s", _meta: { interaction: { questions: [{ text: "Choose" }] } } } };
        h.reply(request);
        expect(h.toClient).toEqual([request]);
        const response = { jsonrpc: "2.0", id: "kernel-1", result: { _meta: { answer: "choice" } } };
        h.send(response);
        expect(h.toKernel).toEqual([response]);
      } finally { await h.close(); }
    }
  );
});
