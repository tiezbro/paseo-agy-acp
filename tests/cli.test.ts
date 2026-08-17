import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import * as installer from "../ACP Connector/agy/installer.js";
import {
  AgyCliBackend,
  AgyCliError,
  AgyCliSession,
  DEFAULT_AGY_MODEL_LIST_TIMEOUT_MS,
  DEFAULT_CONVERSATIONS_DIR,
  configFromEnv,
  parseAgyModels,
  type AgyCliConfig,
  type PtyFactory,
  type PtyProcess,
  type SpawnFactory,
  type SpawnOptions
} from "../ACP Connector/agy/cli.js";
import type { AgyStartupLauncher } from "../ACP Connector/agy/startup-launcher.js";
import {
  canBridgeInteraction,
  interactionKeys,
  isBridgeablePermissionTool,
  permissionKeys,
  permissionOptions
} from "../ACP Connector/acp/tool-calls/permissions.js";
import { requestPermissionV1, requestPermissionV2 } from "../ACP Connector/acp/session/request-permission.js";
import { createConversationDb, insertStep, updateStep } from "./fixtures/conversation-db.js";
import {
  encodeCommandResult,
  encodeModelProviderError,
  encodePermissions,
  encodeStepPayload,
  encodeTaskDetails,
  encodeToolCall,
  encodeToolRun,
  encodeViewFileResult
} from "./fixtures/step-encoder.js";

/** Collects updates via the `onUpdate` callback `AgyCliSession.prompt` takes. */
async function collectUpdates(
  session: AgyCliSession,
  prompt: string
): Promise<{ updates: SessionUpdate[]; stopReason: "end_turn" | "cancelled" }> {
  const updates: SessionUpdate[] = [];
  const outcome = await session.prompt(prompt, async (update) => {
    updates.push(update);
  });
  return { updates, stopReason: outcome.stopReason };
}

describe("commandForPrompt", () => {
  it("uses agy print mode and safe defaults", () => {
    const session = new AgyCliSession({
      ...defaultConfig(),
      additionalDirectories: ["/extra"],
      agyPath: "/opt/homebrew/bin/agy",
      model: "gemini-test",
      project: "project-1",
      printTimeout: "30s",
      logFile: "/tmp/agy.log"
    });

    const command = session.commandForPrompt("hello");

    expect(command[0]).toBe("/opt/homebrew/bin/agy");
    expect(command).toContain("--print");
    expect(command[command.indexOf("--print") + 1]).toBe("hello");
    expect(command).toContain("--sandbox");
    expect(flagValue(command, "--model")).toBe("gemini-test");
    expect(command).not.toContain("--effort");
    expect(flagValue(command, "--project")).toBe("project-1");
    // cwd + additionalDirectories as --add-dir roots
    expect(command.filter((_, i) => command[i - 1] === "--add-dir")).toEqual(["/repo", "/extra"]);
  });

  it("includes --effort when configured", () => {
    const session = new AgyCliSession({
      ...defaultConfig(),
      model: "gemini-3.5-flash",
      effort: "high"
    });
    const command = session.commandForPrompt("hello");
    expect(flagValue(command, "--model")).toBe("gemini-3.5-flash");
    expect(flagValue(command, "--effort")).toBe("high");
  });

  it("omits --mode for default, passes agy modes, and maps the native dangerous bypass flag", () => {
    const defaultCmd = new AgyCliSession(defaultConfig()).commandForPrompt("hello");
    expect(defaultCmd).not.toContain("--mode");
    expect(defaultCmd).not.toContain("--dangerously-skip-permissions");

    const acceptCmd = new AgyCliSession({
      ...defaultConfig(),
      mode: "accept-edits"
    }).commandForPrompt("hello");
    expect(flagValue(acceptCmd, "--mode")).toBe("accept-edits");

    const planCmd = new AgyCliSession({
      ...defaultConfig(),
      mode: "plan"
    }).commandForPrompt("hello");
    expect(flagValue(planCmd, "--mode")).toBe("plan");

    const bypassCmd = new AgyCliSession({
      ...defaultConfig(),
      mode: "dangerously-skip-permissions"
    }).commandForPrompt("hello");
    expect(bypassCmd).toContain("--dangerously-skip-permissions");
    expect(bypassCmd).not.toContain("--mode");
  });

  it("builds interactive mode without print flags", () => {
    const session = new AgyCliSession({ ...defaultConfig(), interactivePermissions: true });
    const command = session.interactiveCommandForPrompt("hello");
    expect(command.slice(0, 3)).toEqual(["agy", "--prompt-interactive", "hello"]);
    expect(command).not.toContain("--print");
    expect(command).not.toContain("--print-timeout");
  });
});

describe("permission bridge", () => {
  it("maps every semantic choice to agy's menu keys", () => {
    expect(permissionKeys("agy-allow-once")).toBe("\r");
    expect(permissionKeys("agy-allow-conversation")).toBe("\x1b[B\r");
    expect(permissionKeys("agy-allow-settings")).toBe("\x1b[B\x1b[B\r");
    expect(permissionKeys("agy-reject-once")).toBe("\x1b[B\x1b[B\x1b[B\r");
    expect(permissionOptions({ sessionUpdate: "tool_call", toolCallId: "x", title: "Run", kind: "execute", status: "pending", rawInput: { CommandLine: "whoami" } })).toEqual([
      { optionId: "agy-allow-once", kind: "allow_once", name: "Yes" },
      { optionId: "agy-allow-conversation", kind: "allow_always", name: "Yes, and always allow in this conversation for commands that start with 'whoami'" },
      { optionId: "agy-allow-settings", kind: "allow_always", name: "Yes, and always allow for commands that start with 'whoami' (Persist to settings.json)" },
      { optionId: "agy-reject-once", kind: "reject_once", name: "No" }
    ]);
    expect(permissionOptions({
      sessionUpdate: "tool_call",
      toolCallId: "y",
      title: "Edit src/cli.ts",
      kind: "edit",
      status: "pending",
      rawInput: { TargetFile: "/repo/src/cli.ts" }
    }, "replace_file_content")).toEqual([
      { optionId: "allow-once", kind: "allow_once", name: "Allow" },
      { optionId: "allow-always", kind: "allow_always", name: "Always allow" },
      { optionId: "reject-once", kind: "reject_once", name: "Reject" }
    ]);
    expect(interactionKeys("allow-once", "replace_file_content")).toBe("\r");
    expect(interactionKeys("reject-once", "replace_file_content")).toBe("\x1b[B\x1b[B\x1b[B\r");
    expect(isBridgeablePermissionTool("run_command")).toBe(true);
    expect(isBridgeablePermissionTool("replace_file_content")).toBe(true);
    expect(isBridgeablePermissionTool("write_to_file")).toBe(true);
    expect(isBridgeablePermissionTool("view_file")).toBe(true);
    expect(isBridgeablePermissionTool("ask_question")).toBe(false);

    const askCall = {
      sessionUpdate: "tool_call" as const,
      toolCallId: "q1",
      title: "Pick one",
      kind: "other" as const,
      status: "pending" as const,
      rawInput: {
        questions: [{
          question: "Which approach?",
          options: ["Option A", "Option B", "Option C"],
          is_multi_select: false
        }]
      }
    };
    expect(canBridgeInteraction("ask_question", askCall)).toBe(true);
    expect(permissionOptions(askCall, "ask_question")).toEqual([
      { optionId: "agy-q-0", kind: "allow_once", name: "Option A" },
      { optionId: "agy-q-1", kind: "allow_once", name: "Option B" },
      { optionId: "agy-q-2", kind: "allow_once", name: "Option C" },
      { optionId: "agy-q-skip", kind: "reject_once", name: "Skip" }
    ]);
    expect(interactionKeys("agy-q-0", "ask_question", askCall)).toBe("\r");
    expect(interactionKeys("agy-q-1", "ask_question", askCall)).toBe("\x1b[B\r");
    expect(interactionKeys("agy-q-2", "ask_question", askCall)).toBe("\x1b[B\x1b[B\r");
    expect(interactionKeys("agy-q-skip", "ask_question", askCall)).toBe("\x1b");

    const multiAskCall = {
      sessionUpdate: "tool_call" as const,
      toolCallId: "q2",
      title: "Pick multiple",
      kind: "other" as const,
      status: "pending" as const,
      rawInput: {
        questions: [{
          question: "Which features?",
          options: ["Auth", "DB", "Analytics"],
          is_multi_select: true
        }]
      }
    };
    expect(canBridgeInteraction("ask_question", multiAskCall)).toBe(true);
    expect(permissionOptions(multiAskCall, "ask_question")).toEqual([
      { optionId: "agy-q-0", kind: "allow_once", name: "Auth" },
      { optionId: "agy-q-1", kind: "allow_once", name: "DB" },
      { optionId: "agy-q-0,1", kind: "allow_once", name: "Auth + DB" },
      { optionId: "agy-q-2", kind: "allow_once", name: "Analytics" },
      { optionId: "agy-q-0,2", kind: "allow_once", name: "Auth + Analytics" },
      { optionId: "agy-q-1,2", kind: "allow_once", name: "DB + Analytics" },
      { optionId: "agy-q-all", kind: "allow_once", name: "Select All (Auth + DB + Analytics)" },
      { optionId: "agy-q-none", kind: "allow_once", name: "Submit (None selected)" },
      { optionId: "agy-q-skip", kind: "reject_once", name: "Skip" }
    ]);
    expect(interactionKeys("agy-q-0,2", "ask_question", multiAskCall)).toBe(" \x1b[B\x1b[B \r");
    expect(interactionKeys("agy-q-all", "ask_question", multiAskCall)).toBe(" \x1b[B \x1b[B \r");
    expect(interactionKeys("agy-q-none", "ask_question", multiAskCall)).toBe("\r");
    expect(interactionKeys("agy-q-skip", "ask_question", multiAskCall)).toBe("\x1b");

    const multiQuestionCall = {
      sessionUpdate: "tool_call" as const,
      toolCallId: "q3",
      title: "Wizard",
      kind: "other" as const,
      status: "pending" as const,
      rawInput: {
        questions: [
          { question: "Env?", options: ["Dev", "Prod"], is_multi_select: false },
          { question: "Features?", options: ["Auth", "Logging"], is_multi_select: true }
        ]
      }
    };
    expect(canBridgeInteraction("ask_question", multiQuestionCall)).toBe(true);
    expect(permissionOptions(multiQuestionCall, "ask_question", 0)).toEqual([
      { optionId: "agy-q-q0-0", kind: "allow_once", name: "Dev" },
      { optionId: "agy-q-q0-1", kind: "allow_once", name: "Prod" },
      { optionId: "agy-q-q0-skip", kind: "reject_once", name: "Skip" }
    ]);
    expect(permissionOptions(multiQuestionCall, "ask_question", 1)).toEqual([
      { optionId: "agy-q-q1-0", kind: "allow_once", name: "Auth" },
      { optionId: "agy-q-q1-1", kind: "allow_once", name: "Logging" },
      { optionId: "agy-q-q1-all", kind: "allow_once", name: "Select All (Auth + Logging)" },
      { optionId: "agy-q-q1-none", kind: "allow_once", name: "Submit (None selected)" },
      { optionId: "agy-q-q1-skip", kind: "reject_once", name: "Skip" }
    ]);
    expect(interactionKeys("agy-q-q0-1", "ask_question", multiQuestionCall, 0)).toBe("\x1b[B\r");
    expect(interactionKeys("agy-q-q1-0,1", "ask_question", multiQuestionCall, 1)).toBe(" \x1b[B \r");

    const fiveOptionCall = {
      sessionUpdate: "tool_call" as const,
      toolCallId: "q5",
      title: "Five option question",
      kind: "other" as const,
      status: "pending" as const,
      rawInput: {
        questions: [{
          question: "Select items",
          options: ["A", "B", "C", "D", "E"],
          is_multi_select: true
        }]
      }
    };
    const fiveOpts = permissionOptions(fiveOptionCall, "ask_question");
    expect(fiveOpts).toContainEqual({ optionId: "agy-q-0,2,4", kind: "allow_once", name: "A + C + E" });
    expect(interactionKeys("agy-q-0,2,4", "ask_question", fiveOptionCall)).toBe(" \x1b[B\x1b[B \x1b[B\x1b[B \r");

    const sevenOptionCall = {
      sessionUpdate: "tool_call" as const,
      toolCallId: "q7",
      title: "7 option question",
      kind: "other" as const,
      status: "pending" as const,
      rawInput: {
        questions: [{
          question: "Select items",
          options: Array.from({ length: 7 }, (_, i) => `Opt${i}`),
          is_multi_select: true
        }]
      }
    };
    expect(canBridgeInteraction("ask_question", sevenOptionCall)).toBe(false);
  });

  it("labels each v1 requestPermission toolCall title with the active question", async () => {
    let capturedTitle: string | undefined;
    const mockClient = {
      request: vi.fn().mockImplementation(async (_method, params) => {
        capturedTitle = params.toolCall.title;
        return { outcome: { outcome: "selected", optionId: "agy-q-q1-0" } };
      })
    };

    const multiQCall = {
      sessionUpdate: "tool_call" as const,
      toolCallId: "q-multi",
      title: "Initial question title",
      kind: "other" as const,
      status: "pending" as const,
      rawInput: {
        questions: [
          { question: "First Question?", options: ["Opt1", "Opt2"] },
          { question: "Second Question?", options: ["Opt3", "Opt4"] }
        ]
      }
    };

    await requestPermissionV1(mockClient as any, "s1", multiQCall, "ask_question", undefined, 1);
    expect(capturedTitle).toBe("[Question 2/2] Second Question?");
  });

  it("filters v1 requestPermission tool names unless the client negotiated them", async () => {
    const payloads: Record<string, unknown>[] = [];
    const mockClient = {
      request: vi.fn().mockImplementation(async (_method, params) => {
        payloads.push(params.toolCall);
        return { outcome: { outcome: "selected", optionId: "allow-once" } };
      })
    };
    const toolCall = {
      sessionUpdate: "tool_call" as const,
      toolCallId: "cmd-name",
      title: "echo hi",
      kind: "execute" as const,
      status: "pending" as const,
      name: "run_command"
    };

    await requestPermissionV1(
      mockClient as any,
      "s1",
      toolCall,
      "run_command",
      undefined,
      undefined,
      undefined,
      { name: false }
    );
    await requestPermissionV1(
      mockClient as any,
      "s1",
      toolCall,
      "run_command",
      undefined,
      undefined,
      undefined,
      { name: true }
    );

    expect(payloads[0]).not.toHaveProperty("name");
    expect(payloads[1]).toHaveProperty("name", "run_command");
  });

  it("filters v2 requestPermission tool names when the client opts out", async () => {
    const payloads: Record<string, unknown>[] = [];
    const mockClient = {
      request: vi.fn().mockImplementation(async (_method, params) => {
        payloads.push(params.subject.toolCall);
        return { outcome: { outcome: "selected", optionId: "allow-once" } };
      })
    };
    const toolCall = {
      sessionUpdate: "tool_call" as const,
      toolCallId: "cmd-v2-name",
      title: "echo hi",
      kind: "execute" as const,
      status: "pending" as const,
      name: "run_command"
    };

    await requestPermissionV2(
      mockClient as any,
      "s1",
      toolCall,
      "run_command",
      new AbortController().signal,
      undefined,
      undefined,
      { name: false }
    );
    await requestPermissionV2(
      mockClient as any,
      "s1",
      toolCall,
      "run_command",
      new AbortController().signal,
      undefined,
      undefined,
      { name: true }
    );

    expect(payloads[0]).not.toHaveProperty("name");
    expect(payloads[1]).toHaveProperty("name", "run_command");
  });

  it("bridges agy's ask_permission sandbox-bypass request as a command-style menu", () => {
    // agy 1.1.7 gates sandbox bypass (run a command / read a file outside the
    // sandbox) through a status-9 `ask_permission` step whose TUI menu is the
    // same 4-row layout as run_command. It must be bridged, not thrown on.
    const askPermission = {
      sessionUpdate: "tool_call" as const,
      toolCallId: "ap1",
      title: "Permission request for git directory",
      kind: "other" as const,
      status: "pending" as const,
      rawInput: {
        Action: "read_file",
        Reason: "To allow git inside the sandbox to read the parent repository",
        Target: "/repo/.git",
        toolAction: "Requesting read access to the git parent repository"
      }
    };
    expect(isBridgeablePermissionTool("ask_permission")).toBe(true);
    expect(canBridgeInteraction("ask_permission", askPermission)).toBe(true);
    expect(permissionOptions(askPermission, "ask_permission")).toEqual([
      { optionId: "agy-allow-once", kind: "allow_once", name: "Yes" },
      { optionId: "agy-allow-conversation", kind: "allow_always", name: "Yes, and always allow '/repo/.git' in this conversation" },
      { optionId: "agy-allow-settings", kind: "allow_always", name: "Yes, and always allow '/repo/.git' (Persist to settings.json)" },
      { optionId: "agy-reject-once", kind: "reject_once", name: "No" }
    ]);
    expect(interactionKeys("agy-allow-once", "ask_permission", askPermission)).toBe("\r");
    expect(interactionKeys("agy-reject-once", "ask_permission", askPermission)).toBe("\x1b[B\x1b[B\x1b[B\r");
  });

  it("bridges agy's manage_task gated actions (kill, send_input) as a 4-row menu", () => {
    const manageTaskKill = {
      sessionUpdate: "tool_call" as const,
      toolCallId: "mt1",
      title: "Manage task kill",
      kind: "other" as const,
      status: "pending" as const,
      rawInput: {
        Action: "kill",
        TaskId: "task-42",
        toolAction: "Killing background task",
        toolSummary: "Kill task"
      }
    };
    expect(isBridgeablePermissionTool("manage_task")).toBe(true);
    expect(canBridgeInteraction("manage_task", manageTaskKill)).toBe(true);
    expect(permissionOptions(manageTaskKill, "manage_task")).toEqual([
      { optionId: "agy-allow-once", kind: "allow_once", name: "Yes" },
      { optionId: "agy-allow-conversation", kind: "allow_always", name: "Yes, and always allow 'manage_task kill (task-42)' in this conversation" },
      { optionId: "agy-allow-settings", kind: "allow_always", name: "Yes, and always allow 'manage_task kill (task-42)' (Persist to settings.json)" },
      { optionId: "agy-reject-once", kind: "reject_once", name: "No" }
    ]);
    expect(interactionKeys("agy-allow-once", "manage_task", manageTaskKill)).toBe("\r");
    expect(interactionKeys("agy-allow-conversation", "manage_task", manageTaskKill)).toBe("\x1b[B\r");
    expect(interactionKeys("agy-reject-once", "manage_task", manageTaskKill)).toBe("\x1b[B\x1b[B\x1b[B\r");

    // Without a TaskId, the target omits the parenthetical.
    const manageTaskNoId = {
      sessionUpdate: "tool_call" as const,
      toolCallId: "mt2",
      title: "Manage task send_input",
      kind: "other" as const,
      status: "pending" as const,
      rawInput: { Action: "send_input" }
    };
    expect(permissionOptions(manageTaskNoId, "manage_task")).toEqual([
      { optionId: "agy-allow-once", kind: "allow_once", name: "Yes" },
      { optionId: "agy-allow-conversation", kind: "allow_always", name: "Yes, and always allow 'manage_task send_input' in this conversation" },
      { optionId: "agy-allow-settings", kind: "allow_always", name: "Yes, and always allow 'manage_task send_input' (Persist to settings.json)" },
      { optionId: "agy-reject-once", kind: "reject_once", name: "No" }
    ]);
  });

  for (const [choice, keys] of [
    ["agy-allow-once", "\r"],
    ["agy-allow-conversation", "\x1b[B\r"],
    ["agy-allow-settings", "\x1b[B\x1b[B\r"]
  ] as const) {
    it(`completes ${choice} from final DB evidence without another idle marker`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-permission-final-"));
      const pty = new FakePty(() => {
        const db = createConversationDb(dir, "permission-final");
        insertStep(db, pendingToolRow("run_command"));
        db.close();
      });
      const session = interactiveSession(dir, pty, "500ms");
      let calls = 0;
      const result = session.prompt("go", async () => {}, async () => {
        calls++;
        const db = new (await import("better-sqlite3")).default(path.join(dir, "permission-final.db"));
        updateStep(db, 1, { status: 3 });
        insertStep(db, {
          idx: 2,
          stepType: 15,
          status: 3,
          stepPayload: encodeStepPayload({ agentText: "done" })
        });
        db.close();
        return choice;
      });

      try {
        expect((await result).stopReason).toBe("end_turn");
        expect(calls).toBe(1);
        expect(pty.writes).toEqual(permissionWriteChunks(keys));
      } finally {
        await session.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("completes after an allowed terminal command task with an explicit exit code", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-terminal-task-"));
    const commandCall = encodeToolCall({
      callId: "permission-1",
      namePrimary: "run_command",
      rawInputJson: '{"CommandLine":"paseo inspect self --json"}'
    });
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "terminal-task");
      insertStep(db, {
        idx: 1,
        stepType: 21,
        status: 9,
        stepPayload: encodeStepPayload({ toolRun: encodeToolRun({ call: commandCall }) }),
        task: encodeTaskDetails({ taskId: "task-3", logUri: "", description: "command" })
      });
      db.close();
    });
    const session = interactiveSession(dir, pty, "500ms");

    try {
      const result = session.prompt("validate selector", async () => {}, async () => {
        const db = new (await import("better-sqlite3")).default(path.join(dir, "terminal-task.db"));
        updateStep(db, 1, {
          status: 3,
          stepPayload: encodeStepPayload({
            toolRun: encodeToolRun({ call: commandCall }),
            commandResult: encodeCommandResult({
              command: "paseo inspect self --json",
              output: '{"status":"running"}\n',
              exitCode: 0
            })
          })
        });
        insertStep(db, {
          idx: 2,
          stepType: 19,
          status: 3,
          stepPayload: encodeStepPayload({
            toolRun: encodeToolRun({
              call: encodeToolCall({
                callId: "read-policy",
                namePrimary: "view_file",
                rawInputJson: '{"AbsolutePath":"/tmp/agent-routing-policy.json"}'
              })
            }),
            viewFile: encodeViewFileResult({
              fileUri: "file:///tmp/agent-routing-policy.json",
              content: '{"enabled":true}'
            })
          })
        });
        insertStep(db, {
          idx: 3,
          stepType: 15,
          status: 3,
          stepPayload: encodeStepPayload({ agentText: '{"validationPassed":true}' })
        });
        db.close();
        return "agy-allow-once";
      });

      expect((await result).stopReason).toBe("end_turn");
      expect(pty.writes).toEqual(["\r"]);
    } finally {
      await session.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a terminal model-provider error instead of completing an empty turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-provider-error-"));
    const providerMessage =
      "FAILED_PRECONDITION (code 400): User location is not supported for the API use.";
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "provider-error");
      insertStep(db, {
        idx: 1,
        stepType: 15,
        status: 3,
        stepPayload: encodeStepPayload({ agentText: "" })
      });
      insertStep(db, {
        idx: 2,
        stepType: 17,
        status: 3,
        stepPayload: encodeStepPayload({
          modelProviderError: encodeModelProviderError({
            summary: providerMessage,
            diagnostic: "HTTP 400 Bad Request",
            responseJson: JSON.stringify({
              error: {
                code: 400,
                message: "User location is not supported for the API use.",
                status: "FAILED_PRECONDITION"
              }
            }),
            userMessage: providerMessage
          })
        })
      });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 20);
    });
    const session = interactiveSession(dir, pty, "500ms");

    try {
      await expect(session.prompt("go", async () => {}, async () => "agy-allow-once"))
        .rejects.toEqual(expect.objectContaining({
          name: AgyCliError.name,
          message: expect.stringContaining(providerMessage)
        }));
    } finally {
      await session.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not complete an allowed permission turn without a post-tool assistant message", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-permission-no-final-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "permission-no-final");
      insertStep(db, pendingToolRow("run_command"));
      db.close();
    });
    const session = interactiveSession(dir, pty, "300ms");

    try {
      await expect(session.prompt("go", async () => {}, async () => {
        const db = new (await import("better-sqlite3")).default(path.join(dir, "permission-no-final.db"));
        updateStep(db, 1, { status: 3 });
        db.close();
        setTimeout(() => pty.emitData("? for shortcuts"), 20);
        return "agy-allow-once";
      })).rejects.toThrow(/timed out after 300ms/);
    } finally {
      await session.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("completes a denied permission turn from terminal tool evidence without a post-tool assistant message", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-permission-denied-terminal-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "permission-denied-terminal");
      insertStep(db, pendingToolRow("run_command"));
      db.close();
    });
    const session = interactiveSession(dir, pty, "300ms");
    const updates: SessionUpdate[] = [];

    try {
      const outcome = await session.prompt("go", async (update) => {
        updates.push(update);
      }, async () => {
        const db = new (await import("better-sqlite3")).default(
          path.join(dir, "permission-denied-terminal.db")
        );
        updateStep(db, 1, { status: 7 });
        db.close();
        return "agy-reject-once";
      });

      expect(outcome.stopReason).toBe("end_turn");
      expect(pty.writes).toEqual(permissionWriteChunks("\x1b[B\x1b[B\x1b[B\r"));
      expect(updates).toContainEqual(expect.objectContaining({
        toolCallId: "permission-1",
        status: "failed"
      }));
    } finally {
      await session.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a denied tool terminal and suppresses late completion and assistant success", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "denied");
      insertStep(db, pendingToolRow(
        "write_to_file",
        '{"TargetFile":"/repo/denied.txt","CodeContent":"denied"}',
        5
      ));
      db.close();
    });
    const session = interactiveSession(dir, pty, "500ms");
    const updates: SessionUpdate[] = [];
    const result = session.prompt("go", async (update) => {
      updates.push(update);
    }, async () => {
      const db = new (await import("better-sqlite3")).default(path.join(dir, "denied.db"));
      updateStep(db, 1, { status: 3 });
      insertStep(db, {
        idx: 2,
        stepType: 15,
        status: 3,
        stepPayload: encodeStepPayload({ agentText: "The file was successfully created." })
      });
      db.close();
      return "agy-reject-once";
    });

    try {
      expect((await result).stopReason).toBe("end_turn");
      const toolUpdates = updates.filter((update) => {
        const raw = update as unknown as { toolCallId?: string };
        return raw.toolCallId === "permission-1";
      });
      expect(toolUpdates.map((update) => (update as unknown as { status?: string }).status)).toEqual([
        "pending",
        "failed"
      ]);
      expect(updates.some((update) => {
        const raw = update as unknown as { sessionUpdate?: string; content?: { text?: string } };
        return raw.sessionUpdate === "agent_message_chunk" && raw.content?.text?.includes("successfully") === true;
      })).toBe(false);
      expect(pty.writes).toEqual(["\x1b[B", "\x1b[B", "\x1b[B", "\r"]);
    } finally {
      await session.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not finish on progress text and an idle marker before a post-tool final answer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-final-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "progress-tool");
      insertStep(db, {
        idx: 1,
        stepType: 15,
        status: 3,
        stepPayload: encodeStepPayload({ agentText: "I'll inspect the files first." })
      });
      insertStep(db, {
        idx: 2,
        stepType: 21,
        status: 3,
        stepPayload: encodeStepPayload({
          toolRun: encodeToolRun({
            call: encodeToolCall({
              callId: "read-then-answer",
              namePrimary: "run_command",
              rawInputJson: '{"CommandLine":"pwd"}'
            })
          }),
          commandResult: encodeCommandResult({ command: "pwd", output: "/repo\n", exitCode: 0 })
        })
      });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 30);
    });
    const session = interactiveSession(dir, pty);
    const updates: SessionUpdate[] = [];
    let resolved = false;
    const result = session.prompt("inspect", async (update) => {
      updates.push(update);
    }, async () => "agy-allow-once").then((value) => { resolved = true; return value; });

    try {
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(resolved).toBe(false);
      expect(updates).toMatchObject([
        { sessionUpdate: "agent_message_chunk", content: { text: "I'll inspect the files first." } },
        { sessionUpdate: "tool_call", toolCallId: "read-then-answer", status: "completed" }
      ]);

      const db = new (await import("better-sqlite3")).default(path.join(dir, "progress-tool.db"));
      insertStep(db, {
        idx: 3,
        stepType: 15,
        status: 3,
        stepPayload: encodeStepPayload({ agentText: "The workspace is /repo." })
      });
      db.close();

      expect((await result).stopReason).toBe("end_turn");
      expect(updates.at(-1)).toMatchObject({
        sessionUpdate: "agent_message_chunk",
        content: { text: "The workspace is /repo." }
      });
    } finally {
      await session.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserves permission panel visibility when intervening non-marker PTY data arrives before applying permission response", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "permission-intervening-pty");
      insertStep(db, pendingToolRow("run_command"));
      db.close();
    });
    const session = interactiveSession(dir, pty);
    const result = session.prompt("go", async () => {}, async () => {
      // Simulate stray terminal output / ANSI codes arriving while user is reviewing prompt
      pty.emitData("\x1b[?25hstray output");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const db = new (await import("better-sqlite3")).default(path.join(dir, "permission-intervening-pty.db"));
      updateStep(db, 1, { status: 3 });
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 100);
      return "agy-allow-once";
    });

    expect((await result).stopReason).toBe("end_turn");
    expect(pty.writes).toEqual(["\r"]);
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts an idle marker emitted after the DB write but before the next poll", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "permission-race");
      insertStep(db, pendingToolRow("run_command"));
      db.close();
    });
    const session = interactiveSession(dir, pty);
    const result = session.prompt("go", async () => {}, async () => {
      const db = new (await import("better-sqlite3")).default(path.join(dir, "permission-race.db"));
      updateStep(db, 1, { status: 3 });
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 0);
      return "agy-allow-once";
    });

    expect((await result).stopReason).toBe("end_turn");
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not mistake the fresh TUI startup marker for turn completion", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "startup-marker");
      insertStep(db, { idx: 1, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
    });
    const session = interactiveSession(dir, pty);
    let resolved = false;
    const result = session.prompt("go", async () => {}, async () => "agy-allow-once")
      .then((value) => { resolved = true; return value; });

    await new Promise((resolve) => setTimeout(resolve, 225));
    pty.emitData("redraw without another marker");
    await new Promise((resolve) => setTimeout(resolve, 225));
    expect(resolved).toBe(false);
    pty.emitData("? for shortcuts");
    expect((await result).stopReason).toBe("end_turn");
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("times out while waiting for background completion when no DB progress arrives", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-bg-timeout-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "bg-timeout");
      insertStep(db, {
        idx: 1,
        stepType: 21,
        status: 3,
        stepPayload: encodeStepPayload({
          commandResult: encodeCommandResult({ command: "sleep 999 &", output: "Task task-t launched" })
        }),
        task: encodeTaskDetails({ taskId: "task-t", logUri: "", description: "Background task" })
      });
      insertStep(db, {
        idx: 2,
        stepType: 15,
        status: 3,
        stepPayload: encodeStepPayload({
          agentText: "Preserving context while waiting for background command output..."
        })
      });
      db.close();
      // Idle markers arrive, but no completion row — deadline must still expire.
      setTimeout(() => pty.emitData("? for shortcuts"), 20);
    });

    const session = interactiveSession(dir, pty, "250ms");
    await expect(
      session.prompt("run bg", async () => {}, async () => "agy-allow-once")
    ).rejects.toThrow(/timed out after 250ms/);
    expect(pty.writes).toEqual([]);
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("maintains turn execution while background tasks are active until completed (gh#68)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-bg-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "bg-test");
      insertStep(db, {
        idx: 1,
        stepType: 21,
        status: 3,
        stepPayload: encodeStepPayload({ commandResult: encodeCommandResult({ command: "sleep 10 &", output: "Task task-1 launched" }) }),
        task: encodeTaskDetails({ taskId: "task-1", logUri: "", description: "Background task" })
      });
      insertStep(db, {
        idx: 2,
        stepType: 15,
        status: 3,
        stepPayload: encodeStepPayload({ agentText: "Preserving context while waiting for background command output..." })
      });
      db.close();

      // Fresh TUI needs two idle markers. Emit the turn-complete marker early;
      // without hasActiveBackgroundTasks the prompt would resolve here.
      setTimeout(() => {
        pty.emitData("? for shortcuts");
        setTimeout(async () => {
          const db2 = new (await import("better-sqlite3")).default(path.join(dir, "bg-test.db"));
          insertStep(db2, {
            idx: 3,
            stepType: 15,
            status: 3,
            stepPayload: encodeStepPayload({
              agentText: '<SYSTEM_MESSAGE>\n[Message] sender=task-1 content=Task id "task-1" finished'
            })
          });
          db2.close();
          setTimeout(async () => {
            const db3 = new (await import("better-sqlite3")).default(path.join(dir, "bg-test.db"));
            insertStep(db3, {
              idx: 4,
              stepType: 15,
              status: 3,
              stepPayload: encodeStepPayload({ agentText: "The background task completed successfully." })
            });
            db3.close();
          }, 200);
        }, 250);
      }, 20);
    });

    const session = interactiveSession(dir, pty);
    const updates: any[] = [];
    let resolved = false;
    const pending = session.prompt("run bg", async (update) => {
      updates.push(update);
    }, async () => "agy-allow-once").then((value) => {
      resolved = true;
      return value;
    });

    // Idle marker has fired and "preserving context" is on disk, but the
    // background task is still active — turn must stay open (gh#68).
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(resolved).toBe(false);

    // The internal completion wake is not itself the assistant's deliverable.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(resolved).toBe(false);

    const outcome = await pending;
    expect(outcome.stopReason).toBe("end_turn");
    expect(resolved).toBe(true);
    expect(updates.some(u => u.sessionUpdate === "agent_message_chunk" && u.content.text.includes("Preserving context"))).toBe(true);
    expect(updates.some(u => u.sessionUpdate === "agent_message_chunk" && u.content.text.includes("completed successfully"))).toBe(true);
    // Zero prompt injection: never invent follow-ups (e.g. "continue").
    // Fresh interactive spawn puts the user prompt in argv; PTY writes stay empty.
    expect(pty.writes).toEqual([]);
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes only the verbatim user prompt back to a reused interactive PTY", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-reuse-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "reuse");
      insertStep(db, { idx: 1, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done one" }) });
      db.close();
      // Fresh TUI owes a second idle marker before the first turn resolves.
      setTimeout(() => pty.emitData("? for shortcuts"), 60);
    });
    const startupEvents: string[] = [];
    const session = interactiveSession(dir, pty, "3s", {
      startupLauncher: recordingStartupLauncher(startupEvents)
    });

    // First turn: fresh spawn, prompt rides in argv; PTY writes stay empty.
    await session.prompt("first", async () => {}, async () => "agy-allow-once");
    expect(pty.writes).toEqual([]);
    expect(pty.killed).toBe(false);
    expect(startupEvents).toEqual(["acquire:resident_pty"]);

    // Second turn reuses the live TUI. The only PTY write must be the user's
    // own prompt under bracketed paste — never adapter prose or "continue".
    const db = new (await import("better-sqlite3")).default(path.join(dir, "reuse.db"));
    insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done two" }) });
    db.close();
    setTimeout(() => pty.emitData("? for shortcuts"), 40);

    await session.prompt("second", async () => {}, async () => "agy-allow-once");
    expect(pty.writes).toEqual(["\x1b[200~second\x1b[201~\r"]);
    expect(startupEvents).toEqual(["acquire:resident_pty"]);
    await session.close();
    expect(startupEvents).toEqual(["acquire:resident_pty", "release:resident_pty"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("pauses turn deadline while waiting for ACP client permission response and extends turn timeout", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "permission-timeout");
      insertStep(db, pendingToolRow("run_command"));
      db.close();
    });
    const session = interactiveSession(dir, pty, "2s");

    const result = session.prompt("go", async () => {}, async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const db = new (await import("better-sqlite3")).default(path.join(dir, "permission-timeout.db"));
      updateStep(db, 1, { status: 3 });
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 450);
      return "agy-allow-once";
    });

    expect((await result).stopReason).toBe("end_turn");
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("re-arms turn deadline to full printTimeout after permission prompt resolves", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "permission-rearm");
      insertStep(db, pendingToolRow("run_command"));
      db.close();
    });
    // Set a short printTimeout of 300ms
    const session = interactiveSession(dir, pty, "300ms");

    const result = session.prompt("go", async () => {}, async () => {
      // User takes 150ms to answer permission prompt
      await new Promise((resolve) => setTimeout(resolve, 150));
      // After permission resolves, agy executes command which completes 250ms later (total 400ms wall clock)
      setTimeout(async () => {
        const { default: Database } = await import("better-sqlite3");
        const db = new Database(path.join(dir, "permission-rearm.db"));
        updateStep(db, 1, { status: 3 });
        insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
        db.close();
        pty.emitData("? for shortcuts");
      }, 250);
      return "agy-allow-once";
    });

    expect((await result).stopReason).toBe("end_turn");
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("re-forwards a re-armed status-9 prompt on the same run_command step (compound `a && b`)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "compound");
      insertStep(db, pendingToolRow("run_command", '{"CommandLine":"git status && git log"}'));
      db.close();
    });
    const session = interactiveSession(dir, pty);
    let calls = 0;
    const result = session.prompt("go", async () => {}, async () => {
      calls++;
      const { default: Database } = await import("better-sqlite3");
      const db = new Database(path.join(dir, "compound.db"));
      if (calls === 1) {
        // agy granted segment 1 (`git status`) but stays at status 9 awaiting
        // the next segment's decision — a re-armed prompt on the same step.
        db.prepare("UPDATE steps SET permissions = ? WHERE idx = 1").run(
          Buffer.from(encodePermissions({ kind: "command", value: "git status", decision: 1 }))
        );
      } else {
        db.prepare("UPDATE steps SET permissions = ?, status = 3 WHERE idx = 1").run(
          Buffer.from(encodePermissions({ kind: "unsandboxed", value: "git log", decision: 1 }))
        );
        insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
        setTimeout(() => pty.emitData("? for shortcuts"), 50);
      }
      db.close();
      return "agy-allow-conversation";
    });
    expect((await result).stopReason).toBe("end_turn");
    // Both segments gated — the second must not be swallowed by toolCallId dedup.
    expect(calls).toBe(2);
    expect(pty.writes).toEqual(["\x1b[B", "\r", "\x1b[B", "\r"]);
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("re-forwards identical sequential permission prompts on the same step without swallowing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "identical-gates");
      insertStep(db, pendingToolRow("run_command", '{"CommandLine":"echo x && echo x && echo x"}'));
      db.close();
    });
    const session = interactiveSession(dir, pty);
    let calls = 0;
    const result = session.prompt("go", async () => {}, async () => {
      calls++;
      const { default: Database } = await import("better-sqlite3");
      const db = new Database(path.join(dir, "identical-gates.db"));
      if (calls < 3) {
        // Same permission details (kind, value, decision) on consecutive gates
        db.prepare("UPDATE steps SET permissions = ? WHERE idx = 1").run(
          Buffer.from(encodePermissions({ kind: "command", value: "echo x", decision: 1 }))
        );
        // The next identical panel arrives immediately, with no marker-free
        // render or debounce gap between permission generations.
        setTimeout(() => {
          pty.emitData("Yes, and ");
          pty.emitData("always allow");
        }, 5);
      } else {
        db.prepare("UPDATE steps SET permissions = ?, status = 3 WHERE idx = 1").run(
          Buffer.from(encodePermissions({ kind: "command", value: "echo x", decision: 1 }))
        );
        insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
        setTimeout(() => pty.emitData("? for shortcuts"), 50);
      }
      db.close();
      return "agy-allow-once";
    });
    expect((await result).stopReason).toBe("end_turn");
    expect(calls).toBe(3);
    expect(pty.writes).toEqual(["\r", "\r", "\r"]);
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not treat arrow-key redraws of the same permission panel as another gate", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "gate-footer-redraw");
      insertStep(db, pendingToolRow("run_command"));
      db.close();
    });
    const session = interactiveSession(dir, pty);
    let calls = 0;
    const result = session.prompt("go", async () => {}, async () => {
      calls++;
      // The initial panel render can still be inside the debounce window when
      // the ACP response resolves. The Down key then redraws that same panel.
      pty.emitData("Yes, and always allow");
      setTimeout(() => pty.emitData("Yes, and always allow"), 10);
      setTimeout(async () => {
        const { default: Database } = await import("better-sqlite3");
        const db = new Database(path.join(dir, "gate-footer-redraw.db"));
        updateStep(db, 1, { status: 3 });
        insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
        db.close();
        pty.emitData("? for shortcuts");
      }, 300);
      return "agy-allow-conversation";
    });

    expect((await result).stopReason).toBe("end_turn");
    expect(calls).toBe(1);
    expect(pty.writes).toEqual(["\x1b[B", "\r"]);
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("bridges manage_task status-9 interaction through full PTY turn loop", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const manageInput = JSON.stringify({ Action: "send_input", TaskId: "task-7", Input: "yes\n" });
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "manage-task");
      insertStep(db, pendingToolRow("manage_task", manageInput, 132));
      db.close();
    });
    const session = interactiveSession(dir, pty);
    const result = session.prompt("go", async () => {}, async () => {
      const db = new (await import("better-sqlite3")).default(path.join(dir, "manage-task.db"));
      updateStep(db, 1, { status: 3 });
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "sent input" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 150);
      return "agy-allow-once";
    });
    expect((await result).stopReason).toBe("end_turn");
    expect(pty.writes).toEqual(["\r"]);
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("bridges single-select ask_question via PTY option keys", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const askInput = JSON.stringify({
      questions: [{
        question: "Which approach?",
        options: ["Option A", "Option B", "Option C"],
        is_multi_select: false
      }]
    });
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "ask");
      insertStep(db, pendingToolRow("ask_question", askInput, 138));
      db.close();
    });
    const session = interactiveSession(dir, pty);
    const result = session.prompt("clarify", async () => {}, async () => {
      const db = new (await import("better-sqlite3")).default(path.join(dir, "ask.db"));
      updateStep(db, 1, { status: 3 });
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "thanks" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 50);
      return "agy-q-1";
    });
    expect((await result).stopReason).toBe("end_turn");
    expect(pty.writes).toEqual(["\x1b[B\r"]);
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("bridges multi-select ask_question via PTY option keys", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const askInput = JSON.stringify({
      questions: [{
        question: "Pick many",
        options: ["A", "B", "C"],
        is_multi_select: true
      }]
    });
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "ask-multi");
      insertStep(db, pendingToolRow("ask_question", askInput, 138));
      db.close();
    });
    const session = interactiveSession(dir, pty);
    const result = session.prompt("go", async () => {}, async () => {
      const db = new (await import("better-sqlite3")).default(path.join(dir, "ask-multi.db"));
      updateStep(db, 1, { status: 3 });
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 50);
      return "agy-q-0,2";
    });
    expect((await result).stopReason).toBe("end_turn");
    expect(pty.writes).toEqual([" \x1b[B\x1b[B \r"]);
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("bridges multi-question ask_question sequences via PTY option keys", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const askInput = JSON.stringify({
      questions: [
        { question: "Q1", options: ["X", "Y"], is_multi_select: false },
        { question: "Q2", options: ["M", "N"], is_multi_select: true }
      ]
    });
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "ask-seq");
      insertStep(db, pendingToolRow("ask_question", askInput, 138));
      db.close();
    });
    const session = interactiveSession(dir, pty);
    const choices = ["agy-q-q0-1", "agy-q-q1-0,1"];
    let qCount = 0;
    const result = session.prompt("go", async () => {}, async (_call, context) => {
      expect(context.questionIndex).toBe(qCount);
      const choice = choices[qCount++];
      if (qCount === 2) {
        setTimeout(async () => {
          const db = new (await import("better-sqlite3")).default(path.join(dir, "ask-seq.db"));
          updateStep(db, 1, { status: 3 });
          insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
          db.close();
          pty.emitData("? for shortcuts");
        }, 100);
      }
      return choice;
    });
    expect((await result).stopReason).toBe("end_turn");
    expect(pty.writes).toEqual(["\x1b[B\r", " \x1b[B \r"]);
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("bridges replace_file_content permission menus like run_command", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "replace");
      insertStep(db, pendingToolRow("replace_file_content", '{"TargetFile":"/repo/src/cli.ts"}', 5));
      db.close();
    });
    const session = interactiveSession(dir, pty);
    const result = session.prompt("edit it", async () => {}, async () => {
      const db = new (await import("better-sqlite3")).default(path.join(dir, "replace.db"));
      updateStep(db, 1, { status: 3 });
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 50);
      return "agy-allow-once";
    });
    expect((await result).stopReason).toBe("end_turn");
    expect(pty.writes).toEqual(["\r"]);
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });


  it("offers review for an edit that already applied without a live gate, and reverts on reject", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const targetFile = path.join(dir, "target.txt");
    fs.writeFileSync(targetFile, "before\nNEW\nafter", "utf8");
    const rawInputJson = JSON.stringify({ TargetFile: targetFile, TargetContent: "OLD", ReplacementContent: "NEW" });
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "already-applied");
      insertStep(db, {
        idx: 1,
        stepType: 5,
        status: 3,
        stepPayload: encodeStepPayload({
          toolRun: encodeToolRun({ call: encodeToolCall({ callId: "edit-1", namePrimary: "replace_file_content", rawInputJson }) })
        })
      });
      db.close();
    });
    const session = interactiveSession(dir, pty);
    let sawKind: string | undefined;
    let sawStatus: string | undefined;
    const result = session.prompt("edit it", async () => {}, async (toolCall) => {
      const raw = toolCall as unknown as { kind?: string; status?: string };
      sawKind = raw.kind;
      sawStatus = raw.status;
      const db = new (await import("better-sqlite3")).default(path.join(dir, "already-applied.db"));
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 0);
      return "reject-once";
    });
    expect((await result).stopReason).toBe("end_turn");
    expect(sawKind).toBe("edit");
    expect(sawStatus).toBe("completed");
    // No live agy gate to answer — nothing sent to the PTY.
    expect(pty.writes).toEqual([]);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("before\nOLD\nafter");
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("makes a rejected completed write authoritative over provider success output", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-posthoc-deny-"));
    const targetFile = path.join(dir, "created.txt");
    const requestedContent = "DENY_CONNECTOR_514";
    const rawInputJson = JSON.stringify({
      TargetFile: targetFile,
      CodeContent: requestedContent,
      Overwrite: true
    });
    const pty = new FakePty(() => {
      fs.writeFileSync(targetFile, `${requestedContent}\n`, "utf8");
      const db = createConversationDb(dir, "posthoc-deny");
      insertStep(db, {
        idx: 1,
        stepType: 15,
        status: 3,
        stepPayload: encodeStepPayload({ agentText: "Permission granted. Now I'll create the file." })
      });
      insertStep(db, {
        idx: 2,
        stepType: 5,
        status: 3,
        stepPayload: encodeStepPayload({
          toolRun: encodeToolRun({
            call: encodeToolCall({
              callId: "posthoc-edit-1",
              namePrimary: "write_to_file",
              rawInputJson
            })
          })
        })
      });
      insertStep(db, {
        idx: 3,
        stepType: 15,
        status: 3,
        stepPayload: encodeStepPayload({ agentText: "Done. The file was created successfully." })
      });
      db.close();
    });
    const session = interactiveSession(dir, pty);
    const updates: SessionUpdate[] = [];

    try {
      const result = session.prompt("create it", async (update) => {
        updates.push(update);
      }, async () => {
        setTimeout(() => pty.emitData("? for shortcuts"), 0);
        return "reject-once";
      });

      expect((await result).stopReason).toBe("end_turn");
      expect(fs.existsSync(targetFile)).toBe(false);

      const toolUpdates = updates.filter((update) =>
        (update as unknown as { toolCallId?: string }).toolCallId === "posthoc-edit-1"
      );
      expect(toolUpdates.length).toBeGreaterThan(0);
      expect((toolUpdates.at(-1) as unknown as { status?: string }).status).toBe("failed");

      const visibleAgentText = updates
        .filter((update) => update.sessionUpdate === "agent_message_chunk")
        .map((update) => (update as unknown as { content?: { text?: string } }).content?.text ?? "")
        .join("\n");
      expect(visibleAgentText).not.toContain("Permission granted");
      expect(visibleAgentText).not.toContain("created successfully");
    } finally {
      await session.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not offer posthoc edit review after switching to dangerous permission bypass", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-danger-posthoc-"));
    const targetFile = path.join(dir, "created.txt");
    const requestedContent = "DANGEROUS_BYPASS_KEEP_741";
    const rawInputJson = JSON.stringify({
      TargetFile: targetFile,
      CodeContent: requestedContent,
      Overwrite: true
    });
    let session!: AgyCliSession;
    const pty = new FakePty(() => {
      session.setMode("dangerously-skip-permissions");
      fs.writeFileSync(targetFile, `${requestedContent}\n`, "utf8");
      const db = createConversationDb(dir, "danger-posthoc");
      insertStep(db, {
        idx: 1,
        stepType: 5,
        status: 3,
        stepPayload: encodeStepPayload({
          toolRun: encodeToolRun({
            call: encodeToolCall({
              callId: "danger-posthoc-edit-1",
              namePrimary: "write_to_file",
              rawInputJson
            })
          })
        })
      });
      insertStep(db, {
        idx: 2,
        stepType: 15,
        status: 3,
        stepPayload: encodeStepPayload({ agentText: "Done. The file was created successfully." })
      });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 0);
    });
    session = interactiveSession(dir, pty);
    const updates: SessionUpdate[] = [];
    let permissionCalls = 0;

    try {
      const result = session.prompt("create it", async (update) => {
        updates.push(update);
      }, async () => {
        permissionCalls++;
        return "reject-once";
      });

      expect((await result).stopReason).toBe("end_turn");
      expect(permissionCalls).toBe(0);
      expect(fs.readFileSync(targetFile, "utf8")).toBe(`${requestedContent}\n`);
      expect(pty.writes).toEqual([]);

      const toolUpdates = updates.filter((update) =>
        (update as unknown as { toolCallId?: string }).toolCallId === "danger-posthoc-edit-1"
      );
      expect(toolUpdates.length).toBeGreaterThan(0);
      expect((toolUpdates.at(-1) as unknown as { status?: string }).status).toBe("completed");
    } finally {
      await session.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports the surviving content when a rejected edit's revert cannot restore it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const conversations = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-conv-"));
    const targetFile = path.join(dir, "a.txt");
    fs.writeFileSync(targetFile, "before", "utf8");
    const rawInputJson = JSON.stringify({
      TargetFile: targetFile,
      TargetContent: "before",
      ReplacementContent: "structured"
    });
    const pty = new FakePty(() => {
      // agy applied the structured edit, then a shell command overwrote it, so
      // the revert has nothing it can safely restore.
      fs.writeFileSync(targetFile, "structured", "utf8");
      fs.writeFileSync(targetFile, "shell final", "utf8");
      const db = createConversationDb(conversations, "diverged-reject");
      insertStep(db, {
        idx: 1,
        stepType: 5,
        status: 3,
        stepPayload: encodeStepPayload({
          toolRun: encodeToolRun({
            call: encodeToolCall({ callId: "edit-1", namePrimary: "replace_file_content", rawInputJson })
          })
        })
      });
      db.close();
    });
    const session = new AgyCliSession(
      {
        ...defaultConfig(),
        cwd: dir,
        conversationsDir: conversations,
        interactivePermissions: true,
        printTimeout: "3s"
      },
      undefined,
      { spawn: () => { pty.start(); return pty; } } as PtyFactory
    );
    const updates: SessionUpdate[] = [];
    const result = session.prompt("edit it", async (update) => { updates.push(update); }, async () => {
      const db = new (await import("better-sqlite3")).default(path.join(conversations, "diverged-reject.db"));
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 0);
      return "reject-once";
    });

    expect((await result).stopReason).toBe("end_turn");
    // Rejecting could not undo the diverged file, so its surviving content is
    // reported instead of being suppressed as already reflected.
    const reconciled = updates.filter((update) =>
      String((update as unknown as { toolCallId?: string }).toolCallId).startsWith("agy-fs-reconcile")
    );
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({
      kind: "edit",
      status: "completed",
      content: [{ type: "diff", path: targetFile, oldText: "before", newText: "shell final" }]
    });
    expect(fs.readFileSync(targetFile, "utf8")).toBe("shell final");
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(conversations, { recursive: true, force: true });
  });

  it("reports an unrelated change that survives a rejected edit's revert", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const conversations = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-conv-"));
    const targetFile = path.join(dir, "a.txt");
    fs.writeFileSync(targetFile, "alpha\nOLD\nomega\n", "utf8");
    const rawInputJson = JSON.stringify({
      TargetFile: targetFile,
      TargetContent: "OLD",
      ReplacementContent: "NEW"
    });
    const pty = new FakePty(() => {
      // agy applied the snippet replacement, then a formatter rewrote another
      // section before the tool-call was polled.
      fs.writeFileSync(targetFile, "alpha\nNEW\nomega\n", "utf8");
      fs.writeFileSync(targetFile, "ALPHA\nNEW\nomega\n", "utf8");
      const db = createConversationDb(conversations, "reject-keeps-shell-change");
      insertStep(db, {
        idx: 1,
        stepType: 5,
        status: 3,
        stepPayload: encodeStepPayload({
          toolRun: encodeToolRun({
            call: encodeToolCall({ callId: "edit-1", namePrimary: "replace_file_content", rawInputJson })
          })
        })
      });
      db.close();
    });
    const session = new AgyCliSession(
      {
        ...defaultConfig(),
        cwd: dir,
        conversationsDir: conversations,
        interactivePermissions: true,
        printTimeout: "3s"
      },
      undefined,
      { spawn: () => { pty.start(); return pty; } } as PtyFactory
    );
    const updates: SessionUpdate[] = [];
    const result = session.prompt("edit it", async (update) => { updates.push(update); }, async () => {
      const db = new (await import("better-sqlite3")).default(path.join(conversations, "reject-keeps-shell-change.db"));
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 0);
      return "reject-once";
    });

    expect((await result).stopReason).toBe("end_turn");
    // The revert restored only the reported snippet; the formatter's change
    // survived and must still be reported, not folded into the rejection.
    expect(fs.readFileSync(targetFile, "utf8")).toBe("ALPHA\nOLD\nomega\n");
    const reconciled = updates.filter((update) =>
      String((update as unknown as { toolCallId?: string }).toolCallId).startsWith("agy-fs-reconcile")
    );
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({
      kind: "edit",
      status: "completed",
      content: [{ type: "diff", path: targetFile, oldText: "alpha\nOLD\nomega\n", newText: "ALPHA\nOLD\nomega\n" }]
    });
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(conversations, { recursive: true, force: true });
  });

  it("leaves an already-applied edit in place when the client keeps it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const targetFile = path.join(dir, "target.txt");
    fs.writeFileSync(targetFile, "before\nNEW\nafter", "utf8");
    const rawInputJson = JSON.stringify({ TargetFile: targetFile, TargetContent: "OLD", ReplacementContent: "NEW" });
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "already-applied-keep");
      insertStep(db, {
        idx: 1,
        stepType: 5,
        status: 3,
        stepPayload: encodeStepPayload({
          toolRun: encodeToolRun({ call: encodeToolCall({ callId: "edit-1", namePrimary: "replace_file_content", rawInputJson }) })
        })
      });
      db.close();
    });
    const session = interactiveSession(dir, pty);
    const result = session.prompt("edit it", async () => {}, async () => {
      const db = new (await import("better-sqlite3")).default(path.join(dir, "already-applied-keep.db"));
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 0);
      return "allow-once";
    });
    expect((await result).stopReason).toBe("end_turn");
    expect(pty.writes).toEqual([]);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("before\nNEW\nafter");
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("routes an already-applied edit through the client's fs write-through instead of asking permission", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const targetFile = path.join(dir, "target.txt");
    fs.writeFileSync(targetFile, "before\nNEW\nafter", "utf8");
    const rawInputJson = JSON.stringify({ TargetFile: targetFile, TargetContent: "OLD", ReplacementContent: "NEW" });
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "fs-bridge-route");
      insertStep(db, {
        idx: 1,
        stepType: 5,
        status: 3,
        stepPayload: encodeStepPayload({
          toolRun: encodeToolRun({ call: encodeToolCall({ callId: "edit-1", namePrimary: "replace_file_content", rawInputJson }) })
        })
      });
      db.close();
    });
    const session = interactiveSession(dir, pty);
    const reads: string[] = [];
    const writes: Array<{ path: string; content: string }> = [];
    let permissionCalls = 0;
    const fsBridge = {
      readTextFile: async (p: string) => { reads.push(p); },
      writeTextFile: async (p: string, content: string) => {
        writes.push({ path: p, content });
        fs.writeFileSync(p, content, "utf8");
      }
    };
    const result = session.prompt("edit it", async () => {}, async () => {
      permissionCalls++;
      return "allow-once";
    }, fsBridge);
    setTimeout(async () => {
      const db = new (await import("better-sqlite3")).default(path.join(dir, "fs-bridge-route.db"));
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      pty.emitData("? for shortcuts");
    }, 50);
    expect((await result).stopReason).toBe("end_turn");
    expect(permissionCalls).toBe(0);
    expect(reads).toEqual([targetFile]);
    expect(writes).toEqual([{ path: targetFile, content: "before\nNEW\nafter" }]);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("before\nNEW\nafter");
    expect(pty.writes).toEqual([]);
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("falls back to the local permission bridge if the client's fs write-through fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const targetFile = path.join(dir, "target.txt");
    fs.writeFileSync(targetFile, "before\nNEW\nafter", "utf8");
    const rawInputJson = JSON.stringify({ TargetFile: targetFile, TargetContent: "OLD", ReplacementContent: "NEW" });
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "fs-bridge-fallback");
      insertStep(db, {
        idx: 1,
        stepType: 5,
        status: 3,
        stepPayload: encodeStepPayload({
          toolRun: encodeToolRun({ call: encodeToolCall({ callId: "edit-1", namePrimary: "replace_file_content", rawInputJson }) })
        })
      });
      db.close();
    });
    const session = interactiveSession(dir, pty);
    let permissionCalls = 0;
    const fsBridge = {
      readTextFile: async () => {},
      writeTextFile: async () => { throw new Error("client rejected the write"); }
    };
    const result = session.prompt("edit it", async () => {}, async () => {
      permissionCalls++;
      const db = new (await import("better-sqlite3")).default(path.join(dir, "fs-bridge-fallback.db"));
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 0);
      return "reject-once";
    }, fsBridge);
    expect((await result).stopReason).toBe("end_turn");
    expect(permissionCalls).toBe(1);
    // The failed write-through must leave disk exactly as it already reported
    // via session/update (newText), not stuck mid-revert.
    expect(fs.readFileSync(targetFile, "utf8")).toBe("before\nOLD\nafter");
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("also routes a live-gated edit (default mode) through the client's fs write-through once agy applies it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const targetFile = path.join(dir, "target.txt");
    fs.writeFileSync(targetFile, "before\nOLD\nafter", "utf8");
    const rawInputJson = JSON.stringify({ TargetFile: targetFile, TargetContent: "OLD", ReplacementContent: "NEW" });
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "fs-bridge-gated");
      insertStep(db, {
        idx: 1,
        stepType: 5,
        status: 9,
        stepPayload: encodeStepPayload({
          toolRun: encodeToolRun({ call: encodeToolCall({ callId: "edit-1", namePrimary: "replace_file_content", rawInputJson }) })
        })
      });
      db.close();
    });
    const session = interactiveSession(dir, pty);
    const reads: string[] = [];
    const writes: Array<{ path: string; content: string }> = [];
    let permissionCalls = 0;
    const fsBridge = {
      readTextFile: async (p: string) => { reads.push(p); },
      writeTextFile: async (p: string, content: string) => {
        writes.push({ path: p, content });
        fs.writeFileSync(p, content, "utf8");
      }
    };
    const result = session.prompt("edit it", async () => {}, async () => {
      permissionCalls++;
      // Simulate agy itself performing the write after the live gate is answered.
      fs.writeFileSync(targetFile, "before\nNEW\nafter", "utf8");
      const db = new (await import("better-sqlite3")).default(path.join(dir, "fs-bridge-gated.db"));
      updateStep(db, 1, { status: 3 });
      insertStep(db, { idx: 2, stepType: 15, status: 3, stepPayload: encodeStepPayload({ agentText: "done" }) });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 0);
      return "agy-allow-once";
    }, fsBridge);
    expect((await result).stopReason).toBe("end_turn");
    // Exactly one permission round trip — the live gate itself. The
    // subsequent write-through must not trigger a second local prompt.
    expect(permissionCalls).toBe(1);
    expect(pty.writes).toEqual(["\r"]);
    expect(reads).toEqual([targetFile]);
    expect(writes).toEqual([{ path: targetFile, content: "before\nNEW\nafter" }]);
    expect(fs.readFileSync(targetFile, "utf8")).toBe("before\nNEW\nafter");
    await session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("cancels reliably while awaiting permission", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => { const db = createConversationDb(dir, "cancel"); insertStep(db, pendingToolRow("run_command")); db.close(); });
    const session = interactiveSession(dir, pty);
    const pending = session.prompt("go", async () => {}, () => new Promise((resolve) => setTimeout(() => resolve("cancelled"), 300)));
    await new Promise((resolve) => setTimeout(resolve, 220));
    await session.cancel();
    expect((await pending).stopReason).toBe("cancelled");
    expect(pty.writes).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("cancels cleanly while waiting for the permission panel to render", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "cancel-panel-wait");
      insertStep(db, pendingToolRow("run_command"));
      db.close();
    });
    pty.emitPermissionPanelOnStart = false;
    const session = interactiveSession(dir, pty);
    const pending = session.prompt("go", async () => {}, async () => "agy-allow-once");
    setTimeout(() => void session.cancel(), 50);

    expect((await pending).stopReason).toBe("cancelled");
    expect(pty.writes).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("cancels cleanly while waiting for an arrow-key panel redraw", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty(() => {
      const db = createConversationDb(dir, "cancel-panel-redraw");
      insertStep(db, pendingToolRow("run_command"));
      db.close();
    });
    pty.emitArrowRedraw = false;
    const session = interactiveSession(dir, pty);
    const pending = session.prompt("go", async () => {}, async () => {
      setTimeout(() => void session.cancel(), 50);
      return "agy-allow-conversation";
    });

    expect((await pending).stopReason).toBe("cancelled");
    expect(pty.writes).toEqual(["\x1b[B"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("times out and stops the PTY when no conversation binds", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-pty-"));
    const pty = new FakePty();
    const session = interactiveSession(dir, pty, "30ms");
    await expect(session.prompt("go", async () => {}, async () => "cancelled")).rejects.toThrow(/timed out after 30ms/);
    expect(pty.killed).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("configFromEnv", () => {
  it("always invokes agy by name and relies on PATH resolution", () => {
    const config = configFromEnv({
      cwd: "/repo",
      additionalDirectories: ["/repo"],
      env: {
        PATH: "/bin"
      }
    });

    expect(config.agyPath).toBe("agy");
    expect(config.sandbox).toBe(true);
    expect(config.skipPermissions).toBe(false);
    expect(config.promptInArgv).toBe(true);
    expect(config.promptFreeDispatch).toBeUndefined();
    expect(config.autoInstall).toBe(false);
    expect(config.interactivePermissions).toBe(true);
  });

  it("configures mode from argv", () => {
    expect(configFromEnv({ cwd: "/repo" }).mode).toBe("default");
    expect(configFromEnv({ cwd: "/repo", argv: ["--mode", "accept-edits"] }).mode).toBe("accept-edits");
    expect(configFromEnv({ cwd: "/repo", argv: ["--dangerously-skip-permissions"] }).mode).toBe("dangerously-skip-permissions");
  });

  it("configures sandbox and skipPermissions based on argv", () => {
    const config1 = configFromEnv({
      cwd: "/repo",
      argv: ["--no-sandbox", "--dangerously-skip-permissions"]
    });
    expect(config1.sandbox).toBe(false);
    expect(config1.skipPermissions).toBe(true);
    expect(config1.interactivePermissions).toBe(false);

    const config4 = configFromEnv({
      cwd: "/repo",
      argv: ["--sandbox"]
    });
    expect(config4.sandbox).toBe(true);
  });

  it("enables interactive permissions by default and lets the dangerous bypass select print mode", () => {
    expect(configFromEnv({ cwd: "/repo" }).interactivePermissions).toBe(true);
    expect(configFromEnv({ cwd: "/repo", argv: ["--dangerously-skip-permissions"] }).interactivePermissions).toBe(false);
    expect(configFromEnv({ cwd: "/repo", argv: ["--no-interactive-permissions"] }).interactivePermissions).toBe(false);
  });
});

describe("parseAgyModels", () => {
  it("filters status and log lines for modern slug lists", () => {
    expect(parseAgyModels(`
Fetching available models...
I0701 10:23:00.894210 model_config_manager.go:157] log
gemini-3.5-flash-medium
claude-opus-4-6-thinking
gemini-3.5-flash-medium
  `)).toEqual(["gemini-3.5-flash-medium", "claude-opus-4-6-thinking"]);
  });
});

describe("listModels", () => {
  it("discovers models through agy models", async () => {
    const fake = new FakeProcess([`
Fetching available models...
gemini-3.5-flash-medium
claude-opus-4-6-thinking
    `]);
    const calls: SpawnCall[] = [];
    const backend = new AgyCliBackend(fake.spawnFactory(calls));
    const startupEvents: string[] = [];

    const models = await backend.listModels({
      ...defaultConfig(),
      startupLauncher: recordingStartupLauncher(startupEvents)
    });

    expect(models).toEqual(["gemini-3.5-flash-medium", "claude-opus-4-6-thinking"]);
    expect(calls[0].command).toBe("agy");
    expect(calls[0].args).toEqual(["models"]);
    expect(startupEvents).toEqual(["acquire:auxiliary", "release:auxiliary"]);
  });
});

describe("prompt", () => {
  it("preserves the legacy disabled argv dispatch path and drains stdout without reading it", async () => {
    const fake = new FakeProcess(["hello ", "world"]);
    const calls: SpawnCall[] = [];
    const disabledLauncher: AgyStartupLauncher = {
      enabled: false,
      acquire: () => {
        throw new Error("a disabled launcher must not acquire a permit");
      }
    };
    const session = new AgyCliSession({
      ...defaultConfig(),
      startupLauncher: disabledLauncher
    }, fake.spawnFactory(calls));

    const { updates, stopReason } = await collectUpdates(session, "hello");

    // No conversation database was written, so nothing is streamed — agy's
    // stdout is drained but never interpreted as ACP updates.
    expect(updates).toEqual([]);
    expect(stopReason).toBe("end_turn");
    expect(calls[0].args[calls[0].args.indexOf("--print") + 1]).toBe("hello");
    expect(fake.stdinText).toBe("");
    expect(fake.stdinEnded).toBe(true);
    expect(calls[0].options.launchSpecification).toBeUndefined();
  });

  it("rejects a terminal model-provider error observed after a print process exits", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-print-provider-error-"));
    const providerMessage =
      "FAILED_PRECONDITION (code 400): User location is not supported for the API use.";
    const fake = new FakeProcess([]);
    const calls: SpawnCall[] = [];
    const spawn = fake.spawnFactory(calls);
    const session = new AgyCliSession({
      ...defaultConfig(),
      interactivePermissions: false,
      conversationsDir: dir
    }, (command, args, options) => {
      const db = createConversationDb(dir, "provider-error");
      insertStep(db, {
        idx: 1,
        stepType: 17,
        status: 3,
        stepPayload: encodeStepPayload({
          modelProviderError: encodeModelProviderError({
            summary: providerMessage,
            diagnostic: "HTTP 400 Bad Request",
            responseJson: JSON.stringify({
              error: {
                code: 400,
                message: "User location is not supported for the API use.",
                status: "FAILED_PRECONDITION"
              }
            }),
            userMessage: providerMessage
          })
        })
      });
      db.close();
      return spawn(command, args, options);
    });

    try {
      await expect(collectUpdates(session, "go")).rejects.toEqual(expect.objectContaining({
        name: AgyCliError.name,
        message: expect.stringContaining(providerMessage)
      }));
    } finally {
      await session.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("starts print turns with a model-turn permit", async () => {
    const fake = new FakeProcess([]);
    const calls: SpawnCall[] = [];
    const startupEvents: string[] = [];
    const spawn = fake.spawnFactory(calls);
    const session = new AgyCliSession({
      ...defaultConfig(),
      startupLauncher: recordingStartupLauncher(startupEvents)
    }, (command, args, options) => {
      startupEvents.push("spawn");
      return spawn(command, args, options);
    });

    await collectUpdates(session, "hello");

    expect(calls).toHaveLength(1);
    expect(startupEvents).toEqual(["acquire:model_turn", "spawn", "release:model_turn"]);
  });

  it("fails closed before spawning or invoking the removed CLI-owned prompt-free boundary", async () => {
    const prompt = "prompt-secret-742";
    const calls: SpawnCall[] = [];
    const hookCalls: string[] = [];
    const fake = new FakeProcess([]);
    const session = new AgyCliSession({
      ...defaultConfig(),
      interactivePermissions: false,
      promptFreeDispatch: {
        enabled: true,
        fence: {
          requestId: "request-1",
          leaseId: "lease-1",
          generation: 7,
          ownerInstanceId: "connector-1"
        },
        captureProcessIdentity: () => {
          hookCalls.push("capture");
          return { startToken: "boot-1:100" };
        },
        persistProcessIdentity: () => {
          hookCalls.push("persist");
          return { status: "recorded" };
        },
        recheckCancellation: () => {
          hookCalls.push("recheck");
          return { generationMatches: true, ownerMatches: true, cancelled: false };
        },
        commitDispatchIntent: () => {
          hookCalls.push("commit");
          return { status: "committed" };
        },
        writeInitialPrompt: () => {
          hookCalls.push("write");
          return { status: "accepted" };
        }
      }
    }, fake.spawnFactory(calls));

    await expect(collectUpdates(session, prompt)).rejects.toMatchObject({
      state: "blocked",
      reason: "dispatcher_owned_prompt_required"
    });
    expect(calls).toEqual([]);
    expect(hookCalls).toEqual([]);
    expect(fake.stdinText).toBe("");
    expect(fake.stdinEnded).toBe(false);
  });

  it("keeps the existing prompt-in-argv PTY path fail closed for production prompt-free dispatch", async () => {
    const prompt = "pty-prompt-secret";
    const fake = new FakeProcess([]);
    const calls: SpawnCall[] = [];
    const session = new AgyCliSession({
      ...defaultConfig(),
      interactivePermissions: true,
      promptFreeDispatch: {
        enabled: true,
        fence: {
          requestId: "request-pty",
          leaseId: "lease-pty",
          generation: 1,
          ownerInstanceId: "connector-1"
        },
        captureProcessIdentity: (child) => ({ pid: child.pid }),
        persistProcessIdentity: () => ({ status: "recorded" }),
        recheckCancellation: () => ({ generationMatches: true, ownerMatches: true, cancelled: false }),
        commitDispatchIntent: () => ({ status: "committed" }),
        writeInitialPrompt: () => ({ status: "ambiguous" })
      }
    }, fake.spawnFactory(calls));

    await expect(session.prompt(prompt, async () => {}, async () => "agy-allow-once"))
      .rejects.toMatchObject({ state: "blocked", reason: "dispatcher_owned_prompt_required" });
    expect(calls).toEqual([]);
    expect(fake.stdinText).toBe("");
  });

  it("awaits print-mode reconciled filesystem write-through before ending the turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-print-reconcile-"));
    try {
      const file = path.join(dir, "a.txt");
      fs.writeFileSync(file, "before", "utf8");

      let releaseWrite!: () => void;
      const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve; });
      let markWriteStarted!: () => void;
      const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
      const updates: SessionUpdate[] = [];
      const session = new AgyCliSession(
        { ...defaultConfig(), cwd: dir, conversationsDir: path.join(dir, "conversations") },
        (command, args, options) => {
          fs.writeFileSync(file, "after", "utf8");
          return new FakeProcess([]).spawnFactory([])(command, args, options);
        }
      );

      let settled = false;
      const prompt = session.prompt(
        "edit it",
        async (update) => { updates.push(update); },
        undefined,
        {
          readTextFile: async () => {},
          writeTextFile: async (target, content) => {
            expect(fs.readFileSync(target, "utf8")).toBe("before");
            markWriteStarted();
            await writeGate;
            fs.writeFileSync(target, content, "utf8");
          }
        }
      ).finally(() => { settled = true; });

      await writeStarted;
      await new Promise((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(fs.readFileSync(file, "utf8")).toBe("before");

      releaseWrite();
      await expect(prompt).resolves.toEqual({ stopReason: "end_turn" });
      expect(fs.readFileSync(file, "utf8")).toBe("after");
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({ kind: "edit", status: "completed" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not re-emit a whole-file write whose reported oldText never existed pre-turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-structured-reconcile-"));
    const conversations = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-structured-conv-"));
    try {
      const file = path.join(dir, "a.txt");
      fs.writeFileSync(file, "before", "utf8");
      const rawInputJson = JSON.stringify({ TargetFile: file, CodeContent: "final" });
      const updates: SessionUpdate[] = [];
      const session = new AgyCliSession(
        { ...defaultConfig(), cwd: dir, conversationsDir: conversations },
        (command, args, options) => {
          // A shell command edited the file first, so the structured replace's
          // reported oldText ("shell") never existed in the pre-turn file.
          fs.writeFileSync(file, "shell", "utf8");
          fs.writeFileSync(file, "final", "utf8");
          const db = createConversationDb(conversations, "structured-reconcile");
          insertStep(db, {
            idx: 1,
            stepType: 5,
            status: 3,
            stepPayload: encodeStepPayload({
              toolRun: encodeToolRun({
                call: encodeToolCall({ callId: "edit-1", namePrimary: "replace_file_content", rawInputJson })
              })
            })
          });
          insertStep(db, {
            idx: 2,
            stepType: 15,
            status: 3,
            stepPayload: encodeStepPayload({ agentText: "Edit completed." })
          });
          db.close();
          return new FakeProcess([]).spawnFactory([])(command, args, options);
        }
      );

      const outcome = await session.prompt("edit it", async (update) => { updates.push(update); });

      expect(outcome).toEqual({ stopReason: "end_turn" });
      // The structured edit alone: reconciliation must not add a second,
      // contradictory before→final edit for the same file.
      expect(updates.filter((update) => (update as unknown as { kind?: string }).kind === "edit")).toHaveLength(1);
      expect(updates[0]).toMatchObject({ kind: "edit", status: "completed" });
      const reconciled = updates.filter((update) =>
        String((update as unknown as { toolCallId?: string }).toolCallId).startsWith("agy-fs-reconcile")
      );
      expect(reconciled).toEqual([]);
      expect(fs.readFileSync(file, "utf8")).toBe("final");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(conversations, { recursive: true, force: true });
    }
  });

  it("can write prompt through stdin", async () => {
    const fake = new FakeProcess(["ok"]);
    const calls: SpawnCall[] = [];
    const session = new AgyCliSession({ ...defaultConfig(), promptInArgv: false }, fake.spawnFactory(calls));

    await collectUpdates(session, "hello");

    expect(fake.stdinText).toBe("hello");
    expect(fake.stdinEnded).toBe(true);
    expect(calls[0].args[calls[0].args.indexOf("--print") + 1]).not.toBe("hello");
  });

  it("binds the conversation id agy creates, then passes --conversation on the next turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-test-"));
    try {
      const calls: SpawnCall[] = [];
      let turn = 0;
      const session = new AgyCliSession(
        { ...defaultConfig(), conversationsDir: dir },
        (command, args, options) => {
          calls.push({ command, args, options });
          turn += 1;
          if (turn === 1) {
            const db = createConversationDb(dir, "conv-123");
            insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "hi" }) });
            db.close();
          }
          return new FakeProcess([]).spawnFactory([])(command, args, options);
        }
      );

      await collectUpdates(session, "first");
      expect(calls[0].args).not.toContain("--conversation");
      expect(session.conversationId).toBe("conv-123");

      const db = new (await import("better-sqlite3")).default(path.join(dir, "conv-123.db"));
      insertStep(db, { idx: 2, stepType: 15, stepPayload: encodeStepPayload({ agentText: "second reply" }) });
      db.close();
      await collectUpdates(session, "second");
      expect(calls[1].args[calls[1].args.indexOf("--conversation") + 1]).toBe("conv-123");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("raises when agy exits nonzero", async () => {
    const fake = new FakeProcess([], { stderr: ["not logged in"], exitCode: 2 });
    const session = new AgyCliSession(defaultConfig(), fake.spawnFactory([]));

    await expect(collectUpdates(session, "hello")).rejects.toThrow(/not logged in/);
  });

  it("keeps a successful print process open until a post-tool final assistant message", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-print-final-"));
    try {
      const updates: SessionUpdate[] = [];
      const session = new AgyCliSession(
        { ...defaultConfig(), conversationsDir: dir, printTimeout: "1s" },
        (command, args, options) => {
          const db = createConversationDb(dir, "print-final");
          insertStep(db, {
            idx: 1,
            stepType: 15,
            status: 3,
            stepPayload: encodeStepPayload({ agentText: "I'll inspect the files first." })
          });
          insertStep(db, {
            idx: 2,
            stepType: 21,
            status: 3,
            stepPayload: encodeStepPayload({
              toolRun: encodeToolRun({
                call: encodeToolCall({
                  callId: "print-tool",
                  namePrimary: "run_command",
                  rawInputJson: '{"CommandLine":"pwd"}'
                })
              }),
              commandResult: encodeCommandResult({ command: "pwd", output: "/repo\n", exitCode: 0 })
            })
          });
          db.close();
          setTimeout(async () => {
            const db = new (await import("better-sqlite3")).default(path.join(dir, "print-final.db"));
            insertStep(db, {
              idx: 3,
              stepType: 15,
              status: 3,
              stepPayload: encodeStepPayload({ agentText: "The workspace is /repo." })
            });
            db.close();
          }, 350);
          return new FakeProcess([]).spawnFactory([])(command, args, options);
        }
      );

      let resolved = false;
      const result = session.prompt("inspect", async (update) => {
        updates.push(update);
      }).then((value) => { resolved = true; return value; });

      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(resolved).toBe(false);
      expect((await result).stopReason).toBe("end_turn");
      expect(updates.at(-1)).toMatchObject({
        sessionUpdate: "agent_message_chunk",
        content: { text: "The workspace is /repo." }
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("can install agy on demand when the default executable is missing", async () => {
    const installSpy = vi.spyOn(installer, "ensureAgyInstalled").mockImplementation(async (options = {}) => {
      if (options.env) {
        options.env.PATH = `/home/user/.local/bin:${options.env.PATH ?? ""}`;
      }
      return "/home/user/.local/bin/agy";
    });
    const missing = Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
    const processes = [
      new FakeProcess([], { spawnError: missing, exitCode: null }),
      new FakeProcess(["ok"])
    ];
    const calls: Array<{ command: string; args: string[] }> = [];
    const session = new AgyCliSession(
      { ...defaultConfig(), autoInstall: true, env: {} },
      (command, args, options) => {
        calls.push({ command, args });
        const process = processes.shift();
        expect(process, `unexpected spawn: ${command}`).toBeDefined();
        return process!.spawnFactory([])(command, args, options);
      }
    );

    const { stopReason } = await collectUpdates(session, "hello");

    expect(stopReason).toBe("end_turn");
    expect(installSpy).toHaveBeenCalledOnce();
    expect(calls.map((call) => call.command)).toEqual(["agy", "agy"]);
    installSpy.mockRestore();
  });

  it("includes install guidance when agy is missing without auto install", async () => {
    const missing = Object.assign(new Error("spawn agy ENOENT"), { code: "ENOENT" });
    const session = new AgyCliSession(
      defaultConfig(),
      new FakeProcess([], { spawnError: missing, exitCode: null }).spawnFactory([])
    );

    await expect(collectUpdates(session, "hello")).rejects.toThrow(/Install the Google Antigravity CLI/);
  });
});

describe("cancel", () => {
  it("sends SIGINT (not SIGTERM) so agy can flush its conversation database", async () => {
    const calls: SpawnCall[] = [];
    const fake = new FakeProcess([], { blockStdout: true, exitCode: null });
    const session = new AgyCliSession(defaultConfig(), fake.spawnFactory(calls));
    const pending = collectUpdates(session, "hello");

    // Print-mode turns snapshot the working tree before spawn; wait until the
    // child exists so cancel has a process to signal.
    await vi.waitFor(() => {
      expect(calls.length).toBeGreaterThan(0);
    });
    await session.cancel();

    expect(fake.killedWith).toBe("SIGINT");
    expect(session.wasCancelled).toBe(true);
    expect((await pending).stopReason).toBe("cancelled");
  });

  it("cancels agy process immediately and throws when onUpdate callback fails in print mode", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-print-update-fail-"));
    try {
      const calls: SpawnCall[] = [];
      const fake = new FakeProcess([], { blockStdout: true, exitCode: null });
      const session = new AgyCliSession(
        { ...defaultConfig(), conversationsDir: dir },
        (command, args, options) => {
          const db = createConversationDb(dir, "print-update-fail");
          insertStep(db, {
            idx: 1,
            stepType: 15,
            status: 3,
            stepPayload: encodeStepPayload({ agentText: "chunk one" })
          });
          db.close();
          return fake.spawnFactory(calls)(command, args, options);
        }
      );

      const callbackError = new Error("ACP client disconnected");
      await expect(
        session.prompt("hello", async () => {
          throw callbackError;
        })
      ).rejects.toThrow("ACP client disconnected");

      expect(fake.killedWith).toBe("SIGINT");
      expect(session.wasCancelled).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails the print-mode turn when background drain exceeds printTimeout", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-print-bg-timeout-"));
    try {
      const session = new AgyCliSession(
        { ...defaultConfig(), conversationsDir: dir, printTimeout: "200ms" },
        (command, args, options) => {
          const db = createConversationDb(dir, "print-bg-timeout");
          insertStep(db, {
            idx: 1,
            stepType: 21,
            status: 3,
            stepPayload: encodeStepPayload({
              commandResult: encodeCommandResult({ command: "sleep 999 &", output: "Task task-to launched" })
            }),
            task: encodeTaskDetails({ taskId: "task-to", logUri: "", description: "Background task" })
          });
          insertStep(db, {
            idx: 2,
            stepType: 15,
            status: 3,
            stepPayload: encodeStepPayload({
              agentText: "Preserving context while waiting for background command output..."
            })
          });
          db.close();
          return new FakeProcess([]).spawnFactory([])(command, args, options);
        }
      );

      await expect(collectUpdates(session, "run bg")).rejects.toThrow(
        /timed out after 200ms while waiting for background tasks/
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancels print-mode background drain after the child has already exited", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-print-bg-cancel-"));
    try {
      const session = new AgyCliSession(
        { ...defaultConfig(), conversationsDir: dir, printTimeout: "5s" },
        (command, args, options) => {
          // Child exits immediately, but background task rows remain incomplete.
          const db = createConversationDb(dir, "print-bg-cancel");
          insertStep(db, {
            idx: 1,
            stepType: 21,
            status: 3,
            stepPayload: encodeStepPayload({
              commandResult: encodeCommandResult({ command: "sleep 999 &", output: "Task task-c launched" })
            }),
            task: encodeTaskDetails({ taskId: "task-c", logUri: "", description: "Background task" })
          });
          insertStep(db, {
            idx: 2,
            stepType: 15,
            status: 3,
            stepPayload: encodeStepPayload({
              agentText: "Preserving context while waiting for background command output..."
            })
          });
          db.close();
          return new FakeProcess([]).spawnFactory([])(command, args, options);
        }
      );

      const pending = collectUpdates(session, "run bg");
      // Let the child exit and enter the post-exit background drain loop.
      await new Promise((resolve) => setTimeout(resolve, 80));
      await session.cancel();

      expect(session.wasCancelled).toBe(true);
      expect((await pending).stopReason).toBe("cancelled");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

interface SpawnCall {
  command: string;
  args: string[];
  options: SpawnOptions;
}

function defaultConfig(): AgyCliConfig {
  return {
    cwd: "/repo",
    additionalDirectories: [],
    agyPath: "agy",
    printTimeout: "5m0s",
    effort: undefined,
    mode: "default",
    sandbox: true,
    skipPermissions: false,
    interactivePermissions: false,
    promptInArgv: true,
    autoInstall: false,
    modelList: [],
    discoverModels: true,
    modelListTimeoutMs: DEFAULT_AGY_MODEL_LIST_TIMEOUT_MS,
    conversationsDir: DEFAULT_CONVERSATIONS_DIR
  };
}

function flagValue(command: string[], flag: string): string {
  return command[command.indexOf(flag) + 1];
}

interface FakeProcessOptions {
  stderr?: string[];
  exitCode?: number | null;
  blockStdout?: boolean;
  spawnError?: Error & { code?: string };
  onStdinWrite?: (text: string) => void;
}

class FakeProcess extends EventEmitter {
  stdinText = "";
  stdinEnded = false;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null = null;
  pid = 1;
  killedWith?: string;
  spawnError?: Error & { code?: string };

  constructor(chunks: string[], options: FakeProcessOptions = {}) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const text = chunk.toString();
        this.stdinText += text;
        options.onStdinWrite?.(text);
        callback();
      },
      final: (callback) => {
        this.stdinEnded = true;
        callback();
      }
    });
    this.spawnError = options.spawnError;
    this.exitCode = options.exitCode === undefined ? 0 : options.exitCode;
    this.stdout = options.blockStdout ? new Readable({ read() {} }) : Readable.from(chunks);
    this.stderr = Readable.from(options.stderr ?? []);
    if (!options.blockStdout && this.exitCode !== null) {
      queueMicrotask(() => this.emit("exit", this.exitCode, null));
    }
  }

  kill(signal?: string) {
    this.killedWith = signal;
    this.signalCode = typeof signal === "string" ? signal as NodeJS.Signals : "SIGTERM";
    this.exitCode = signal === "SIGKILL" ? -9 : -15;
    this.stdout.push(null);
    this.emit("exit", this.exitCode, signal ?? "SIGTERM");
    return true;
  }

  spawnFactory(calls: SpawnCall[]): SpawnFactory {
    return (command, args, options) => {
      calls.push({ command, args, options });
      if (this.spawnError) {
        queueMicrotask(() => this.emit("error", this.spawnError));
      }
      return this as unknown as ReturnType<SpawnFactory>;
    };
  }
}

function pendingToolRow(name: string, rawInputJson = '{"CommandLine":"echo hi"}', stepType = 21) {
  return { idx: 1, stepType, status: 9, stepPayload: encodeStepPayload({
    toolRun: encodeToolRun({ call: encodeToolCall({ callId: "permission-1", namePrimary: name, rawInputJson }) })
  }) };
}

function interactiveSession(
  dir: string,
  pty: FakePty,
  printTimeout = "3s",
  config: Partial<AgyCliConfig> = {}
) {
  return new AgyCliSession({ ...defaultConfig(), ...config, conversationsDir: dir, interactivePermissions: true, printTimeout }, undefined, {
    spawn: () => { pty.start(); return pty; }
  } as PtyFactory);
}

function recordingStartupLauncher(events: string[]): AgyStartupLauncher {
  return {
    enabled: true,
    acquire: (classification) => {
      events.push(`acquire:${classification}`);
      return {
        release: () => events.push(`release:${classification}`)
      };
    }
  };
}

function permissionWriteChunks(keys: string): string[] {
  const chunks: string[] = [];
  const down = "\x1b[B";
  let offset = 0;
  while (keys.startsWith(down, offset)) {
    chunks.push(down);
    offset += down.length;
  }
  if (offset < keys.length) chunks.push(keys.slice(offset));
  return chunks;
}

class FakePty implements PtyProcess {
  writes: string[] = [];
  killed = false;
  emitPermissionPanelOnStart = true;
  emitArrowRedraw = true;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number }) => void> = [];
  constructor(private readonly onSpawn?: () => void) {}
  start() {
    this.onSpawn?.();
    queueMicrotask(() => this.emitData(
      this.emitPermissionPanelOnStart ? "? for shortcuts\nYes, and always allow" : "? for shortcuts"
    ));
  }
  write(data: string) {
    this.writes.push(data);
    if (data === "\x1b[B" && this.emitArrowRedraw) {
      setTimeout(() => this.emitData("Yes, and always allow"), 0);
    }
  }
  kill() { this.killed = true; for (const listener of this.exitListeners) listener({ exitCode: 0 }); }
  onData(listener: (data: string) => void) { this.dataListeners.push(listener); return { dispose() {} }; }
  onExit(listener: (event: { exitCode: number }) => void) { this.exitListeners.push(listener); return { dispose() {} }; }
  emitData(data: string) { for (const listener of this.dataListeners) listener(data); }
}
