#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "dist/ACP Connector/main.js");
const officialBin =
  process.env.PASEO_AGY_ACP_OFFICIAL_BIN ??
  path.join(
    process.env.HOME ?? "",
    ".local/opt/agy-acp-server-agy_acp_server_20260818_01_RC01/agy-acp-server-canary"
  );

const child = spawn(process.execPath, [cli], {
  cwd: root,
  env: {
    ...process.env,
    PASEO_AGY_ACP_KERNEL: "official",
    PASEO_AGY_ACP_OFFICIAL_BIN: officialBin
  },
  stdio: ["pipe", "pipe", "pipe"]
});

let buffer = "";
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  }
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 120_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

const stderr = [];
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => stderr.push(chunk));

try {
  const initialized = await request(1, "initialize", {
    protocolVersion: 1,
    clientInfo: { name: "official-kernel-smoke", version: "2.2.0" },
    capabilities: {}
  });
  if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
  const agentInfo = initialized.result?.agentInfo ?? {};
  if (agentInfo.name !== "agy-acp") {
    throw new Error(`expected product identity agy-acp, got ${JSON.stringify(agentInfo)}`);
  }
  if (agentInfo.version !== "2.2.0") {
    throw new Error(`expected version 2.2.0, got ${agentInfo.version}`);
  }

  const created = await request(2, "session/new", {
    cwd: root,
    mcpServers: []
  });
  if (created.error) throw new Error(`session/new failed: ${JSON.stringify(created.error)}`);
  const sessionId = created.result?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error(`session/new missing sessionId: ${JSON.stringify(created)}`);
  }

  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        agentInfo,
        sessionId,
        modeId: created.result?.modeId ?? null
      },
      null,
      2
    ) + "\n"
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  if (stderr.length > 0) process.stderr.write(stderr.join("").slice(-2000) + "\n");
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, 2000).unref();
}
