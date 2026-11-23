// 显式真实账号验收：只输出模型状态和断言结果，不记录正文或认证环境。
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { liveProviderEnvironment } from "./paseo-live-config.mjs";

import { actualForNativeLevel, advertisedCapabilities, rawGroupedIds, rawModel, rawThought, trackedFamilies } from "./paseo-live-model-capabilities.mjs";

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
const forwardedEffort = path.join(home, "forwarded-effort.log");
await writeFile(forwardedEffort, "", { mode: 0o600 });
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
createInterface({input:process.stdin}).on('line',line=>{try{const m=JSON.parse(line);sessionId=m.params?.sessionId??sessionId;if(m.method==='session/set_config_option'||m.method==='session/set_model'||m.method==='session/set_mode')appendFileSync(${JSON.stringify(forwardedEffort)},JSON.stringify({configId:m.params?.configId??(m.method==='session/set_model'?'model':'mode'),value:m.params?.value??m.params?.modelId??m.params?.modeId})+'\\n');}catch{}});
const probeFile=${JSON.stringify(path.join(home, "probe.json"))};
watchFile(probeFile,{interval:50},()=>{try {const p=JSON.parse(readFileSync(probeFile,'utf8'));child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:'probe-'+p.nonce,method:'session/load',params:{sessionId,cwd:p.cwd,mcpServers:[]}})+'\\n');}catch{}});
createInterface({input:child.stdout}).on('line',line=>{try {const m=JSON.parse(line);const r=m.result;sessionId=r?.sessionId??sessionId;const probe=typeof m.id==='string'&&m.id.startsWith('probe-');if(!probe)process.stdout.write(line+'\\n');if(r?.models || r?.configOptions)appendFileSync(${JSON.stringify(trace)},JSON.stringify({probe:probe?m.id.slice(6):undefined,pid:child.pid,model:r.models?.currentModelId,modelIds:r.models?.availableModels?.map(model=>model.modelId),configOptions:r.configOptions})+'\\n',{encoding:'utf8',mode:0o600});}catch{}});
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
const verifyActual = async () => {
  const nonce = randomUUID();
  await writeFile(path.join(home, "probe.json"), JSON.stringify({ nonce, cwd: work }), "utf8");
  let state;
  for (let n = 0; n < 200; n++) {
    state = await selection();
    if (state.probe === nonce) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(state.probe, nonce);
  assert.equal(typeof state.model, "string");
  return state;
};
const summary = { passed: false, paseo: "0.16.2", expectedManagedKernel: "1.5.0", checks: [], output: home };
let session;
let stage = "create";
const selection = async () => JSON.parse((await readFile(trace, "utf8")).trim().split("\n").at(-1));
const effortRequests = async () => (await readFile(forwardedEffort, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const forwardedEffortCount = async () => (await effortRequests()).length;
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
  const catalog = await selection();
  const menu = deriveModelDefinitionsFromACP("paseo-agy-acp", null, (await import(pathToFileURL(path.join(root, "dist/ACP Connector/official-kernel/mode-map.js")))).describeOfficialModes(catalog).configOptions);
  summary.menu = menu.map(model => ({ id: model.id, name: model.label }));
  assert.ok(menu.length, "expected at least one model");
  assert.ok(menu.every(model => !/\((?:thinking|minimal|high|medium|low|xhigh|extra high|max)(?: thinking)?\)$/i.test(model.label)));
  const officialIds = rawGroupedIds(catalog);
  summary.officialCatalog = officialIds;
  const targets = menu.filter(model => /^(claude-|gpt-oss-|gemini-)/.test(model.id));
  summary.skips = trackedFamilies(officialIds).map(family => ({
    family, reason: "not advertised in the official account model catalog"
  }));
  assert.deepEqual(targets.map(target => target.id).sort(), officialIds.filter(id => /^(claude-|gpt-oss-|gemini-)/.test(id)).sort());
  const runtimeSelection = async (id, level) => {
    const runtime = await session.getRuntimeInfo();
    assert.equal(runtime.model, id);
    assert.equal(runtime.thinkingOptionId, level);
  };
  for (const { id } of targets) {
    stage = "select:" + id;
    await daemon.agentManager.setAgentModel(agentId, id);
    const initial = await verifyActual();
    assert.equal(rawModel(initial)?.currentValue, id);
    const capability = advertisedCapabilities(initial, id);
    if (capability.kind === "not-bridged" || capability.kind === "unsupported-native-option") {
      summary.skips.push({ id, reason: capability.kind, nativeOption: capability.id, levels: capability.levels });
      continue;
    }
    const isFixed = capability.kind === "fixed";
    if (isFixed) assert.equal(initial.model, id, "fixed-model raw ID must match the advertised ID");
    const initialEffort = isFixed ? (await session.getRuntimeInfo()).thinkingOptionId : rawThought(initial)?.currentValue;
    // Stock Paseo may skip a re-selection of the current value. Exercise every
    // native tier as an actual change, with the initial one moved to the end.
    const levels = [
      ...capability.levels.filter(level => level !== initialEffort),
      ...capability.levels.filter(level => level === initialEffort)
    ];
    if (!isFixed && levels.length === 1 && levels[0] === initialEffort) {
      summary.skips.push({ id, reason: "only one native effort advertised; no native change to exercise", levels, actual: initial.model });
      continue;
    }
    for (const level of levels) {
      stage = capability.kind + "-effort:" + id + ":" + level;
      const before = await forwardedEffortCount();
      await daemon.agentManager.setAgentThinkingOption(agentId, level);
      await runtimeSelection(id, level);
      const state = await verifyActual();
      assert.equal(rawModel(state)?.currentValue, id);
      const expectedActual = isFixed ? initial.model : actualForNativeLevel(initial, id, level);
      if (!expectedActual) summary.missingConcreteId = { id, level, expected: id + "-" + level, officialModelIds: initial.modelIds };
      assert.ok(expectedActual, "expected an official concrete model ID for the advertised effort");
      assert.equal(state.model, expectedActual);
      const writes = (await effortRequests()).slice(before);
      if (isFixed) {
        assert.equal(rawThought(state), undefined);
        assert.deepEqual(writes, [], "fixed-model display effort must not reach the kernel");
      } else {
        assert.equal(rawThought(state)?.currentValue, level);
        assert.deepEqual(writes.map(({ configId, value }) => ({ configId, value })), [{ configId: capability.id, value: level }]);
      }
      const nonce = !id.startsWith("gemini-") && level === levels.at(-1) ? "check-" + randomUUID() : undefined;
      if (nonce) {
        stage = "generate:" + id;
        assert.ok((await run("只回复以下校验码，不调用工具：" + nonce)).finalText.includes(nonce));
      }
      stage = "restore:" + id + ":" + level;
      const beforeRestore = await forwardedEffortCount();
      await restore();
      const reopened = await verifyActual();
      assert.notEqual(reopened.pid, state.pid, "cold restore must use a new kernel process");
      assert.equal(reopened.model, expectedActual);
      assert.equal(rawModel(reopened)?.currentValue, id);
      assert.equal(rawThought(reopened)?.currentValue, isFixed ? undefined : level);
      if (isFixed) {
        const restoreWrites = (await effortRequests()).slice(beforeRestore);
        assert.deepEqual(restoreWrites.filter(write => !["model", "mode", "session_mode"].includes(write.configId)), [],
          "cold restore must not forward a fixed effort");
      }
      await runtimeSelection(id, level);
      if (nonce) {
        stage = "restored-generate:" + id;
        assert.ok((await run("只回复上一轮给你的完整校验码，不调用工具。")).finalText.includes(nonce));
      }
      summary.checks.push({ id, actual: state.model, level, capability: capability.kind,
        nativeWrites: writes.length, restored: true, ...(nonce ? { generated: true, restoredHistory: true } : {}) });
    }
  }
  assert.ok(summary.checks.length, "no target advertised verifiable capabilities");
  summary.coverage = summary.skips.length ? "advertised capabilities only; see explicit skips" : "all tracked capabilities advertised";
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
