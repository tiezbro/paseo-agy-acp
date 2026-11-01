import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));

async function providerHarness(t, enabled) {
  const home = await mkdtemp(path.join(root, ".tmp-provider-platform-"));
  const trace = path.join(home, "requests.ndjson");
  const child = spawn(process.execPath, [path.join(root, "tests/helpers/run-paseo-contract-adapter.mjs")], {
    cwd: root, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: home, PASEO_HOME: home, PASEO_AGENT_ID: enabled ? undefined : "", PASEO_AGENT_CWD: home,
      AGY_ACP_ADMISSION_ENABLED: String(enabled), AGY_ACP_STATE_DIR: path.join(home, "admission"), PASEO_CONTRACT_TRACE: trace }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
  const closed = new Promise(resolve => child.once("close", resolve));
  const pending = new Map();
  const updates = [];
  readline.createInterface({ input: child.stdout }).on("line", line => {
    const message = JSON.parse(line);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else updates.push(message);
  });
  let sequence = 0;
  const send = message => child.stdin.write(JSON.stringify(message) + "\n");
  const rpc = (method, params) => new Promise(resolve => {
    const id = ++sequence;
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });
  const requests = async () => (await readFile(trace, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 5_000);
    try { await closed; }
    finally { clearTimeout(timer); await rm(home, { recursive: true, force: true }); }
  });
  return { home, rpc, send, requests, updates, stderr: () => stderr };
}

for (const enabled of [false, true]) {
  test(`${process.platform}：${enabled ? "无身份 discovery 告警且拒绝业务 prompt" : "Admission 关闭时普通 provider 可用"}`, { timeout: 20_000 }, async t => {
    const h = await providerHarness(t, enabled);
    assert.ok((await h.rpc("initialize", { protocolVersion: 1, clientCapabilities: { terminal: true, fs: {} } })).result);
    const created = await h.rpc("session/new", { cwd: h.home, mcpServers: [] });
    const sessionId = created.result.sessionId;
    assert.ok(sessionId);
    const sessionParams = (await h.requests()).find(row => row.method === "session/new").params;
    const url = sessionParams.mcpServers.find(server => server.name === "paseo_skills").url;
    const tools = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
    assert.equal(tools.status, 200);
    if (enabled) {
      assert.match(h.stderr(), /Admission enabled without PASEO_AGENT_ID.*discovery only.*session\/prompt is blocked/);
      const rejected = await h.rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "inspect" }] });
      assert.match(rejected.error.message, /session\/prompt is blocked/);
      assert.equal((await h.requests()).filter(row => row.method === "session/prompt").length, 0);
      await assert.rejects(stat(path.join(h.home, "admission")), { code: "ENOENT" });
    } else {
      await h.rpc("session/set_model", { sessionId, modelId: "model-b" });
      assert.equal((await h.rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "inspect" }] })).result.stopReason, "end_turn");
      assert.match(JSON.stringify(h.updates), /model-b/);
      const held = h.rpc("session/prompt", { sessionId, prompt: [{ type: "text", text: "hold" }] });
      let dispatched = false;
      for (let n = 0; n < 200; n++) {
        if ((await h.requests()).filter(row => row.method === "session/prompt").length === 2) { dispatched = true; break; }
        await delay(10);
      }
      assert.ok(dispatched, "hold prompt must reach the isolated kernel before cancellation");
      h.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
      assert.equal((await held).result.stopReason, "cancelled");
      assert.equal(h.stderr().includes("Admission enabled"), false);
    }
    await h.rpc("session/close", { sessionId });
    assert.equal((await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) })).status, 404);
  });
}
