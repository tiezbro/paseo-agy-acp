import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { probeExactAgyBinaryVersion } from "../ACP Connector/agy/launch-spec.js";
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
  it("waits for fresh interactive PTY startup redraws to settle before the admitted prompt write", async () => {
    const workspace = tempDir("workspace");
    const conversations = tempDir("conversations");
    const pty = new ScriptedPty(() => {}, true, 250);
    pty.onBusinessWrite = () => {
      const db = createConversationDb(conversations, "fresh-ready");
      insertStep(db, {
        idx: 1,
        stepType: 15,
        status: 3,
        stepPayload: encodeStepPayload({ agentText: "ready turn done" })
      });
      db.close();
      queueMicrotask(() => pty.emitData("? for shortcuts"));
    };
    const session = new AgyCliSession(
      {
        ...defaultConfig(workspace, conversations),
        ...promptFreeBinaryConfig(workspace),
        interactivePermissions: true
      },
      unusedPrintSpawn,
      ptyFactory(pty)
    );

    try {
      const boundary = new RecordingBoundary();
      const outcome = await session.prompt(
        "wait for ready",
        async () => {},
        async () => {
          throw new Error("ready-only turn should not request permission");
        },
        undefined,
        undefined,
        boundary
      );

      expect(outcome).toEqual({ stopReason: "end_turn" });
      expect(pty.businessWrites).toEqual(["\x1b[200~wait for ready\x1b[201~\r"]);
      expect(boundary.events).toEqual([
        "preparePty:12345",
        "beforePromptWrite",
        "commitDispatchIntent",
        "afterPromptWrite"
      ]);
    } finally {
      await session.close().catch(() => {});
    }
  });

  it("builds an enabled non-skip session that reaches interactive permissions before dispatch fencing", async () => {
    const workspace = tempDir("workspace");
    const conversations = tempDir("conversations");
    const agyBinary = path.join(workspace, "agy");
    writeFileSync(agyBinary, "#!/bin/sh\nprintf '%s\\n' '1.1.13'\n", { mode: 0o700 });
    const pty = new ScriptedPty(() => {
      const db = createConversationDb(conversations, "permission-chain");
      insertStep(db, pendingPermissionStep());
      db.close();
    });
    let session: Awaited<ReturnType<typeof buildSession>> | undefined;

    try {
      session = await buildSession(workspace, [], null, {
        env: { ...process.env, NODE_ENV: "test", AGY_BIN: agyBinary },
        argv: ["--mode", "accept-edits"],
        backend: new AgyCliBackend(unusedPrintSpawn, ptyFactory(pty)),
        getModelOptions: async () => MODEL_LIST,
        conversationsDir: conversations,
        admissionEnabled: true
      });
      session.sessionId = "permission-session";
      session.agy.config.printTimeout = "1s";
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

  it("runs permission-bypass admission through one fenced prompt-free PTY and stops it after the turn", async () => {
    const workspace = tempDir("workspace");
    const conversations = tempDir("conversations");
    const agyBinary = path.join(workspace, "agy");
    writeFileSync(agyBinary, "#!/bin/sh\nprintf '%s\\n' 'agy version 1.1.13'\n", { mode: 0o700 });
    const pty = new ScriptedPty(() => {});
    pty.onBusinessWrite = () => {
      const db = createConversationDb(conversations, "permission-bypass");
      insertStep(db, {
        idx: 1,
        stepType: 15,
        status: 3,
        stepPayload: encodeStepPayload({ agentText: "permission bypass turn done" })
      });
      db.close();
      queueMicrotask(() => pty.emitData("? for shortcuts"));
    };
    let session: Awaited<ReturnType<typeof buildSession>> | undefined;

    try {
      session = await buildSession(workspace, [], null, {
        env: { ...process.env, NODE_ENV: "test", AGY_BIN: agyBinary },
        argv: ["--dangerously-skip-permissions"],
        backend: new AgyCliBackend(unusedPrintSpawn, ptyFactory(pty)),
        getModelOptions: async () => MODEL_LIST,
        conversationsDir: conversations,
        admissionEnabled: true
      });
      session.sessionId = "permission-bypass-session";
      session.agy.config.printTimeout = "1s";
      const boundary = new RecordingBoundary();

      const outcome = await session.agy.prompt(
        "run without permission prompts",
        async () => {},
        undefined,
        undefined,
        undefined,
        boundary
      );

      expect(outcome).toEqual({ stopReason: "end_turn" });
      expect(pty.businessWrites).toEqual([
        "\x1b[200~run without permission prompts\x1b[201~\r"
      ]);
      expect(pty.permissionWrites).toEqual([]);
      expect(boundary.events).toEqual([
        "preparePty:12345",
        "beforePromptWrite",
        "commitDispatchIntent",
        "afterPromptWrite"
      ]);
      expect(pty.killCalls).toBe(1);
    } finally {
      await session?.agy.close().catch(() => {});
    }
  });

  it("replaces a legacy resident PTY before fencing an admitted business prompt", async () => {
    const workspace = tempDir("workspace");
    const conversations = tempDir("conversations");
    const legacyPty = new ScriptedPty(() => {
      const db = createConversationDb(conversations, "permission-chain");
      insertStep(db, pendingPermissionStep());
      db.close();
    });
    const admittedPty = new ScriptedPty(() => {});
    admittedPty.onBusinessWrite = () => {
      const db = new Database(path.join(conversations, "permission-chain.db"));
      insertStep(db, {
        idx: 3,
        stepType: 15,
        status: 3,
        stepPayload: encodeStepPayload({ agentText: "second turn done" })
      });
      db.close();
      setTimeout(() => admittedPty.emitData("? for shortcuts"), 0);
    };
    const ptys = [legacyPty, admittedPty];

    const session = new AgyCliSession(
      {
        ...defaultConfig(workspace, conversations),
        ...promptFreeBinaryConfig(workspace),
        interactivePermissions: true,
        mode: "accept-edits"
      },
      unusedPrintSpawn,
      {
        spawn: () => {
          const next = ptys.shift();
          if (!next) throw new Error("unexpected extra PTY spawn");
          next.start();
          return next;
        }
      }
    );

    try {
      await session.prompt("first turn", async () => {}, async () => {
        completePermissionTurn(conversations, "permission-chain", legacyPty, 1, 2);
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
      expect(legacyPty.permissionWrites).toEqual(["\r"]);
      expect(legacyPty.businessWrites).toEqual([]);
      expect(legacyPty.killCalls).toBe(1);
      expect(admittedPty.businessWrites).toEqual(["\x1b[200~second turn\x1b[201~\r"]);
      expect(admittedPty.killCalls).toBe(1);
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

function promptFreeBinaryConfig(cwd: string): Pick<AgyCliConfig, "agyPath" | "verifiedAgyBinary"> {
  const agyPath = path.join(cwd, "agy-prompt-free-test");
  writeFileSync(agyPath, "#!/bin/sh\nprintf '%s\\n' 'agy version 1.1.13'\n", { mode: 0o700 });
  return {
    agyPath,
    verifiedAgyBinary: probeExactAgyBinaryVersion({ executable: agyPath, cwd })
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

  preparePty(processId: number): void {
    this.events.push(`preparePty:${processId}`);
  }

  beforePromptWrite(): void {
    this.events.push("beforePromptWrite");
  }

  commitDispatchIntent(): void {
    this.events.push("commitDispatchIntent");
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
  killCalls = 0;
  onBusinessWrite: ((data: string) => void) | undefined;
  private readonly dataListeners: Array<(data: string) => void> = [];
  private readonly exitListeners: Array<(event: { exitCode: number }) => void> = [];
  private ready = false;

  constructor(
    private readonly onStart: () => void,
    private readonly ignoreBusinessUntilReady = false,
    private readonly startupReadyDelayMs = 0
  ) {}

  start(): void {
    this.onStart();
    queueMicrotask(() => {
      if (this.startupReadyDelayMs === 0) this.ready = true;
      this.emitData("? for shortcuts\nYes, and always allow");
    });
    if (this.startupReadyDelayMs > 0) {
      setTimeout(() => this.emitData("loading model\n? for shortcuts"), 100);
      setTimeout(() => {
        this.ready = true;
        this.emitData("model ready\n? for shortcuts");
      }, this.startupReadyDelayMs);
    }
  }

  write(data: string): void {
    if (data.startsWith("\x1b[200~")) {
      if (this.ignoreBusinessUntilReady && !this.ready) return;
      this.businessWrites.push(data);
      this.onBusinessWrite?.(data);
      return;
    }
    this.permissionWrites.push(data);
  }

  kill(): void {
    this.killCalls++;
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
