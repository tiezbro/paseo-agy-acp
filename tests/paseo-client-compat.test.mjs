import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

// 此套件由 CI 在独立 job 中按提交的 lockfile 安装后必跑；依赖缺失或版本不符必须失败，不能静默跳过。
const root = fileURLToPath(new URL("../", import.meta.url));
const clientRoot = path.resolve(process.env.PASEO_COMPAT_CLIENT_ROOT ?? path.join(root, "tests/fixtures/paseo-client"));
const require = createRequire(path.join(clientRoot, "package.json"));
const serverEntry = require.resolve("@getpaseo/server");
const serverRoot = path.resolve(path.dirname(serverEntry), "../../..");
assert.equal(JSON.parse(await readFile(path.join(serverRoot, "package.json"), "utf8")).version, "0.13.2");
const { ACPAgentClient } = await import(pathToFileURL(path.join(path.dirname(serverEntry), "agent/providers/acp-agent.js")).href);
const logger = { child() { return this; }, trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const provider = "paseo-agy-acp";

async function waitFor(probe, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await probe();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`等待超时：${label}`);
}

async function harness(t, extraEnv = {}) {
  const directory = await mkdtemp(path.join(root, ".tmp-paseo-contract-"));
  const trace = path.join(directory, "requests.ndjson");
  const sessions = [];
  const client = new ACPAgentClient({ provider, logger,
    defaultCommand: [process.execPath, path.join(root, "tests/helpers/run-paseo-contract-adapter.mjs")] });
  const launch = { env: { HOME: directory, PASEO_HOME: directory, PASEO_AGENT_ID: "",
    PASEO_AGENT_CWD: directory, AGY_ACP_ADMISSION_ENABLED: "false", PASEO_CONTRACT_TRACE: trace, ...extraEnv } };
  const requests = async () => (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  t.after(async () => {
    try {
      await Promise.all(sessions.map(session => session.close()));
      for (const { pid } of (await requests()).filter(row => row.event === "kernel_started")) {
        await waitFor(() => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } }, "内核退出");
      }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  return { directory, requests,
    async create(mcpServers = {}) {
      const session = await client.createSession({ provider, cwd: directory, mcpServers }, launch);
      sessions.push(session);
      return session;
    },
    async resume(handle, options) {
      const session = await client.resumeSession(handle, undefined, launch, options);
      sessions.push(session);
      return session;
    }
  };
}

test("Paseo 0.13.2：真实客户端新建、模型切换、权限拒绝、取消与关闭", { timeout: 20_000 }, async t => {
  const h = await harness(t);
  const session = await h.create();
  const initialize = (await h.requests()).find(row => row.method === "initialize");
  assert.equal(initialize.params.clientCapabilities.terminal, true);
  assert.equal(initialize.params.clientCapabilities.session?.notices, undefined);
  assert.deepEqual(initialize.params.clientCapabilities.fs, { readTextFile: false, writeTextFile: false });
  assert.equal((await session.run("hello")).finalText, "contract-ok");
  await session.setModel("model-b");
  assert.equal((await session.getRuntimeInfo()).model, "model-b");
  assert.equal((await h.requests()).find(row => row.method === "session/set_model").params.modelId, "model-b");
  const denied = session.run("permission");
  const request = await waitFor(() => session.getPendingPermissions()[0], "许可请求");
  await session.respondToPermission(request.id, { behavior: "deny", selectedActionId: "reject" });
  assert.equal((await denied).finalText, "permission rejected");
  const events = [];
  const unsubscribe = session.subscribe(event => events.push(event));
  const cancelled = session.run("cancel");
  await waitFor(() => session.getPendingPermissions()[0], "取消前许可请求");
  await session.interrupt();
  assert.equal((await cancelled).finalText, "");
  assert.equal(events.filter(event => event.type === "turn_canceled").length, 1);
  assert.equal(events.filter(event => event.type === "turn_completed").length, 0);
  unsubscribe();
  assert.deepEqual(session.getPendingPermissions(), []);
  await session.close();
  assert.ok((await h.requests()).some(row => row.method === "session/close"));
});

for (const method of ["session/load", "session/resume"]) {
  test(`Paseo 0.13.2：冷启动 ${method} 保留 cwd 与 MCP`, { timeout: 20_000 }, async t => {
    const h = await harness(t, { PASEO_CONTRACT_RESUME: method === "session/resume" ? "1" : "0" });
    const original = await h.create();
    const handle = original.describePersistence();
    await original.close();
    const resumed = await h.resume(handle);
    assert.equal(resumed.id, handle.sessionId);
    assert.equal((await resumed.run("hello")).finalText, "contract-ok");
    const forwarded = (await h.requests()).find(row => row.method === method);
    assert.equal(forwarded.params.cwd, h.directory);
    assert.ok(Array.isArray(forwarded.params.mcpServers));
    await resumed.close();
    const history = await h.resume(handle, { purpose: "history" });
    assert.equal(history.id, handle.sessionId);
    assert.equal((await h.requests()).filter(row => row.method === method).length, 2);
  });
}

test("Paseo 0.13.2：跨主机委派 MCP 目录、参数、认证头和会话头透传", { timeout: 20_000 }, async t => {
  const received = [];
  const tools = [{ name: "delegate_to_host", description: "隔离测试工具，模拟远端主机委派",
    inputSchema: { type: "object", properties: { host: { type: "string" }, prompt: { type: "string" } } } }];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push({ url: request.url, headers: request.headers, message });
    if (request.headers.authorization !== "Bearer isolated-test-token") { response.writeHead(401).end(); return; }
    const result = message.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "isolated-paseo", version: "test" } }
      : message.method === "tools/list" ? { tools }
      : { content: [{ type: "text", text: "delegated:workstation-b" }] };
    response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "isolated-session" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const h = await harness(t);
  const url = `http://127.0.0.1:${server.address().port}/mcp?agent=isolated`;
  const session = await h.create({ paseo: { type: "http", url, headers: {
    Authorization: "Bearer isolated-test-token", "Mcp-Session-Id": "isolated-session", "X-Paseo-Agent": "agent-a"
  } } });
  const result = JSON.parse((await session.run("tools")).finalText);
  assert.deepEqual(result.listed.result.tools, tools);
  assert.equal(result.called.result.content[0].text, "delegated:workstation-b");
  assert.deepEqual(received.map(row => row.message.method), ["initialize", "tools/list", "tools/call"]);
  for (const row of received) {
    assert.equal(row.url, "/mcp?agent=isolated");
    assert.equal(row.headers.authorization, "Bearer isolated-test-token");
    assert.equal(row.headers["mcp-session-id"], "isolated-session");
    assert.equal(row.headers["x-paseo-agent"], "agent-a");
    assert.equal(row.headers["mcp-protocol-version"], "2025-11-25");
  }
  assert.equal(received[0].message.params.protocolVersion, "2025-11-25");
  assert.deepEqual(received[2].message.params, { name: "delegate_to_host", arguments: { host: "workstation-b", prompt: "执行隔离测试" } });
  const forwarded = (await h.requests()).find(row => row.method === "session/new").params.mcpServers.find(entry => entry.name === "paseo");
  assert.equal(forwarded.type, "http");
  assert.notEqual(forwarded.url, url);
  await session.close();
  await assert.rejects(fetch(forwarded.url, { signal: AbortSignal.timeout(1000) }));
});
