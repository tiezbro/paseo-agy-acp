import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import * as installer from "../src/agy/installer.js";
import { client as acpClient, methods, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import {
  AcpAgent,
  type AcpAgentOptions,
  buildModelCatalog,
  createAcpApp,
  createAcpV2App,
  modelConfigOption,
  contentBlocksToText,
  reasoningEffortConfigOption,
  toModelSlug
} from "../src/agent.js";
import { configFromEnv, type AgyCliConfig, type PtyFactory, type SpawnFactory } from "../src/agy/cli.js";
import { createConversationDb, insertStep } from "./fixtures/conversation-db.js";
import { encodeCommandResult, encodeStepPayload, encodeToolCall, encodeToolRun } from "./fixtures/step-encoder.js";
import { createTerminalOutputTracker, createToolCallContentTracker, expandSessionUpdateToV2, sessionUpdateToV1, sessionUpdateToV2 } from "../src/acp/session/update-wire.js";
import { filterUpdatesForReplayFrom } from "../src/acp/session/setup.js";
import { turnsOf } from "../src/acp/session/turn-scheduler.js";
import { terminalIdForToolCall } from "../src/acp/terminal/index.js";
import { parseClientToolCallName } from "../src/acp/initialize.js";
import type { SessionConfigOption, SessionUpdate } from "@agentclientprotocol/sdk";

type SelectConfigOption = Extract<SessionConfigOption, { type: "select" }>;

/**
 * `available_commands_update` on session/new is deferred past the response
 * (via setImmediate) so real clients register the session before seeing a
 * notification for it. Await this once after session/new to drain that
 * notification before asserting on / resetting the `updates` array.
 */
function flushDeferredNotifications(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("contentBlocksToText", () => {
  it("joins text content blocks", () => {
    expect(contentBlocksToText([
      { type: "text", text: "first" },
      { type: "text", text: "second" }
    ])).toBe("first\nsecond");
  });
});

describe("initialize", () => {
  it("parses nested camel- and snake-case tool call name capabilities", () => {
    expect(parseClientToolCallName({ toolCall: { name: true } }, false)).toEqual({ name: true });
    expect(
      parseClientToolCallName({ capabilities: { tool_call: { name: false } } }, true)
    ).toEqual({ name: false });
  });

  it("returns SDK-validated ACP capabilities", async () => {
    const installSpy = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);
    const connection = acpClient({ name: "test-client" }).connect(createAcpApp());
    try {
      const response = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {}
      });

      expect(response.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(response.agentInfo?.name).toBe("agy-acp");
      expect(response.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(true);
      expect(response.agentCapabilities?.promptCapabilities?.image).toBe(true);
      expect(response.agentCapabilities?.sessionCapabilities?.additionalDirectories).toEqual({});
      expect(response.agentCapabilities?.auth?.logout).toEqual({});
      expect(response.agentCapabilities).not.toHaveProperty("terminal");
      expect(response.authMethods).toEqual([
        expect.objectContaining({ type: "terminal", id: "agy-login", args: ["--login"] })
      ]);
      expect(installSpy).toHaveBeenCalledOnce();
    } finally {
      installSpy.mockRestore();
      connection.close();
    }
  });
});

describe("authentication", () => {
  it("gates session/new with auth_required when agy is not logged in", async () => {
    vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);
    const spawnProcess = (_command: string, args: string[]) => {
      if (args[0] === "models") {
        return new FakeProcess([], {
          exitCode: 1,
          stderr: "error getting token source: You are not logged into Antigravity.\n"
        });
      }
      return new FakeProcess(["ok"]);
    };
    const connection = acpClient({ name: "test-client" }).connect(
      createAcpApp(printModeOptions({ spawnProcess: spawnProcess as unknown as SpawnFactory }))
    );
    try {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {}
      });
      await expect(
        connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          additionalDirectories: [],
          mcpServers: []
        })
      ).rejects.toMatchObject({
        code: -32000,
        message: expect.stringMatching(/Authentication required|not logged/i)
      });
    } finally {
      connection.close();
      vi.restoreAllMocks();
    }
  });

  it("authenticate succeeds when agy models lists models", async () => {
    vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);
    const spawnProcess = (_command: string, args: string[]) => {
      if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
      return new FakeProcess(["ok"]);
    };
    const connection = acpClient({ name: "test-client" }).connect(
      createAcpApp(printModeOptions({ spawnProcess: spawnProcess as unknown as SpawnFactory }))
    );
    try {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {}
      });
      await expect(
        connection.agent.request(methods.agent.authenticate, { methodId: "agy-login" })
      ).resolves.toEqual({});
    } finally {
      connection.close();
      vi.restoreAllMocks();
    }
  });

  it("logout sends /logout to an interactive agy PTY", async () => {
    vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);
    const writes: string[] = [];
    const spawnProcess = (_command: string, args: string[]) => {
      if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
      return new FakeProcess(["ok"]);
    };
    class LogoutPty {
      private dataListeners: Array<(data: string) => void> = [];
      private exitListeners: Array<(event: { exitCode: number }) => void> = [];
      write(data: string) {
        writes.push(data);
        queueMicrotask(() => {
          for (const listener of this.exitListeners) listener({ exitCode: 0 });
        });
      }
      kill() {
        for (const listener of this.exitListeners) listener({ exitCode: 0 });
      }
      onData(listener: (data: string) => void) {
        this.dataListeners.push(listener);
        queueMicrotask(() => listener("? for shortcuts"));
        return { dispose() {} };
      }
      onExit(listener: (event: { exitCode: number }) => void) {
        this.exitListeners.push(listener);
        return { dispose() {} };
      }
    }
    const connection = acpClient({ name: "test-client" }).connect(
      createAcpApp(
        printModeOptions({
          spawnProcess: spawnProcess as unknown as SpawnFactory,
          ptyFactory: { spawn: () => new LogoutPty() } as unknown as PtyFactory
        })
      )
    );
    try {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {}
      });
      await expect(connection.agent.request(methods.agent.logout, {})).resolves.toEqual({});
      expect(writes.some((w) => w.includes("/logout"))).toBe(true);
    } finally {
      connection.close();
      vi.restoreAllMocks();
    }
  });
});

describe("clientFileSystemV1", () => {
  type FsAgent = {
    clientFileSystemV1(
      client: { request: (...args: unknown[]) => Promise<unknown> },
      sessionId: string
    ): { readTextFile(path: string): Promise<void>; writeTextFile(path: string, content: string): Promise<void> } | undefined;
  };

  it("is undefined when the client doesn't advertise both fs capabilities", async () => {
    vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);
    const agent = new AcpAgent();
    await agent.initializeV1({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true } } });
    const bridge = (agent as unknown as FsAgent).clientFileSystemV1({ request: vi.fn() }, "s1");
    expect(bridge).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("routes read/write through client.request with fs/read_text_file and fs/write_text_file", async () => {
    vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);
    const agent = new AcpAgent();
    await agent.initializeV1({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
    });
    const request = vi.fn().mockResolvedValue({});
    const bridge = (agent as unknown as FsAgent).clientFileSystemV1({ request }, "s1")!;
    expect(bridge).toBeDefined();

    await bridge.readTextFile("/repo/a.txt");
    expect(request).toHaveBeenCalledWith(methods.client.fs.readTextFile, { sessionId: "s1", path: "/repo/a.txt" });

    await bridge.writeTextFile("/repo/a.txt", "new content");
    expect(request).toHaveBeenCalledWith(methods.client.fs.writeTextFile, {
      sessionId: "s1",
      path: "/repo/a.txt",
      content: "new content"
    });
    vi.restoreAllMocks();
  });
});

class FakePty {
  writes: string[] = [];
  killed = false;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number }) => void> = [];
  constructor(private readonly onSpawn?: (pty: FakePty) => void) {}
  start() {
    this.onSpawn?.(this);
    queueMicrotask(() => this.emitData("? for shortcuts"));
  }
  write(data: string) { this.writes.push(data); }
  kill() { this.killed = true; for (const listener of this.exitListeners) listener({ exitCode: 0 }); }
  onData(listener: (data: string) => void) { this.dataListeners.push(listener); return { dispose() {} }; }
  onExit(listener: (event: { exitCode: number }) => void) { this.exitListeners.push(listener); return { dispose() {} }; }
  emitData(data: string) { for (const listener of this.dataListeners) listener(data); }
}

describe("edit fs write-through (full ACP round trip)", () => {
  it("routes an already-applied edit through fs/read_text_file + fs/write_text_file instead of session/request_permission", async () => {
    await withConversationsDir(async (dir) => {
      const targetFile = path.join(dir, "target.txt");
      fs.writeFileSync(targetFile, "before\nNEW\nafter", "utf8");
      const rawInputJson = JSON.stringify({ TargetFile: targetFile, TargetContent: "OLD", ReplacementContent: "NEW" });

      const pty = new FakePty((self) => {
        const db = createConversationDb(dir, "fs-bridge-e2e");
        insertStep(db, {
          idx: 1,
          stepType: 5,
          status: 3,
          stepPayload: encodeStepPayload({
            toolRun: encodeToolRun({ call: encodeToolCall({ callId: "edit-1", namePrimary: "replace_file_content", rawInputJson }) })
          })
        });
        db.close();
        setTimeout(async () => {
          const Database = (await import("better-sqlite3")).default;
          const db2 = new Database(path.join(dir, "fs-bridge-e2e.db"));
          insertStep(db2, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
          db2.close();
          self.emitData("? for shortcuts");
        }, 300);
      });

      const readCalls: string[] = [];
      const writeCalls: Array<{ path: string; content: string }> = [];
      let permissionCalls = 0;

      const testClient = acpClient({ name: "test-client" })
        .onRequest(methods.client.fs.readTextFile, (ctx) => {
          readCalls.push(ctx.params.path);
          return { content: fs.readFileSync(ctx.params.path, "utf8") };
        })
        .onRequest(methods.client.fs.writeTextFile, (ctx) => {
          writeCalls.push({ path: ctx.params.path, content: ctx.params.content });
          fs.writeFileSync(ctx.params.path, ctx.params.content, "utf8");
          return {};
        })
        .onRequest(methods.client.session.requestPermission, () => {
          permissionCalls++;
          return { outcome: { outcome: "selected", optionId: "allow-once" } };
        })
        .onNotification(methods.client.session.update, () => {});

      const connection = testClient.connect(createAcpApp({
        conversationsDir: dir,
        stateDir: dir,
        spawnProcess: ((_command: string, args: string[]) => {
          if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
          return new FakeProcess([]);
        }) as unknown as SpawnFactory,
        ptyFactory: { spawn: () => { pty.start(); return pty; } } as unknown as PtyFactory
      }));

      try {
        await connection.agent.request(methods.agent.initialize, {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
        });
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: dir,
          additionalDirectories: [],
          mcpServers: []
        });

        const response = await connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "edit it" }]
        });

        expect(response.stopReason).toBe("end_turn");
        expect(permissionCalls).toBe(0);
        expect(readCalls).toEqual([targetFile]);
        expect(writeCalls).toEqual([{ path: targetFile, content: "before\nNEW\nafter" }]);
        expect(fs.readFileSync(targetFile, "utf8")).toBe("before\nNEW\nafter");
      } finally {
        connection.close();
      }
    });
  });
});

describe("session prompt", () => {
  it("streams agy's conversation database as ACP message chunks", async () => {
    await withConversationsDir(async (dir) => {
      const updates: unknown[] = [];
      const client = acpClient({ name: "test-client" })
        .onNotification(methods.client.session.update, (ctx) => {
          updates.push(ctx.params.update);
        });
      const connection = client.connect(createAcpApp({
        ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
        spawnProcess: spawnAgyWritingConversation(dir, "conv-1", [
          { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "hello" }) }
        ])
      }));
      try {
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          additionalDirectories: [],
          mcpServers: []
        });
        await flushDeferredNotifications();
        updates.length = 0;
        const response = await connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hi" }]
        });

        expect(updates[0]).toMatchObject({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" }
        });
        expect(response.stopReason).toBe("end_turn");
      } finally {
        connection.close();
      }
    });
  });

  it("renders a structured tool-run step as an ACP tool_call", async () => {
    await withConversationsDir(async (dir) => {
      const updates: unknown[] = [];
      const client = acpClient({ name: "test-client" })
        .onNotification(methods.client.session.update, (ctx) => {
          updates.push(ctx.params.update);
        });
      const connection = client.connect(createAcpApp({
        ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
        spawnProcess: spawnAgyWritingConversation(dir, "conv-2", [
          {
            idx: 1,
            stepType: 21,
            stepPayload: encodeStepPayload({
              toolRun: encodeToolRun({
                call: encodeToolCall({ namePrimary: "run_command", rawInputJson: '{"CommandLine":"echo hi"}' })
              })
            })
          },
          { idx: 2, stepType: 15, stepPayload: encodeStepPayload({ agentText: "done" }) }
        ])
      }));
      try {
        const session = await connection.agent.request(methods.agent.session.new, {
          cwd: "/repo",
          additionalDirectories: [],
          mcpServers: []
        });
        await flushDeferredNotifications();
        updates.length = 0;
        const response = await connection.agent.request(methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hi" }]
        });

        expect(updates).toMatchObject([
          {
            sessionUpdate: "tool_call",
            kind: "execute",
            title: "echo hi",
            status: "completed"
          },
          {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "done" }
          }
        ]);
        expect(response.stopReason).toBe("end_turn");
      } finally {
        connection.close();
      }
    });
  });
});

describe("session/load and session/resume", () => {
  it("replays prior conversation history on load, but not on resume, after a simulated restart", async () => {
    await withConversationsDir(async (dir) => {
      const appOptions = {
        ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
        spawnProcess: spawnAgyWritingConversation(dir, "conv-persisted", [
          {
            idx: 1,
            stepType: 8,
            stepPayload: encodeStepPayload({
              toolRun: encodeToolRun({
                call: encodeToolCall({
                  callId: "replayed-view",
                  namePrimary: "view_file",
                  rawInputJson: '{"AbsolutePath":"/repo/README.md"}'
                })
              })
            })
          },
          { idx: 2, stepType: 15, stepPayload: encodeStepPayload({ agentText: "hello from before" }) }
        ])
      };

      // First "process": create a session, run a prompt, then disconnect —
      // simulating the ACP client reconnecting to a fresh server instance.
      let sessionId: string;
      {
        const connection = acpClient({ name: "test-client" }).connect(createAcpApp(appOptions));
        try {
          const session = await connection.agent.request(methods.agent.session.new, {
            cwd: "/repo",
            additionalDirectories: [],
            mcpServers: []
          });
          sessionId = session.sessionId;
          await connection.agent.request(methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: "hi" }]
          });
        } finally {
          connection.close();
        }
      }

      // session/load: a brand-new AcpAgent (no in-memory state) should
      // restore the binding from disk and replay the prior turn.
      {
        const updates: unknown[] = [];
        const client = acpClient({ name: "test-client" })
          .onNotification(methods.client.session.update, (ctx) => {
            updates.push(ctx.params.update);
          });
        const connection = client.connect(createAcpApp(appOptions));
        try {
          await connection.agent.request(methods.agent.initialize, {
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {}
          });
          const response = await connection.agent.request(methods.agent.session.load, {
            sessionId,
            cwd: "/repo",
            mcpServers: []
          });
          expect(updates).toContainEqual(
            expect.objectContaining({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hello from before" }
            })
          );
          const replayedToolCall = updates.find(
            (update) =>
              (update as { sessionUpdate?: string; toolCallId?: string }).sessionUpdate === "tool_call" &&
              (update as { toolCallId?: string }).toolCallId === "replayed-view"
          );
          expect(replayedToolCall).toMatchObject({
            sessionUpdate: "tool_call",
            title: "Read README.md"
          });
          expect(replayedToolCall).not.toHaveProperty("name");
          expect(updates).toContainEqual(
            expect.objectContaining({ sessionUpdate: "available_commands_update" })
          );
          expect(response.configOptions?.length).toBeGreaterThan(0);
        } finally {
          connection.close();
        }
      }

      // session/resume: same restoration, but no history replay.
      {
        const updates: unknown[] = [];
        const client = acpClient({ name: "test-client" })
          .onNotification(methods.client.session.update, (ctx) => {
            updates.push(ctx.params.update);
          });
        const connection = client.connect(createAcpApp(appOptions));
        try {
          const response = await connection.agent.request(methods.agent.session.resume, {
            sessionId,
            cwd: "/repo"
          });
          // Resume does not replay history; it still advertises slash commands.
          expect(updates).toEqual([
            expect.objectContaining({ sessionUpdate: "available_commands_update" })
          ]);
          expect(response.configOptions?.length).toBeGreaterThan(0);
        } finally {
          connection.close();
        }
      }
    });
  });

  it("lists persisted sessions after a restart", async () => {
    await withConversationsDir(async (dir) => {
      const appOptions = {
        ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
        spawnProcess: spawnAgyWritingConversation(dir, "conv-list", [
          { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "listed" }) }
        ])
      };

      let sessionId: string;
      {
        const connection = acpClient({ name: "test-client" }).connect(createAcpApp(appOptions));
        try {
          const session = await connection.agent.request(methods.agent.session.new, {
            cwd: "/repo",
            additionalDirectories: ["/extra"],
            mcpServers: []
          });
          sessionId = session.sessionId;
          await connection.agent.request(methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: "hi" }]
          });
        } finally {
          connection.close();
        }
      }

      {
        const connection = acpClient({ name: "test-client" }).connect(createAcpApp(appOptions));
        try {
          const listed = await connection.agent.request(methods.agent.session.list, {
            cwd: "/repo"
          });
          expect(listed.sessions).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                sessionId,
                cwd: "/repo",
                additionalDirectories: ["/extra"]
              })
            ])
          );
        } finally {
          connection.close();
        }
      }
    });
  });

  it("deletes a persisted session via session/delete (ACP v1 & v2)", async () => {
    await withConversationsDir(async (dir) => {
      const appOptions = {
        ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
        spawnProcess: spawnAgyWritingConversation(dir, "conv-delete-1", [
          { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "world" }) }
        ])
      };

      let sessionId: string;
      {
        const connection = acpClient({ name: "test-client" }).connect(createAcpApp(appOptions));
        try {
          const session = await connection.agent.request(methods.agent.session.new, {
            cwd: "/repo",
            additionalDirectories: [],
            mcpServers: []
          });
          sessionId = session.sessionId;
          await connection.agent.request(methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: "hi" }]
          });
        } finally {
          connection.close();
        }
      }

      // Verify it appears in list
      {
        const connection = acpClient({ name: "test-client" }).connect(createAcpApp(appOptions));
        try {
          const listed = await connection.agent.request(methods.agent.session.list, { cwd: "/repo" });
          expect(listed.sessions.some((s) => s.sessionId === sessionId)).toBe(true);

          // Delete session via ACP v1
          const response = await connection.agent.request(methods.agent.session.delete, { sessionId });
          expect(response).toEqual({});

          // Verify list no longer contains the session
          const listedAfter = await connection.agent.request(methods.agent.session.list, { cwd: "/repo" });
          expect(listedAfter.sessions.some((s) => s.sessionId === sessionId)).toBe(false);
        } finally {
          connection.close();
        }
      }

      // Verify loading the deleted session rejects
      {
        const connection = acpClient({ name: "test-client" }).connect(createAcpApp(appOptions));
        try {
          await expect(
            connection.agent.request(methods.agent.session.load, {
              sessionId,
              cwd: "/repo",
              mcpServers: []
            })
          ).rejects.toThrow();
        } finally {
          connection.close();
        }
      }
    });
  });

  it("rejects loading a session that was never persisted", async () => {
    await withConversationsDir(async (dir) => {
      const connection = acpClient({ name: "test-client" }).connect(createAcpApp({
        ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
        spawnProcess: spawnAgyWritingConversation(dir, "unused", [])
      }));
      try {
        await expect(
          connection.agent.request(methods.agent.session.load, {
            sessionId: "does-not-exist",
            cwd: "/repo",
            mcpServers: []
          })
        ).rejects.toThrow();
      } finally {
        connection.close();
      }
    });
  });
});

describe("toModelSlug", () => {
  it("converts agy display names to lowercase hyphenated slugs", () => {
    expect(toModelSlug("Gemini 3.5 Flash")).toBe("gemini-3.5-flash");
    expect(toModelSlug("Claude Sonnet 4.6 (Thinking)")).toBe("claude-sonnet-4.6-thinking");
    expect(toModelSlug("GPT-OSS 120B")).toBe("gpt-oss-120b");
    expect(toModelSlug("gemini-3.5-flash-medium")).toBe("gemini-3.5-flash-medium");
  });
});

describe("buildModelCatalog", () => {
  it("splits effort from modern stable model slugs", () => {
    const catalog = buildModelCatalog([
      "gemini-3.5-flash-medium",
      "gemini-3.5-flash-high",
      "claude-opus-4-6-thinking",
      "claude-sonnet-4-6",
      "gpt-oss-120b-medium"
    ]);

    expect(catalog.baseModels()).toEqual([
      "gemini-3.5-flash",
      "claude-opus-4-6-thinking",
      "claude-sonnet-4-6",
      "gpt-oss-120b"
    ]);
    expect(catalog.effortsFor("gemini-3.5-flash")).toEqual(["medium", "high"]);
    expect(catalog.effortsFor("claude-opus-4-6-thinking")).toEqual([]);
    expect(catalog.effortsFor("claude-sonnet-4-6")).toEqual([]);
    expect(catalog.effortsFor("gpt-oss-120b")).toEqual(["medium"]);
    expect(catalog.resolve("gemini-3.5-flash", "medium")).toBe("gemini-3.5-flash-medium");
    expect(catalog.split("gemini-3.5-flash-high")).toEqual({
      base: "gemini-3.5-flash",
      reasoningEffort: "high"
    });
    expect(catalog.agyBaseName("gemini-3.5-flash")).toBe("gemini-3.5-flash");
    expect(catalog.displayName("gemini-3.5-flash")).toBe("Gemini 3.5 Flash");
  });

  it("keeps -thinking slug models intact instead of treating thinking as effort", () => {
    const catalog = buildModelCatalog([
      "gemini-3.5-flash-medium",
      "claude-opus-4-6-thinking",
      "claude-sonnet-4-6"
    ]);

    expect(catalog.split("claude-opus-4-6-thinking")).toEqual({
      base: "claude-opus-4-6-thinking"
    });
    expect(catalog.effortsFor("claude-opus-4-6-thinking")).toEqual([]);
    const reasoningConfig = reasoningEffortConfigOption(
      "claude-opus-4-6-thinking",
      "none",
      catalog
    ) as SelectConfigOption;
    expect(reasoningConfig.options).toEqual([{ value: "none", name: "N/A" }]);
  });

  it("still splits legacy display-name model lists", () => {
    const catalog = buildModelCatalog([
      "Gemini 3.5 Flash (Medium)",
      "Gemini 3.5 Flash (High)",
      "Claude Sonnet 4.6 (Thinking)"
    ]);

    expect(catalog.baseModels()).toEqual([
      "gemini-3.5-flash",
      "claude-sonnet-4.6-thinking"
    ]);
    expect(catalog.effortsFor("gemini-3.5-flash")).toEqual(["medium", "high"]);
    expect(catalog.agyBaseName("gemini-3.5-flash")).toBe("Gemini 3.5 Flash");
    expect(catalog.resolve("gemini-3.5-flash", "medium")).toBe("Gemini 3.5 Flash (Medium)");
  });

  it("exposes mode, model, and reasoningEffort config options", () => {
    const catalog = buildModelCatalog(["gemini-3.5-flash-medium", "gemini-3.5-flash-high"]);
    const modelConfig = modelConfigOption("gemini-3.5-flash", catalog) as SelectConfigOption;
    const reasoningConfig = reasoningEffortConfigOption(
      "gemini-3.5-flash",
      "medium",
      catalog
    ) as SelectConfigOption;

    expect(modelConfig.id).toBe("model");
    expect(modelConfig.name).toBe("Model");
    expect(reasoningConfig.id).toBe("reasoningEffort");
    expect(reasoningConfig.name).toBe("Reasoning Effort");
    expect(modelConfig.options).toEqual([
      { value: "gemini-3.5-flash", name: "Gemini 3.5 Flash" }
    ]);
    expect(reasoningConfig.options).toEqual([
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" }
    ]);
  });
});

describe("model discovery cache", () => {
  it("reuses discovered models in memory and across agent instances", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-model-cache-"));
    let modelCalls = 0;
    const spawnProcess = (_command: string, args: string[]) => {
      if (args[0] === "models") {
        modelCalls++;
        return new FakeProcess([TEST_MODELS_OUTPUT]);
      }
      return new FakeProcess(["ok"]);
    };
    const config = configFromEnv({ cwd: "/repo" });
    type ModelCacheAgent = {
      modelOptionsForConfig(config: AgyCliConfig): Promise<string[]>;
    };

    try {
      const first = new AcpAgent({
        stateDir,
        modelCacheEnabled: true,
        spawnProcess: spawnProcess as unknown as SpawnFactory
      });
      const firstModels = await (first as unknown as ModelCacheAgent).modelOptionsForConfig(config);
      const secondModels = await (first as unknown as ModelCacheAgent).modelOptionsForConfig(config);
      expect(firstModels).toEqual(secondModels);
      expect(modelCalls).toBe(1);

      await waitFor(() => fs.existsSync(path.join(stateDir, "models.json")));
      const restored = new AcpAgent({
        stateDir,
        modelCacheEnabled: true,
        spawnProcess: spawnProcess as unknown as SpawnFactory
      });
      await expect(
        (restored as unknown as ModelCacheAgent).modelOptionsForConfig(config)
      ).resolves.toEqual(firstModels);
      expect(modelCalls).toBe(1);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

describe("active session retention", () => {
  it("evicts and closes the least recently used inactive session", async () => {
    const agent = new AcpAgent({
      maxActiveSessions: 2
    });
    const close1 = vi.fn(async () => {});
    const close2 = vi.fn(async () => {});
    const close3 = vi.fn(async () => {});
    const session = (id: string, close: () => Promise<void>) => ({
      sessionId: id,
      promptQueue: [],
      agy: { close }
    });
    type SessionRetentionAgent = {
      registerSession(id: string, session: unknown): Promise<void>;
      requireSession(id: string): unknown;
    };
    const retention = agent as unknown as SessionRetentionAgent;

    await retention.registerSession("s1", session("s1", close1));
    await retention.registerSession("s2", session("s2", close2));
    retention.requireSession("s1");
    await retention.registerSession("s3", session("s3", close3));

    expect(close1).not.toHaveBeenCalled();
    expect(close2).toHaveBeenCalledOnce();
    expect(close3).not.toHaveBeenCalled();
    expect(() => retention.requireSession("s2")).toThrow("Unknown session");
  });

  it("does not evict a session reserved by a steer", async () => {
    const agent = new AcpAgent({
      maxActiveSessions: 2
    });
    const close1 = vi.fn(async () => {});
    const close2 = vi.fn(async () => {});
    const close3 = vi.fn(async () => {});
    const session = (id: string, close: () => Promise<void>, reserved = false) => {
      const state = { sessionId: id, promptQueue: [], agy: { close } };
      if (reserved) turnsOf(state as any).reserveSteer();
      return state;
    };
    type SessionRetentionAgent = {
      registerSession(id: string, session: unknown): Promise<void>;
      requireSession(id: string): unknown;
    };
    const retention = agent as unknown as SessionRetentionAgent;

    await retention.registerSession("s1", session("s1", close1, true));
    await retention.registerSession("s2", session("s2", close2));
    await retention.registerSession("s3", session("s3", close3));

    expect(close1).not.toHaveBeenCalled();
    expect(close2).toHaveBeenCalledOnce();
    expect(close3).not.toHaveBeenCalled();
    expect(() => retention.requireSession("s1")).not.toThrow();
    expect(() => retention.requireSession("s2")).toThrow("Unknown session");
  });
});

describe("session modes and config option sync", () => {
  it("advertises modes on session/new and keeps set_mode dual-synced with config", async () => {
    const spawnProcess = (command: string, args: string[]) => {
      if (args[0] === "models") {
        return new FakeProcess([TEST_MODELS_OUTPUT]);
      }
      return new FakeProcess(["ok"]);
    };
    const updates: Array<Record<string, unknown>> = [];
    const client = acpClient({ name: "test-client" }).onNotification(
      methods.client.session.update,
      (ctx) => {
        updates.push(ctx.params.update as Record<string, unknown>);
      }
    );
    const connection = client.connect(
      createAcpApp(printModeOptions({ spawnProcess: spawnProcess as unknown as SpawnFactory }))
    );
    try {
      const session = await connection.agent.request(methods.agent.session.new, {
        cwd: "/repo",
        additionalDirectories: [],
        mcpServers: []
      });

      expect(session.modes).toEqual({
        currentModeId: "default",
        availableModes: [
          {
            id: "default",
            name: "Default",
            description: "Request review before file writes (agy default; omits --mode)."
          },
          {
            id: "accept-edits",
            name: "Accept Edits",
            description: "Apply file edits without interactive write review (agy --mode accept-edits)."
          },
          {
            id: "plan",
            name: "Plan",
            description: "Plan-oriented execution (agy --mode plan)."
          },
          {
            id: "dangerously-skip-permissions",
            name: "Dangerously Skip Permissions",
            description: "Auto-approve all tool permission requests without prompting (agy --dangerously-skip-permissions)."
          }
        ]
      });
      expect(session.configOptions?.[0]).toMatchObject({
        id: "mode",
        currentValue: "default"
      });

      updates.length = 0;
      await connection.agent.request(methods.agent.session.setMode, {
        sessionId: session.sessionId,
        modeId: "plan"
      });

      expect(updates).toEqual(
        expect.arrayContaining([
          { sessionUpdate: "current_mode_update", currentModeId: "plan" },
          expect.objectContaining({
            sessionUpdate: "config_option_update",
            configOptions: expect.arrayContaining([
              expect.objectContaining({ id: "mode", currentValue: "plan" })
            ])
          })
        ])
      );
      expect(updates.filter((u) => u.sessionUpdate === "current_mode_update")).toHaveLength(1);
      expect(updates.filter((u) => u.sessionUpdate === "config_option_update")).toHaveLength(1);

      updates.length = 0;
      const modeViaConfig = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: "mode",
        value: "accept-edits"
      });
      expect(modeViaConfig.configOptions[0].currentValue).toBe("accept-edits");
      // ACP transition: both legacy current_mode_update and out-of-band config_option_update are sent.
      expect(updates).toEqual(
        expect.arrayContaining([
          { sessionUpdate: "current_mode_update", currentModeId: "accept-edits" },
          expect.objectContaining({ sessionUpdate: "config_option_update" })
        ])
      );
      expect(updates.some((u) => u.sessionUpdate === "current_mode_update")).toBe(true);

      updates.length = 0;
      await connection.agent.request(methods.agent.session.setMode, {
        sessionId: session.sessionId,
        modeId: "accept-edits"
      });
      // Same mode: no redundant notifications.
      expect(updates).toEqual([]);
    } finally {
      connection.close();
    }
  });

  it("rejects unknown mode ids on session/set_mode", async () => {
    const spawnProcess = (_command: string, args: string[]) => {
      if (args[0] === "models") {
        return new FakeProcess([TEST_MODELS_OUTPUT]);
      }
      return new FakeProcess(["ok"]);
    };
    const connection = acpClient({ name: "test-client" }).connect(
      createAcpApp(printModeOptions({ spawnProcess: spawnProcess as unknown as SpawnFactory }))
    );
    try {
      const session = await connection.agent.request(methods.agent.session.new, {
        cwd: "/repo",
        additionalDirectories: [],
        mcpServers: []
      });
      await expect(
        connection.agent.request(methods.agent.session.setMode, {
          sessionId: session.sessionId,
          modeId: "architect"
        })
      ).rejects.toThrow();
    } finally {
      connection.close();
    }
  });
});

describe("available_commands_update and slash commands", () => {
  it("advertises curated commands on session/new", async () => {
    const spawnProcess = (_command: string, args: string[]) => {
      if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
      return new FakeProcess(["ok"]);
    };
    const updates: Array<Record<string, unknown>> = [];
    const client = acpClient({ name: "test-client" }).onNotification(
      methods.client.session.update,
      (ctx) => {
        updates.push(ctx.params.update as Record<string, unknown>);
      }
    );
    const connection = client.connect(
      createAcpApp(printModeOptions({ spawnProcess: spawnProcess as unknown as SpawnFactory }))
    );
    try {
      await connection.agent.request(methods.agent.session.new, {
        cwd: "/repo",
        additionalDirectories: [],
        mcpServers: []
      });
      await flushDeferredNotifications();

      const commandUpdate = updates.find((u) => u.sessionUpdate === "available_commands_update");
      expect(commandUpdate).toMatchObject({
        sessionUpdate: "available_commands_update",
        availableCommands: expect.arrayContaining([
          expect.objectContaining({ name: "mode" }),
          expect.objectContaining({ name: "plan" }),
          expect.objectContaining({ name: "model" }),
          expect.objectContaining({ name: "effort" })
        ])
      });
    } finally {
      connection.close();
    }
  });

  it("handles /mode and /plan via prompt without spawning agy", async () => {
    const spawnCalls: string[][] = [];
    const spawnProcess = (_command: string, args: string[]) => {
      spawnCalls.push(args);
      if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
      return new FakeProcess(["should-not-run"]);
    };
    const updates: Array<Record<string, unknown>> = [];
    const client = acpClient({ name: "test-client" }).onNotification(
      methods.client.session.update,
      (ctx) => {
        updates.push(ctx.params.update as Record<string, unknown>);
      }
    );
    const connection = client.connect(
      createAcpApp(printModeOptions({ spawnProcess: spawnProcess as unknown as SpawnFactory }))
    );
    try {
      const session = await connection.agent.request(methods.agent.session.new, {
        cwd: "/repo",
        additionalDirectories: [],
        mcpServers: []
      });
      spawnCalls.length = 0;
      updates.length = 0;

      const response = await connection.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "/plan" }]
      });
      expect(response.stopReason).toBe("end_turn");
      expect(spawnCalls).toEqual([]);
      expect(updates).toEqual(
        expect.arrayContaining([
          { sessionUpdate: "current_mode_update", currentModeId: "plan" },
          expect.objectContaining({
            sessionUpdate: "config_option_update",
            configOptions: expect.arrayContaining([
              expect.objectContaining({ id: "mode", currentValue: "plan" })
            ])
          })
        ])
      );

      updates.length = 0;
      await connection.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "/mode accept-edits" }]
      });
      expect(updates).toEqual(
        expect.arrayContaining([
          { sessionUpdate: "current_mode_update", currentModeId: "accept-edits" },
          expect.objectContaining({
            sessionUpdate: "config_option_update",
            configOptions: expect.arrayContaining([
              expect.objectContaining({ id: "mode", currentValue: "accept-edits" })
            ])
          })
        ])
      );
    } finally {
      connection.close();
    }
  });

  it("handles /effort via prompt", async () => {
    const spawnProcess = (_command: string, args: string[]) => {
      if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
      return new FakeProcess(["should-not-run"]);
    };
    const updates: Array<Record<string, unknown>> = [];
    const client = acpClient({ name: "test-client" }).onNotification(
      methods.client.session.update,
      (ctx) => {
        updates.push(ctx.params.update as Record<string, unknown>);
      }
    );
    const connection = client.connect(
      createAcpApp(printModeOptions({ spawnProcess: spawnProcess as unknown as SpawnFactory }))
    );
    try {
      const session = await connection.agent.request(methods.agent.session.new, {
        cwd: "/repo",
        additionalDirectories: [],
        mcpServers: []
      });
      updates.length = 0;

      await connection.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "/effort high" }]
      });

      expect(updates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionUpdate: "config_option_update",
            configOptions: expect.arrayContaining([
              expect.objectContaining({ id: "reasoningEffort", currentValue: "high" })
            ])
          })
        ])
      );
    } finally {
      connection.close();
    }
  });
});

describe("session model config", () => {
  it("updates agy --model and --effort for later prompts", async () => {
    const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
    const spawnProcess = (command: string, args: string[], options: unknown) => {
      calls.push({ command, args, options });
      if (args[0] === "models") {
        return new FakeProcess([TEST_MODELS_OUTPUT]);
      }
      return new FakeProcess(["ok"]);
    };
    const updates: Array<{ content: { text: string } }> = [];
    const client = acpClient({ name: "test-client" })
      .onNotification(methods.client.session.update, (ctx) => {
        updates.push(ctx.params.update as { content: { text: string } });
      });
    const connection = client.connect(createAcpApp(printModeOptions({ spawnProcess: spawnProcess as unknown as SpawnFactory })));
    try {
      const session = await connection.agent.request(methods.agent.session.new, {
        cwd: "/repo",
        additionalDirectories: [],
        mcpServers: []
      });
      const configOptions = session.configOptions ?? [];
      expect(configOptions.map((option) => option.id)).toEqual(["mode", "model", "reasoningEffort"]);
      expect(configOptions.map((option) => option.name)).toEqual(["Mode", "Model", "Reasoning Effort"]);

      const modeConfig = configOptions[0] as SelectConfigOption;
      const modelConfig = configOptions[1] as SelectConfigOption;
      const reasoningConfig = configOptions[2] as SelectConfigOption;

      expect(modeConfig.category).toBe("mode");
      expect(modeConfig.currentValue).toBe("default");
      expect(optionValues(modeConfig)).toEqual(["default", "accept-edits", "plan", "dangerously-skip-permissions"]);

      expect(modelConfig.category).toBe("model");
      expect(modelConfig.currentValue).toBe("gemini-3.5-flash");
      expect(modelConfig.options).toEqual([
        { value: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
        { value: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 Thinking" },
        { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }
      ]);

      expect(reasoningConfig.category).toBe("thought_level");
      expect(reasoningConfig.currentValue).toBe("medium");
      expect(reasoningConfig.options).toEqual([
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" }
      ]);
      expect(configOptions.find((option) => option.id === "effort" || option.id === "fast-mode")).toBeUndefined();

      const modelResponse = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: "model",
        value: "gemini-3.5-flash"
      });
      expect(modelResponse.configOptions.map((option) => option.id)).toEqual([
        "mode",
        "model",
        "reasoningEffort"
      ]);
      expect(modelResponse.configOptions[1].currentValue).toBe("gemini-3.5-flash");
      expect(modelResponse.configOptions[2].currentValue).toBe("medium");
      expect(optionValues(modelResponse.configOptions[2] as SelectConfigOption)).toEqual(["medium", "high"]);

      const reasoningResponse = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: "reasoningEffort",
        value: "high"
      });
      expect(reasoningResponse.configOptions[2].currentValue).toBe("high");

      const modeResponse = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: "mode",
        value: "dangerously-skip-permissions"
      });
      expect(modeResponse.configOptions[0].currentValue).toBe("dangerously-skip-permissions");

      const thinkingResponse = await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: "model",
        value: "claude-opus-4-6-thinking"
      });
      expect(thinkingResponse.configOptions[1].currentValue).toBe("claude-opus-4-6-thinking");
      expect(thinkingResponse.configOptions[2].currentValue).toBe("none");
      expect(optionNames(thinkingResponse.configOptions[2] as SelectConfigOption)).toEqual(["N/A"]);

      await connection.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hi" }]
      });

      const promptCall = calls.find((call) => call.args.includes("--print"));
      expect(promptCall?.args[promptCall.args.indexOf("--print") + 1]).toBe("hi");
      expect(flagValue(promptCall!.args, "--model")).toBe("claude-opus-4-6-thinking");
      expect(promptCall!.args).not.toContain("--effort");
      expect(promptCall!.args).toContain("--dangerously-skip-permissions");
      expect(promptCall!.args).not.toContain("--mode");
    } finally {
      connection.close();
    }
  });

  it("passes --effort for models with effort variants", async () => {
    const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
    const spawnProcess = (command: string, args: string[], options: unknown) => {
      calls.push({ command, args, options });
      if (args[0] === "models") {
        return new FakeProcess([TEST_MODELS_OUTPUT]);
      }
      return new FakeProcess(["ok"]);
    };
    const connection = acpClient({ name: "test-client" }).connect(
      createAcpApp(printModeOptions({ spawnProcess: spawnProcess as unknown as SpawnFactory }))
    );
    try {
      const session = await connection.agent.request(methods.agent.session.new, {
        cwd: "/repo",
        additionalDirectories: [],
        mcpServers: []
      });
      await connection.agent.request(methods.agent.session.setConfigOption, {
        sessionId: session.sessionId,
        configId: "reasoningEffort",
        value: "high"
      });
      await connection.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hi" }]
      });
      const promptCall = calls.find((call) => call.args.includes("--print"));
      expect(flagValue(promptCall!.args, "--model")).toBe("gemini-3.5-flash");
      expect(flagValue(promptCall!.args, "--effort")).toBe("high");
    } finally {
      connection.close();
    }
  });
});

describe("ACP v2 (experimental draft)", () => {
  it("negotiates protocolVersion 2 with role-agnostic info/capabilities", async () => {
    const installSpy = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);
    const connection = acpV2.client({ name: "test-client" }).connect(createAcpV2App());
    try {
      const response = await connection.agent.request(acpV2.methods.agent.initialize, {
        protocolVersion: acpV2.PROTOCOL_VERSION,
        info: { name: "test-client", version: "0.0.0" },
        capabilities: {}
      });

      expect(response.protocolVersion).toBe(2);
      expect(response.info.name).toBe("agy-acp");
      expect(response.capabilities?.session?.prompt?.image).toEqual({});
      expect(response.capabilities?.session?.prompt?.embeddedContext).toEqual({});
      expect(response.capabilities?.session?.additionalDirectories).toEqual({});
      expect(response.capabilities).not.toHaveProperty("terminal");
      expect(installSpy).toHaveBeenCalledOnce();
    } finally {
      installSpy.mockRestore();
      connection.close();
    }
  });

  it("accepts session/prompt immediately and reports idle via state_update", async () => {
    await withConversationsDir(async (dir) => {
      const updates: unknown[] = [];
      const client = acpV2.client({ name: "test-client" }).onNotification(
        acpV2.methods.client.session.update,
        (ctx) => {
          updates.push(ctx.params.update);
        }
      );
      const connection = client.connect(
        createAcpV2App({
          ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
          spawnProcess: spawnAgyWritingConversation(dir, "conv-v2-1", [
            { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "hello v2" }) }
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
        const response = await connection.agent.request(acpV2.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hi" }]
        });

        // v2 prompt response is an empty acceptance ack (no stopReason).
        expect(response).toEqual({});

        await waitFor(() => updates.some((u) => (u as { state?: string }).state === "idle"));

        expect(updates).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              sessionUpdate: "user_message",
              content: [{ type: "text", text: "hi" }]
            }),
            expect.objectContaining({ sessionUpdate: "state_update", state: "running" }),
            expect.objectContaining({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hello v2" },
              messageId: expect.any(String)
            }),
            expect.objectContaining({
              sessionUpdate: "state_update",
              state: "idle",
              stopReason: "end_turn"
            })
          ])
        );
      } finally {
        connection.close();
      }
    });
  });

  it("does not resurrect a deleted session when an in-flight prompt finishes after session/delete (gh#77)", async () => {
    await withConversationsDir(async (dir) => {
      const client = acpV2.client({ name: "test-client" });
      const connection = client.connect(
        createAcpV2App({
          ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
          spawnProcess: spawnAgyWritingConversation(dir, "conv-resurrect-77", [
            { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "done" }) }
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
        const sessionId = session.sessionId;

        await connection.agent.request(acpV2.methods.agent.session.prompt, {
          sessionId,
          prompt: [{ type: "text", text: "hi" }]
        });

        // Delete session immediately while prompt turn is floating in background
        await connection.agent.request(acpV2.methods.agent.session.delete, { sessionId });

        // Allow floating turn task to finish or error out
        await new Promise((resolve) => setTimeout(resolve, 300));

        // Verify session was deleted from disk and NOT resurrected
        const listed = await connection.agent.request(acpV2.methods.agent.session.list, { cwd: "/repo" });
        expect(listed.sessions.some((s) => s.sessionId === sessionId)).toBe(false);

        await expect(
          connection.agent.request(acpV2.methods.agent.session.resume, {
            sessionId,
            cwd: "/repo"
          })
        ).rejects.toThrow();
      } finally {
        connection.close();
      }
    });
  });

  it("keeps curated slash command IDs out of the DB step namespace", async () => {
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
          spawnProcess: spawnAgyWritingConversation(dir, "conv-v2-slash-id", [
            { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: "hi" }) }
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

        await connection.agent.request(acpV2.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "/plan" }]
        });
        await waitFor(() => updates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"));
        const slashMessage = updates.find((u) => u.sessionUpdate === "user_message");
        expect(slashMessage?.messageId).toMatch(/^slash-[0-9a-f-]{36}$/);

        updates.length = 0;
        await connection.agent.request(acpV2.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hi" }]
        });
        await waitFor(() => updates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"));
        const ordinaryMessage = updates.find((u) => u.sessionUpdate === "user_message");
        expect(ordinaryMessage?.messageId).toMatch(/^user-[0-9a-f-]{36}$/);
        expect(ordinaryMessage?.messageId).not.toBe(slashMessage?.messageId);
      } finally {
        connection.close();
      }
    });
  });

  it("does not reuse a v2 user message ID after a prompt fails before persistence", async () => {
    await withConversationsDir(async (dir) => {
      let promptAttempts = 0;
      const spawnProcess = ((_command: string, args: string[]) => {
        if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
        promptAttempts++;
        if (promptAttempts === 1) {
          return new FakeProcess([], { exitCode: 1, stderr: "prompt failed" });
        }
        const db = createConversationDb(dir, "conv-v2-after-failure");
        insertStep(db, {
          idx: 7,
          stepType: 14,
          stepPayload: encodeStepPayload({ userPrompt: "second prompt" })
        });
        db.close();
        return new FakeProcess([]);
      }) as unknown as SpawnFactory;
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
          spawnProcess
        })
      );
      try {
        await connection.agent.request(acpV2.methods.agent.initialize, {
          protocolVersion: 2,
          info: { name: "test-client", version: "0.0.0" },
          capabilities: {}
        });
        const session = await connection.agent.request(acpV2.methods.agent.session.new, { cwd: "/repo" });

        await connection.agent.request(acpV2.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "first prompt" }]
        });
        await waitFor(() => updates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"));
        const failedMessageId = updates.find((u) => u.sessionUpdate === "user_message")?.messageId;
        await new Promise((resolve) => setImmediate(resolve));

        updates.length = 0;
        await connection.agent.request(acpV2.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "second prompt" }]
        });
        await waitFor(() => updates.some((u) => u.sessionUpdate === "state_update" && u.state === "idle"));
        const persistedMessageId = updates.find((u) => u.sessionUpdate === "user_message")?.messageId;

        expect(failedMessageId).toMatch(/^user-[0-9a-f-]{36}$/);
        expect(persistedMessageId).toMatch(/^user-[0-9a-f-]{36}$/);
        expect(persistedMessageId).not.toBe(failedMessageId);
      } finally {
        connection.close();
      }
    });
  });

  it("replays a persisted v2 user message from its live message ID", async () => {
    await withConversationsDir(async (dir) => {
      const appOptions = {
        ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
        spawnProcess: spawnAgyWritingConversation(dir, "conv-v2-replay", [
          { idx: 0, stepType: 14, stepPayload: encodeStepPayload({ userPrompt: "hi" }) },
          {
            idx: 1,
            stepType: 8,
            stepPayload: encodeStepPayload({
              toolRun: encodeToolRun({
                call: encodeToolCall({
                  callId: "v2-replayed-view",
                  namePrimary: "view_file",
                  rawInputJson: '{"AbsolutePath":"/repo/README.md"}'
                })
              })
            })
          },
          { idx: 2, stepType: 15, stepPayload: encodeStepPayload({ agentText: "prior turn" }) }
        ])
      };

      let sessionId: string;
      let liveUserMessageId: string;
      {
        const updates: Array<Record<string, unknown>> = [];
        const client = acpV2.client({ name: "test-client" }).onNotification(
          acpV2.methods.client.session.update,
          (ctx) => {
            updates.push(ctx.params.update as Record<string, unknown>);
          }
        );
        const connection = client.connect(createAcpV2App(appOptions));
        try {
          await connection.agent.request(acpV2.methods.agent.initialize, {
            protocolVersion: 2,
            info: { name: "test-client", version: "0.0.0" },
            capabilities: {}
          });
          const session = await connection.agent.request(acpV2.methods.agent.session.new, {
            cwd: "/repo"
          });
          sessionId = session.sessionId;
          await connection.agent.request(acpV2.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: "hi" }]
          });
          // Drain the async turn so the conversation binding is persisted.
          await waitFor(() => updates.some((u) => u.state === "idle"));
          liveUserMessageId = String(
            updates.find((u) => u.sessionUpdate === "user_message")?.messageId
          );
          expect(liveUserMessageId).toMatch(/^user-[0-9a-f-]{36}$/);
        } finally {
          connection.close();
        }
      }

      {
        const updates: unknown[] = [];
        const client = acpV2.client({ name: "test-client" }).onNotification(
          acpV2.methods.client.session.update,
          (ctx) => {
            updates.push(ctx.params.update);
          }
        );
        const connection = client.connect(createAcpV2App(appOptions));
        try {
          await connection.agent.request(acpV2.methods.agent.initialize, {
            protocolVersion: 2,
            info: { name: "test-client", version: "0.0.0" },
            capabilities: { _meta: { toolCallName: false } }
          });
          await connection.agent.request(acpV2.methods.agent.session.resume, {
            sessionId,
            cwd: "/repo",
            replayFrom: { type: "message", messageId: liveUserMessageId }
          });
          expect(updates).toContainEqual(
            expect.objectContaining({
              sessionUpdate: "user_message_chunk",
              messageId: liveUserMessageId
            })
          );
          expect(updates).toContainEqual(
            expect.objectContaining({
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "prior turn" },
              messageId: expect.any(String)
            })
          );
          const replayedToolCall = updates.find(
            (update) =>
              (update as { sessionUpdate?: string; toolCallId?: string }).sessionUpdate ===
                "tool_call_update" &&
              (update as { toolCallId?: string }).toolCallId === "v2-replayed-view"
          );
          expect(replayedToolCall).toMatchObject({
            sessionUpdate: "tool_call_update",
            title: "Read README.md"
          });
          expect(replayedToolCall).not.toHaveProperty("name");
        } finally {
          connection.close();
        }
      }
    });
  });

  it("maps tool_call to tool_call_update and diffs to structured changes", () => {
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "c1",
      title: "Edit /tmp/a.ts",
      kind: "edit",
      status: "completed",
      content: [{ type: "diff", path: "/tmp/a.ts", oldText: null, newText: "export {}\n" }]
    } as SessionUpdate;

    const v2Update = sessionUpdateToV2(update) as Record<string, unknown>;
    expect(v2Update.sessionUpdate).toBe("tool_call_update");
    const content = v2Update.content as Array<Record<string, unknown>>;
    expect(content[0]).toMatchObject({
      type: "diff",
      changes: [{ operation: "add", path: "/tmp/a.ts", fileType: "text" }],
      patch: { format: "git_patch" }
    });
  });

  it("maps classic plan to v2 plan_update markdown when meta is present", () => {
    const markdown = "# Plan\n\n- [ ] One\n- [x] Two\n";
    const update = {
      sessionUpdate: "plan",
      entries: [
        { content: "One", priority: "high", status: "pending" },
        { content: "Two", priority: "high", status: "completed" }
      ],
      _meta: {
        "agy-acp/planId": "file:/tmp/brain/plan.md",
        "agy-acp/planPath": "/tmp/brain/plan.md",
        "agy-acp/planMarkdown": markdown
      }
    } as SessionUpdate;

    const v2Update = sessionUpdateToV2(update) as Record<string, unknown>;
    expect(v2Update.sessionUpdate).toBe("plan_update");
    expect(v2Update.plan).toEqual({
      type: "items",
      planId: "file:/tmp/brain/plan.md",
      entries: [
        { content: "One", priority: "high", status: "pending" },
        { content: "Two", priority: "high", status: "completed" }
      ]
    });

    const v1Wire = sessionUpdateToV1(update) as Record<string, unknown>;
    expect(v1Wire.sessionUpdate).toBe("plan");
    expect(v1Wire.entries).toHaveLength(2);
    expect(v1Wire._meta).toBeUndefined();
  });

  it("maps classic plan to v2 plan_update markdown when entries is empty", () => {
    const markdown = "# Plan\n\nNo items\n";
    const update = {
      sessionUpdate: "plan",
      entries: [],
      _meta: {
        "agy-acp/planId": "file:/tmp/brain/plan.md",
        "agy-acp/planPath": "/tmp/brain/plan.md",
        "agy-acp/planMarkdown": markdown
      }
    } as SessionUpdate;

    const v2Update = sessionUpdateToV2(update) as Record<string, unknown>;
    expect(v2Update).toEqual({
      sessionUpdate: "plan_update",
      plan: {
        type: "markdown",
        planId: "file:/tmp/brain/plan.md",
        content: markdown
      }
    });
  });

  it("maps classic plan to v2 plan_update items without markdown meta", () => {
    const update = {
      sessionUpdate: "plan",
      entries: [{ id: "entry_f323ded6", content: "Ship it", priority: "medium", status: "pending" }]
    } as unknown as SessionUpdate;

    const v2Update = sessionUpdateToV2(update) as Record<string, unknown>;
    expect(v2Update).toEqual({
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: "agy-plan",
        entries: [{ id: "entry_f323ded6", content: "Ship it", priority: "medium", status: "pending" }]
      }
    });
  });

  it("maps plan_removed to v2 plan_removed update with planId", () => {
    const update = {
      sessionUpdate: "plan_removed",
      planId: "file:/tmp/brain/plan.md"
    } as SessionUpdate;

    const v2Update = sessionUpdateToV2(update) as Record<string, unknown>;
    expect(v2Update).toEqual({
      sessionUpdate: "plan_removed",
      planId: "file:/tmp/brain/plan.md"
    });
  });

  it("translates plan_removed to empty plan on v1 wire", () => {
    const update = {
      sessionUpdate: "plan_removed",
      planId: "file:/tmp/brain/plan.md"
    } as SessionUpdate;

    const v1Wire = sessionUpdateToV1(update) as Record<string, unknown>;
    expect(v1Wire.sessionUpdate).toBe("plan");
    expect(v1Wire.entries).toEqual([]);
  });

  it("expands execute tool calls into terminal_update + tool_call_update", () => {
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "cmd-1",
      title: "ls",
      kind: "execute",
      status: "completed",
      rawInput: { CommandLine: "ls", Cwd: "/repo" },
      rawOutput: { exitCode: 0, output: "README.md\n" },
      content: [
        { type: "content", content: { type: "text", text: "```\nls\n```" } },
        { type: "content", content: { type: "text", text: "```\nREADME.md\n```" } }
      ]
    } as SessionUpdate;

    const expanded = expandSessionUpdateToV2(update) as Array<Record<string, unknown>>;
    expect(expanded).toHaveLength(4);

    const terminalId = terminalIdForToolCall("cmd-1");
    expect(expanded[0]).toMatchObject({
      sessionUpdate: "terminal_update",
      terminalId,
      command: "ls",
      cwd: "/repo"
    });
    expect(expanded[0].exitStatus).toBeUndefined();

    expect(expanded[1]).toEqual({
      sessionUpdate: "terminal_output_chunk",
      terminalId,
      data: Buffer.from("README.md\n", "utf8").toString("base64")
    });

    expect(expanded[2]).toMatchObject({
      sessionUpdate: "terminal_update",
      terminalId,
      exitStatus: { exitCode: 0 }
    });

    expect(expanded[3]).toMatchObject({
      sessionUpdate: "tool_call_update",
      toolCallId: "cmd-1",
      kind: "execute",
      status: "completed"
    });
    const content = expanded[3].content as Array<Record<string, unknown>>;
    expect(content.some((item) => item.type === "terminal")).toBe(false);
    expect(content.some((item) => item.type === "content")).toBe(true);
  });

  it("emits in-progress terminal_update with terminal content block", () => {
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "cmd-2",
      title: "sleep 1",
      kind: "execute",
      status: "in_progress",
      rawInput: { CommandLine: "sleep 1" }
    } as SessionUpdate;

    const [terminal, tool] = expandSessionUpdateToV2(update) as Array<Record<string, unknown>>;
    expect(terminal).toMatchObject({
      sessionUpdate: "terminal_update",
      terminalId: terminalIdForToolCall("cmd-2"),
      command: "sleep 1"
    });
    expect(terminal.exitStatus).toBeUndefined();
    expect(terminal.output).toBeUndefined();
    expect(tool).toMatchObject({
      sessionUpdate: "tool_call_update",
      status: "in_progress",
      content: [{ type: "terminal", terminalId: terminalIdForToolCall("cmd-2") }]
    });
  });

  it("emits terminal_output_chunk for incremental command output bytes", () => {
    const termTracker = createTerminalOutputTracker();
    const toolTracker = createToolCallContentTracker();

    const update1 = {
      sessionUpdate: "tool_call",
      toolCallId: "stream-cmd",
      title: "build",
      kind: "execute",
      status: "in_progress",
      rawInput: { CommandLine: "make" },
      rawOutput: { output: "compiling step 1\n" }
    } as unknown as SessionUpdate;

    const res1 = expandSessionUpdateToV2(update1, termTracker, toolTracker) as Array<Record<string, unknown>>;
    expect(res1).toHaveLength(3);
    expect(res1[0]).toMatchObject({ sessionUpdate: "terminal_update", command: "make" });
    expect(res1[0].output).toBeUndefined();
    expect(res1[1]).toEqual({
      sessionUpdate: "terminal_output_chunk",
      terminalId: terminalIdForToolCall("stream-cmd"),
      data: Buffer.from("compiling step 1\n", "utf8").toString("base64")
    });
    expect(res1[2]).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "stream-cmd" });

    const update2 = {
      sessionUpdate: "tool_call_update",
      toolCallId: "stream-cmd",
      title: "build",
      kind: "execute",
      status: "completed",
      rawInput: { CommandLine: "make" },
      rawOutput: { exitCode: 0, output: "compiling step 1\ncompiling step 2\n" }
    } as unknown as SessionUpdate;

    const res2 = expandSessionUpdateToV2(update2, termTracker, toolTracker) as Array<Record<string, unknown>>;
    expect(res2).toHaveLength(4);
    expect(res2[0]).toMatchObject({ sessionUpdate: "terminal_update" });
    expect(res2[0].exitStatus).toBeUndefined();
    expect(res2[1]).toEqual({
      sessionUpdate: "terminal_output_chunk",
      terminalId: terminalIdForToolCall("stream-cmd"),
      data: Buffer.from("compiling step 2\n", "utf8").toString("base64")
    });
    expect(res2[2]).toMatchObject({
      sessionUpdate: "terminal_update",
      terminalId: terminalIdForToolCall("stream-cmd"),
      exitStatus: { exitCode: 0 }
    });
    expect(res2[3]).toMatchObject({ sessionUpdate: "tool_call_update", status: "completed" });
  });

  it("uses a terminal output snapshot when new output does not extend the previous snapshot", () => {
    const termTracker = createTerminalOutputTracker();
    const toolTracker = createToolCallContentTracker();
    const update = (output: string) => ({
      sessionUpdate: "tool_call_update",
      toolCallId: "rewritten-output",
      title: "build",
      kind: "execute",
      status: "in_progress",
      rawInput: { CommandLine: "make" },
      rawOutput: { output }
    } as unknown as SessionUpdate);

    expandSessionUpdateToV2(update("abc"), termTracker, toolTracker);
    const replaced = expandSessionUpdateToV2(
      update("XYZ12"),
      termTracker,
      toolTracker
    ) as Array<Record<string, unknown>>;

    expect(replaced.some((item) => item.sessionUpdate === "terminal_output_chunk")).toBe(false);
    expect(replaced[0]).toMatchObject({
      sessionUpdate: "terminal_update",
      output: { data: Buffer.from("XYZ12", "utf8").toString("base64") }
    });
  });

  it("retains terminal output progress when a completed row grows after first sight", () => {
    const termTracker = createTerminalOutputTracker();
    const toolTracker = createToolCallContentTracker();
    const update = (output: string) => ({
      sessionUpdate: "tool_call_update",
      toolCallId: "late-completed-output",
      title: "build",
      kind: "execute",
      status: "completed",
      rawInput: { CommandLine: "make" },
      rawOutput: { exitCode: 0, output }
    } as unknown as SessionUpdate);

    expandSessionUpdateToV2(update("abc"), termTracker, toolTracker);
    const grown = expandSessionUpdateToV2(
      update("abcdef"),
      termTracker,
      toolTracker
    ) as Array<Record<string, unknown>>;

    expect(grown[1]).toEqual({
      sessionUpdate: "terminal_output_chunk",
      terminalId: terminalIdForToolCall("late-completed-output"),
      data: Buffer.from("def", "utf8").toString("base64")
    });
  });

  it("emits tool_call_content_chunk when new content items are appended to a previously empty tool call", () => {
    const termTracker = createTerminalOutputTracker();
    const toolTracker = createToolCallContentTracker();

    const update1 = {
      sessionUpdate: "tool_call",
      toolCallId: "tc-empty-init",
      title: "fetch data",
      kind: "fetch",
      status: "in_progress",
      content: []
    } as unknown as SessionUpdate;

    const res1 = expandSessionUpdateToV2(update1, termTracker, toolTracker) as Array<Record<string, unknown>>;
    expect(res1).toHaveLength(1);
    expect(res1[0]).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "tc-empty-init" });

    const update2 = {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-empty-init",
      title: "fetch data",
      kind: "fetch",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "Late Data" } }]
    } as unknown as SessionUpdate;

    const res2 = expandSessionUpdateToV2(update2, termTracker, toolTracker) as Array<Record<string, unknown>>;
    expect(res2).toHaveLength(2);
    expect(res2[0]).toEqual({
      sessionUpdate: "tool_call_content_chunk",
      toolCallId: "tc-empty-init",
      content: { type: "content", content: { type: "text", text: "Late Data" } }
    });
    expect(res2[1]).toMatchObject({ sessionUpdate: "tool_call_update", status: "completed" });
  });

  it("emits tool_call_content_chunk when new content items are appended", () => {
    const termTracker = createTerminalOutputTracker();
    const toolTracker = createToolCallContentTracker();

    const update1 = {
      sessionUpdate: "tool_call",
      toolCallId: "tc-progress",
      title: "fetch data",
      kind: "fetch",
      status: "in_progress",
      content: [{ type: "content", content: { type: "text", text: "Part 1" } }]
    } as unknown as SessionUpdate;

    const res1 = expandSessionUpdateToV2(update1, termTracker, toolTracker) as Array<Record<string, unknown>>;
    expect(res1).toHaveLength(1);
    expect(res1[0]).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "tc-progress" });

    const update2 = {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-progress",
      title: "fetch data",
      kind: "fetch",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "Part 1" } },
        { type: "content", content: { type: "text", text: "Part 2" } }
      ]
    } as unknown as SessionUpdate;

    const res2 = expandSessionUpdateToV2(update2, termTracker, toolTracker) as Array<Record<string, unknown>>;
    expect(res2).toHaveLength(2);
    expect(res2[0]).toEqual({
      sessionUpdate: "tool_call_content_chunk",
      toolCallId: "tc-progress",
      content: { type: "content", content: { type: "text", text: "Part 2" } }
    });
    expect(res2[1]).toMatchObject({ sessionUpdate: "tool_call_update", status: "completed" });
  });

  it("isolates progressive trackers across separate sessions with identical toolCallIds", () => {
    const sessionATermTracker = createTerminalOutputTracker();
    const sessionAToolTracker = createToolCallContentTracker();
    const sessionBTermTracker = createTerminalOutputTracker();
    const sessionBToolTracker = createToolCallContentTracker();

    const updateA1 = {
      sessionUpdate: "tool_call",
      toolCallId: "shared-cmd",
      title: "run",
      kind: "execute",
      status: "in_progress",
      rawInput: { CommandLine: "run" },
      rawOutput: { output: "session A output prefix\n" }
    } as unknown as SessionUpdate;

    const resA1 = expandSessionUpdateToV2(updateA1, sessionATermTracker, sessionAToolTracker) as Array<Record<string, unknown>>;
    expect(resA1[1]).toMatchObject({
      sessionUpdate: "terminal_output_chunk",
      data: Buffer.from("session A output prefix\n", "utf8").toString("base64")
    });

    const updateB1 = {
      sessionUpdate: "tool_call",
      toolCallId: "shared-cmd",
      title: "run",
      kind: "execute",
      status: "in_progress",
      rawInput: { CommandLine: "run" },
      rawOutput: { output: "B\n" }
    } as unknown as SessionUpdate;

    const resB1 = expandSessionUpdateToV2(updateB1, sessionBTermTracker, sessionBToolTracker) as Array<Record<string, unknown>>;
    expect(resB1[1]).toMatchObject({
      sessionUpdate: "terminal_output_chunk",
      data: Buffer.from("B\n", "utf8").toString("base64")
    });

    const updateA2 = {
      sessionUpdate: "tool_call_update",
      toolCallId: "shared-cmd",
      title: "run",
      kind: "execute",
      status: "completed",
      rawInput: { CommandLine: "run" },
      rawOutput: { exitCode: 0, output: "session A output prefix\nsession A output suffix\n" }
    } as unknown as SessionUpdate;

    const resA2 = expandSessionUpdateToV2(updateA2, sessionATermTracker, sessionAToolTracker) as Array<Record<string, unknown>>;
    expect(resA2[1]).toMatchObject({
      sessionUpdate: "terminal_output_chunk",
      data: Buffer.from("session A output suffix\n", "utf8").toString("base64")
    });
  });

  it("filters updates for replayFrom cursors", () => {
    const updates = [
      { sessionUpdate: "agent_message_chunk", messageId: "1", content: { type: "text", text: "one" } },
      { sessionUpdate: "tool_call", toolCallId: "call-1", title: "read", _meta: { stepIdx: 2 } },
      { sessionUpdate: "agent_message_chunk", messageId: "3", content: { type: "text", text: "two" } }
    ] as SessionUpdate[];

    expect(filterUpdatesForReplayFrom(updates, { type: "start" })).toEqual(updates);

    expect(filterUpdatesForReplayFrom(updates, { type: "message", messageId: "3" })).toEqual([updates[2]]);

    expect(filterUpdatesForReplayFrom(updates, { type: "step", stepIdx: 2 })).toEqual([updates[1], updates[2]]);

    const mergedUpdates = [
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "merged 1 and 2" },
        _meta: { stepIdx: 1, endStepIdx: 2 }
      },
      {
        sessionUpdate: "tool_call",
        toolCallId: "call-3",
        title: "run",
        _meta: { stepIdx: 3 }
      }
    ] as SessionUpdate[];

    expect(filterUpdatesForReplayFrom(mergedUpdates, { type: "step", stepIdx: 2 })).toEqual(mergedUpdates);
    expect(filterUpdatesForReplayFrom(mergedUpdates, { type: "message", messageId: "1" })).toEqual(mergedUpdates);
    expect(filterUpdatesForReplayFrom(mergedUpdates, { type: "message", messageId: "2" })).toEqual(mergedUpdates);

    const thoughtAndAnswer = [
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "agent-thought-4",
        content: { type: "text", text: "thinking" },
        _meta: { stepIdx: 4 }
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "4",
        content: { type: "text", text: "answer" },
        _meta: { stepIdx: 4 }
      }
    ] as SessionUpdate[];
    expect(filterUpdatesForReplayFrom(thoughtAndAnswer, { type: "message", messageId: "4" })).toEqual([
      thoughtAndAnswer[1]
    ]);

    expect(filterUpdatesForReplayFrom(updates, { type: "tool_call", toolCallId: "call-1" })).toEqual([
      updates[1],
      updates[2]
    ]);

    expect(() => filterUpdatesForReplayFrom(updates, { type: "invalid_cursor" })).toThrow(
      "Unsupported replay cursor: invalid_cursor"
    );
  });

  it("embeds _meta.terminal_* on v1 execute tool calls", () => {
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "cmd-v1",
      title: "npm run test",
      kind: "execute",
      status: "completed",
      rawInput: { CommandLine: "npm run test" },
      rawOutput: { exitCode: 0 },
      content: [
        { type: "content", kind: "output", content: { type: "text", text: "```\nPASS test/a.test.ts\n```" } }
      ]
    } as unknown as SessionUpdate;

    const v1 = sessionUpdateToV1(update) as Record<string, unknown>;
    const terminalId = terminalIdForToolCall("cmd-v1");
    expect(v1._meta).toEqual({
      terminal_info: { terminal_id: terminalId },
      terminal_output: { data: Buffer.from("PASS test/a.test.ts", "utf8").toString("base64") },
      terminal_exit: { exit_code: 0 }
    });
  });

  it("emits fallback terminal_exit on finished v1 execute steps without exitCode", () => {
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "cmd-failed",
      title: "bad command",
      kind: "execute",
      status: "failed",
      rawInput: { CommandLine: "bad command" }
    } as SessionUpdate;

    const v1 = sessionUpdateToV1(update) as Record<string, unknown>;
    expect(v1._meta).toEqual({
      terminal_info: { terminal_id: terminalIdForToolCall("cmd-failed") },
      terminal_exit: { exit_code: 1 }
    });
  });

  it("handles terminal output buffer reset / truncation", () => {
    const tracker = createTerminalOutputTracker();
    const step1 = {
      sessionUpdate: "tool_call",
      toolCallId: "cmd-reset",
      title: "run",
      kind: "execute",
      status: "in_progress",
      rawInput: { CommandLine: "run" },
      content: [
        { type: "content", kind: "output", content: { type: "text", text: "```\nLong initial log text\n```" } }
      ]
    } as unknown as SessionUpdate;

    const v1First = sessionUpdateToV1(step1, tracker) as Record<string, unknown>;
    const metaFirst = v1First._meta as Record<string, Record<string, string>>;
    expect(metaFirst.terminal_output.data).toBe(Buffer.from("Long initial log text", "utf8").toString("base64"));

    // Simulate upstream reset to shorter output (terminal_output is append-only, so do not append chunk)
    const step2 = {
      ...step1,
      content: [
        { type: "content", kind: "output", content: { type: "text", text: "```\nReset\n```" } }
      ]
    } as unknown as SessionUpdate;

    const v1Second = sessionUpdateToV1(step2, tracker) as Record<string, unknown>;
    const metaSecond = v1Second._meta as Record<string, Record<string, string>>;
    expect(metaSecond.terminal_output).toBeUndefined();
  });

  it("bounds terminal output tracker size to prevent unbounded memory growth", () => {
    const tracker = createTerminalOutputTracker();
    // Fill tracker beyond MAX_TERMINAL_TRACKER_SIZE (500)
    for (let i = 0; i < 505; i++) {
      const step = {
        sessionUpdate: "tool_call",
        toolCallId: `cmd-orphan-${i}`,
        title: "run",
        kind: "execute",
        status: "in_progress",
        rawInput: { CommandLine: "run" },
        content: [
          { type: "content", kind: "output", content: { type: "text", text: "```\noutput\n```" } }
        ]
      } as unknown as SessionUpdate;
      sessionUpdateToV1(step, tracker);
    }
    expect(tracker.size).toBeLessThanOrEqual(500);
    // Oldest entries like cmd-orphan-0 should have been evicted
    expect(tracker.has(terminalIdForToolCall("cmd-orphan-0"))).toBe(false);
    expect(tracker.has(terminalIdForToolCall("cmd-orphan-504"))).toBe(true);
  });

  it("drops terminal content block on completed or failed status to prevent lookup of evicted terminals", () => {
    const updateWithTerminal = {
      sessionUpdate: "tool_call_update",
      toolCallId: "cmd-3",
      title: "git status",
      kind: "execute",
      status: "completed",
      rawInput: { CommandLine: "git status" },
      content: [
        { type: "terminal", terminalId: terminalIdForToolCall("cmd-3") },
        { type: "content", content: { type: "text", text: "working tree clean" } }
      ]
    } as SessionUpdate;

    const [terminal, tool] = expandSessionUpdateToV2(updateWithTerminal) as Array<Record<string, unknown>>;
    expect(terminal).toMatchObject({
      sessionUpdate: "terminal_update",
      terminalId: terminalIdForToolCall("cmd-3"),
      command: "git status",
      exitStatus: {}
    });
    expect(tool.content).toEqual([
      { type: "content", content: { type: "text", text: "working tree clean" } }
    ]);
  });
});

const TEST_MODELS_OUTPUT =
  "gemini-3.5-flash-medium\ngemini-3.5-flash-high\nclaude-opus-4-6-thinking\nclaude-sonnet-4-6\n";

function printModeOptions(overrides: AcpAgentOptions = {}): AcpAgentOptions {
  return {
    argv: ["--no-interactive-permissions"],
    stateDir: overrides.stateDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-state-")),
    ...overrides
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Run `fn` with a throwaway conversations directory, cleaned up afterwards. */
export async function withConversationsDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-test-"));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A spawn factory simulating agy: on `agy models` it returns the test model
 * list; on a real prompt turn it writes the given steps into a conversation
 * database (as agy itself would) before exiting, so the ACP server's poller
 * picks them up.
 */
export function spawnAgyWritingConversation(
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

export class FakeProcess extends EventEmitter {
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

  spawnFactory() {
    return () => this;
  }
}

function flagValue(command: string[], flag: string): string {
  return command[command.indexOf(flag) + 1];
}

function optionValues(configOption: SelectConfigOption): string[] {
  return configOption.options.map((option) => {
    if (!("value" in option)) {
      throw new Error("expected flat select options");
    }
    return option.value;
  });
}

function optionNames(configOption: SelectConfigOption): string[] {
  return configOption.options.map((option) => option.name);
}

describe("tool call name field (gh#52)", () => {
  it("advertises toolCallName in initialize agent capabilities", async () => {
    vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);
    const spawnProcess = (_command: string, args: string[]) => {
      if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
      return new FakeProcess(["ok"]);
    };
    const options = printModeOptions({ spawnProcess: spawnProcess as unknown as SpawnFactory });
    const connectionV1 = acpClient({ name: "test-client" }).connect(createAcpApp(options));
    const connectionV2 = acpV2.client({ name: "test-client" }).connect(createAcpV2App(options));

    try {
      const initV1 = (await connectionV1.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {}
      })) as any;
      expect(initV1.agentCapabilities?.toolCallName).toEqual({});

      const initV2 = (await connectionV2.agent.request(acpV2.methods.agent.initialize, {
        protocolVersion: acpV2.PROTOCOL_VERSION,
        info: { name: "test-client", version: "0.0.0" },
        capabilities: {}
      })) as any;
      expect((initV2.capabilities as any)?.toolCallName ?? (initV2.capabilities as any)?._meta?.toolCallName).toBeDefined();
    } finally {
      connectionV1.close();
      connectionV2.close();
      vi.restoreAllMocks();
    }
  });

  it("emits name field on tool_call_update for ACP v2 turns", async () => {
    await withConversationsDir(async (dir) => {
      vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);
      const sessionUpdates: any[] = [];
      const connection = acpV2.client({ name: "test-client" })
        .onNotification(acpV2.methods.client.session.update, (ctx) => {
          sessionUpdates.push(ctx.params.update);
        })
        .connect(
          createAcpV2App({
            ...printModeOptions({ conversationsDir: dir, stateDir: dir }),
            spawnProcess: spawnAgyWritingConversation(dir, "v2-name-session", [
              {
                idx: 1,
                stepType: 21,
                status: 3,
                stepPayload: encodeStepPayload({
                  toolRun: encodeToolRun({
                    call: encodeToolCall({
                      callId: "call-cmd-1",
                      namePrimary: "run_command",
                      rawInputJson: JSON.stringify({ CommandLine: "echo hello" })
                    })
                  }),
                  commandResult: encodeCommandResult({ command: "echo hello", output: "hello", exitCode: 0, cwd: dir })
                })
              }
            ])
          })
        );

      try {
        await connection.agent.request(acpV2.methods.agent.initialize, {
          protocolVersion: acpV2.PROTOCOL_VERSION,
          info: { name: "test-client", version: "0.0.0" },
          capabilities: {}
        });
        const session = await connection.agent.request(acpV2.methods.agent.session.new, { cwd: dir });
        await connection.agent.request(acpV2.methods.agent.session.prompt, {
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "run echo" }]
        });

        await waitFor(() =>
          sessionUpdates.some(
            (u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "call-cmd-1"
          )
        );

        const toolUpdate = sessionUpdates.find(
          (u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "call-cmd-1"
        );
        expect(toolUpdate).toBeDefined();
        expect(toolUpdate.name).toBe("run_command");
      } finally {
        connection.close();
        vi.restoreAllMocks();
      }
    });
  });
});
