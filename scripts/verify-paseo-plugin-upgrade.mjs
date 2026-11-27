import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { commandEnvironment, quotaScratch } from "./quota-install-environment.mjs";

// 2.11.0 -> 当前打包插件的原位升级回归验证（假 ACP 内核，无需真实 OAuth）。
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = process.env.PASEO_UPGRADE_CLI || "paseo";
const baselineVersion = process.env.PASEO_UPGRADE_BASELINE || "2.11.0";
let daemonRunning = false;

const transport = commandEnvironment(process.env);
const scratch = quotaScratch(root, () => {
  if (daemonRunning) {
    try { run(cli, ["daemon", "stop", "--home", daemonHome], daemonEnv); } catch { /* ignore stop error on teardown */ }
    daemonRunning = false;
  }
});
const area = scratch.area;
process.once("exit", scratch.cleanup);
process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));

const daemonHome = path.join(area, "daemon");
const daemonUserHome = path.join(area, "user");
const fakeGeminiHome = path.join(area, "gemini-home");
const installPrefix = path.join(area, "installed");
const npmCache = path.join(area, "npm-cache");
const tarballs = path.join(area, "tarballs");
for (const dir of [daemonHome, daemonUserHome, fakeGeminiHome, installPrefix, npmCache, tarballs]) {
  mkdirSync(dir, { recursive: true });
}
const daemonEnv = { ...transport, HOME: daemonUserHome, PASEO_HOME: daemonHome };

function run(command, args, env = transport) {
  return execFileSync(command, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function readJsonLines(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function extractReports(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.reports)) return payload.reports;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
}

// 假 ACP 内核：支持普通 provider 握手、模型列表和 /usage，不接触真实账号或网络。
const fakeKernelPath = path.join(area, "fake-acp-kernel.mjs");
const kernelTracePath = path.join(area, "kernel-trace.jsonl");
const adapterTracePath = path.join(area, "adapter-trace.jsonl");
writeFileSync(kernelTracePath, "", "utf8");
writeFileSync(adapterTracePath, "", "utf8");

writeFileSync(fakeKernelPath, `#!${process.execPath}
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const tracePath = ${JSON.stringify(kernelTracePath)};
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");

createInterface({ input: process.stdin }).on("line", line => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const request = JSON.parse(trimmed);
  const promptText = Array.isArray(request.params?.prompt)
    ? request.params.prompt.map(item => item?.text ?? "").join("")
    : undefined;
  appendFileSync(tracePath, JSON.stringify({
    method: request.method ?? null,
    clientName: request.params?.clientInfo?.name ?? null,
    promptText: promptText ?? null,
  }) + "\\n", "utf8");
  const reply = result => send({ id: request.id, result });

  if (request.method === "initialize") {
    reply({
      protocolVersion: 1,
      agentInfo: { name: "antigravity-acp", version: "1.5.2-fake" },
      agentCapabilities: { promptCapabilities: { image: true } },
      authMethods: [],
    });
  } else if (request.method === "authenticate") {
    reply({});
  } else if (request.method === "session/new") {
    const sessionId = "fake-upgrade-session";
    reply({
      sessionId,
      modes: {
        currentModeId: "default",
        availableModes: [{ id: "default", name: "Default", description: "Default mode" }],
      },
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "gemini-fake-pro",
          options: [{ value: "gemini-fake-pro", name: "Gemini Fake Pro" }],
        },
      ],
    });
    send({
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [{ name: "usage", description: "Show usage" }],
        },
      },
    });
  } else if (request.method === "session/prompt") {
    if (promptText === "/usage") {
      const text = "### Session Usage\\n- **Session total:** 0 tokens\\n\\n### Quota Limits\\n- **Gemini Models**\\n  - **Weekly Limit Remaining:** 46% remaining (resets Dec 02, 2026, 09:05 UTC)\\n  - **Five Hour Limit Remaining:** 100% remaining\\n- **Claude and GPT models**\\n  - **Weekly Limit Remaining:** 0% remaining\\n  - **Five Hour Limit Remaining:** Disabled\\n";
      send({
        method: "session/update",
        params: {
          sessionId: request.params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
        },
      });
      reply({ stopReason: "end_turn" });
    } else {
      reply({ stopReason: "end_turn" });
    }
  }
});
`, "utf8");
chmodSync(fakeKernelPath, 0o755);

const packageRoot = path.join(installPrefix, "node_modules", "paseo-agy-acp");
const pluginDir = path.join(packageRoot, "plugins", "paseo-agy-acp");
const adapterEntry = path.join(packageRoot, "dist", "ACP Connector", "main.js");
const adapterWrapper = path.join(area, "adapter-wrapper.mjs");

// 包装器只记录命令行参数，不改变启动目标与 stdio 语义。
writeFileSync(adapterWrapper, `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(adapterTracePath)}, JSON.stringify({ args }) + "\\n", "utf8");
const child = spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(adapterEntry)}, ...args], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
`, "utf8");
chmodSync(adapterWrapper, 0o755);

const configPath = path.join(daemonHome, "config.json");
const baseConfig = {
  version: 1,
  pluginsEnabled: true,
  daemon: { listen: "127.0.0.1:0", relay: { enabled: false } },
  features: { voiceMode: { enabled: false } },
  agents: {
    providers: {
      ...Object.fromEntries(
        ["claude", "codex", "copilot", "opencode", "pi", "omp", "antigravity", "muse"].map(id => [id, { enabled: false }])
      ),
      "paseo-agy-acp": {
        enabled: true,
        command: [process.execPath, adapterWrapper],
        env: {
          HOME: daemonUserHome,
          GEMINI_HOME: fakeGeminiHome,
          PASEO_HOME: daemonHome,
          PASEO_AGY_ACP_OFFICIAL_BIN: fakeKernelPath,
        },
      },
    },
  },
};

function startDaemon() {
  run(cli, ["daemon", "start", "--home", daemonHome], daemonEnv);
  daemonRunning = true;
}

function stopDaemon() {
  run(cli, ["daemon", "stop", "--home", daemonHome], daemonEnv);
  daemonRunning = false;
}

const paseoVersion = run(cli, ["--version"]).trim();
const candidateVersion = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const summary = {
  passed: false,
  stage: "init",
  paseoVersion,
  baselineVersion,
  candidateVersion,
  tarballSha256: null,
  beforeUpgrade: null,
  afterUpgradeAndRestart: null,
};

try {
  // 1. 先安装已发布的 2.11.0 对照包
  summary.stage = "install-baseline";
  run("npm", [
    "install", "--prefix", installPrefix, "--ignore-scripts",
    "--no-audit", "--no-fund", "--cache", npmCache,
    `paseo-agy-acp@${baselineVersion}`,
  ]);
  assert.equal(existsSync(path.join(pluginDir, "server", "usage.ts")), true, "基线 2.11.0 必须包含 server/usage.ts");

  // 2. 启动隔离 daemon 并安装 2.11.0 插件
  summary.stage = "start-baseline-daemon";
  writeFileSync(configPath, JSON.stringify(baseConfig, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  startDaemon();
  run(cli, ["plugin", "install", pluginDir, "--json"], daemonEnv);
  run(cli, ["reload", "--json"], daemonEnv);

  const baselinePlugin = JSON.parse(run(cli, ["plugin", "ls", "paseo-agy-acp", "--json"], daemonEnv));
  assert.equal(baselinePlugin[0]?.status, "running", "2.11.0 插件应处于 running 状态");

  // 3. 证明旧版 2.11.0 刷新会触发后台 --usage 查询并展示 Antigravity ACP 来源
  summary.stage = "verify-baseline-usage";
  const adapterCountBeforeOld = readJsonLines(adapterTracePath).length;
  const kernelCountBeforeOld = readJsonLines(kernelTracePath).length;
  const oldUsagePayload = JSON.parse(run(cli, ["usage", "ls", "--refresh", "--json"], daemonEnv));
  const oldReports = extractReports(oldUsagePayload);
  const oldAcpSource = oldReports.find(report => report.sourceLabel === "Antigravity ACP" || report.sourceId === "acp-quota");
  assert(oldAcpSource, "2.11.0 基线刷新应返回 Antigravity ACP 用量来源");
  assert.equal(oldAcpSource.report?.status, "available", "2.11.0 假内核额度报告应为 available");
  assert.equal(oldAcpSource.report?.windows?.length, 4, "2.11.0 假内核应解析出 4 个额度窗口");

  const oldAdapterCalls = readJsonLines(adapterTracePath).slice(adapterCountBeforeOld);
  const oldKernelCalls = readJsonLines(kernelTracePath).slice(kernelCountBeforeOld);
  assert(
    oldAdapterCalls.some(entry => entry.args.includes("--usage")),
    "2.11.0 基线刷新必须实际触发 --usage 调用"
  );
  assert(
    oldKernelCalls.some(entry => entry.method === "session/prompt" && entry.promptText === "/usage"),
    "2.11.0 基线刷新必须向假 ACP 内核发送 /usage prompt"
  );

  summary.beforeUpgrade = {
    pluginStatus: baselinePlugin[0].status,
    usageSourcePresent: true,
    usageReportStatus: oldAcpSource.report.status,
    usageWindowsCount: oldAcpSource.report.windows.length,
    adapterUsageCalls: oldAdapterCalls.filter(entry => entry.args.includes("--usage")).length,
    kernelUsagePrompts: oldKernelCalls.filter(entry => entry.method === "session/prompt" && entry.promptText === "/usage").length,
  };

  // 4. 打包修订后的产物，并在同一目录原位覆盖安装（升级），然后重载插件并重启同一个隔离 daemon
  summary.stage = "pack-and-upgrade-in-place";
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", tarballs]);
  const tarballPath = path.join(tarballs, `paseo-agy-acp-${candidateVersion}.tgz`);
  assert(existsSync(tarballPath), "应生成当前版本的 npm tarball");
  summary.tarballSha256 = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");

  run("npm", [
    "install", "--prefix", installPrefix, "--ignore-scripts",
    "--no-audit", "--no-fund", "--cache", npmCache,
    tarballPath,
  ]);
  assert.equal(existsSync(path.join(pluginDir, "server", "usage.ts")), false, "原位升级后必须移除 server/usage.ts");

  run(cli, ["plugin", "reload", "paseo-agy-acp", "--json"], daemonEnv);
  stopDaemon();
  startDaemon();

  // 5. 升级并重启 daemon 后：验证 Antigravity ACP 来源消失、刷新零查询，且普通 provider 仍可完成真实握手
  summary.stage = "verify-upgraded-no-usage";
  const upgradedPlugin = JSON.parse(run(cli, ["plugin", "ls", "paseo-agy-acp", "--json"], daemonEnv));
  assert.equal(upgradedPlugin[0]?.status, "running", "升级并重启后插件应仍处于 running 状态");

  const adapterCountBeforeNew = readJsonLines(adapterTracePath).length;
  const kernelCountBeforeNew = readJsonLines(kernelTracePath).length;
  const newUsagePayload = JSON.parse(run(cli, ["usage", "ls", "--refresh", "--json"], daemonEnv));
  const newReports = extractReports(newUsagePayload);
  const newAcpSource = newReports.find(report => report.sourceLabel === "Antigravity ACP" || report.sourceId === "acp-quota");
  assert.equal(newAcpSource, undefined, "升级并重启后 Antigravity ACP 来源必须消失");

  const newAdapterCallsDuringUsage = readJsonLines(adapterTracePath).slice(adapterCountBeforeNew);
  const newKernelCallsDuringUsage = readJsonLines(kernelTracePath).slice(kernelCountBeforeNew);
  assert.equal(
    newAdapterCallsDuringUsage.filter(entry => entry.args.includes("--usage")).length,
    0,
    "升级并重启后刷新用量不得再触发 --usage 调用"
  );
  assert.equal(
    newKernelCallsDuringUsage.filter(entry => entry.method === "session/prompt" && entry.promptText === "/usage").length,
    0,
    "升级并重启后刷新用量不得再向假内核发送 /usage prompt"
  );

  // 6. 验证普通 provider 仍可完成真实 ACP 握手
  summary.stage = "verify-ordinary-provider-handshake";
  const kernelCountBeforeHandshake = readJsonLines(kernelTracePath).length;
  const diagnosticPayload = JSON.parse(run(cli, ["provider", "diagnostic", "paseo-agy-acp", "--json"], daemonEnv));
  assert.match(diagnosticPayload.diagnostic ?? "", /Status: Ready/, "升级后普通 provider 诊断应为 Status: Ready");

  const modelsPayload = JSON.parse(run(cli, ["provider", "models", "paseo-agy-acp", "--json"], daemonEnv));
  const handshakeKernelCalls = readJsonLines(kernelTracePath).slice(kernelCountBeforeHandshake);
  const ordinaryInitializes = handshakeKernelCalls.filter(
    entry => entry.method === "initialize" && entry.clientName !== "paseo-agy-acp-quota"
  );
  assert(ordinaryInitializes.length >= 1, "升级后普通 ACP provider 必须能与假内核完成真实 initialize 握手");

  summary.afterUpgradeAndRestart = {
    pluginStatus: upgradedPlugin[0].status,
    usageSourceRemovedFile: !existsSync(path.join(pluginDir, "server", "usage.ts")),
    usageSourcePresent: false,
    remainingSourceIds: newReports.map(report => report.sourceId ?? report.sourceLabel ?? "unknown"),
    adapterCallsDuringUsageRefresh: newAdapterCallsDuringUsage.length,
    kernelUsagePromptsDuringRefresh: 0,
    providerDiagnosticReady: /Status: Ready/.test(diagnosticPayload.diagnostic ?? ""),
    ordinaryHandshakeInitializeCount: ordinaryInitializes.length,
    providerModelsReturned: Array.isArray(modelsPayload)
      ? modelsPayload.length
      : Array.isArray(modelsPayload?.models)
        ? modelsPayload.models.length
        : Object.keys(modelsPayload ?? {}).length,
  };

  summary.stage = "complete";
  summary.passed = true;
} catch (error) {
  summary.passed = false;
  summary.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  scratch.cleanup();
  summary.workspaceRemoved = !existsSync(area);
}

process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
