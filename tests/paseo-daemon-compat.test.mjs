import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { clientFixtures } from "../scripts/paseo-client-versions.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = clientFixtures.find(entry => entry.version === "0.14.0");
const require = createRequire(path.resolve(process.env.PASEO_COMPAT_CLIENT_ROOT ?? fixture.root, "package.json"));
const entry = require.resolve("@getpaseo/server");
const serverRoot = path.resolve(path.dirname(entry), "../../..");
assert.equal(JSON.parse(await readFile(path.join(serverRoot, "package.json"), "utf8")).version, "0.14.0");
const load = relative => import(pathToFileURL(path.join(path.dirname(entry), relative)).href);
const { AgentManager } = await load("agent/agent-manager.js");
const { AgentStorage } = await load("agent/agent-storage.js");
const { ACPAgentClient } = await load("agent/providers/acp-agent.js");
const { createIdleRuntimeCleanup } = await load("agent/idle-runtime-cleanup/index.js");
const logger = require("pino")({ level: "silent" });
const provider = "paseo-agy-acp";

async function waitFor(probe, label) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await probe();
    if (value) return value;
    await delay(20);
  }
  throw new Error("等待超时：" + label);
}

// 使用真实 daemon 核心和存储，只有 Google 内核与插件 hook 的返回值由测试提供。
async function harness(t, { resume = false, admission = false } = {}) {
  const directory = await mkdtemp(path.join(root, ".tmp-paseo-daemon-"));
  const trace = path.join(directory, "requests.ndjson");
  await mkdir(path.join(directory, "admission/official-kernel"), { recursive: true, mode: 0o700 });
  const opens = [];
  const received = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    received.push({ url: request.url, message });
    const result = message.method === "initialize"
      ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "plugin-probe", version: "1" } }
      : message.method === "tools/list"
        ? { tools: [{ name: "delegate_to_host", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: "delegated:workstation-b" }] };
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const registry = new AgentStorage(path.join(directory, "agents"), logger);
  await registry.initialize();
  const client = new ACPAgentClient({ provider, logger,
    defaultCommand: [process.execPath, path.join(root, "tests/helpers/run-paseo-contract-adapter.mjs")],
    runtimeSettings: { env: { HOME: directory, PASEO_HOME: directory, PASEO_CONTRACT_TRACE: trace,
      PASEO_CONTRACT_RESUME: resume ? "1" : "0", AGY_ACP_ADMISSION_ENABLED: String(admission),
      AGY_ACP_STATE_DIR: path.join(directory, "admission"), AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS: "1" } } });
  const manager = new AgentManager({ logger, registry, clients: { [provider]: client },
    providerDefinitions: { [provider]: { enabled: true } }, paseoToolsEnabled: false,
    appendSystemPrompt: "daemon-context-marker",
    pluginLifecycle: {
      emit() {},
      async before(name, request) {
        if (name !== "agent.session_open") return request;
        opens.push({ agentId: request.agentId, reason: request.reason });
        return { ...request, mcpServers: { plugin_probe: { type: "http",
          url: `http://127.0.0.1:${server.address().port}/open-${opens.length}` } } };
      }
    } });
  const requests = async () => {
    try { return (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  };
  t.after(async () => {
    try {
      for (const agent of manager.listAgents()) {
        await manager.cancelAgentRun(agent.id);
        await manager.closeAgent(agent.id);
      }
      await manager.flushForShutdown();
      await registry.flush();
      for (const row of (await requests()).filter(row => row.event === "kernel_started")) {
        await waitFor(() => { try { process.kill(row.pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } }, "内核退出");
      }
    } finally {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await rm(directory, { recursive: true, force: true });
    }
  });
  return { directory, manager, registry, requests, opens, received,
    async create(id) { return manager.createAgent({ provider, cwd: directory, model: "model-b", thinkingOptionId: "high" }, id, { workspaceId: undefined }); }
  };
}

for (const resume of [false, true]) {
  test(`Paseo 0.14 daemon：空闲回收后 ${resume ? "resume" : "load"} 保留会话、context、MCP、模型和 thinking`, { timeout: 30_000 }, async t => {
    const h = await harness(t, { resume });
    const agent = await h.create("00000000-0000-4000-8000-000000000001");
    const first = JSON.parse((await h.manager.runAgent(agent.id, "inspect")).finalText);
    assert.match(JSON.stringify(first.prompt), /daemon-context-marker/);
    assert.equal(first.state.models.currentModelId, "model-b");
    assert.equal(first.state.configOptions[0].currentValue, "high");
    await h.manager.runAgent(agent.id, "tools");
    assert.ok(h.received.some(row => row.url === "/open-1" && row.message.method === "tools/call"));
    const sessionId = agent.persistence.sessionId;
    await waitFor(() => h.manager.getRuntimeCleanupCandidates()[0]?.isEligible(), "daemon 空闲");
    const firstPid = (await h.requests()).find(row => row.event === "kernel_started").pid;
    let now = h.manager.getAgent(agent.id).updatedAt.getTime() + 3_599_999;
    const cleanup = createIdleRuntimeCleanup({ enabled: true, logger, now: () => now,
      runtimes: () => h.manager.getRuntimeCleanupCandidates(), schedule: () => () => {} });
    t.after(() => cleanup.close());
    assert.deepEqual((await cleanup.sweep()).collected, []);
    now += 2;
    const swept = await cleanup.sweep();
    assert.equal(swept.failures.length, 0);
    assert.equal(swept.collected[0]?.agentId, agent.id);
    assert.equal(swept.collected[0]?.sessionId, sessionId);
    await waitFor(() => { try { process.kill(firstPid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } }, "回收进程退出");
    const second = JSON.parse((await h.manager.runAgent(agent.id, "inspect")).finalText);
    assert.match(JSON.stringify(second.prompt), /daemon-context-marker/);
    assert.deepEqual(second.state, first.state);
    assert.ok(second.servers.includes("plugin_probe"));
    assert.equal(h.manager.getAgent(agent.id).persistence.sessionId, sessionId);
    assert.equal(h.opens.length, 2);
    await h.manager.runAgent(agent.id, "tools");
    assert.ok(h.received.some(row => row.url === "/open-2" && row.message.method === "tools/call"));
    const forwarded = (await h.requests()).find(row => row.method === (resume ? "session/resume" : "session/load"));
    assert.equal(forwarded.params.sessionId, sessionId);
    assert.equal(forwarded.params.cwd, h.directory);
    const runtime = await h.manager.getAgent(agent.id).session.getRuntimeInfo();
    assert.equal(runtime.model, "model-b");
    assert.equal(runtime.thinkingOptionId, "high");
  });
}

test("Paseo 0.14 daemon：排队取消不派发、不被空闲回收，并释放活动席位", { timeout: 30_000 }, async t => {
  const h = await harness(t, { admission: true });
  const first = await h.create("00000000-0000-4000-8000-000000000001");
  const second = await h.create("00000000-0000-4000-8000-000000000002");
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(path.join(h.directory, "admission/official-kernel/runtime.sqlite"), { readonly: true });
  t.after(() => db.close());
  const active = h.manager.runAgent(first.id, "hold");
  active.catch(() => {});
  await waitFor(() => db.prepare("SELECT 1 FROM turn_requests WHERE agent_id=? AND state='active'").get(first.id), "首轮激活");
  const queued = h.manager.runAgent(second.id, "inspect");
  queued.catch(() => {});
  await waitFor(() => db.prepare("SELECT 1 FROM turn_requests WHERE agent_id=? AND state='queued'").get(second.id), "第二轮排队");
  const cleanup = createIdleRuntimeCleanup({ enabled: true, logger, now: () => Date.now() + 3_600_001,
    runtimes: () => h.manager.getRuntimeCleanupCandidates(), schedule: () => () => {} });
  t.after(() => cleanup.close());
  assert.deepEqual((await cleanup.sweep()).collected, []);
  assert.equal((await h.manager.cancelAgentRun(second.id)).status, "settled");
  await queued.catch(() => {});
  assert.equal(db.prepare("SELECT state FROM turn_requests WHERE agent_id=?").get(second.id).state, "cancelled");
  assert.equal((await h.requests()).filter(row => row.method === "session/prompt" && row.params.sessionId === second.persistence.sessionId).length, 0);
  assert.equal((await h.manager.cancelAgentRun(first.id)).status, "settled");
  await active.catch(() => {});
  await waitFor(() => db.prepare("SELECT state FROM turn_requests WHERE agent_id=?").get(first.id).state === "cancelled", "已派发轮次结算");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM turn_requests WHERE state IN ('active','starting','dispatching')").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM leases").get().n, 0);
  assert.equal(db.prepare("SELECT state FROM turn_requests WHERE agent_id=?").get(first.id).state, "cancelled");
  // 再跑一轮，证明席位可复用，且已取消的业务 prompt 没有被自动重放。
  await h.manager.runAgent(second.id, "inspect");
  await waitFor(() => db.prepare("SELECT COUNT(*) AS n FROM turn_requests WHERE state='completed'").get().n === 1, "后续轮次结算");
  assert.equal((await h.requests()).filter(row => row.method === "session/prompt" && row.params.sessionId === second.persistence.sessionId).length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM turn_requests WHERE state IN ('active','starting','dispatching')").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM leases").get().n, 0);
});
