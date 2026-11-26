import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 显式真实验收：独立 daemon、真实 npm 安装产物和现有 ACP 登录；不发送生成请求。
assert(process.argv.includes("--live"), "真实额度验收需显式传入 --live；会读取现有 ACP 登录并访问额度服务");
const root = fileURLToPath(new URL("../", import.meta.url));
const cli = process.env.PASEO_QUOTA_CLI || "paseo";
const area = mkdtempSync(path.join(root, ".tmp-quota-install-"));
const daemonHome = path.join(area, "daemon");
const daemonUserHome = path.join(area, "user");
mkdirSync(daemonHome); mkdirSync(daemonUserHome);
const daemonEnv = { ...process.env, HOME: daemonUserHome, PASEO_HOME: daemonHome };
function run(command, args, env = process.env) {
  try { return execFileSync(command, args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000, maxBuffer: 4 * 1024 * 1024 }); }
  catch (error) {
    writeFileSync(path.join(area, "last-command-error.log"), String(error.stderr || error.message), { encoding: "utf8", mode: 0o600 });
    throw new Error(`验收命令失败：${path.basename(command)} ${args.slice(0, 2).join(" ")}；诊断已保存在隔离目录`);
  }
}
assert.equal(run(cli, ["--version"]).trim(), "0.17.4", "本验收要求原版 Paseo 0.17.4");
const originalHome = process.env.PASEO_HOME || path.join(process.env.HOME, ".paseo");
const original = JSON.parse(readFileSync(path.join(originalHome, "config.json"), "utf8"));
const acpEnv = { ...process.env, ...original.agents?.providers?.["paseo-agy-acp"]?.env };
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
const marker = path.join(area, "ordinary-kernel-started");
const sentinel = path.join(area, "sentinel.mjs");
writeFileSync(sentinel, `#!${process.execPath}\nimport{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'started','utf8');\n`, "utf8"); chmodSync(sentinel, 0o755);
daemonEnv.PATH = path.join(old, "node_modules", ".bin") + path.delimiter + process.env.PATH;
const config = { version: 1, pluginsEnabled: true, daemon: { listen: "127.0.0.1:0", relay: { enabled: false } },
  features: { voiceMode: { enabled: false } },
  agents: { providers: {
    ...Object.fromEntries(["claude", "codex", "copilot", "opencode", "pi", "omp", "antigravity", "muse"].map(id => [id, { enabled: false }])),
    "paseo-agy-acp": { enabled: true, env: { ...acpEnv, PATH: daemonEnv.PATH, PASEO_HOME: daemonHome, PASEO_AGY_ACP_OFFICIAL_BIN: sentinel } },
  } } };
const configPath = path.join(daemonHome, "config.json");
function save() { writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", { encoding: "utf8", mode: 0o600 }); }
function usage() {
  const data = JSON.parse(run(cli, ["usage", "ls", "--refresh", "--json"], daemonEnv));
  const reports = Array.isArray(data) ? data : data.reports || data.data;
  const own = reports.find(report => report.sourceLabel === "Antigravity ACP");
  assert(own, "Paseo 未发现实际安装产物的 ACP 额度来源");
  return own.report;
}
const result = { paseo: "0.17.4", adapterVersion: version, tarball, pluginPath: plugin, cases: [] };
let started = false;
try {
  save();
  run(cli, ["daemon", "start", "--home", daemonHome], daemonEnv); started = true;
  run(cli, ["plugin", "install", plugin, "--json"], daemonEnv);
  Object.assign(config, JSON.parse(readFileSync(configPath, "utf8")));
  run(cli, ["reload", "--json"], daemonEnv);
  const status = JSON.parse(run(cli, ["plugin", "ls", "paseo-agy-acp", "--json"], daemonEnv));
  assert.equal(status[0].status, "running");
  const fromPath = usage();
  assert.equal(fromPath.status, "error");
  assert.match(fromPath.error, /daemon PATH/); assert(fromPath.error.includes(old));
  assert(!existsSync(marker), "PATH 旧适配器启动了普通内核");
  result.cases.push({ name: "published-2.10.0-from-daemon-PATH", blocked: true, ordinaryKernelStarted: false, diagnostic: fromPath.error });
  config.agents.providers["paseo-agy-acp"].command = [process.execPath, oldEntry];
  save(); run(cli, ["reload", "--json"], daemonEnv);
  const fromOverride = usage();
  assert.equal(fromOverride.status, "error");
  assert.match(fromOverride.error, /provider 指定/); assert(fromOverride.error.includes(oldEntry));
  assert(!existsSync(marker), "provider 指定的旧适配器启动了普通内核");
  result.cases.push({ name: "published-2.10.0-provider-command", blocked: true, ordinaryKernelStarted: false, diagnostic: fromOverride.error });
  config.agents.providers["paseo-agy-acp"].command = [process.execPath, entry];
  config.agents.providers["paseo-agy-acp"].env = { ...acpEnv, PASEO_HOME: daemonHome };
  save(); run(cli, ["reload", "--json"], daemonEnv);
  const matched = usage();
  assert.equal(matched.status, "available"); assert.equal(matched.windows.length, 4);
  const direct = JSON.parse(run(process.execPath, [entry, "--usage"], acpEnv));
  assert.equal(direct.status, "available");
  const normalize = report => report.windows.map(({ id, remainingPct, resetsAt }) => ({ id, remainingPct, resetsAt }));
  assert.deepEqual(normalize(matched), normalize(direct));
  result.cases.push({ name: "installed-matching-adapter-and-ACP-account", windows: normalize(matched), matchesDirectAcp: true });
  const daemonStatus = JSON.parse(run(cli, ["daemon", "status", "--json"], daemonEnv));
  assert.equal(daemonStatus.daemonVersion, "0.17.4");
  writeFileSync(path.join(area, "result.json"), JSON.stringify(result, null, 2) + "\n", "utf8");
  process.stdout.write(JSON.stringify({ result: path.join(area, "result.json"), ...result }, null, 2) + "\n");
} finally {
  try { if (started) run(cli, ["daemon", "stop", "--home", daemonHome], daemonEnv); }
  finally {
    const persisted = JSON.parse(readFileSync(configPath, "utf8"));
    persisted.agents.providers["paseo-agy-acp"].env = Object.fromEntries(Object.keys(persisted.agents.providers["paseo-agy-acp"].env).map(key => [key, "REDACTED"]));
    writeFileSync(configPath, JSON.stringify(persisted, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  }
}
