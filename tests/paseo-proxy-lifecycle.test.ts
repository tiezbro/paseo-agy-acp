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

async function lifecycleRequest(h: ReturnType<typeof harness>, id: number, method: string, params: unknown, result: unknown = {}) {
  h.send({ jsonrpc: "2.0", id, method, params });
  await vi.waitFor(() => expect(h.forwarded.some(row => row.id === id)).toBe(true));
  h.reply({ jsonrpc: "2.0", id, result });
  return h.forwarded.find(row => row.id === id)!;
}

function skillEndpoint(request: JsonRpcRequest): string {
  return (request.params as { mcpServers: Array<{ name: string; url: string }> }).mcpServers.find(server => server.name === "paseo_skills")!.url;
}

async function skillStatus(url: string): Promise<number> {
  return (await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) })).status;
}

describe("会话关闭边界与竞态", () => {
  it("缺失或空 sessionId 的 close 在本地拒绝，不误用响应中的 ID 清理会话", async () => {
    const h = harness();
    try {
      const first = await lifecycleRequest(h, 1, "session/new", { cwd: process.cwd() }, { sessionId: "s1" });
      for (const [index, params] of [undefined, {}, { sessionId: "" }, { sessionId: " " }, { sessionId: null }].entries()) {
        h.send({ jsonrpc: "2.0", id: index + 10, method: "session/close", params });
        await vi.waitFor(() => expect(h.received).toContainEqual(expect.objectContaining({ id: index + 10, error: expect.objectContaining({ code: -32602 }) })));
      }
      expect(h.forwarded.filter(row => row.method === "session/close")).toHaveLength(0);
      expect(await skillStatus(skillEndpoint(first))).toBe(200);
    } finally { await h.close(); }
  });

  it("new 成功响应缺失 sessionId 时释放未绑定 token，不清理其他会话", async () => {
    const h = harness();
    try {
      const first = await lifecycleRequest(h, 1, "session/new", { cwd: process.cwd() }, { sessionId: "s1" });
      const unbound = await lifecycleRequest(h, 2, "session/new", { cwd: process.cwd() });
      expect(await skillStatus(skillEndpoint(unbound))).toBe(404);
      expect(await skillStatus(skillEndpoint(first))).toBe(200);
    } finally { await h.close(); }
  });

  it.each([[true, true], [false, true], [true, false], [false, false]])("同会话并发 close 乱序成功/失败 %j %j，按成功结果撤销目标会话", async (firstSuccess, secondSuccess) => {
    const h = harness();
    try {
      const first = await lifecycleRequest(h, 1, "session/new", { cwd: process.cwd() }, { sessionId: "s1" });
      const other = await lifecycleRequest(h, 2, "session/new", { cwd: process.cwd() }, { sessionId: "s2" });
      for (const id of [3, 4]) h.send({ jsonrpc: "2.0", id, method: "session/close", params: { sessionId: "s1" } });
      await vi.waitFor(() => expect(h.forwarded.filter(row => row.method === "session/close")).toHaveLength(2));
      for (const [id, success] of [[4, secondSuccess], [3, firstSuccess]] as const) {
        h.reply(success ? { jsonrpc: "2.0", id, result: {} } : { jsonrpc: "2.0", id, error: { code: -32000, message: "rejected" } });
      }
      expect(await skillStatus(skillEndpoint(first))).toBe(firstSuccess || secondSuccess ? 404 : 200);
      expect(await skillStatus(skillEndpoint(other))).toBe(200);
      for (const id of [3, 4]) expect(h.received.filter(row => "id" in row && row.id === id)).toHaveLength(1);
    } finally { await h.close(); }
  });

  it.each(["session/load", "session/resume"])("旧 close 响应不得撤销 %s 刚重新绑定的会话", async method => {
    const h = harness();
    try {
      const first = await lifecycleRequest(h, 1, "session/new", { cwd: process.cwd() }, { sessionId: "s1" });
      h.send({ jsonrpc: "2.0", id: 2, method: "session/close", params: { sessionId: "s1" } });
      await vi.waitFor(() => expect(h.forwarded.some(row => row.id === 2)).toBe(true));
      const rebound = await lifecycleRequest(h, 3, method, { sessionId: "s1", cwd: process.cwd() }, { sessionId: "s1" });
      expect(await skillStatus(skillEndpoint(first))).toBe(404);
      expect(await skillStatus(skillEndpoint(rebound))).toBe(200);
      h.reply({ jsonrpc: "2.0", id: 2, result: {} });
      expect(await skillStatus(skillEndpoint(rebound))).toBe(200);
      // 当前代的关闭仍会撤销，不能因防旧响应而永久保留。
      await lifecycleRequest(h, 4, "session/close", { sessionId: "s1" });
      expect(await skillStatus(skillEndpoint(rebound))).toBe(404);
    } finally { await h.close(); }
  });

  it("close 失败保留模型、cwd、native context 和技能能力", async () => {
    mkdirSync(path.join(process.cwd(), "node_modules/.cache"), { recursive: true });
    const directory = mkdtempSync(path.join(process.cwd(), "node_modules/.cache/close-retain-"));
    directories.push(directory);
    mkdirSync(path.join(directory, "agents"));
    writeFileSync(path.join(directory, "agents/agent-1.json"), JSON.stringify({ persistence: { metadata: { daemonAppendSystemPrompt: "retained-native-context" } } }), "utf8");
    const skill = path.join(directory, ".paseo/skills/retained");
    mkdirSync(skill, { recursive: true });
    writeFileSync(path.join(skill, "SKILL.md"), "---\nname: retained\ndescription: 保留的技能\n---\n", "utf8");
    const admit = vi.fn(async (input: AdmissionTurnInput) => (await input.execute({ prepare() {}, beforePromptWrite() {}, afterPromptWrite() {} })).stopReason);
    vi.mocked(createOfficialAdmission).mockReturnValue({ coordinator: { admit, close() {} }, runtime: { close() {} } } as unknown as ReturnType<typeof createOfficialAdmission>);
    const h = harness({ PASEO_HOME: directory, PASEO_AGENT_ID: "agent-1", PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT: "1" });
    try {
      await lifecycleRequest(h, 1, "initialize", {}, { agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } } });
      const created = await lifecycleRequest(h, 2, "session/new", { cwd: directory }, { sessionId: "s1", models: { currentModelId: "retained-model" } });
      expect(JSON.stringify(created.params)).toContain("retained-native-context");
      h.send({ jsonrpc: "2.0", id: 3, method: "session/close", params: { sessionId: "s1" } });
      await vi.waitFor(() => expect(h.forwarded.some(row => row.id === 3)).toBe(true));
      h.reply({ jsonrpc: "2.0", id: 3, error: { code: -32000, message: "busy" } });
      expect(await skillStatus(skillEndpoint(created))).toBe(200);
      h.reply({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "available_commands_update", availableCommands: [] } } });
      expect(JSON.stringify(h.received.at(-1))).toContain('"name":"retained"');
      h.send({ jsonrpc: "2.0", id: 4, method: "session/prompt", params: { sessionId: "s1", prompt: "next" } });
      await vi.waitFor(() => expect(h.forwarded.some(row => row.id === 4)).toBe(true));
      expect(admit.mock.calls[0]![0].model).toBe("retained-model");
      expect(JSON.stringify(h.forwarded.find(row => row.id === 4))).not.toContain("retained-native-context");
      h.reply({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } } } });
      h.reply({ jsonrpc: "2.0", id: 4, result: { stopReason: "end_turn" } });
    } finally { await h.close(); }
  });
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
  it.each([
    [undefined, false], [[], false], [[{ type: "text", text: " \t" }], false],
    [[{ type: "text", text: " " }, { type: "text", text: "answer" }], true],
    [[{ type: "audio", data: "AAAA", mimeType: "audio/wav" }], true],
    [{ type: "resource", resource: { uri: "file:///a", text: "a" } }, true],
    [{ type: "resource_link", uri: "file:///a", name: "a" }, true],
    [{ type: "future_block", data: "opaque" }, true]
  ])("内容形态 %j 的真实代理终态为 %s", async (content, visible) => {
    const h = harness();
    try {
      h.send({ jsonrpc: "2.0", id: 1, method: "session/prompt", params: { sessionId: "s1", prompt: "hello" } });
      await vi.waitFor(() => expect(h.forwarded).toHaveLength(1));
      h.reply({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content } } });
      h.reply({ jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } });
      expect(h.received.at(-1)).toMatchObject(visible ? { id: 1, result: { stopReason: "end_turn" } } : { id: 1, error: { code: -32000 } });
    } finally { await h.close(); }
  });
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
