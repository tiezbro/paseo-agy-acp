import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as acp from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import { client as acpClient, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { createAcpApp, createAcpV2App, type AcpAgentOptions } from "../src/agent.js";
import { cancelQueuedPrompts, handleCancel } from "../src/acp/session/cancel.js";
import { handleCloseSession } from "../src/acp/session/close.js";
import {
  handlePromptV1,
  handlePromptV2,
  notifyIdleAndDrainQueue,
  type PromptV1Deps,
  type PromptV2Deps
} from "../src/acp/session/prompt.js";
import { turnsOf } from "../src/acp/session/turn-scheduler.js";
import type { SessionState } from "../src/acp/session/types.js";
import { createConversationDb, insertStep } from "./fixtures/conversation-db.js";
import { encodeStepPayload } from "./fixtures/step-encoder.js";
import type { SpawnFactory } from "../src/agy/cli.js";

const TEST_MODELS_OUTPUT =
  "gemini-3.5-flash-medium\ngemini-3.5-flash-high\nclaude-opus-4-6-thinking\nclaude-sonnet-4-6\n";

function printModeOptions(overrides: AcpAgentOptions = {}): AcpAgentOptions {
  return {
    argv: ["--no-interactive-permissions"],
    stateDir: overrides.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-state-")),
    ...overrides
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function withConversationsDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-test-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

const ORIGINAL_PASEO_HOME = process.env.PASEO_HOME;
const ORIGINAL_PASEO_AGENT_ID = process.env.PASEO_AGENT_ID;

beforeEach(() => {
  setEnv("PASEO_HOME", undefined);
  setEnv("PASEO_AGENT_ID", undefined);
});

afterEach(() => {
  setEnv("PASEO_HOME", ORIGINAL_PASEO_HOME);
  setEnv("PASEO_AGENT_ID", ORIGINAL_PASEO_AGENT_ID);
});

function writePaseoAgentState(home: string, agentId: string, appendSystemPrompt: string): void {
  const agentDir = path.join(home, "agents", "workspace-one");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, `${agentId}.json`),
    JSON.stringify({
      persistence: {
        metadata: {
          daemonAppendSystemPrompt: appendSystemPrompt
        }
      }
    }),
    "utf8"
  );
}

class FakeProcess extends EventEmitter {
  stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  stdout: Readable;
  stderr: Readable;
  exitCode = 0;
  pid = 1;

  constructor(
    chunks: string[],
    options: { exitCode?: number; stderr?: string } = {}
  ) {
    super();
    this.exitCode = options.exitCode ?? 0;
    this.stdout = Readable.from(chunks);
    this.stderr = Readable.from(options.stderr ? [options.stderr] : []);
    queueMicrotask(() => this.emit("exit", this.exitCode, null));
  }

  kill() {
    this.exitCode = -15;
    this.emit("exit", -15, "SIGTERM");
    return true;
  }
}

function spawnAgyWritingConversation(
  dir: string,
  conversationId: string,
  steps: Parameters<typeof insertStep>[1][]
): SpawnFactory {
  return ((command: string, args: string[]) => {
    if (args[0] === "models") {
      return new FakeProcess([TEST_MODELS_OUTPUT]);
    }
    const db = createConversationDb(dir, conversationId);
    for (const step of steps) insertStep(db, step);
    db.close();
    return new FakeProcess([]);
  }) as unknown as SpawnFactory;
}

class ControlledFakeProcess extends EventEmitter {
  stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  stdout = new Readable({ read() {} });
  stderr = new Readable({ read() {} });
  exitCode: number | null = null;
  pid = 1;

  finish(code = 0) {
    this.exitCode = code;
    this.stdout.push(null);
    this.stderr.push(null);
    this.emit("exit", code, null);
  }

  kill(signal?: string) {
    this.exitCode = signal === "SIGKILL" ? -9 : -15;
    this.stdout.push(null);
    this.stderr.push(null);
    this.emit("exit", this.exitCode, signal ?? "SIGTERM");
    return true;
  }
}

describe("queue and steer-by-cancel", () => {
  it("prepends Paseo daemon context only to the backend prompt", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-paseo-home-"));
    const agentId = "agent-v2-append";
    const append = "PASEO_APPEND_NONCE_v2";
    const oldHome = process.env.PASEO_HOME;
    const oldAgentId = process.env.PASEO_AGENT_ID;
    const forwardedPrompts: string[] = [];
    const updates: Array<Record<string, unknown>> = [];
    writePaseoAgentState(home, agentId, append);
    setEnv("PASEO_HOME", home);
    setEnv("PASEO_AGENT_ID", agentId);

    const session = {
      sessionId: "s-paseo-v2",
      cwd: "/repo",
      additionalDirectories: [],
      promptQueue: [],
      v2UserMessageIdsByStep: {},
      catalog: { models: [], byBase: new Map() },
      selectedBaseModel: "m",
      selectedReasoningEffort: "",
      agy: {
        lastPromptUserStepIdxs: [],
        prompt: async (promptText: string) => {
          forwardedPrompts.push(promptText);
          return { stopReason: "end_turn" };
        },
        cancel: async () => {}
      }
    } as unknown as SessionState;
    const deps = {
      requireSession: () => session,
      applyConfigOption: async () => {},
      persistSession: async () => {},
      notifyConfigOptionUpdateV2: async () => {}
    } satisfies PromptV2Deps;
    const client = {
      notify: async (_method: unknown, params: { update: Record<string, unknown> }) => {
        updates.push(params.update);
      }
    } as any;

    try {
      await expect(handlePromptV2({
        sessionId: "s-paseo-v2",
        prompt: [{ type: "text", text: "hello user" }]
      } as any, client, deps)).resolves.toEqual({});

      await waitFor(() => forwardedPrompts.length === 1);
      await waitFor(() => updates.some((update) =>
        update.sessionUpdate === "state_update" &&
        update.state === "idle"
      ));

      expect(forwardedPrompts[0]).toBe([
        "[Paseo daemon system context]",
        append,
        "[/Paseo daemon system context]",
        "",
        "hello user"
      ].join("\n"));

      const userMessages = updates.filter((update) => update.sessionUpdate === "user_message");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]).toMatchObject({
        sessionUpdate: "user_message",
        content: [{ type: "text", text: "hello user" }]
      });
      expect(JSON.stringify(userMessages[0])).not.toContain(append);
    } finally {
      setEnv("PASEO_HOME", oldHome);
      setEnv("PASEO_AGENT_ID", oldAgentId);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("leaves the backend prompt unchanged without Paseo environment metadata", async () => {
    const oldHome = process.env.PASEO_HOME;
    const oldAgentId = process.env.PASEO_AGENT_ID;
    const forwardedPrompts: string[] = [];
    setEnv("PASEO_HOME", undefined);
    setEnv("PASEO_AGENT_ID", undefined);

    const session = {
      sessionId: "s-no-paseo",
      cwd: "/repo",
      additionalDirectories: [],
      promptQueue: [],
      v2UserMessageIdsByStep: {},
      catalog: { models: [], byBase: new Map() },
      selectedBaseModel: "m",
      selectedReasoningEffort: "",
      agy: {
        config: { mode: "default" },
        prompt: async (promptText: string) => {
          forwardedPrompts.push(promptText);
          return { stopReason: "end_turn" };
        },
        cancel: async () => {}
      }
    } as unknown as SessionState;
    const deps = {
      requireSession: () => session,
      applyConfigOption: async () => {},
      persistSession: async () => {},
      notifyCurrentModeUpdate: async () => {},
      notifyConfigOptionUpdateV1: async () => {},
      clientFileSystemV1: () => undefined
    } satisfies PromptV1Deps;

    try {
      await expect(handlePromptV1({
        sessionId: "s-no-paseo",
        prompt: [{ type: "text", text: "plain prompt" }]
      } as any, { notify: async () => {} } as any, undefined, deps)).resolves.toEqual({
        stopReason: "end_turn"
      });

      expect(forwardedPrompts).toEqual(["plain prompt"]);
    } finally {
      setEnv("PASEO_HOME", oldHome);
      setEnv("PASEO_AGENT_ID", oldAgentId);
    }
  });

  it("claims an idle v1 turn before asynchronous slash setup", async () => {
    let releaseConfigNotification!: () => void;
    const configNotification = new Promise<void>((resolve) => {
      releaseConfigNotification = resolve;
    });
    const session = {
      sessionId: "s1",
      cwd: "/repo",
      additionalDirectories: [],
      promptQueue: [],
      v2UserMessageIdsByStep: {},
      catalog: { models: [], byBase: new Map() },
      selectedBaseModel: "m",
      selectedReasoningEffort: "",
      agy: { config: { mode: "default" } }
    } as unknown as SessionState;
    const deps: PromptV1Deps = {
      requireSession: () => session,
      applyConfigOption: async () => {},
      persistSession: async () => {},
      notifyCurrentModeUpdate: async () => {},
      notifyConfigOptionUpdateV1: async () => configNotification,
      clientFileSystemV1: () => undefined
    };
    const client = { notify: async () => {} } as any;

    const first = handlePromptV1({
      sessionId: "s1",
      prompt: [{ type: "text", text: "/plan" }]
    } as any, client, undefined, deps);
    await waitFor(() => turnsOf(session).busy());

    await expect(handlePromptV1({
      sessionId: "s1",
      prompt: [{ type: "text", text: "overlap" }]
    } as any, client, undefined, deps)).rejects.toThrow("already has an active prompt");

    releaseConfigNotification();
    await expect(first).resolves.toEqual({ stopReason: "end_turn" });
    expect(turnsOf(session).busy()).toBe(false);
  });

  it("cancels a v1 turn while prompt content is still being prepared", async () => {
    let promptCalls = 0;
    const session = {
      sessionId: "s1",
      cwd: "/repo",
      additionalDirectories: [],
      promptQueue: [],
      v2UserMessageIdsByStep: {},
      catalog: { models: [], byBase: new Map() },
      selectedBaseModel: "m",
      selectedReasoningEffort: "",
      agy: {
        config: { mode: "default" },
        prompt: async () => {
          promptCalls++;
          return { stopReason: "end_turn" };
        },
        cancel: async () => {}
      }
    } as unknown as SessionState;
    const deps = {
      requireSession: () => session,
      applyConfigOption: async () => {},
      persistSession: async () => {},
      notifyCurrentModeUpdate: async () => {},
      notifyConfigOptionUpdateV1: async () => {},
      clientFileSystemV1: () => undefined
    } satisfies PromptV1Deps;

    const response = handlePromptV1({
      sessionId: "s1",
      prompt: [{ type: "text", text: "prepared asynchronously" }]
    } as any, { notify: async () => {} } as any, undefined, deps);

    expect(turnsOf(session).activeClaim).toBeDefined();
    turnsOf(session).activeClaim!.abort();

    await expect(response).resolves.toEqual({ stopReason: "cancelled" });
    expect(promptCalls).toBe(0);
    expect(turnsOf(session).activeClaim).toBeUndefined();
    expect(turnsOf(session).busy()).toBe(false);
  });

  it("places concurrent v2 queue requests in FIFO before notification awaits", async () => {
    const session = {
      sessionId: "s1",
      cwd: "/repo",
      promptQueue: []
    } as unknown as SessionState;
    // A turn is already running, so both requests must queue rather than start.
    turnsOf(session).claimIdle("foreground");
    const deps = {
      requireSession: () => session
    } as unknown as PromptV2Deps;
    const firstNotify = vi.fn(() => new Promise<void>(() => {}));
    const secondNotify = vi.fn(async () => {});
    const firstClient = { notify: firstNotify } as any;
    const secondClient = { notify: secondNotify } as any;

    const first = handlePromptV2({
      sessionId: "s1",
      prompt: [{ type: "text", text: "first" }],
      _meta: { "agy-acp/turnIntent": "queue" }
    } as any, firstClient, deps);
    const second = handlePromptV2({
      sessionId: "s1",
      prompt: [{ type: "text", text: "second" }],
      _meta: { "agy-acp/turnIntent": "queue" }
    } as any, secondClient, deps);

    expect(session.promptQueue.map((item) => (item.params.prompt[0] as any).text))
      .toEqual(["first", "second"]);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { _meta: { "agy-acp/queuedPromptId": expect.any(String) } },
      { _meta: { "agy-acp/queuedPromptId": expect.any(String) } }
    ]);
    // Acceptance responses precede queued user_message publication.
    expect(firstNotify).not.toHaveBeenCalled();
    expect(secondNotify).not.toHaveBeenCalled();

    cancelQueuedPrompts(session);
  });

  it("acknowledges a v2 steer before awaiting active-turn cancellation", async () => {
    let releaseCancel!: () => void;
    const cancelPending = new Promise<void>((resolve) => {
      releaseCancel = resolve;
    });
    let cancelCalls = 0;
    const session = {
      sessionId: "s1",
      cwd: "/repo",
      promptQueue: [],
      agy: {
        cancel: () => {
          cancelCalls++;
          return cancelPending;
        }
      }
    } as unknown as SessionState;
    const deps = {
      requireSession: () => session
    } as unknown as PromptV2Deps;
    const turns = turnsOf(session);
    const activeClaim = turns.claimIdle("foreground");

    const response = handlePromptV2({
      sessionId: "s1",
      prompt: [{ type: "text", text: "replacement" }],
      _meta: { "agy-acp/turnIntent": "steer" }
    } as any, { notify: async () => {} } as any, deps);

    // Accepted while the backend cancellation is still pending.
    await expect(response).resolves.toEqual({});
    expect(turns.busy()).toBe(true);
    await waitFor(() => cancelCalls === 1);

    session.closed = true;
    turns.close();
    turns.release(activeClaim);
    releaseCancel();
    await waitFor(() => !turns.busy());
  });

  it("cancels a v2 turn while prompt content is still being prepared", async () => {
    let promptCalls = 0;
    const session = {
      sessionId: "s1",
      cwd: "/repo",
      promptQueue: [],
      agy: {
        prompt: async () => {
          promptCalls++;
          return { stopReason: "end_turn" };
        },
        cancel: async () => {}
      }
    } as unknown as SessionState;
    const deps = {
      requireSession: () => session
    } as unknown as PromptV2Deps;

    const response = handlePromptV2({
      sessionId: "s1",
      prompt: [{ type: "text", text: "prepared asynchronously" }]
    } as any, { notify: async () => {} } as any, deps);

    expect(turnsOf(session).activeClaim).toBeDefined();
    turnsOf(session).activeClaim!.abort();

    await expect(response).resolves.toEqual({});
    await waitFor(() => !turnsOf(session).busy());
    expect(promptCalls).toBe(0);
    expect(turnsOf(session).activeClaim).toBeUndefined();
  });

  it("does not install a new idle waiter when a competing steer resumes after close", async () => {
    const session = {
      sessionId: "s1",
      cwd: "/repo",
      additionalDirectories: [],
      promptQueue: [],
      v2UserMessageIdsByStep: {},
      catalog: { models: [], byBase: new Map() },
      selectedBaseModel: "m",
      selectedReasoningEffort: "",
      agy: {
        config: { mode: "default" },
        cancel: async () => {},
        prompt: async () => ({ stopReason: "end_turn" })
      }
    } as unknown as SessionState;
    const deps = {
      requireSession: () => session,
      applyConfigOption: async () => {},
      persistSession: async () => {},
      notifyCurrentModeUpdate: async () => {},
      notifyConfigOptionUpdateV1: async () => {},
      clientFileSystemV1: () => undefined
    } satisfies PromptV1Deps;
    const client = { notify: async () => {} } as any;
    const steer = (text: string) => handlePromptV1({
      sessionId: "s1",
      prompt: [{ type: "text", text }],
      _meta: { "agy-acp/turnIntent": "steer" }
    } as any, client, undefined, deps);

    const turns = turnsOf(session);
    const activeClaim = turns.claimIdle("foreground");

    const first = steer("first");
    const second = steer("second");
    await waitFor(() => activeClaim.aborted);

    session.closed = true;
    turns.close();
    turns.release(activeClaim);

    await expect(Promise.all([first, second])).resolves.toEqual([
      { stopReason: "cancelled" },
      { stopReason: "cancelled" }
    ]);
    expect(turns.busy()).toBe(false);
  });

  it("does not let stalled queued v2 notifications block session teardown", async () => {
    const queuedController = new AbortController();
    const notify = vi.fn(() => new Promise<void>(() => {}));
    const close = vi.fn(async () => {});
    const session = {
      sessionId: "s1",
      promptQueue: [{
        id: "q1",
        version: "v2",
        params: { sessionId: "s1" },
        client: { notify },
        controller: queuedController
      }],
      agy: { close }
    } as unknown as SessionState;
    const activeClaim = turnsOf(session).claimIdle("foreground");
    const sessions = new Map([["s1", session]]);

    await handleCloseSession({ sessionId: "s1" }, sessions);

    expect(activeClaim.aborted).toBe(true);
    expect(queuedController.signal.aborted).toBe(true);
    expect(notify).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(sessions.has("s1")).toBe(false);
  });

  it("rejects overlapping prompts when no turnIntent meta is provided", async () => {
    await withConversationsDir(async (dir) => {
      let activeProc: ControlledFakeProcess | null = null;
      let promptCount = 0;
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        promptCount++;
        const convId = `conv-${promptCount}`;
        const db = createConversationDb(dir, convId);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: "prompt" }) });
        insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "reply" }) });
        db.close();
        const proc = new ControlledFakeProcess();
        activeProc = proc;
        return proc as any;
      };

      const client = acpClient({ name: "test-client" }).onNotification(
        methods.client.session.update,
        () => {}
      );
      const connection = client.connect(
        createAcpApp({
          ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          mcpServers: []
        });

        // Start first prompt (which stays active)
        const p1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 1" }]
        });

        await waitFor(() => activeProc !== null);

        // Overlapping prompt without turnIntent should reject immediately
        await expect(
          connection.agent.request(methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "prompt 2" }]
          })
        ).rejects.toThrow();

        (activeProc as ControlledFakeProcess | null)?.finish();
        await p1;
      } finally {
        connection.close();
      }
    });
  });

  it("queues v1 follow-up prompts and executes them in FIFO order", async () => {
    await withConversationsDir(async (dir) => {
      const executedPrompts: string[] = [];
      const processes: ControlledFakeProcess[] = [];
      let promptCount = 0;
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        const promptIdx = args.indexOf("--print");
        const promptText = promptIdx >= 0 ? args[promptIdx + 1] : "";
        executedPrompts.push(promptText);

        promptCount++;
        const convId = `conv-${promptCount}`;
        const db = createConversationDb(dir, convId);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: promptText }) });
        insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: `ans ${promptText}` }) });
        db.close();

        const proc = new ControlledFakeProcess();
        processes.push(proc);
        return proc as any;
      };

      const client = acpClient({ name: "test-client" }).onNotification(
        methods.client.session.update,
        () => {}
      );
      const connection = client.connect(
        createAcpApp({
          ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          mcpServers: []
        });

        // First prompt
        const p1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 1" }]
        });

        await waitFor(() => processes.length === 1);

        // Second prompt queued
        const p2 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 2" }],
          _meta: { "agy-acp/turnIntent": "queue" }
        } as any);

        // Third prompt queued
        const p3 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 3" }],
          _meta: { "agy-acp/turnIntent": "queue" }
        } as any);

        // Finish prompt 1
        processes[0].finish();
        const r1 = await p1;

        // Prompt 2 should now be running
        await waitFor(() => processes.length === 2);
        processes[1].finish();
        const r2 = (await p2) as acp.PromptResponse;

        // Prompt 3 should now be running
        await waitFor(() => processes.length === 3);
        processes[2].finish();
        const r3 = (await p3) as acp.PromptResponse;

        expect(r1.stopReason).toBe("end_turn");
        expect(r2.stopReason).toBe("end_turn");
        expect(r3.stopReason).toBe("end_turn");

        expect(executedPrompts).toEqual(["prompt 1", "prompt 2", "prompt 3"]);
      } finally {
        connection.close();
      }
    });
  });

  it("queues v2 follow-up prompts, accepting immediately and ordering updates", async () => {
    await withConversationsDir(async (dir) => {
      const updates: Array<Record<string, unknown>> = [];
      const client = acpV2.client({ name: "test-client" }).onNotification(
        acpV2.methods.client.session.update,
        (ctx) => {
          updates.push(ctx.params.update as Record<string, unknown>);
        }
      );
      const connection = client.connect(
        createAcpV2App({
          ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
          spawnProcess: spawnAgyWritingConversation(dir, "conv-v2-queue", [
            { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: "prompt 1" }) },
            { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "ans 1" }) },
            { idx: 2, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: "prompt 2" }) },
            { idx: 3, stepType: 15, stepPayload: encodeStepPayload({ agentText: "ans 2" }) }
          ])
        })
      );
      try {
        await connection.agent.request(acpV2.methods.agent.initialize, {
          protocolVersion: 2,
          info: { name: "test-client", version: "0.0.0" },
          capabilities: {}
        });
        const session = await connection.agent.request(acpV2.methods.agent.session.new, {
          cwd: "/repo"
        });

        // Prompt 1
        const r1 = await connection.agent.request(acpV2.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 1" }]
        });
        expect(r1).toEqual({});

        // Prompt 2 queued while 1 is active
        const r2 = await connection.agent.request(acpV2.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 2" }],
          _meta: { "agy-acp/turnIntent": "queue" }
        } as any);
        expect(r2).toEqual({ _meta: { "agy-acp/queuedPromptId": expect.any(String) } });

        await waitFor(() => {
          const idleCount = updates.filter((u) => u.sessionUpdate === "state_update" && u.state === "idle").length;
          return idleCount >= 2;
        });

        const userMessages = updates.filter((u) => u.sessionUpdate === "user_message");
        expect(userMessages.length).toBe(2);

        const states = updates.filter((u) => u.sessionUpdate === "state_update");
        // State updates: running (p1) -> idle (p1) -> running (p2) -> idle (p2)
        expect(states.map((s) => ({ state: s.state, stopReason: s.stopReason }))).toEqual([
          { state: "running", stopReason: undefined },
          { state: "idle", stopReason: "end_turn" },
          { state: "running", stopReason: undefined },
          { state: "idle", stopReason: "end_turn" }
        ]);
      } finally {
        connection.close();
      }
    });
  });

  it("steers an active turn by cancelling it and executing the steer prompt", async () => {
    await withConversationsDir(async (dir) => {
      const executedPrompts: string[] = [];
      const processes: ControlledFakeProcess[] = [];
      let promptCount = 0;
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        const promptIdx = args.indexOf("--print");
        const promptText = promptIdx >= 0 ? args[promptIdx + 1] : "";
        executedPrompts.push(promptText);

        promptCount++;
        const convId = `conv-steer-${promptCount}`;
        const db = createConversationDb(dir, convId);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: promptText }) });
        insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: `ans ${promptText}` }) });
        db.close();

        const proc = new ControlledFakeProcess();
        processes.push(proc);
        return proc as any;
      };

      const client = acpClient({ name: "test-client" }).onNotification(
        methods.client.session.update,
        () => {}
      );
      const connection = client.connect(
        createAcpApp({
          ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          mcpServers: []
        });

        // Start long-running prompt 1
        const p1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "long running turn" }]
        });

        await waitFor(() => processes.length === 1);

        // Steer with prompt 2
        const p2 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "steer turn" }],
          _meta: { "agy-acp/turnIntent": "steer" }
        } as any);

        // Turn 1 should be cancelled via SIGINT kill
        const r1 = await p1;
        expect(r1.stopReason).toBe("cancelled");

        // Complete steer process
        await waitFor(() => processes.length === 2);
        processes[1].finish();

        const r2 = (await p2) as acp.PromptResponse;
        expect(r2.stopReason).toBe("end_turn");

        expect(executedPrompts).toEqual(["long running turn", "steer turn"]);
      } finally {
        connection.close();
      }
    });
  });

  it("serializes competing steer requests", async () => {
    await withConversationsDir(async (dir) => {
      const processes: ControlledFakeProcess[] = [];
      const executedPrompts: string[] = [];
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        const promptIdx = args.indexOf("--print");
        executedPrompts.push(promptIdx >= 0 ? args[promptIdx + 1] : "");
        const db = createConversationDb(dir, `conv-steer-serial-${processes.length}`);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: "prompt" }) });
        db.close();
        const proc = new ControlledFakeProcess();
        processes.push(proc);
        return proc as any;
      };

      const client = acpClient({ name: "test-client" }).onNotification(
        methods.client.session.update,
        () => {}
      );
      const connection = client.connect(
        createAcpApp({
          ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          mcpServers: []
        });

        const p1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 1" }]
        });
        await waitFor(() => processes.length === 1);

        const p2 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "steer 1" }],
          _meta: { "agy-acp/turnIntent": "steer" }
        } as any);
        const p3 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "steer 2" }],
          _meta: { "agy-acp/turnIntent": "steer" }
        } as any);

        await waitFor(() => processes.length === 2);
        expect(executedPrompts).toEqual(["prompt 1", "steer 1"]);
        processes[1].finish();
        await p1;
        await p2;

        await waitFor(() => processes.length === 3);
        expect(executedPrompts).toEqual(["prompt 1", "steer 1", "steer 2"]);
        processes[2].finish();
        await p3;
      } finally {
        connection.close();
      }
    });
  });

  it("does not start a queued follow-up between competing steers", async () => {
    await withConversationsDir(async (dir) => {
      const processes: ControlledFakeProcess[] = [];
      const executedPrompts: string[] = [];
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        const promptIdx = args.indexOf("--print");
        executedPrompts.push(promptIdx >= 0 ? args[promptIdx + 1] : "");
        const db = createConversationDb(dir, `conv-steer-queue-${processes.length}`);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: "prompt" }) });
        db.close();
        const proc = new ControlledFakeProcess();
        processes.push(proc);
        return proc as any;
      };

      const client = acpClient({ name: "test-client" }).onNotification(
        methods.client.session.update,
        () => {}
      );
      const connection = client.connect(
        createAcpApp({
          ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          mcpServers: []
        });

        const p1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 1" }]
        });
        await waitFor(() => processes.length === 1);

        // Queue a follow-up, then two steers that must replace without letting the
        // queue claim the session between them.
        const pq = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "queued should wait" }],
          _meta: { "agy-acp/turnIntent": "queue" }
        } as any);
        const s1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "steer 1" }],
          _meta: { "agy-acp/turnIntent": "steer" }
        } as any);
        const s2 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "steer 2" }],
          _meta: { "agy-acp/turnIntent": "steer" }
        } as any);

        await waitFor(() => processes.length === 2);
        expect(executedPrompts).toEqual(["prompt 1", "steer 1"]);
        processes[1].finish();
        await p1;
        await s1;

        await waitFor(() => processes.length === 3);
        expect(executedPrompts).toEqual(["prompt 1", "steer 1", "steer 2"]);
        processes[2].finish();
        await s2;

        await waitFor(() => processes.length === 4);
        expect(executedPrompts).toEqual(["prompt 1", "steer 1", "steer 2", "queued should wait"]);
        processes[3].finish();
        const rq = (await pq) as acp.PromptResponse;
        expect(rq.stopReason).toBe("end_turn");
      } finally {
        connection.close();
      }
    });
  });

  it("cancels an in-flight steer when the session is closed", async () => {
    await withConversationsDir(async (dir) => {
      const processes: ControlledFakeProcess[] = [];
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        const db = createConversationDb(dir, `conv-steer-close-${processes.length}`);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: "prompt" }) });
        db.close();
        const proc = new ControlledFakeProcess();
        processes.push(proc);
        return proc as any;
      };

      const client = acpClient({ name: "test-client" }).onNotification(
        methods.client.session.update,
        () => {}
      );
      const connection = client.connect(
        createAcpApp({
          ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          mcpServers: []
        });

        const p1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 1" }]
        });
        await waitFor(() => processes.length === 1);

        const steer = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "steer after close" }],
          _meta: { "agy-acp/turnIntent": "steer" }
        } as any);

        await connection.agent.request(methods.agent.session.close, {
          sessionId: session.sessionId
        });

        const r1 = await p1;
        const rs = (await steer) as acp.PromptResponse;
        expect(r1.stopReason).toBe("cancelled");
        expect(rs.stopReason).toBe("cancelled");
        // Steer must not start a replacement after cleanup.
        expect(processes.length).toBe(1);
      } finally {
        connection.close();
      }
    });
  });

  it("stops an aborted v1 steer before launching the replacement", async () => {
    let promptCalls = 0;
    const session = {
      sessionId: "s1",
      cwd: "/repo",
      additionalDirectories: [],
      promptQueue: [],
      v2UserMessageIdsByStep: {},
      catalog: { models: [], byBase: new Map() },
      selectedBaseModel: "m",
      selectedReasoningEffort: "",
      agy: {
        config: { mode: "default" },
        cancel: async () => {
          // Keep the turn owned until the steer is waiting on idle.
        },
        prompt: async () => {
          promptCalls++;
          return { stopReason: "end_turn" };
        }
      }
    } as unknown as SessionState;

    const deps: PromptV1Deps = {
      requireSession: () => session,
      applyConfigOption: async () => {},
      persistSession: async () => {},
      notifyCurrentModeUpdate: async () => {},
      notifyConfigOptionUpdateV1: async () => {},
      clientFileSystemV1: () => undefined
    };

    const turns = turnsOf(session);
    const activeClaim = turns.claimIdle("foreground");
    const controller = new AbortController();
    const steerPromise = handlePromptV1(
      {
        sessionId: "s1",
        prompt: [{ type: "text", text: "replacement" }],
        _meta: { "agy-acp/turnIntent": "steer" }
      } as any,
      { notify: async () => {} } as any,
      controller.signal,
      deps
    );

    // Wait until the steer has displaced the active turn and is awaiting idle.
    await waitFor(() => activeClaim.aborted);

    // Abort while still waiting for the prior turn to settle.
    controller.abort();
    turns.release(activeClaim);

    const result = await steerPromise;
    expect(result.stopReason).toBe("cancelled");
    expect(promptCalls).toBe(0);
    expect(turns.busy()).toBe(false);
  });

  it("cancels a reserved v2 steer that is still waiting for the active turn", async () => {
    // PR #84 review: an accepted steer holds a reservation while it waits for
    // the previous turn to stop. A stop arriving in that window was dropped,
    // and the replacement launched anyway.
    let promptCalls = 0;
    const session = {
      sessionId: "s1",
      cwd: "/repo",
      additionalDirectories: [],
      promptQueue: [],
      v2UserMessageIdsByStep: {},
      agy: {
        config: { mode: "default" },
        cancel: async () => {},
        prompt: async () => {
          promptCalls++;
          return { stopReason: "end_turn" };
        },
        lastPromptUserStepIdxs: []
      }
    } as unknown as SessionState;
    const turns = turnsOf(session);
    const activeClaim = turns.claimIdle("foreground");
    const deps = {
      requireSession: () => session,
      persistSession: async () => {},
      applyConfigOption: async () => {},
      notifyConfigOptionUpdateV2: async () => {}
    } as unknown as PromptV2Deps;

    await expect(handlePromptV2({
      sessionId: "s1",
      prompt: [{ type: "text", text: "replacement" }],
      _meta: { "agy-acp/turnIntent": "steer" }
    } as any, { notify: async () => {} } as any, deps)).resolves.toEqual({});

    await waitFor(() => activeClaim.aborted);
    await handleCancel("s1", new Map([["s1", session]]));
    turns.release(activeClaim);

    await waitFor(() => !turns.busy());
    expect(promptCalls).toBe(0);
  });

  it("reports a failed v2 steer setup as a terminal idle update", async () => {
    // PR #84 review: the RPC has already returned {}, so a setup failure that
    // is only logged leaves the client stuck in `running` forever.
    const updates: any[] = [];
    const session = {
      sessionId: "s1",
      cwd: "/repo",
      additionalDirectories: [],
      promptQueue: [],
      v2UserMessageIdsByStep: {},
      agy: {
        config: { mode: "default" },
        cancel: async () => {
          throw new Error("backend kill failed");
        },
        prompt: async () => ({ stopReason: "end_turn" }),
        lastPromptUserStepIdxs: []
      }
    } as unknown as SessionState;
    const turns = turnsOf(session);
    const activeClaim = turns.claimIdle("foreground");
    const deps = {
      requireSession: () => session,
      persistSession: async () => {},
      applyConfigOption: async () => {},
      notifyConfigOptionUpdateV2: async () => {}
    } as unknown as PromptV2Deps;
    const client = { notify: async (_m: string, p: any) => { updates.push(p.update); } } as any;

    await expect(handlePromptV2({
      sessionId: "s1",
      prompt: [{ type: "text", text: "replacement" }],
      _meta: { "agy-acp/turnIntent": "steer" }
    } as any, client, deps)).resolves.toEqual({});

    await waitFor(() => updates.length > 0);
    expect(updates.at(-1)).toMatchObject({ sessionUpdate: "state_update", state: "idle" });
    // The failed steer released its reservation; only the simulated turn holds
    // the slot, so the session frees up once that finishes.
    turns.release(activeClaim);
    expect(turns.busy()).toBe(false);
  });

  it("releases the turn slot when a terminal update stalls and the session closes", async () => {
    // A wedged client transport must not hold the turn slot forever: closing
    // the session aborts the claim, which unblocks the terminal notification.
    const session = {
      sessionId: "s1",
      cwd: "/repo",
      additionalDirectories: [],
      promptQueue: [],
      v2UserMessageIdsByStep: {},
      agy: {
        config: { mode: "default" },
        cancel: async () => {},
        close: async () => {},
        prompt: async () => ({ stopReason: "end_turn" }),
        lastPromptUserStepIdxs: []
      }
    } as unknown as SessionState;
    const turns = turnsOf(session);
    const deps = {
      requireSession: () => session,
      persistSession: async () => {},
      applyConfigOption: async () => {},
      notifyConfigOptionUpdateV2: async () => {}
    } as unknown as PromptV2Deps;
    // Every notification after the first two (user_message, running) stalls.
    let sent = 0;
    const client = {
      notify: async () => {
        sent++;
        if (sent > 2) await new Promise<void>(() => {});
      }
    } as any;

    await expect(handlePromptV2({
      sessionId: "s1",
      prompt: [{ type: "text", text: "hello" }]
    } as any, client, deps)).resolves.toEqual({});

    await waitFor(() => sent >= 3);
    expect(turns.busy()).toBe(true);

    await handleCloseSession({ sessionId: "s1" }, new Map([["s1", session]]) as any);

    await waitFor(() => !turns.busy());
  });

  it("settles a v1 turn whose client notification never resolves when cancelled", async () => {
    // PR #84 review: agy's print-mode poll loop awaits each onUpdate callback,
    // so a wedged v1 session/update pinned the turn — killing the backend could
    // not settle it, and the turn slot was never released.
    let notifyCalls = 0;
    const session = {
      sessionId: "s1",
      cwd: "/repo",
      additionalDirectories: [],
      promptQueue: [],
      v2UserMessageIdsByStep: {},
      catalog: { models: [], byBase: new Map() },
      selectedBaseModel: "m",
      selectedReasoningEffort: "",
      agy: {
        config: { mode: "default" },
        cancel: async () => {},
        prompt: async (_prompt: string, onUpdate: (update: unknown) => Promise<void>) => {
          // Mirrors runPromptCommand: the poll loop awaits each callback, so a
          // wedged delivery pins the turn until the callback settles.
          await onUpdate({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "chunk" }
          });
          return { stopReason: "end_turn" };
        }
      }
    } as unknown as SessionState;
    const deps: PromptV1Deps = {
      requireSession: () => session,
      applyConfigOption: async () => {},
      persistSession: async () => {},
      notifyCurrentModeUpdate: async () => {},
      notifyConfigOptionUpdateV1: async () => {},
      clientFileSystemV1: () => undefined
    };
    const client = {
      notify: async () => {
        notifyCalls++;
        await new Promise<void>(() => {}); // wedged transport
      }
    } as any;

    const promptPromise = handlePromptV1({
      sessionId: "s1",
      prompt: [{ type: "text", text: "hello" }]
    } as any, client, undefined, deps);

    await waitFor(() => notifyCalls === 1);
    await handleCancel("s1", new Map([["s1", session]]));

    await expect(promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    expect(turnsOf(session).busy()).toBe(false);
  });

  it("steers a v1 turn whose client notification is wedged", async () => {
    // Same wedge as above, but displaced by a steer: the replacement must not
    // wait forever behind a turn that can never settle.
    let notifyCalls = 0;
    let promptCalls = 0;
    const session = {
      sessionId: "s1",
      cwd: "/repo",
      additionalDirectories: [],
      promptQueue: [],
      v2UserMessageIdsByStep: {},
      catalog: { models: [], byBase: new Map() },
      selectedBaseModel: "m",
      selectedReasoningEffort: "",
      agy: {
        config: { mode: "default" },
        cancel: async () => {},
        prompt: async (_prompt: string, onUpdate: (update: unknown) => Promise<void>) => {
          promptCalls++;
          if (promptCalls === 1) {
            await onUpdate({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "chunk" }
            });
          }
          return { stopReason: "end_turn" };
        }
      }
    } as unknown as SessionState;
    const deps: PromptV1Deps = {
      requireSession: () => session,
      applyConfigOption: async () => {},
      persistSession: async () => {},
      notifyCurrentModeUpdate: async () => {},
      notifyConfigOptionUpdateV1: async () => {},
      clientFileSystemV1: () => undefined
    };
    const client = {
      notify: async () => {
        notifyCalls++;
        await new Promise<void>(() => {}); // wedged transport
      }
    } as any;

    const first = handlePromptV1({
      sessionId: "s1",
      prompt: [{ type: "text", text: "first" }]
    } as any, client, undefined, deps);
    await waitFor(() => notifyCalls === 1);

    const steer = handlePromptV1({
      sessionId: "s1",
      prompt: [{ type: "text", text: "replacement" }],
      _meta: { "agy-acp/turnIntent": "steer" }
    } as any, client, undefined, deps);

    await expect(first).resolves.toEqual({ stopReason: "cancelled" });
    await expect(steer).resolves.toEqual({ stopReason: "end_turn" });
    expect(promptCalls).toBe(2);
    expect(turnsOf(session).busy()).toBe(false);
  });

  it("does not jam the v2 queue behind a wedged user_message notification", async () => {
    // A queued v2 prompt publishes its user_message during enqueue, serialized
    // in FIFO order. If that delivery wedges, cancelling the item must unwedge
    // the chain so later queued prompts still prepare.
    const updates: any[] = [];
    let notifyCalls = 0;
    const session = {
      sessionId: "s1",
      cwd: "/repo",
      additionalDirectories: [],
      promptQueue: [],
      v2UserMessageIdsByStep: {},
      agy: {
        config: { mode: "default" },
        cancel: async () => {},
        prompt: async () => ({ stopReason: "end_turn" }),
        lastPromptUserStepIdxs: []
      }
    } as unknown as SessionState;
    const turns = turnsOf(session);
    const activeClaim = turns.claimIdle("foreground"); // hold the slot so prompts queue
    const deps = {
      requireSession: () => session,
      persistSession: async () => {},
      applyConfigOption: async () => {},
      notifyConfigOptionUpdateV2: async () => {}
    } as unknown as PromptV2Deps;
    const client = {
      notify: async (_method: string, p: any) => {
        notifyCalls++;
        if (notifyCalls === 1) await new Promise<void>(() => {}); // wedged transport
        updates.push(p.update);
      }
    } as any;

    await expect(handlePromptV2({
      sessionId: "s1",
      prompt: [{ type: "text", text: "first" }],
      _meta: { "agy-acp/turnIntent": "queue" }
    } as any, client, deps)).resolves.toEqual({
      _meta: { "agy-acp/queuedPromptId": expect.any(String) }
    });
    await waitFor(() => notifyCalls === 1); // item 1's user_message is wedged

    await expect(handlePromptV2({
      sessionId: "s1",
      prompt: [{ type: "text", text: "second" }],
      _meta: { "agy-acp/turnIntent": "queue" }
    } as any, client, deps)).resolves.toEqual({
      _meta: { "agy-acp/queuedPromptId": expect.any(String) }
    });

    // Cancel the wedged item through the real session/cancel path.
    const queuedId = session.promptQueue[0].id;
    await handleCancel("s1", new Map([["s1", session]]), { "agy-acp/queuedPromptId": queuedId });

    // Item 2's preparation must proceed despite item 1's wedged delivery.
    await waitFor(() => updates.some((u) => u.sessionUpdate === "user_message"));

    turns.release(activeClaim);
  });

  it("returns a cancellation id for queued v2 prompts", async () => {
    // PR #84 review: targeted cancellation of a queued v2 prompt requires
    // agy-acp/queuedPromptId, but it was generated internally and never
    // returned, so clients could not cancel individual queued items.
    const updates: any[] = [];
    const session = {
      sessionId: "s1",
      cwd: "/repo",
      additionalDirectories: [],
      promptQueue: [],
      v2UserMessageIdsByStep: {},
      agy: {
        config: { mode: "default" },
        cancel: async () => {},
        prompt: async () => ({ stopReason: "end_turn" }),
        lastPromptUserStepIdxs: []
      }
    } as unknown as SessionState;
    const turns = turnsOf(session);
    const activeClaim = turns.claimIdle("foreground"); // hold the slot so the prompt queues
    const deps = {
      requireSession: () => session,
      persistSession: async () => {},
      applyConfigOption: async () => {},
      notifyConfigOptionUpdateV2: async () => {}
    } as unknown as PromptV2Deps;
    const client = { notify: async (_m: string, p: any) => { updates.push(p.update); } } as any;

    const response = await handlePromptV2({
      sessionId: "s1",
      prompt: [{ type: "text", text: "follow up" }],
      _meta: { "agy-acp/turnIntent": "queue" }
    } as any, client, deps);

    const queuedId = (response as any)._meta?.["agy-acp/queuedPromptId"];
    expect(typeof queuedId).toBe("string");
    expect(session.promptQueue.map((item) => item.id)).toContain(queuedId);

    // The id cancels exactly that queued item through session/cancel.
    await handleCancel("s1", new Map([["s1", session]]), { "agy-acp/queuedPromptId": queuedId });
    expect(session.promptQueue).toHaveLength(0);
    expect(
      updates.some((u) => u.sessionUpdate === "state_update" && u.stopReason === "cancelled")
    ).toBe(true);

    turns.release(activeClaim);
  });

  it("unblocks later v2 queue preparation when a claimed queued turn is cancelled", async () => {
    // PR #84 review: once a queued v2 item is claimed, session/cancel aborts
    // its TurnClaim but not its preparation controller; a `ready` promise
    // still wedged on user_message delivery stayed pinned in
    // promptQueuePreparation and jammed every later queued prompt.
    const updates: any[] = [];
    let notifyCalls = 0;
    const session = {
      sessionId: "s1",
      cwd: "/repo",
      additionalDirectories: [],
      promptQueue: [],
      v2UserMessageIdsByStep: {},
      agy: {
        config: { mode: "default" },
        cancel: async () => {},
        prompt: async () => ({ stopReason: "end_turn" }),
        lastPromptUserStepIdxs: []
      }
    } as unknown as SessionState;
    const turns = turnsOf(session);
    const deps = {
      requireSession: () => session,
      persistSession: async () => {},
      applyConfigOption: async () => {},
      notifyConfigOptionUpdateV2: async () => {}
    } as unknown as PromptV2Deps;
    const client = {
      notify: async (_method: string, p: any) => {
        notifyCalls++;
        if (notifyCalls === 1) await new Promise<void>(() => {}); // wedge item 1's user_message
        updates.push(p.update);
      }
    } as any;

    const activeClaim = turns.claimIdle("foreground");
    await expect(handlePromptV2({
      sessionId: "s1",
      prompt: [{ type: "text", text: "first" }],
      _meta: { "agy-acp/turnIntent": "queue" }
    } as any, client, deps)).resolves.toEqual({
      _meta: { "agy-acp/queuedPromptId": expect.any(String) }
    });
    await waitFor(() => notifyCalls === 1); // item 1's user_message is wedged

    // The item leaves the FIFO and its turn claims the slot, still waiting on
    // the wedged preparation.
    const queuedItem = session.promptQueue[0];
    turns.release(activeClaim);
    notifyIdleAndDrainQueue(session);
    await waitFor(() => turns.busy() && session.promptQueue.length === 0);

    // A plain session/cancel aborts the claimed turn...
    await handleCancel("s1", new Map([["s1", session]]));
    await waitFor(() => !turns.busy());
    // ...and must also abort the item's preparation controller.
    expect((queuedItem as Extract<SessionState["promptQueue"][number], { version: "v2" }>).controller.signal.aborted).toBe(true);

    // A later queued prompt prepares instead of chaining behind the wedge.
    const nextActive = turns.claimIdle("foreground");
    await expect(handlePromptV2({
      sessionId: "s1",
      prompt: [{ type: "text", text: "second" }],
      _meta: { "agy-acp/turnIntent": "queue" }
    } as any, client, deps)).resolves.toBeDefined();
    await waitFor(() => updates.some((u) => u.sessionUpdate === "user_message"));

    turns.release(nextActive);
  });

  it("cancels a claimed queued turn by id without aborting a concurrent steer", async () => {
    // PR #84 review: a targeted cancel whose item had already left the FIFO
    // fell through to abortAll(), killing the unrelated steer reservation too.
    const updates: any[] = [];
    let promptCalls = 0;
    let settlePrompt: (outcome: { stopReason: string }) => void = () => {};
    const session = {
      sessionId: "s1",
      cwd: "/repo",
      additionalDirectories: [],
      promptQueue: [],
      v2UserMessageIdsByStep: {},
      agy: {
        config: { mode: "default" },
        cancel: async () => { settlePrompt({ stopReason: "cancelled" }); },
        prompt: async () => {
          promptCalls++;
          return new Promise<{ stopReason: string }>((resolve) => { settlePrompt = resolve; });
        },
        lastPromptUserStepIdxs: []
      }
    } as unknown as SessionState;
    const turns = turnsOf(session);
    const deps = {
      requireSession: () => session,
      persistSession: async () => {},
      applyConfigOption: async () => {},
      notifyConfigOptionUpdateV2: async () => {}
    } as unknown as PromptV2Deps;
    const client = { notify: async (_m: string, p: any) => { updates.push(p.update); } } as any;

    // Queue item 1 behind a held slot, then let it claim the turn.
    const held = turns.claimIdle("foreground");
    const queuedResponse = await handlePromptV2({
      sessionId: "s1",
      prompt: [{ type: "text", text: "queued" }],
      _meta: { "agy-acp/turnIntent": "queue" }
    } as any, client, deps);
    const queuedId = (queuedResponse as any)._meta["agy-acp/queuedPromptId"] as string;
    await waitFor(() => updates.some((u) => u.sessionUpdate === "user_message"));
    turns.release(held);
    notifyIdleAndDrainQueue(session);
    await waitFor(() => promptCalls === 1); // the queued turn is running

    // A steer reserves the next turn; displacement starts on the next task, so
    // the reservation exists but the queued turn's claim is still untouched.
    const steer = handlePromptV2({
      sessionId: "s1",
      prompt: [{ type: "text", text: "steer" }],
      _meta: { "agy-acp/turnIntent": "steer" }
    } as any, client, deps);
    await steer; // acceptance only

    // Targeted cancel of the queued item must abort only its claimed turn.
    await handleCancel("s1", new Map([["s1", session]]), { "agy-acp/queuedPromptId": queuedId });

    // The steer survives, displaces the cancelled turn, and runs.
    await waitFor(() => promptCalls === 2);
    settlePrompt({ stopReason: "end_turn" });
    await waitFor(() =>
      updates.some(
        (u) => u.sessionUpdate === "state_update" && u.state === "idle" && u.stopReason === "end_turn"
      )
    );
    expect(turns.busy()).toBe(false);
  });

  it("treats a stale queued cancellation id as a no-op", async () => {
    // PR #84 review: an unmatched targeted cancel fell through to abortAll(),
    // so a stale id could cancel whichever newer turn happened to be active.
    let promptCalls = 0;
    let cancelCalls = 0;
    let settlePrompt: (outcome: { stopReason: string }) => void = () => {};
    const session = {
      sessionId: "s1",
      cwd: "/repo",
      additionalDirectories: [],
      promptQueue: [],
      v2UserMessageIdsByStep: {},
      agy: {
        config: { mode: "default" },
        cancel: async () => {
          cancelCalls++;
          settlePrompt({ stopReason: "cancelled" });
        },
        prompt: async () => {
          promptCalls++;
          return new Promise<{ stopReason: string }>((resolve) => { settlePrompt = resolve; });
        },
        lastPromptUserStepIdxs: []
      }
    } as unknown as SessionState;
    const turns = turnsOf(session);
    const deps = {
      requireSession: () => session,
      persistSession: async () => {},
      applyConfigOption: async () => {},
      notifyConfigOptionUpdateV2: async () => {}
    } as unknown as PromptV2Deps;
    const client = { notify: async () => {} } as any;

    // A foreground v2 turn is running.
    await handlePromptV2({
      sessionId: "s1",
      prompt: [{ type: "text", text: "active" }]
    } as any, client, deps);
    await waitFor(() => promptCalls === 1);

    // A targeted cancel for an unknown id must not touch the active turn.
    await handleCancel("s1", new Map([["s1", session]]), { "agy-acp/queuedPromptId": "q-stale" });
    expect(cancelCalls).toBe(0);
    expect(turns.busy()).toBe(true);

    // A plain session/cancel still stops the active turn.
    await handleCancel("s1", new Map([["s1", session]]));
    await waitFor(() => !turns.busy());
    expect(cancelCalls).toBeGreaterThan(0);
  });

  it("rejects a non-intent prompt while a steer replacement is in progress", async () => {
    await withConversationsDir(async (dir) => {
      const processes: ControlledFakeProcess[] = [];
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        const db = createConversationDb(dir, `conv-steer-busy-${processes.length}`);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: "prompt" }) });
        insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "ok" }) });
        db.close();
        const proc = new ControlledFakeProcess();
        processes.push(proc);
        return proc as any;
      };

      const client = acpClient({ name: "test-client" }).onNotification(
        methods.client.session.update,
        () => {}
      );
      const connection = client.connect(
        createAcpApp({
          ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          mcpServers: []
        });

        const p1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 1" }]
        });
        await waitFor(() => processes.length === 1);

        const steer = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "steer turn" }],
          _meta: { "agy-acp/turnIntent": "steer" }
        } as any);

        await waitFor(() => processes.length === 2);

        // Steer owns the session (active or claim); concurrent no-intent must not start.
        await expect(
          connection.agent.request(methods.agent.session.prompt, {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "sneak in" }]
          })
        ).rejects.toThrow();

        processes[1].finish();
        await p1;
        await steer;
      } finally {
        connection.close();
      }
    });
  });

  it("drains the queue after a slash-command steer", async () => {
    await withConversationsDir(async (dir) => {
      const processes: ControlledFakeProcess[] = [];
      const executedPrompts: string[] = [];
      const updates: Array<Record<string, unknown>> = [];
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        const promptIdx = args.indexOf("--print");
        executedPrompts.push(promptIdx >= 0 ? args[promptIdx + 1] : "");
        const db = createConversationDb(dir, `conv-slash-steer-${processes.length}`);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: "prompt" }) });
        insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "ok" }) });
        db.close();
        const proc = new ControlledFakeProcess();
        processes.push(proc);
        return proc as any;
      };

      const client = acpClient({ name: "test-client" }).onNotification(
        methods.client.session.update,
        (ctx) => {
          updates.push(ctx.params.update as Record<string, unknown>);
        }
      );
      const connection = client.connect(
        createAcpApp({
          ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          mcpServers: []
        });

        const p1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 1" }]
        });
        await waitFor(() => processes.length === 1);

        const queued = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "queued after slash steer" }],
          _meta: { "agy-acp/turnIntent": "queue" }
        } as any);

        const steer = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "/plan" }],
          _meta: { "agy-acp/turnIntent": "steer" }
        } as any);

        const r1 = await p1;
        expect(r1.stopReason).toBe("cancelled");

        const rs = (await steer) as acp.PromptResponse;
        expect(rs.stopReason).toBe("end_turn");
        expect(
          updates.some(
            (u) =>
              u.sessionUpdate === "current_mode_update" && u.currentModeId === "plan"
          )
        ).toBe(true);

        // Queue must still run after the slash-only steer releases its claim.
        await waitFor(() => processes.length === 2);
        processes[1].finish();
        const rq = (await queued) as acp.PromptResponse;
        expect(rq.stopReason).toBe("end_turn");
        expect(executedPrompts).toEqual(["prompt 1", "queued after slash steer"]);
      } finally {
        connection.close();
      }
    });
  });

  it("releases the steer slot when slash-command setup throws", async () => {
    await withConversationsDir(async (dir) => {
      const processes: ControlledFakeProcess[] = [];
      const executedPrompts: string[] = [];
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        const promptIdx = args.indexOf("--print");
        executedPrompts.push(promptIdx >= 0 ? args[promptIdx + 1] : "");
        const db = createConversationDb(dir, `conv-steer-throw-${processes.length}`);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: "prompt" }) });
        insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "ok" }) });
        db.close();
        const proc = new ControlledFakeProcess();
        processes.push(proc);
        return proc as any;
      };

      const client = acpClient({ name: "test-client" }).onNotification(
        methods.client.session.update,
        () => {}
      );
      const connection = client.connect(
        createAcpApp({
          ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          mcpServers: []
        });

        const p1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 1" }]
        });
        await waitFor(() => processes.length === 1);

        const queued = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "queued after failed steer" }],
          _meta: { "agy-acp/turnIntent": "queue" }
        } as any);

        const badSteer = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "/model nonexistent-model-xyz" }],
          _meta: { "agy-acp/turnIntent": "steer" }
        } as any);

        // ACP wraps handler errors; the important bit is rejection + claim release.
        await expect(badSteer).rejects.toThrow();
        const r1 = await p1;
        expect(r1.stopReason).toBe("cancelled");

        // Failed steer must release its claim so the queue can proceed.
        await waitFor(() => processes.length === 2);
        processes[1].finish();
        const rq = (await queued) as acp.PromptResponse;
        expect(rq.stopReason).toBe("end_turn");
        expect(executedPrompts).toEqual(["prompt 1", "queued after failed steer"]);
      } finally {
        connection.close();
      }
    });
  });

  it("does not leave a v2 queue item stuck when the session closes during enqueue", async () => {
    await withConversationsDir(async (dir) => {
      const processes: ControlledFakeProcess[] = [];
      const updates: Array<Record<string, unknown>> = [];
      let blockUserMessage: (() => void) | undefined;
      const userMessageGate = new Promise<void>((resolve) => {
        blockUserMessage = resolve;
      });

      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        const db = createConversationDb(dir, `conv-v2-enqueue-close-${processes.length}`);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: "prompt" }) });
        insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "ok" }) });
        db.close();
        const proc = new ControlledFakeProcess();
        processes.push(proc);
        return proc as any;
      };

      let userMessageCount = 0;
      const client = acpV2.client({ name: "test-client" }).onNotification(
        acpV2.methods.client.session.update,
        async (ctx) => {
          const update = ctx.params.update as Record<string, unknown>;
          updates.push(update);
          if (update.sessionUpdate === "user_message") {
            userMessageCount++;
            // Hold the second user_message (queued) so close can interleave.
            if (userMessageCount === 2 && blockUserMessage) {
              await userMessageGate;
            }
          }
        }
      );
      const connection = client.connect(
        createAcpV2App({
          ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(acpV2.methods.agent.initialize, {
          protocolVersion: 2,
          info: { name: "test-client", version: "0.0.0" },
          capabilities: {}
        });
        const session = await connection.agent.request(acpV2.methods.agent.session.new, {
          cwd: "/repo"
        });

        const r1 = await connection.agent.request(acpV2.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 1" }]
        });
        expect(r1).toEqual({});
        await waitFor(() => processes.length === 1);

        const queued = connection.agent.request(acpV2.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "queued v2 during close" }],
          _meta: { "agy-acp/turnIntent": "queue" }
        } as any);

        await waitFor(() => userMessageCount >= 2);

        await connection.agent.request(acpV2.methods.agent.session.close, {
          sessionId: session.sessionId
        } as any);

        blockUserMessage?.();
        await queued;

        // Must emit a terminal cancelled update rather than silently dropping the queue item.
        await waitFor(() =>
          updates.some(
            (u) =>
              u.sessionUpdate === "state_update" &&
              u.state === "idle" &&
              u.stopReason === "cancelled"
          )
        );
        // Queued turn must not spawn agy after close.
        expect(processes.length).toBe(1);
      } finally {
        connection.close();
      }
    });
  });

  it("cancels a queued v2 turn aborted during startup notifications", async () => {
    await withConversationsDir(async (dir) => {
      const processes: ControlledFakeProcess[] = [];
      const updates: Array<Record<string, unknown>> = [];
      let promptSpawnCount = 0;
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        promptSpawnCount++;
        const db = createConversationDb(dir, `conv-v2-abort-${processes.length}`);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: "prompt" }) });
        insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "ok" }) });
        db.close();
        const proc = new ControlledFakeProcess();
        processes.push(proc);
        return proc as any;
      };

      const client = acpV2.client({ name: "test-client" }).onNotification(
        acpV2.methods.client.session.update,
        (ctx) => {
          updates.push(ctx.params.update as Record<string, unknown>);
        }
      );
      const connection = client.connect(
        createAcpV2App({
          ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(acpV2.methods.agent.initialize, {
          protocolVersion: 2,
          info: { name: "test-client", version: "0.0.0" },
          capabilities: {}
        });
        const session = await connection.agent.request(acpV2.methods.agent.session.new, {
          cwd: "/repo"
        });

        // Start a long-running v2 turn so we can queue behind it.
        const r1 = await connection.agent.request(acpV2.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 1" }]
        });
        expect(r1).toEqual({});
        await waitFor(() => processes.length === 1);

        const r2 = await connection.agent.request(acpV2.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "queued v2" }],
          _meta: { "agy-acp/turnIntent": "queue" }
        } as any);
        expect(r2).toEqual({ _meta: { "agy-acp/queuedPromptId": expect.any(String) } });

        // Close while p1 is active and p2 is queued — queued turn must not spawn agy.
        await connection.agent.request(acpV2.methods.agent.session.close, {
          sessionId: session.sessionId
        } as any);

        await waitFor(() =>
          updates.some(
            (u) =>
              u.sessionUpdate === "state_update" &&
              u.state === "idle" &&
              u.stopReason === "cancelled"
          )
        );

        // Only the first (active) prompt may have spawned; queued must not start after teardown.
        expect(promptSpawnCount).toBe(1);
        expect(
          updates.filter(
            (u) =>
              u.sessionUpdate === "state_update" &&
              u.state === "idle" &&
              u.stopReason === "cancelled"
          ).length
        ).toBeGreaterThanOrEqual(1);
      } finally {
        connection.close();
      }
    });
  });

  it("does not treat a queued resource body of /plan as a config slash command", async () => {
    await withConversationsDir(async (dir) => {
      const processes: ControlledFakeProcess[] = [];
      const executedPrompts: string[] = [];
      const updates: Array<Record<string, unknown>> = [];
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        const promptIdx = args.indexOf("--print");
        executedPrompts.push(promptIdx >= 0 ? args[promptIdx + 1] : "");
        const db = createConversationDb(dir, `conv-queued-resource-${processes.length}`);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: "prompt" }) });
        insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "ok" }) });
        db.close();
        const proc = new ControlledFakeProcess();
        processes.push(proc);
        return proc as any;
      };

      const client = acpClient({ name: "test-client" }).onNotification(
        methods.client.session.update,
        (ctx) => {
          updates.push(ctx.params.update as Record<string, unknown>);
        }
      );
      const connection = client.connect(
        createAcpApp({
          ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          mcpServers: []
        });

        const p1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 1" }]
        });
        await waitFor(() => processes.length === 1);

        const p2 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [
            {
              type: "resource",
              resource: { uri: "file:///notes.md", text: "/plan", mimeType: "text/markdown" }
            }
          ],
          _meta: { "agy-acp/turnIntent": "queue" }
        } as any);

        processes[0].finish();
        await p1;

        await waitFor(() => processes.length === 2);
        processes[1].finish();
        const r2 = (await p2) as acp.PromptResponse;
        expect(r2.stopReason).toBe("end_turn");
        // Resource body is forwarded to agy, not intercepted as /plan mode change.
        expect(executedPrompts[1]).toBe("/plan");
        expect(
          updates.some(
            (u) =>
              u.sessionUpdate === "current_mode_update" ||
              (u.sessionUpdate === "config_option_update" &&
                Array.isArray(u.configOptions) &&
                (u.configOptions as Array<{ id?: string; currentValue?: string }>).some(
                  (o) => o.id === "mode" && o.currentValue === "plan"
                ))
          )
        ).toBe(false);
      } finally {
        connection.close();
      }
    });
  });

  // The ACP SDK request helper does not currently expose a request-abort
  // option, so queued request cancellation is covered by session close below.
  it.skip("cancels a specific queued prompt via signal abort", async () => {
    await withConversationsDir(async (dir) => {
      const processes: ControlledFakeProcess[] = [];
      const executedPrompts: string[] = [];
      let promptCount = 0;
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        const promptIdx = args.indexOf("--print");
        const promptText = promptIdx >= 0 ? args[promptIdx + 1] : "";
        executedPrompts.push(promptText);

        promptCount++;
        const convId = `conv-abort-${promptCount}`;
        const db = createConversationDb(dir, convId);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: promptText }) });
        insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: `ans ${promptText}` }) });
        db.close();

        const proc = new ControlledFakeProcess();
        processes.push(proc);
        return proc as any;
      };

      const client = acpClient({ name: "test-client" }).onNotification(
        methods.client.session.update,
        () => {}
      );
      const connection = client.connect(
        createAcpApp({
          ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          mcpServers: []
        });

        const p1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 1" }]
        });

        await waitFor(() => processes.length === 1);

        // Queue item 2 with AbortController
        const controller = new AbortController();
        const p2 = (connection.agent.request as any)(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 2" }],
          _meta: { "agy-acp/turnIntent": "queue" }
        } as any, { signal: controller.signal });

        // Abort p2 while p1 is active
        controller.abort();

        const r2 = (await p2) as acp.PromptResponse;
        expect(r2.stopReason).toBe("cancelled");

        // Complete p1
        processes[0].finish();
        const r1 = await p1;
        expect(r1.stopReason).toBe("end_turn");

        // Only prompt 1 was executed
        expect(executedPrompts).toEqual(["prompt 1"]);
      } finally {
        connection.close();
      }
    });
  });

  it("drains and cancels queued prompts on session close", async () => {
    await withConversationsDir(async (dir) => {
      const processes: ControlledFakeProcess[] = [];
      let promptCount = 0;
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        promptCount++;
        const convId = `conv-close-${promptCount}`;
        const db = createConversationDb(dir, convId);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: "prompt" }) });
        db.close();

        const proc = new ControlledFakeProcess();
        processes.push(proc);
        return proc as any;
      };

      const client = acpClient({ name: "test-client" }).onNotification(
        methods.client.session.update,
        () => {}
      );
      const connection = client.connect(
        createAcpApp({
          ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          mcpServers: []
        });

        const p1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 1" }]
        });

        await waitFor(() => processes.length === 1);

        const p2 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "prompt 2" }],
          _meta: { "agy-acp/turnIntent": "queue" }
        } as any);

        // Close session while p1 is active and p2 is queued
        await connection.agent.request(methods.agent.session.close, {
          sessionId: session.sessionId
        });

        const r1 = await p1;
        const r2 = (await p2) as acp.PromptResponse;

        expect(r1.stopReason).toBe("cancelled");
        expect(r2.stopReason).toBe("cancelled");
      } finally {
        connection.close();
      }
    });
  });

  it("continues draining the queue if an active turn fails with an error", async () => {
    await withConversationsDir(async (dir) => {
      const executedPrompts: string[] = [];
      let promptCount = 0;
      const spawnProcess: SpawnFactory = (_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        const promptIdx = args.indexOf("--print");
        const promptText = promptIdx >= 0 ? args[promptIdx + 1] : "";
        executedPrompts.push(promptText);

        promptCount++;
        const convId = `conv-fail-${promptCount}`;
        const db = createConversationDb(dir, convId);
        insertStep(db, { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: promptText }) });
        insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: `ans ${promptText}` }) });
        db.close();

        if (promptText === "failing prompt") {
          return new FakeProcess([], { exitCode: 1, stderr: "error" });
        }
        const proc = new ControlledFakeProcess();
        queueMicrotask(() => proc.finish(0));
        return proc as any;
      };

      const client = acpClient({ name: "test-client" }).onNotification(
        methods.client.session.update,
        () => {}
      );
      const connection = client.connect(
        createAcpApp({
          ...printModeOptions({ conversationsDir: dir }),
          spawnProcess
        })
      );
      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {}
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          mcpServers: []
        });

        const p1 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "failing prompt" }]
        });

        const p2 = connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "queued after failure" }],
          _meta: { "agy-acp/turnIntent": "queue" }
        } as any);

        await expect(p1).rejects.toThrow();

        const r2 = (await p2) as acp.PromptResponse;
        expect(r2.stopReason).toBe("end_turn");
        expect(executedPrompts).toEqual(["failing prompt", "queued after failure"]);
      } finally {
        connection.close();
      }
    });
  });
});
