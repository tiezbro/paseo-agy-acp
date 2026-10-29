import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { JsonRpcMessage, JsonRpcRequest } from "../ACP Connector/official-kernel/json-rpc.js";
import { createNdjsonParser, encodeNdjson } from "../ACP Connector/official-kernel/ndjson.js";
import { OfficialKernelProxy } from "../ACP Connector/official-kernel/proxy.js";

function capabilityHarness(env: NodeJS.ProcessEnv) {
  const child = Object.assign(new EventEmitter(), { pid: process.pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const forwarded: JsonRpcRequest[] = [];
  const received: JsonRpcMessage[] = [];
  child.stdin.on("data", createNdjsonParser(message => forwarded.push(message as JsonRpcRequest)));
  stdout.on("data", createNdjsonParser(message => received.push(message)));
  const running = new OfficialKernelProxy({ child: child as unknown as ChildProcessWithoutNullStreams, stdin, stdout, env, version: "2.7.1" }).start();
  return {
    forwarded, received,
    send(id: number, method: string, params: unknown) { stdin.write(encodeNdjson({ jsonrpc: "2.0", id, method, params })); },
    reply(id: number, result: unknown) { child.stdout.write(encodeNdjson({ jsonrpc: "2.0", id, result })); },
    async request(id: number) {
      await vi.waitFor(() => expect(forwarded.some(message => message.id === id)).toBe(true));
      return forwarded.find(message => message.id === id)!;
    },
    async close() { child.emit("close", 0); await running; }
  };
}

describe("proxy 能力与技能 MCP 闭环", () => {
  it.each(["cancelled", "end_turn"])("无 Admission 的 %s 内核响应只产生一个准确终态诊断", async stopReason => {
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      lines.push(String(value));
      return true;
    });
    const h = capabilityHarness({ AGY_ACP_DIAGNOSTICS: "1" });
    try {
      h.send(10, "session/prompt", { sessionId: "diagnostic-session", prompt: [{ type: "text", text: "private-user-text" }] });
      await h.request(10);
      h.reply(10, { stopReason });
      await vi.waitFor(() => {
        const events = lines.flatMap(line => line.trim().split("\n")).map(line => JSON.parse(line) as { event: string; request?: string; session?: string; durationMs?: number });
        const terminal = events.filter(event => ["turn_cancel", "turn_fail", "turn_end"].includes(event.event));
        expect(terminal).toHaveLength(1);
        // 无输出的 end_turn 被空轮次保护转换为失败。
        expect(terminal[0]).toMatchObject({ event: stopReason === "cancelled" ? "turn_cancel" : "turn_fail", durationMs: expect.any(Number), request: expect.any(String), session: expect.any(String) });
        expect(events.some(event => event.event === "first_kernel_output")).toBe(false);
      });
      expect(lines.join("")).not.toContain("private-user-text");
      expect(lines.join("")).not.toContain("diagnostic-session");
    } finally { await h.close(); stderr.mockRestore(); }
  });

  it.each([
    { supported: true, enabled: true },
    { supported: false, enabled: true },
    { supported: true, enabled: false }
  ])("原生 context $supported，开关 $enabled：metadata协商、会话绑定和真实技能资源读取", async ({ supported, enabled }) => {
    const native = supported && enabled;
    const home = await mkdtemp(path.join(os.tmpdir(), "paseo-capabilities-"));
    const stateDir = path.join(home, "agents/workspace");
    const skillDir = path.join(home, "workspace/.agents/skills/example");
    await mkdir(stateDir, { recursive: true });
    await mkdir(skillDir, { recursive: true });
    const state = path.join(stateDir, "agent.json");
    const writeContext = (value: string) => writeFile(state, JSON.stringify({ persistence: { metadata: { daemonAppendSystemPrompt: value } } }), "utf8");
    await writeContext("daemon-original");
    await writeFile(path.join(skillDir, "SKILL.md"), "---\nname: example\ndescription: example skill\n---\nread resource.txt", "utf8");
    await writeFile(path.join(skillDir, "resource.txt"), "verified-resource", "utf8");
    const h = capabilityHarness({ HOME: home, PASEO_HOME: home, PASEO_AGENT_ID: "agent", ...(enabled ? { PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT: "1" } : {}) });
    let endpoint: string | undefined;
    try {
      h.send(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
      await h.request(1);
      h.reply(1, { agentCapabilities: supported ? { _meta: { antigravity: { systemPrompt: { append: true } } } } : {} });
      h.send(2, "session/load", { sessionId: "session", cwd: path.join(home, "workspace"), mcpServers: [], _meta: { custom: "preserved", antigravity: { systemPrompt: { append: "existing-append" } } } });
      const setup = (await h.request(2)).params as { _meta: { custom: string; antigravity: { systemPrompt: { append: string } } }; mcpServers: Array<{ name: string; url: string }> };
      expect(setup._meta.custom).toBe("preserved");
      expect(setup._meta.antigravity.systemPrompt.append).toBe(native ? "existing-append\n\ndaemon-original" : "existing-append");
      endpoint = setup.mcpServers.find(server => server.name === "paseo_skills")?.url;
      expect(endpoint).toBeDefined();
      h.reply(2, { sessionId: "session" });
      const rpc = async (name: string, args: unknown) => {
        const result = await fetch(endpoint!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
        return result.json() as Promise<{ result: { content: Array<{ text: string }> } }>;
      };
      expect((await rpc("list_skills", {})).result.content[0]?.text).toContain("example");
      expect((await rpc("read_skill", { name: "example", path: "resource.txt" })).result.content[0]?.text).toBe("verified-resource");
      await writeContext("daemon-updated");
      h.send(3, "session/prompt", { sessionId: "session", prompt: [{ type: "text", text: "user-message" }] });
      const prompt = JSON.stringify((await h.request(3)).params);
      expect(prompt).toContain("user-message");
      if (native) expect(prompt).not.toContain("daemon-");
      else expect(prompt).toContain("daemon-updated");
      h.reply(3, { stopReason: "cancelled" });
    } finally {
      await h.close();
      if (endpoint) await expect(fetch(endpoint)).rejects.toThrow();
      await rm(home, { recursive: true, force: true });
    }
  });
});
