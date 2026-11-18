#!/usr/bin/env node
// Explicit, bounded live ACP experiment. Never launches the production wrapper/daemon.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: {
  run: { type: "boolean", default: false },
  kernel: { type: "string" }, model: { type: "string" },
  concurrency: { type: "string", default: "1" },
  groups: { type: "string", default: "native,adapter" },
  "timeout-ms": { type: "string", default: "120000" },
  "cancel-after-ms": { type: "string" },
  output: { type: "string" }
} });
if (!values.run) {
  console.log("Usage: node scripts/compare-kernel.mjs --run --kernel /absolute/agy_acp_server.par [--model ID] [--concurrency 1|3|4|6|8] [--groups native,adapter] [--cancel-after-ms 1000] [--output /absolute/report.json]");
  process.exit(0);
}
const concurrency = Number(values.concurrency);
const timeoutMs = Number(values["timeout-ms"]);
const cancelAfterMs = values["cancel-after-ms"] === undefined ? undefined : Number(values["cancel-after-ms"]);
const groups = values.groups.split(",");
if (!values.kernel || !path.isAbsolute(values.kernel) || !existsSync(values.kernel)) throw new Error("--kernel must be an existing absolute executable path");
if (![1, 3, 4, 6, 8].includes(concurrency)) throw new Error("concurrency must be 1, 3, 4, 6, or 8");
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) throw new Error("timeout-ms must be 1000..300000");
if (cancelAfterMs !== undefined && (!Number.isSafeInteger(cancelAfterMs) || cancelAfterMs < 0 || cancelAfterMs >= timeoutMs)) throw new Error("cancel-after-ms must be nonnegative and below timeout-ms");
if (!groups.length || new Set(groups).size !== groups.length || groups.some(g => !["native", "adapter"].includes(g))) throw new Error("groups must contain unique native/adapter entries");
const cli = path.join(root, "dist/ACP Connector/main.js");
if (!existsSync(cli)) throw new Error("run npm run build first");
const experiment = mkdtempSync(path.join(os.tmpdir(), "agy-kernel-compare-"));
const work = path.join(experiment, "work");
mkdirSync(work, { mode: 0o700 });
const output = values.output ? path.resolve(values.output) : path.join(experiment, "report.json");
const kernel = values.kernel;
const hash = createHash("sha256");
for await (const chunk of createReadStream(kernel)) hash.update(chunk);
const report = {
  schemaVersion: 1, startedAt: new Date().toISOString(), kernel, kernelSha256: hash.digest("hex"),
  adapterVersion: JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version,
  concurrency, timeoutMs, cancelAfterMs: cancelAfterMs ?? null, experiment,
  scope: "Short text ACP probe; submitted turns are not measured model concurrency. Same inherited login; local state isolated, cloud quota shared. No automatic retries.",
  groups: []
};
let selectedModel = values.model;
const live = new Set();
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  interrupted = true;
  for (const client of live) client.stop();
});

function launch(group, ordinal) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PASEO_") && !key.startsWith("AGY_ACP_")));
  Object.assign(env, {
    PASEO_HOME: path.join(experiment, "paseo"), PASEO_AGENT_ID: `kernel-compare-${group}-${ordinal}`,
    PASEO_AGY_ACP_OFFICIAL_BIN: kernel, AGY_ACP_DIAGNOSTICS: "1"
  });
  const nativeArgs = process.platform === "linux" && kernel.endsWith(".par") ? ["--uid="] : [];
  const child = spawn(group === "native" ? kernel : process.execPath, group === "native" ? nativeArgs : [cli], {
    cwd: group === "native" ? path.dirname(kernel) : root, env, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32"
  });
  const pending = new Map();
  const row = { ordinal, status: "initializing", sessionId: null, model: null, firstTextMs: null, thoughtChunks: 0, toolCalls: 0, firstKernelOutputMs: null };
  let nextId = 0, dead = false, text = "", promptStarted, stopping;
  const closed = new Promise(resolve => child.once("close", resolve));
  const fail = () => { dead = true; for (const p of pending.values()) p.reject(new Error("kernel-exited")); pending.clear(); };
  child.once("error", fail); child.once("close", fail); child.stdin.on("error", fail);
  const send = message => { if (dead) throw new Error("kernel-exited"); child.stdin.write(`${JSON.stringify(message)}\n`); };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.method && msg.id !== undefined) {
      // The probe is text-only. Never grant tool/file/terminal actions.
      send(msg.method === "session/request_permission"
        ? { jsonrpc: "2.0", id: msg.id, result: { outcome: { outcome: "cancelled" } } }
        : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Text-only probe" } });
    } else if (msg.method === "session/update") {
      const update = msg.params?.update;
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
        text = (text + update.content.text).slice(-16384);
        if (promptStarted !== undefined && row.firstTextMs === null) row.firstTextMs = performance.now() - promptStarted;
      } else if (update?.sessionUpdate === "agent_thought_chunk") row.thoughtChunks++;
      else if (update?.sessionUpdate === "tool_call") row.toolCalls++;
    } else if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      if (msg.error) {
        const body = typeof msg.error.message === "string" ? msg.error.message : "";
        const terms = ["429", "502", "503", "504", "quota", "timeout", "timed out", "capacity", "auth", "connection", "database is locked", "session", "resource exhausted"];
        p.reject(Object.assign(new Error("rpc-error"), { rpcCode: msg.error.code, rpcTerms: terms.filter(term => body.toLowerCase().includes(term)) }));
      }
      else p.resolve(msg.result);
    }
  });
  // Keep fixed diagnostic fields only; never persist provider stderr or model text.
  const diagnostics = createInterface({ input: child.stderr });
  diagnostics.on("line", line => {
    let event; try { event = JSON.parse(line); } catch { return; }
    if (event.component === "official-kernel" && event.event === "first_kernel_output" && Number.isFinite(event.durationMs)) row.firstKernelOutputMs = event.durationMs;
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("rpc-timeout")); }, timeoutMs);
    pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); error.rpcMethod = method; reject(error); } });
    try { send({ jsonrpc: "2.0", id, method, params }); } catch (error) { pending.get(id).reject(error); pending.delete(id); }
  });
  const client = {
    row,
    async setup() {
      const begin = performance.now();
      const initialized = await request("initialize", { protocolVersion: 1, clientInfo: { name: "kernel-compare", version: "1" }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, session: { notices: {} } } });
      row.reportedVersion = initialized?.agentInfo?.version ?? null;
      const session = await request("session/new", { cwd: work, mcpServers: [] });
      if (!session?.sessionId) throw new Error("missing-session-id");
      row.sessionId = session.sessionId;
      row.model = session.models?.currentModelId ?? session.configOptions?.find(o => o.category === "model" || o.id === "model")?.currentValue ?? null;
      row.setupMs = performance.now() - begin;
    },
    async selectModel(model) {
      if (row.model !== model) await request("session/set_model", { sessionId: row.sessionId, modelId: model });
      row.model = model;
    },
    async prompt(epoch) {
      promptStarted = performance.now(); row.submittedMs = promptStarted - epoch; row.status = "running";
      let cancelledAt;
      const cancelTimer = cancelAfterMs === undefined ? undefined : setTimeout(() => {
        cancelledAt = performance.now();
        try { send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: row.sessionId } }); } catch { /* request observes exit */ }
      }, cancelAfterMs);
      try {
        const result = await request("session/prompt", { sessionId: row.sessionId, prompt: [{ type: "text", text: "Reply with exactly ACP_KERNEL_OK. Do not use tools." }] });
        row.stopReason = result?.stopReason ?? null;
        row.markerReceived = text.trim() === "ACP_KERNEL_OK";
        row.status = cancelledAt !== undefined
          ? (row.stopReason === "cancelled" ? "cancelled" : "unexpected-stop")
          : (row.stopReason === "end_turn" && row.markerReceived && row.toolCalls === 0 ? "passed" : "unexpected-result");
      } catch (error) {
        row.status = error.message === "rpc-timeout" ? "timeout" : "failed";
        row.error = error.message; row.rpcMethod = error.rpcMethod; row.rpcTerms = error.rpcTerms; if (error.rpcCode !== undefined) row.rpcCode = error.rpcCode;
      } finally {
        clearTimeout(cancelTimer); row.elapsedMs = performance.now() - promptStarted;
        row.cancelAckMs = cancelledAt === undefined ? null : performance.now() - cancelledAt;
        row.finishedMs = performance.now() - epoch;
      }
    },
    stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        const signal = name => {
          try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name); else child.kill(name); } catch { /* already exited */ }
        };
        child.stdin.end(); signal("SIGTERM");
        const timer = setTimeout(() => signal("SIGKILL"), 2000);
        await closed; clearTimeout(timer);
        // A group can outlive its leader; ensure descendants from this probe stop too.
        signal("SIGKILL"); lines.close(); diagnostics.close(); live.delete(client);
      })();
      return stopping;
    }
  };
  live.add(client); return client;
}

try {
  for (const group of groups) {
    if (interrupted) break;
    const clients = Array.from({ length: concurrency }, (_, i) => launch(group, i + 1));
    const result = { group, rows: clients.map(c => c.row) }; report.groups.push(result);
    try {
      await Promise.all(clients.map(c => c.setup()));
      selectedModel ??= clients[0].row.model;
      if (!selectedModel) throw new Error("cannot-determine-model-use-model-option");
      await Promise.all(clients.map(c => c.selectModel(selectedModel)));
      const epoch = performance.now();
      await Promise.all(clients.map(c => c.prompt(epoch)));
      result.wallMs = performance.now() - epoch;
    } catch (error) {
      result.setupError = error.message; result.rpcMethod = error.rpcMethod; result.rpcTerms = error.rpcTerms; if (error.rpcCode !== undefined) result.rpcCode = error.rpcCode;
    } finally {
      await Promise.all(clients.map(c => c.stop()));
    }
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ group, statuses: result.rows.map(r => r.status), wallMs: result.wallMs ?? null }));
    // Stop after anomalies instead of spending more shared quota or hiding failures.
    if (result.setupError || result.rows.some(r => !["passed", "cancelled"].includes(r.status))) { process.exitCode = 1; break; }
  }
} finally {
  await Promise.all([...live].map(c => c.stop()));
  report.finishedAt = new Date().toISOString(); report.interrupted = interrupted;
  if (interrupted) process.exitCode = 1;
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`Report: ${output}`);
}
