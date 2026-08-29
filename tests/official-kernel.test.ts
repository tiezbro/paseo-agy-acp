import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { AgyAdmissionDispatchBoundary } from "../ACP Connector/admission/dispatch-boundary.js";
import {
  createOfficialAdmission,
  isAdmissionDiscoveryEnvironment,
  issueAdmittedOfficialPromptWrite,
  officialAdmissionStateDir
} from "../ACP Connector/official-kernel/admission-fence.js";
import { injectPaseoContext } from "../ACP Connector/official-kernel/context.js";
import {
  blankTurnError,
  sessionUpdateShowsVisibleOutput,
  shouldRejectBlankTurn
} from "../ACP Connector/official-kernel/errors.js";
import { overlayProductIdentity, PRODUCT_AGENT_NAME } from "../ACP Connector/official-kernel/identity.js";
import { resolveAcpKernel } from "../ACP Connector/official-kernel/kernel.js";
import { rewriteMcpServers } from "../ACP Connector/official-kernel/mcp-rewrite.js";
import { mapToOfficialModeId, rewriteModeFields } from "../ACP Connector/official-kernel/mode-map.js";
import { createNdjsonParser, encodeNdjson } from "../ACP Connector/official-kernel/ndjson.js";
import { OfficialKernelProxy } from "../ACP Connector/official-kernel/proxy.js";
import { officialSpawnArgs, resolveOfficialBinary } from "../ACP Connector/official-kernel/spawn.js";
import { PASEO_DAEMON_CONTEXT_OPEN } from "../ACP Connector/acp/session/paseo-context.js";
import type { JsonRpcMessage } from "../ACP Connector/official-kernel/json-rpc.js";

const repositoryRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const fakeOfficialAgent = path.join(repositoryRoot, "tests/helpers/fake-official-acp-agent.mjs");
const builtCli = path.join(repositoryRoot, "dist/ACP Connector/main.js");
const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function collect(stream: PassThrough): { messages: JsonRpcMessage[]; waitFor: (predicate: (message: JsonRpcMessage) => boolean) => Promise<JsonRpcMessage> } {
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

describe("official kernel selection", () => {
  it("defaults to official and rejects the removed scraper kernel", () => {
    expect(resolveAcpKernel({}, [])).toBe("official");
    expect(resolveAcpKernel({ PASEO_AGY_ACP_KERNEL: "official" }, [])).toBe("official");
    expect(() => resolveAcpKernel({ PASEO_AGY_ACP_KERNEL: "legacy" }, [])).toThrow(/scraper kernel was removed/);
    expect(() => resolveAcpKernel({ PASEO_AGY_ACP_KERNEL: "scraper" }, [])).toThrow(/scraper kernel was removed/);
    expect(() => resolveAcpKernel({}, ["--legacy-kernel"])).toThrow(/scraper kernel was removed/);
  });

  it("adds --uid= only for the official .par binary", () => {
    expect(officialSpawnArgs("/tmp/agy_acp_server.par")).toEqual(["--uid="]);
    expect(officialSpawnArgs(fakeOfficialAgent)).toEqual([]);
    expect(resolveOfficialBinary({ PASEO_AGY_ACP_OFFICIAL_BIN: fakeOfficialAgent })).toBe(fakeOfficialAgent);
  });
});

describe("official kernel adapters", () => {
  it("maps Paseo/scraper modes onto the official live mode ids", () => {
    expect(mapToOfficialModeId("accept-edits")).toBe("auto_edit");
    expect(mapToOfficialModeId("dangerously-skip-permissions")).toBe("yolo");
    expect(mapToOfficialModeId("plan")).toBe("default");
    expect(rewriteModeFields({ modeId: "accept-edits", currentModeId: "plan" })).toEqual({
      modeId: "auto_edit",
      currentModeId: "default"
    });
  });

  it("rewrites MCP http servers to sse with header arrays", () => {
    expect(
      rewriteMcpServers({
        mcpServers: [
          {
            name: "paseo",
            type: "http",
            url: "http://127.0.0.1:6767/mcp",
            headers: { Authorization: "Bearer token" }
          }
        ]
      })
    ).toEqual({
      mcpServers: [
        {
          name: "paseo",
          type: "sse",
          url: "http://127.0.0.1:6767/mcp",
          headers: [{ name: "Authorization", value: "Bearer token" }]
        }
      ]
    });
  });

  it("rejects a successful end_turn that never showed assistant output", () => {
    expect(sessionUpdateShowsVisibleOutput({ update: { sessionUpdate: "agent_message_chunk" } })).toBe(true);
    expect(shouldRejectBlankTurn({ stopReason: "end_turn" }, false)).toBe(true);
    expect(shouldRejectBlankTurn({ stopReason: "end_turn" }, true)).toBe(false);
    expect(blankTurnError(7).error.code).toBe(-32000);
  });

  it("overlays product identity onto the official initialize payload", () => {
    const overlaid = overlayProductIdentity(
      { protocolVersion: 1, agentInfo: { name: "antigravity-acp", version: "rc01" } },
      "2.2.1"
    );
    expect(overlaid).toMatchObject({
      agentInfo: { name: PRODUCT_AGENT_NAME, version: "2.2.1" }
    });
  });

  it("prefixes daemon append-system-prompt onto the official prompt", async () => {
    const home = tempDir("paseo-official-context-");
    mkdirSync(path.join(home, "agents"));
    writeFileSync(
      path.join(home, "agents", "agent-1.json"),
      JSON.stringify({
        persistence: { metadata: { daemonAppendSystemPrompt: "account-level daemon context" } }
      })
    );
    const injected = await injectPaseoContext(
      { sessionId: "s1", prompt: [{ type: "text", text: "hello" }] },
      { PASEO_HOME: home, PASEO_AGENT_ID: "agent-1" }
    );
    expect(JSON.stringify(injected)).toContain(PASEO_DAEMON_CONTEXT_OPEN);
    expect(JSON.stringify(injected)).toContain("account-level daemon context");
    expect(JSON.stringify(injected)).toContain("hello");
  });

  it("issues the official prompt write in Admission order", () => {
    const calls: string[] = [];
    const boundary = {
      prepare(processId: number) {
        calls.push(`prepare:${processId}`);
      },
      commitDispatchIntent() {
        calls.push("commitDispatchIntent");
      },
      beforePromptWrite() {
        calls.push("beforePromptWrite");
      },
      afterPromptWrite() {
        calls.push("afterPromptWrite");
      },
      markDispatchAmbiguous() {
        calls.push("markDispatchAmbiguous");
      }
    } as AgyAdmissionDispatchBoundary & {
      commitDispatchIntent(): void;
      markDispatchAmbiguous(): void;
    };
    issueAdmittedOfficialPromptWrite(boundary, 42, () => {
      calls.push("write");
    });
    expect(calls).toEqual([
      "prepare:42",
      "commitDispatchIntent",
      "beforePromptWrite",
      "write",
      "afterPromptWrite"
    ]);
    expect(officialAdmissionStateDir("/tmp/state")).toBe(path.join("/tmp/state", "official-kernel"));
    expect(isAdmissionDiscoveryEnvironment({ AGY_ACP_ADMISSION_ENABLED: "true" })).toBe(true);
    expect(createOfficialAdmission({ AGY_ACP_ADMISSION_ENABLED: "true" })).toBeUndefined();
  });
});

describe("official kernel proxy", () => {
  async function withProxy(
    run: (input: {
      send: (message: unknown) => void;
      waitFor: (predicate: (message: JsonRpcMessage) => boolean) => Promise<JsonRpcMessage>;
    }) => Promise<void>,
    env?: NodeJS.ProcessEnv
  ): Promise<void> {
    const child = spawn(process.execPath, [fakeOfficialAgent], { stdio: ["pipe", "pipe", "pipe"] });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const proxy = new OfficialKernelProxy({
      child,
      stdin,
      stdout,
      env,
      version: "2.2.1"
    });
    const started = proxy.start();
    const collected = collect(stdout);
    try {
      await run({
        send(message) {
          stdin.write(encodeNdjson(message as never));
        },
        waitFor: collected.waitFor
      });
    } finally {
      stdin.end();
      child.kill("SIGTERM");
      await Promise.race([started, new Promise((resolve) => setTimeout(resolve, 500))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }

  it("overlays initialize identity, maps modes, injects context, and rejects blank turns", async () => {
    const home = tempDir("paseo-official-proxy-");
    mkdirSync(path.join(home, "agents"));
    writeFileSync(
      path.join(home, "agents", "agent-proxy.json"),
      JSON.stringify({
        persistence: { metadata: { daemonAppendSystemPrompt: "proxy-daemon-context" } }
      })
    );

    await withProxy(
      async ({ send, waitFor }) => {
        send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
        const initialized = await waitFor((message) => "id" in message && message.id === 1);
        expect(initialized).toMatchObject({
          result: { agentInfo: { name: "agy-acp", version: "2.2.1" } }
        });

        send({
          jsonrpc: "2.0",
          id: 2,
          method: "session/new",
          params: {
            cwd: home,
            modeId: "accept-edits",
            mcpServers: [{ name: "paseo", type: "http", url: "http://127.0.0.1:9", headers: { K: "V" } }]
          }
        });
        const created = await waitFor((message) => "id" in message && message.id === 2);
        expect(created).toMatchObject({
          result: {
            modeId: "auto_edit",
            mcpServers: [{ type: "sse", headers: [{ name: "K", value: "V" }] }]
          }
        });

        send({
          jsonrpc: "2.0",
          id: 3,
          method: "session/prompt",
          params: { sessionId: "session-official-1", prompt: [{ type: "text", text: "ping" }] }
        });
        const visible = await waitFor(
          (message) => "method" in message && message.method === "session/update"
        );
        expect(visible).toMatchObject({
          params: { update: { content: { text: "pong-official" } } }
        });
        const completed = await waitFor((message) => "id" in message && message.id === 3);
        expect(JSON.stringify(completed)).toContain("proxy-daemon-context");
        expect(completed).toMatchObject({ result: { stopReason: "end_turn" } });

        send({
          jsonrpc: "2.0",
          id: 4,
          method: "session/prompt",
          params: { sessionId: "session-official-1", prompt: [{ type: "text", text: "BLANK_TURN" }] }
        });
        const blank = await waitFor((message) => "id" in message && message.id === 4);
        expect(blank).toMatchObject({ error: { code: -32000 } });
      },
      { PASEO_HOME: home, PASEO_AGENT_ID: "agent-proxy" }
    );
  });

  it("lets the packaged CLI talk to the official kernel through the product proxy", async () => {
    chmodSync(fakeOfficialAgent, 0o755);
    const child = spawn(process.execPath, [builtCli], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PASEO_AGY_ACP_KERNEL: "official",
        PASEO_AGY_ACP_OFFICIAL_BIN: fakeOfficialAgent
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = new PassThrough();
    child.stdout.pipe(stdout);
    const collected = collect(stdout);
    try {
      child.stdin.write(
        encodeNdjson({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } })
      );
      const initialized = await collected.waitFor((message) => "id" in message && message.id === 1);
      expect(initialized).toMatchObject({
        result: { agentInfo: { name: "agy-acp", version: "2.2.1" } }
      });
    } finally {
      child.stdin.end();
      child.kill("SIGTERM");
    }
  });
});
