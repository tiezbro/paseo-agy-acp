import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createNdjsonParser, encodeNdjson } from "../ACP Connector/official-kernel/ndjson.js";
import type { JsonRpcMessage } from "../ACP Connector/official-kernel/json-rpc.js";

const repositoryRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const fakeOfficialAgent = path.join(repositoryRoot, "tests/helpers/fake-official-acp-agent.mjs");
const builtCli = path.join(repositoryRoot, "dist/ACP Connector/main.js");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function collect(stream: PassThrough): {
  messages: JsonRpcMessage[];
  waitFor: (predicate: (message: JsonRpcMessage) => boolean) => Promise<JsonRpcMessage>;
} {
  const messages: JsonRpcMessage[] = [];
  const waiters: Array<{ predicate: (message: JsonRpcMessage) => boolean; resolve: (message: JsonRpcMessage) => void }> = [];
  const parse = createNdjsonParser((message) => {
    messages.push(message);
    const remaining = [];
    for (const waiter of waiters) {
      if (waiter.predicate(message)) waiter.resolve(message);
      else remaining.push(waiter);
    }
    waiters.splice(0, waiters.length, ...remaining);
  });
  stream.on("data", parse);
  return {
    messages,
    waitFor(predicate) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    }
  };
}

describe("admission production composition", () => {
  it("answers provider discovery before Paseo assigns the agent identity", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "agy-admission-discovery-"));
    temporaryDirectories.push(directory);
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      PASEO_AGY_ACP_OFFICIAL_BIN: fakeOfficialAgent,
      AGY_ACP_ADMISSION_ENABLED: "true",
      AGY_ACP_STATE_DIR: directory,
      NODE_ENV: "test"
    };
    delete environment.PASEO_AGENT_ID;

    const child = spawn(process.execPath, [builtCli], {
      cwd: directory,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = new PassThrough();
    child.stdout.pipe(stdout);
    const collected = collect(stdout);
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));

    try {
      child.stdin.write(
        encodeNdjson({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })
      );
      const initialized = await collected.waitFor((message) => "id" in message && message.id === 1);
      expect(initialized).toMatchObject({
        result: { agentInfo: { name: "agy-acp", version: "2.1.0.0" } }
      });

      child.stdin.write(
        encodeNdjson({
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: { cwd: directory, mcpServers: [] }
        })
      );
      const created = await collected.waitFor((message) => "id" in message && message.id === 2);
      expect(created).toMatchObject({
        result: { sessionId: expect.any(String) }
      });
      expect(existsSync(path.join(directory, "runtime.sqlite"))).toBe(false);
    } finally {
      child.stdin.end();
      child.kill("SIGTERM");
    }
    await exited;
  });
});
