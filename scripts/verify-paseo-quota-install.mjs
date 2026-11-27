import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acpEnvironment, commandEnvironment, quotaScratch } from "./quota-install-environment.mjs";

// 显式真实验收：独立 daemon、真实 npm 安装产物和现有 ACP 登录；验证插件不触发后台自动用量刷新，并单独验证手动 --usage。
assert(process.argv.includes("--live"), "真实额度验收需显式传入 --live；会读取现有 ACP 登录并手动访问额度服务");
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = process.env.PASEO_QUOTA_CLI || "paseo";
let started = false;
const transport = commandEnvironment(process.env);
const scratch = quotaScratch(root, () => { if (started) run(cli, ["daemon", "stop", "--home", daemonHome], daemonEnv); });
const area = scratch.area;
process.once("exit", scratch.cleanup);
process.once("SIGINT", () => process.exit(130));
process.once("SIGTERM", () => process.exit(143));
const results = path.join(root, ".tmp-quota-results"); mkdirSync(results, { recursive: true, mode: 0o700 });
const resultFile = path.join(results, path.basename(area) + ".json");
const daemonHome = path.join(area, "daemon");
const daemonUserHome = path.join(area, "user");
mkdirSync(daemonHome); mkdirSync(daemonUserHome);
const daemonEnv = { ...transport, HOME: daemonUserHome, PASEO_HOME: daemonHome };
function run(command, args, env = transport) {
  try { return execFileSync(command, args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000, maxBuffer: 4 * 1024 * 1024 }); }
  catch {
    const error = new Error("验收命令失败；不保留可能含敏感内容的子进程输出");
    error.safeCode = "command-" + path.basename(command) + "-" + args.slice(0, 2).filter(arg => /^[a-z-]+$/i.test(arg)).join("-");
    throw error;
  }
}
function check(value, safeCode) { if (!value) { const error = new Error(safeCode); error.safeCode = safeCode; throw error; } }
const originalHome = process.env.PASEO_QUOTA_SOURCE_HOME || process.env.PASEO_HOME || path.join(process.env.HOME, ".paseo");
const original = JSON.parse(readFileSync(path.join(originalHome, "config.json"), "utf8"));
// provider 独有的代理等必要网络设置只合并到子进程内存，不写入配置。
Object.assign(transport, commandEnvironment(original.agents?.providers?.["paseo-agy-acp"]?.env ?? {}));
Object.assign(daemonEnv, transport, { HOME: daemonUserHome, PASEO_HOME: daemonHome });
const acpPaths = acpEnvironment(process.env, original.agents?.providers?.["paseo-agy-acp"]?.env);
const acpEnv = { ...transport, ...acpPaths };
const tarballs = path.join(area, "tarballs"); mkdirSync(tarballs);
run("npm", ["pack", "--ignore-scripts", "--pack-destination", tarballs]);
const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
const tarball = path.join(tarballs, `paseo-agy-acp-${version}.tgz`);
const installed = path.join(area, "installed"), old = path.join(area, "old");
run("npm", ["install", "--prefix", installed, "--ignore-scripts", "--no-audit", "--no-fund", "--cache", path.join(area, "npm-cache"), tarball]);
run("npm", ["install", "--prefix", old, "--ignore-scripts", "--no-audit", "--no-fund", "--cache", path.join(area, "npm-cache"), "paseo-agy-acp@2.10.0"]);
const packageRoot = path.join(installed, "node_modules", "paseo-agy-acp");
const oldRoot = path.join(old, "node_modules", "paseo-agy-acp");
const plugin = path.join(packageRoot, "plugins", "paseo-agy-acp");
const entry = path.join(packageRoot, "dist", "ACP Connector", "main.js");
const oldEntry = path.join(oldRoot, "dist", "ACP Connector", "main.js");
const trace = path.join(area, "old-launches.jsonl"); writeFileSync(trace, "", "utf8");
const legacyBin = path.join(area, "old-bin"); mkdirSync(legacyBin);
const legacyCommand = path.join(legacyBin, "paseo-agy-acp");
// 只记录调用边界；所有参数、stdio 和退出仍交给实际安装的公开 2.10.0。
writeFileSync(legacyCommand, `#!${process.execPath}\nimport{appendFileSync}from'node:fs';import{spawn}from'node:child_process';const args=process.argv.slice(2);appendFileSync(${JSON.stringify(trace)},JSON.stringify(args)+'\\n','utf8');const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(oldEntry)},...args],{stdio:'inherit',env:process.env});child.on('exit',(code)=>process.exit(code??1));process.on('SIGTERM',()=>child.kill('SIGTERM'));process.on('SIGINT',()=>child.kill('SIGINT'));\n`, "utf8"); chmodSync(legacyCommand, 0o755);
daemonEnv.PATH = legacyBin + path.delimiter + transport.PATH;
const config = { version: 1, pluginsEnabled: true, daemon: { listen: "127.0.0.1:0", relay: { enabled: false } },
  features: { voiceMode: { enabled: false } },
  agents: { providers: {
    ...Object.fromEntries(["claude", "codex", "copilot", "opencode", "pi", "omp", "antigravity", "muse"].map(id => [id, { enabled: false }])),
    "paseo-agy-acp": { enabled: true, env: { ...acpPaths, PASEO_HOME: daemonHome } },
  } } };
const configPath = path.join(daemonHome, "config.json");
function save() {
  assert(Object.keys(config.agents.providers["paseo-agy-acp"].env).every(key => ["HOME", "USERPROFILE", "GEMINI_HOME", "PASEO_AGY_ACP_OFFICIAL_BIN", "PASEO_HOME"].includes(key)));
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
}
function refreshUsageWithoutAcpSource() {
  const before = readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).length;
  const data = JSON.parse(run(cli, ["usage", "ls", "--refresh", "--json"], daemonEnv));
  const calls = readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).slice(before).map(line => JSON.parse(line));
  const reports = Array.isArray(data) ? data : data.reports || data.data || [];
  const own = reports.find(report => report.sourceLabel === "Antigravity ACP" || report.sourceId === "acp-quota");
  check(!own, "unexpected-background-usage-source");
  check(!calls.some(args => args.includes("--usage")), "unexpected-background-usage-call");
  return calls;
}
const cliVersion = run(cli, ["--version"]).trim();
const result = { passed: false, stage: "start", paseo: cliVersion, adapterVersion: version, tarballSha256: createHash("sha256").update(readFileSync(tarball)).digest("hex"), pluginPath: plugin, cases: [] };
try {
  save();
  run(cli, ["daemon", "start", "--home", daemonHome], daemonEnv); started = true;
  run(cli, ["plugin", "install", plugin, "--json"], daemonEnv);
  Object.assign(config, JSON.parse(readFileSync(configPath, "utf8")));
  run(cli, ["reload", "--json"], daemonEnv);
  const status = JSON.parse(run(cli, ["plugin", "ls", "paseo-agy-acp", "--json"], daemonEnv));
  assert.equal(status[0].status, "running");
  result.stage = "old-PATH-ordinary-ACP";
  const pathDiagnostic = JSON.parse(run(cli, ["provider", "diagnostic", "paseo-agy-acp", "--json"], daemonEnv));
  assert.match(pathDiagnostic.diagnostic, /Status: Ready/);
  result.stage = "no-background-usage-from-PATH";
  refreshUsageWithoutAcpSource();
  result.cases.push({ name: "published-2.10.0-from-daemon-PATH", ordinaryAcpReady: true, backgroundUsageRemoved: true });
  config.agents.providers["paseo-agy-acp"].command = [process.execPath, legacyCommand];
  result.stage = "old-provider-ordinary-ACP";
  config.agents.providers["paseo-agy-acp"].env = { ...acpPaths, PASEO_HOME: daemonHome };
  save(); run(cli, ["reload", "--json"], daemonEnv);
  const overrideDiagnostic = JSON.parse(run(cli, ["provider", "diagnostic", "paseo-agy-acp", "--json"], daemonEnv));
  assert.match(overrideDiagnostic.diagnostic, /Status: Ready/);
  result.stage = "no-background-usage-from-provider-command";
  refreshUsageWithoutAcpSource();
  result.cases.push({ name: "published-2.10.0-provider-command", ordinaryAcpReady: true, backgroundUsageRemoved: true });
  config.agents.providers["paseo-agy-acp"].command = [process.execPath, entry];
  result.stage = "matching-provider-and-manual-usage";
  config.agents.providers["paseo-agy-acp"].env = { ...acpPaths, PASEO_HOME: daemonHome };
  save(); run(cli, ["reload", "--json"], daemonEnv);
  const matchedDiagnostic = JSON.parse(run(cli, ["provider", "diagnostic", "paseo-agy-acp", "--json"], daemonEnv));
  assert.match(matchedDiagnostic.diagnostic, /Status: Ready/);
  refreshUsageWithoutAcpSource();
  const direct = JSON.parse(run(process.execPath, [entry, "--usage"], acpEnv));
  assert.equal(direct.status, "available");
  const normalize = report => report.windows.map(({ id, remainingPct, resetsAt }) => ({ id, remainingPct, resetsAt }));
  result.cases.push({ name: "installed-matching-adapter-and-manual-usage", ordinaryAcpReady: true, backgroundUsageRemoved: true, windows: normalize(direct) });
  result.stage = "complete"; result.passed = true;
} catch (error) {
  result.passed = false; result.error = "验收失败；不保存原始命令输出、环境或账号路径"; result.failureCode = error.safeCode || "assertion-failed"; process.exitCode = 1;
} finally {
  try { scratch.cleanup(); }
  catch { result.passed = false; result.failureCode = "cleanup-stop-failed"; process.exitCode = 1; }
  finally {
    result.workspaceRemoved = !existsSync(area);
    writeFileSync(resultFile, JSON.stringify(result, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  }
}
process.stdout.write(JSON.stringify({ resultFile, ...result }, null, 2) + "\n");
