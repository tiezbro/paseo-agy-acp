import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdmissionTurnInput } from "../ACP Connector/admission/turn-coordinator.js";
import { createOfficialAdmission } from "../ACP Connector/official-kernel/admission-fence.js";
import type { JsonRpcMessage, JsonRpcRequest } from "../ACP Connector/official-kernel/json-rpc.js";
import { createNdjsonParser, encodeNdjson } from "../ACP Connector/official-kernel/ndjson.js";
import { OfficialKernelProxy } from "../ACP Connector/official-kernel/proxy.js";

vi.mock("../ACP Connector/official-kernel/admission-fence.js", async (original) => ({
  ...await original<typeof import("../ACP Connector/official-kernel/admission-fence.js")>(),
  createOfficialAdmission: vi.fn()
}));

const directories: string[] = [];
afterEach(() => {
  vi.mocked(createOfficialAdmission).mockReset();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness(env: NodeJS.ProcessEnv = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: process.pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()
  });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const received: JsonRpcMessage[] = [];
  const forwarded: JsonRpcRequest[] = [];
  stdout.on("data", createNdjsonParser(message => received.push(message)));
  child.stdin.on("data", createNdjsonParser(message => forwarded.push(message as JsonRpcRequest)));
  const proxy = new OfficialKernelProxy({ child: child as unknown as ChildProcessWithoutNullStreams, stdin, stdout, env, version: "test" });
  const running = proxy.start();
  return {
    child, received, forwarded, running,
    send(message: JsonRpcMessage) { stdin.write(encodeNdjson(message)); },
    reply(message: JsonRpcMessage) { child.stdout.write(encodeNdjson(message)); },
    async close() { child.emit("close", 0); await running; }
  };
}

describe("Paseo 代理工作区与生命周期", () => {
  it.each(["", " \t\n"])("空文本分块 %j 仍返回空轮次错误", async text => {
    const h = harness();
    try {
      h.send({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s1", prompt: "hello" } });
      await vi.waitFor(() => expect(h.forwarded).toHaveLength(1));
      h.reply({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: {
        sessionUpdate: "agent_message_chunk", content: { type: "text", text }
      } } });
      h.reply({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } });
      expect(h.received.at(-1)).toMatchObject({ id: 1, error: { code: -32000 } });
    } finally { await h.close(); }
  });

  it("图片输出可正常结束轮次", async () => {
    const h = harness();
    try {
      h.send({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s1", prompt: "image" } });
      await vi.waitFor(() => expect(h.forwarded).toHaveLength(1));
      h.reply({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: {
        sessionUpdate: "agent_message_chunk", content: { type: "image", mimeType: "image/png", data: "AAAA" }
      } } });
      h.reply({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } });
      expect(h.received.at(-1)).toMatchObject({ id: 1, result: { stopReason: "end_turn" } });
    } finally { await h.close(); }
  });

  it.each(["session/new", "session/load", "session/resume"])("%s 的技能权限只在成功关闭后撤销，其他会话仍可用", async method => {
    const h = harness({ PASEO_AGENT_CWD: process.cwd() });
    const rpc = async (id: number, requestMethod: string, sessionId: string, success = true) => {
      h.send({ jsonrpc: "2.0", id, method: requestMethod, params: { sessionId } });
      await vi.waitFor(() => expect(h.forwarded.some(request => request.id === id)).toBe(true));
      h.reply(success ? { jsonrpc: "2.0", id, result: { sessionId } } : { jsonrpc: "2.0", id, error: { code: -32000, message: "close rejected" } });
      return h.forwarded.find(request => request.id === id)!;
    };
    const list = async (url: string) => (await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) })).status;
    try {
      const first = await rpc(1, method, "s1");
      const second = await rpc(2, method, "s2");
      const skillUrl = (request: JsonRpcRequest) => (request.params as { mcpServers: Array<{ name: string; url: string }> }).mcpServers.find(server => server.name === "paseo_skills")!.url;
      const firstUrl = skillUrl(first);
      const secondUrl = skillUrl(second);
      expect(await list(firstUrl)).toBe(200);
      await rpc(3, "session/close", "s1", false);
      expect(await list(firstUrl)).toBe(200);
      await rpc(4, "session/close", "s1");
      expect(await list(firstUrl)).toBe(404);
      expect(await list(secondUrl)).toBe(200);
      await rpc(5, "session/close", "s1");
      expect(await list(secondUrl)).toBe(200);
      await rpc(6, "session/close", "s2");
      expect(await list(secondUrl)).toBe(404);
    } finally { await h.close(); }
  });

  it("exit 后仍接收未排空的最后一条响应，close 后才完成清理", async () => {
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await vi.waitFor(() => expect(h.forwarded).toHaveLength(1));
    h.child.emit("exit", 0);
    h.reply({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1 } });
    expect(h.received).toHaveLength(1);
    expect(h.received[0]).toMatchObject({ id: 1, result: { protocolVersion: 1 } });
    await h.close();
    expect(h.child.listenerCount("close")).toBe(0);
    expect(h.child.listenerCount("error")).toBe(0);
  });

  it.each(["session/new", "session/load", "session/resume"])("%s 补全 cwd 并发现 Paseo 工作区技能", async method => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "paseo-proxy-cwd-"));
    directories.push(cwd);
    const skill = path.join(cwd, ".paseo/skills/workspace-paseo");
    mkdirSync(skill, { recursive: true });
    writeFileSync(path.join(skill, "SKILL.md"), "---\nname: workspace-paseo\ndescription: 工作区技能\n---\n", "utf8");
    const h = harness({ PASEO_AGENT_CWD: cwd });
    try {
      h.send({ jsonrpc: "2.0", id: 1, method, params: { sessionId: "s1" } });
      await vi.waitFor(() => expect(h.forwarded).toHaveLength(1));
      expect(h.forwarded[0]?.params).toMatchObject({ cwd });
      // session/new 的命令更新可能早于响应，此时也必须能定位工作区。
      h.reply({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "available_commands_update", availableCommands: [] } } });
      expect(h.received[0]).toMatchObject({ params: { update: { availableCommands: expect.arrayContaining([{ name: "workspace-paseo", description: "工作区技能" }]) } } });
      h.reply({ jsonrpc: "2.0", id: 1, result: { sessionId: "s1" } });
    } finally { await h.close(); }
  });

  it("保留显式 cwd，且退出时解开串行等待的 session/new", async () => {
    const h = harness({ PASEO_AGENT_CWD: "/fallback" });
    h.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/explicit" } });
    h.send({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
    await vi.waitFor(() => expect(h.forwarded).toHaveLength(1));
    expect(h.forwarded[0]?.params).toMatchObject({ cwd: "/explicit" });
    await h.close();
    expect(h.forwarded).toHaveLength(1);
  });

  it("Admission 排队通知不计入内核可见输出，空轮次仍被拒绝", async () => {
    const coordinatorClose = vi.fn();
    const runtimeClose = vi.fn();
    const admit = vi.fn(async (input: AdmissionTurnInput) => {
      await input.reportProgress?.({ state: "queued", position: 2, eligiblePosition: 1, waitedMs: 2_500, cooldownUntil: 12345 });
      return (await input.execute({ prepare() {}, beforePromptWrite() {}, afterPromptWrite() {} })).stopReason;
    });
    vi.mocked(createOfficialAdmission).mockReturnValue({
      coordinator: { admit, close: coordinatorClose }, runtime: { close: runtimeClose }
    } as unknown as ReturnType<typeof createOfficialAdmission>);
    const h = harness();
    try {
      h.send({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s1", prompt: "hello" } });
      await vi.waitFor(() => expect(h.forwarded).toHaveLength(1));
      expect(h.received[0]).toMatchObject({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: expect.stringContaining("队列第 2 位") } } } });
      expect(JSON.stringify(h.forwarded[0])).not.toContain("请求排队中");
      h.reply({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } });
      expect(h.received.at(-1)).toMatchObject({ id: 1, error: { code: -32000 } });
    } finally { await h.close(); }
    expect(coordinatorClose).toHaveBeenCalledOnce();
    expect(runtimeClose).toHaveBeenCalledOnce();
  });

  it("内核错误也会关闭所属 bridge，且不影响其他代理", async () => {
    const first = harness();
    const second = harness();
    const upstream = createServer((_request, response) => response.end("ok"));
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    const port = (upstream.address() as { port: number }).port;
    try {
      const localUrls: string[] = [];
      for (const h of [first, second]) {
        h.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { mcpServers: [{ type: "http", name: "paseo", url: `http://127.0.0.1:${port}/mcp` }] } });
        await vi.waitFor(() => expect(h.forwarded).toHaveLength(1));
        localUrls.push((h.forwarded[0]!.params as { mcpServers: Array<{ url: string }> }).mcpServers[0]!.url);
        h.reply({ jsonrpc: "2.0", id: 1, result: { sessionId: "s1" } });
      }
      expect(await (await fetch(localUrls[0]!)).text()).toBe("ok");
      const failed = expect(first.running).rejects.toThrow("kernel failed");
      first.child.emit("error", new Error("kernel failed"));
      await failed;
      await expect(fetch(localUrls[0]!)).rejects.toThrow();
      expect(await (await fetch(localUrls[1]!)).text()).toBe("ok");
      await second.close();
      await expect(fetch(localUrls[1]!)).rejects.toThrow();
    } finally {
      first.child.emit("exit", 0);
      await second.close();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });

  it.each(["queued", "dispatched"])("%s 轮次在退出时结束等待，然后释放 Admission", async phase => {
    const events: string[] = [];
    let turn: AdmissionTurnInput | undefined;
    const admit = vi.fn(async (input: AdmissionTurnInput) => {
      turn = input;
      if (phase === "queued") {
        await new Promise<void>(resolve => input.claim.signal.addEventListener("abort", () => resolve(), { once: true }));
        events.push("cancelled");
        return "cancelled" as const;
      }
      try {
        await input.execute({ prepare() {}, beforePromptWrite() {}, afterPromptWrite() {} });
        throw new Error("断连轮次不应正常完成");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("connection closed during prompt");
        events.push("recovery_required");
        throw error;
      }
    });
    vi.mocked(createOfficialAdmission).mockReturnValue({
      coordinator: { admit, close() { events.push("coordinator closed"); } },
      runtime: { close() { events.push("runtime closed"); } }
    } as unknown as ReturnType<typeof createOfficialAdmission>);
    const h = harness();
    h.send({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s1", prompt: "hello" } });
    await vi.waitFor(() => expect(admit).toHaveBeenCalledOnce());
    expect(h.forwarded).toHaveLength(phase === "queued" ? 0 : 1);
    await h.close();
    expect(turn?.claim.aborted).toBe(true);
    expect(events).toEqual([phase === "queued" ? "cancelled" : "recovery_required", "coordinator closed", "runtime closed"]);
  });
});
