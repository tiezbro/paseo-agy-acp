// 显式真实账号验收：只输出模型状态和断言结果，不记录正文或认证环境。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { liveProviderEnvironment } from "./paseo-live-config.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const cliRoot = process.env.PASEO_LIVE_CLI_ROOT;
assert.ok(cliRoot, "需要 PASEO_LIVE_CLI_ROOT");
const require = createRequire(path.resolve(cliRoot, "package.json"));
const entry = require.resolve("@getpaseo/server");
assert.equal(JSON.parse(await readFile(path.resolve(path.dirname(entry), "../../../package.json"), "utf8")).version, "0.16.2");
const { deriveModelDefinitionsFromACP } = await import(pathToFileURL(path.join(path.dirname(entry), "agent/providers/acp-agent.js")));
const source = JSON.parse(await readFile(path.join(process.env.PASEO_LIVE_SOURCE_HOME ?? path.join(process.env.HOME, ".paseo"), "config.json"), "utf8"));
const env = liveProviderEnvironment(source.agents.providers["paseo-agy-acp"].env);
const home = await mkdtemp(path.join(root, ".tmp-paseo-model-live-"));
const work = path.join(home, "work");
await mkdir(work);
const trace = path.join(home, "selection.ndjson");
const wrapper = path.join(home, "kernel.mjs");
const kernel = path.join(process.env.HOME, ".local/opt/paseo-agy-acp-kernel-compat/agy-acp-kernel-compat-active");
// 透明观察官方回包中的实际模型 ID；磁盘仅保存选择状态，不保存请求、正文或环境。
await writeFile(wrapper, `#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {appendFileSync,readFileSync,watchFile} from 'node:fs';
import {createInterface} from 'node:readline';
const child=spawn(${JSON.stringify(kernel)},[],{env:process.env,stdio:['pipe','pipe','pipe']});
process.stdin.pipe(child.stdin);child.stderr.pipe(process.stderr);
let sessionId;
createInterface({input:process.stdin}).on('line',line=>{try{sessionId=JSON.parse(line).params?.sessionId??sessionId;}catch{}});
const probeFile=${JSON.stringify(path.join(home, "probe.json"))};
watchFile(probeFile,{interval:50},()=>{try {const p=JSON.parse(readFileSync(probeFile,'utf8'));child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:'probe-'+p.nonce,method:'session/load',params:{sessionId,cwd:p.cwd,mcpServers:[]}})+'\\n');}catch{}});
createInterface({input:child.stdout}).on('line',line=>{try {const m=JSON.parse(line);const r=m.result;sessionId=r?.sessionId??sessionId;const probe=typeof m.id==='string'&&m.id.startsWith('probe-');if(!probe)process.stdout.write(line+'\\n');if(r?.models || r?.configOptions)appendFileSync(${JSON.stringify(trace)},JSON.stringify({probe:probe?m.id.slice(6):undefined,model:r.models?.currentModelId,configOptions:r.configOptions})+'\\n',{encoding:'utf8',mode:0o600});}catch{}});
process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('close',code=>process.exit(code??0));
`, "utf8");
await chmod(wrapper, 0o700);
const load = relative => import(pathToFileURL(path.join(path.dirname(entry), relative)));
const { createPaseoDaemon } = await load("bootstrap.js");
const { ensureAgentLoaded } = await load("agent/agent-loading.js");
const { resolveConfigFromPersisted } = await load("config.js");
const persisted = { version: 1, pluginsEnabled: false,
  daemon: { listen: "127.0.0.1:0", relay: { enabled: false }, mcp: { enabled: false } },
  agents: { idleRuntimeCleanup: false, providers: { ...Object.fromEntries(
    ["claude", "codex", "copilot", "opencode", "pi", "omp", "antigravity", "muse"].map(id => [id, { enabled: false }])),
    "paseo-agy-acp": { enabled: true, extends: "acp", label: "Isolated grouped model acceptance", command: [process.execPath, path.join(root, "dist/ACP Connector/main.js")],
      env: { ...env, PASEO_AGY_ACP_OFFICIAL_BIN: wrapper, PASEO_HOME: home } }
  } }, features: { voiceMode: { enabled: false } } };
let daemon;
let agentId;
const restore = async () => {
  await daemon.agentStorage.flush();
  let candidate;
  for (let n = 0; n < 100; n++) {
    candidate = daemon.agentManager.getRuntimeCleanupCandidates().find(row => row.agentId === agentId);
    if (candidate?.isEligible()) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(await candidate.closeIfEligible(() => true));
  await ensureAgentLoaded(agentId, { agentManager: daemon.agentManager, agentStorage: daemon.agentStorage, logger: require("pino")({level:"silent"}) });
  session = daemon.agentManager.getAgent(agentId).session;
};
const verifyActual = async expected => {
  const nonce = randomUUID();
  await writeFile(path.join(home, "probe.json"), JSON.stringify({ nonce, cwd: work }), "utf8");
  let state;
  for (let n = 0; n < 200; n++) {
    state = await selection();
    if (state.probe === nonce) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(state.probe, nonce);
  assert.equal(state.model, expected);
};
const summary = { passed: false, paseo: "0.16.2", kernel: "1.5.0", checks: [], output: home };
let session;
let stage = "create";
const selection = async () => JSON.parse((await readFile(trace, "utf8")).trim().split("\n").at(-1));
const configModel = state => state.configOptions.find(option => option.category === "model");
const thinking = state => state.configOptions.find(option => option.category === "thought_level");
const run = async prompt => {
  let timer;
  try { return await Promise.race([daemon.agentManager.runAgent(agentId, prompt), new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("generation timeout")), 180_000);
  })]); } finally { clearTimeout(timer); }
};
try {
  stage = "resolve-config";
  const config = resolveConfigFromPersisted(home, persisted, { env: {}, relayEnabledFallback: false });
  for (const provider of Object.values(config.speech.providers)) provider.enabled = false;
  stage = "create-daemon";
  daemon = await createPaseoDaemon(config, require("pino")({ level: "silent" }));
  stage = "start-daemon";
  await daemon.start();
  stage = "create-agent";
  const agent = await daemon.agentManager.createAgent({ provider: "paseo-agy-acp", cwd: work }, undefined, { workspaceId: undefined });
  agentId = agent.id;
  await daemon.agentManager.ensureInteractiveSession(agentId);
  session = daemon.agentManager.getAgent(agentId).session;
  let state = await selection();
  const menu = deriveModelDefinitionsFromACP("paseo-agy-acp", null, (await import(pathToFileURL(path.join(root, "dist/ACP Connector/official-kernel/mode-map.js")))).describeOfficialModes(state).configOptions);
  summary.menu = menu.map(model => ({ id: model.id, name: model.label }));
  assert.ok(menu.every(model => !/\((?:thinking|high|medium|low)\)/i.test(model.label)));
  const targets = menu.filter(model => /^(claude-|gpt-oss-)/.test(model.id));
  assert.ok(targets.some(model => model.id.startsWith("claude-")));
  assert.ok(targets.some(model => model.id.startsWith("gpt-oss-")));
  for (const target of targets) {
    stage = "select:" + target.id;
    await daemon.agentManager.setAgentModel(agentId, target.id);
    state = await selection();
    assert.equal(configModel(state).currentValue, target.id);
    assert.equal(thinking(state), undefined, "单档模型不得出现档位选择器");
    const actual = target.id;
    const nonce = "check-" + randomUUID();
    stage = "generate:" + target.id;
    assert.ok((await run("只回复以下校验码，不调用工具：" + nonce)).finalText.includes(nonce));
    stage = "restore:" + target.id;
    await restore();
    await verifyActual(actual);
    state = await selection();
    assert.equal(state.model, actual);
    assert.equal(configModel(state).currentValue, target.id);
    assert.equal(thinking(state), undefined);
    stage = "restored-generate:" + target.id;
    assert.ok((await run("只回复上一轮给你的完整校验码，不调用工具。")).finalText.includes(nonce));
    summary.checks.push({ id: target.id, actual, generated: true, restored: true });
  }
  stage = "thinking";
  const family = menu.find(model => model.id === "gemini-3.8-flash");
  assert.ok(family);
  await daemon.agentManager.setAgentModel(agentId, family.id);
  for (const level of ["low", "medium", "high"]) {
    await daemon.agentManager.setAgentThinkingOption(agentId, level);
    state = await selection();
    assert.equal(thinking(state).currentValue, level);
    await restore();
    await verifyActual(family.id + "-" + level);
    state = await selection();
    assert.equal(state.model, family.id + "-" + level);
    assert.equal(thinking(state).currentValue, level);
    summary.checks.push({ id: family.id, level, actual: state.model });
  }
  await restore();
  await verifyActual(family.id + "-high");
  state = await selection();
  assert.equal(state.model, family.id + "-high");
  assert.equal(thinking(state).currentValue, "high");
  summary.passed = true;
} catch (error) {
  summary.errorLocations = [...(error.stack ?? "").matchAll(/\b[\w-]+\.(?:m?js|ts):\d+:\d+/g)].map(m => m[0]).slice(0, 4);
  summary.failedStage = stage;
  process.exitCode = 1;
} finally {
  await daemon?.stop();
  await rm(wrapper, { force: true });
  await writeFile(path.join(home, "result.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

process.exit(process.exitCode ?? 0);
