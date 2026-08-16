import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { buildSession } from "../ACP Connector/acp/session/setup.js";
import {
  AgyCliBackend,
  AgyCliSession,
  DEFAULT_AGY_MODEL_LIST_TIMEOUT_MS,
  type AgyAdmissionDispatchBoundary,
  type AgyCliConfig,
  type PtyFactory,
  type PtyProcess,
  type SpawnFactory
} from "../ACP Connector/agy/cli.js";
import { createConversationDb, insertStep, updateStep } from "./fixtures/conversation-db.js";
import {
  encodeStepPayload,
  encodeToolCall,
  encodeToolRun
} from "./fixtures/step-encoder.js";

const MODEL_LIST = ["gemini-3.5-flash-medium"];
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("S3-T10 admission permission chain", () => {
  it("builds an enabled non-skip session that reaches interactive permissions before dispatch fencing", async () => {
    const workspace = tempDir("workspace");
    const conversations = tempDir("conversations");
    const pty = new ScriptedPty(() => {
      const db = createConversationDb(conversations, "permission-chain");
      insertStep(db, pendingPermissionStep());
      db.close();
    });
    let session: Awaited<ReturnType<typeof buildSession>> | undefined;

    try {
      session = await buildSession(workspace, [], null, {
        env: { NODE_ENV: "test" },
        argv: ["--mode", "accept-edits"],
        backend: new AgyCliBackend(unusedPrintSpawn, ptyFactory(pty)),
        getModelOptions: async () => MODEL_LIST,
        conversationsDir: conversations,
        admissionEnabled: true
      });
      session.sessionId = "permission-session";
      const boundary = new RecordingBoundary();
      let permissionRequests = 0;

      const outcome = await session.agy.prompt(
        "edit safely",
        async () => {},
        async () => {
          permissionRequests++;
          completePermissionTurn(conversations, "permission-chain", pty, 1, 2);
          return "agy-allow-once";
        },
        undefined,
        undefined,
        boundary
      );

      expect(outcome).toEqual({ stopReason: "end_turn" });
      expect(permissionRequests).toBe(1);
      expect(pty.permissionWrites).toEqual(["\r"]);
      expect(boundary.count("beforePromptWrite")).toBe(1);
      expect(boundary.count("afterPromptWrite")).toBe(1);
    } finally {
      await session?.agy.close().catch(() => {});
    }
  });

  it("fences one reused-PTY business prompt without counting permission-key writes as dispatch", async () => {
    const workspace = tempDir("workspace");
    const conversations = tempDir("conversations");
    const pty = new ScriptedPty(() => {
      const db = createConversationDb(conversations, "permission-chain");
      insertStep(db, pendingPermissionStep());
      db.close();
    });
    pty.onBusinessWrite = () => {
      const db = new Database(path.join(conversations, "permission-chain.db"));
      insertStep(db, {
        idx: 3,
        stepType: 15,
        status: 3,
        stepPayload: encodeStepPayload({ agentText: "second turn done" })
      });
      db.close();
      setTimeout(() => pty.emitData("? for shortcuts"), 0);
    };

    const session = new AgyCliSession(
      {
        ...defaultConfig(workspace, conversations),
        interactivePermissions: true,
        mode: "accept-edits"
      },
      unusedPrintSpawn,
      ptyFactory(pty)
    );

    try {
      await session.prompt("first turn", async () => {}, async () => {
        completePermissionTurn(conversations, "permission-chain", pty, 1, 2);
        return "agy-allow-once";
      });

      const boundary = new RecordingBoundary();
      const outcome = await session.prompt(
        "second turn",
        async () => {},
        async () => {
          throw new Error("second turn should not request a permission panel");
        },
        undefined,
        undefined,
        boundary
      );

      expect(outcome).toEqual({ stopReason: "end_turn" });
      expect(pty.permissionWrites).toEqual(["\r"]);
      expect(pty.businessWrites).toEqual(["\x1b[200~second turn\x1b[201~\r"]);
      expect(boundary.count("beforePromptWrite")).toBe(1);
      expect(boundary.count("afterPromptWrite")).toBe(1);
    } finally {
      await session.close().catch(() => {});
    }
  });
});

function tempDir(label: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), `paseo-agy-acp-permission-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function defaultConfig(cwd: string, conversationsDir: string): AgyCliConfig {
  return {
    cwd,
    additionalDirectories: [],
    agyPath: "agy",
    printTimeout: "1s",
    effort: undefined,
    mode: "default",
    sandbox: true,
    skipPermissions: false,
    interactivePermissions: true,
    promptInArgv: true,
    autoInstall: false,
    modelList: [],
    discoverModels: true,
    modelListTimeoutMs: DEFAULT_AGY_MODEL_LIST_TIMEOUT_MS,
    conversationsDir
  };
}

const unusedPrintSpawn: SpawnFactory = () => {
  throw new Error("S3-T10 permission RED must use the interactive PTY path");
};

function ptyFactory(pty: ScriptedPty): PtyFactory {
  return {
    spawn: () => {
      pty.start();
      return pty;
    }
  };
}

function pendingPermissionStep() {
  return {
    idx: 1,
    stepType: 21,
    status: 9,
    stepPayload: encodeStepPayload({
      toolRun: encodeToolRun({
        call: encodeToolCall({
          callId: "permission-1",
          namePrimary: "run_command",
          rawInputJson: '{"CommandLine":"touch requested.txt"}'
        })
      })
    })
  };
}

function completePermissionTurn(
  conversations: string,
  conversationId: string,
  pty: ScriptedPty,
  permissionIdx: number,
  finalIdx: number
): void {
  const db = new Database(path.join(conversations, `${conversationId}.db`));
  updateStep(db, permissionIdx, { status: 3 });
  insertStep(db, {
    idx: finalIdx,
    stepType: 15,
    status: 3,
    stepPayload: encodeStepPayload({ agentText: `turn ${finalIdx} done` })
  });
  db.close();
  setTimeout(() => pty.emitData("? for shortcuts"), 0);
}

class RecordingBoundary implements AgyAdmissionDispatchBoundary {
  readonly events: string[] = [];

  prepare(processId: number): void {
    this.events.push(`prepare:${processId}`);
  }

  beforePromptWrite(): void {
    this.events.push("beforePromptWrite");
  }

  afterPromptWrite(): void {
    this.events.push("afterPromptWrite");
  }

  count(event: string): number {
    return this.events.filter((value) => value === event).length;
  }
}

class ScriptedPty implements PtyProcess {
  readonly pid = 12_345;
  readonly permissionWrites: string[] = [];
  readonly businessWrites: string[] = [];
  onBusinessWrite: ((data: string) => void) | undefined;
  private readonly dataListeners: Array<(data: string) => void> = [];
  private readonly exitListeners: Array<(event: { exitCode: number }) => void> = [];

  constructor(private readonly onStart: () => void) {}

  start(): void {
    this.onStart();
    queueMicrotask(() => this.emitData("? for shortcuts\nYes, and always allow"));
  }

  write(data: string): void {
    if (data.startsWith("\x1b[200~")) {
      this.businessWrites.push(data);
      this.onBusinessWrite?.(data);
      return;
    }
    this.permissionWrites.push(data);
  }

  kill(): void {
    for (const listener of this.exitListeners) listener({ exitCode: 0 });
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.dataListeners.push(listener);
    return { dispose() {} };
  }

  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void } {
    this.exitListeners.push(listener);
    return { dispose() {} };
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
}
