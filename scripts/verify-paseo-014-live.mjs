// 显式本机验收：使用现有登录账号，另开 loopback daemon 和 Admission 状态目录。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const cliRoot = process.env.PASEO_LIVE_CLI_ROOT;
assert.ok(cliRoot, "请显式设置 PASEO_LIVE_CLI_ROOT 为已安装的 @getpaseo/cli 目录");
const require = createRequire(path.join(cliRoot, "package.json"));
const entry = require.resolve("@getpaseo/server");
assert.equal(JSON.parse(await readFile(path.resolve(path.dirname(entry), "../../../package.json"), "utf8")).version, "0.14.0");
const load = relative => import(pathToFileURL(path.join(path.dirname(entry), relative)).href);
const { createPaseoDaemon } = await load("bootstrap.js");
const { resolveConfigFromPersisted } = await load("config.js");
const { createIdleRuntimeCleanup } = await load("agent/idle-runtime-cleanup/index.js");
const home = path.join(root, ".tmp-paseo-014-live", randomUUID());
await mkdir(path.join(home, "admission/official-kernel"), { recursive: true, mode: 0o700 });
await mkdir(path.join(home, "work"));
const configHome = process.env.PASEO_LIVE_SOURCE_HOME ?? path.join(process.env.HOME, ".paseo");
const source = JSON.parse(await readFile(path.join(configHome, "config.json"), "utf8"));
const provider = "paseo-agy-acp";
const original = source.agents?.providers?.[provider];
assert.ok(original, "源配置缺少 paseo-agy-acp provider");
const contextMarker = "context-" + randomUUID();
const persisted = { version: 1, pluginsEnabled: false,
  daemon: { listen: "127.0.0.1:0", relay: { enabled: false }, mcp: { enabled: true, injectIntoAgents: true },
    appendSystemPrompt: `这是隔离验收。每次回复必须包含 ${contextMarker}。只执行用户指定的只读工具。` },
  agents: { idleRuntimeCleanup: false, providers: {
    ...Object.fromEntries(["claude", "codex", "copilot", "opencode", "pi", "omp", "antigravity", "muse"].map(id => [id, { enabled: false }])),
    [provider]: { ...original, command: [process.execPath, path.join(root, "dist/ACP Connector/main.js")], env: {
      ...original.env, PASEO_HOME: home, AGY_ACP_ADMISSION_ENABLED: "true", AGY_ACP_STATE_DIR: path.join(home, "admission")
    } }
  } }, features: { voiceMode: { enabled: false } } };
// 仅保留本次验收的私有配置；日志与结果不输出源 provider 的环境变量。
await writeFile(path.join(home, "config.json"), JSON.stringify(persisted, null, 2), { encoding: "utf8", mode: 0o600 });
const config = resolveConfigFromPersisted(home, persisted, { env: {}, relayEnabledFallback: false });
for (const setting of Object.values(config.speech.providers)) setting.enabled = false;
const logger = require("pino")({ level: "warn" }, path.join(home, "daemon.log"));
const daemon = await createPaseoDaemon(config, logger);
let cleanup;
const summary = { passed: false, paseo: "0.14.0", isolatedHome: home, clock: "injected into real idle collector", checks: {} };
try {
  await daemon.start();
  summary.serverId = daemon.getServerId();
  summary.listen = daemon.getListenTarget();
  const nonce = "memory-" + randomUUID();
  const agent = await daemon.agentManager.createAgent({ provider, cwd: path.join(home, "work"),
    model: "gemini-3.8-flash-high", thinkingOptionId: "high", modeId: "yolo" }, undefined, { workspaceId: undefined });
  const first = await daemon.agentManager.runAgent(agent.id, `记住校验码 ${nonce}。调用 Paseo 的 list_hosts 工具一次，然后回复校验码。`);
  assert.match(first.finalText, new RegExp(nonce));
  assert.match(first.finalText, new RegExp(contextMarker));
  const firstTools = daemon.agentManager.getTimeline(agent.id).filter(row => row.type === "tool_call" && /list_hosts/.test(JSON.stringify(row)));
  assert.ok(firstTools.some(row => row.status === "completed"), "首轮没有成功调用 list_hosts 的证据");
  summary.checks.mcpBefore = true;
  const current = daemon.agentManager.getAgent(agent.id);
  summary.agentId = agent.id;
  summary.sessionId = current.persistence.sessionId;
  summary.runtimeBefore = await current.session.getRuntimeInfo();
  await daemon.agentStorage.flush();
  for (let attempt = 0; !daemon.agentManager.getRuntimeCleanupCandidates().find(row => row.agentId === agent.id)?.isEligible(); attempt++) {
    assert.ok(attempt < 100, "运行时未进入可回收状态");
    await delay(50);
  }
  cleanup = createIdleRuntimeCleanup({ enabled: true, logger, now: () => Date.now() + 3_600_001,
    runtimes: () => daemon.agentManager.getRuntimeCleanupCandidates(), schedule: () => () => {} });
  const swept = await cleanup.sweep();
  assert.equal(swept.failures.length, 0);
  assert.ok(swept.collected.some(row => row.agentId === agent.id));
  summary.checks.idleCollected = true;
  const second = await daemon.agentManager.runAgent(agent.id, "调用 Paseo 的 list_hosts 工具一次，再回复上一轮给你的完整校验码。");
  assert.match(second.finalText, new RegExp(nonce));
  assert.match(second.finalText, new RegExp(contextMarker));
  const secondTools = daemon.agentManager.getTimeline(agent.id).filter(row => row.type === "tool_call" && /list_hosts/.test(JSON.stringify(row)));
  assert.ok(secondTools.filter(row => row.status === "completed").length > firstTools.filter(row => row.status === "completed").length,
    "恢复后没有新的成功 list_hosts 调用");
  summary.checks.mcpAfter = true;
  const resumed = daemon.agentManager.getAgent(agent.id);
  assert.equal(resumed.persistence.sessionId, summary.sessionId);
  summary.runtimeAfter = await resumed.session.getRuntimeInfo();
  assert.equal(summary.runtimeAfter.model, summary.runtimeBefore.model);
  assert.equal(summary.runtimeAfter.thinkingOptionId, summary.runtimeBefore.thinkingOptionId);
  summary.checks.sameSessionAndHistory = true;
  summary.checks.contextRetained = true;
  summary.checks.modelAndThinkingRetained = true;
  summary.passed = true;
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  await cleanup?.close();
  await daemon.stop();
  await writeFile(path.join(home, "result.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(summary, null, 2));
}
