import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AgyCliSession,
  DEFAULT_AGY_MODEL_LIST_TIMEOUT_MS,
  type AgyCliConfig,
  type SpawnFactory,
  type SpawnOptions
} from "../src/agy/cli.js";
import {
  probeExactAgyBinaryVersion,
  type VerifiedAgyBinary
} from "../src/agy/launch-spec.js";
import type { SqliteProviderSnapshotReader } from "../src/agy/db/provider-observer.js";

const BUSINESS_PROMPT = "connector prompt must stay on stdin";
const CONVERSATION_ID = "c3b66b04-872b-4fbe-a3a4-058a026ef20a";
const OTHER_CONVERSATION_ID = "055a398f-db14-4c5f-abbb-1bf03f8120a7";
const OBSERVED_AT = 1_725_000_000_000;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function streamLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function activeSnapshot(conversationId: string, cursor = 7) {
  return {
    conversationId,
    cursor,
    latest: { cursor, kind: "activity" as const, status: "ACTIVE" as const },
    backgroundTasks: "settled" as const
  };
}

function terminalSnapshot(conversationId: string, cursor = 8) {
  return {
    conversationId,
    cursor,
    latest: { cursor, kind: "terminal" as const, status: "SUCCESS" as const },
    backgroundTasks: "settled" as const
  };
}

describe("Agy exact SQLite conversation turn", () => {
  it("subscribes before the prompt write and exposes SQLite-only exact binding evidence", async () => {
    const fixture = verifiedAgyBinary();
    try {
      const child = new FakePromptFreeChild();
      const seen: string[] = [];
      let currentSnapshot: unknown = activeSnapshot(CONVERSATION_ID);
      const reader: SqliteProviderSnapshotReader = {
        readSnapshot(conversationId) {
          seen.push(conversationId);
          return currentSnapshot as never;
        }
      };
      const turn = new AgyCliSession(
        defaultConfig(fixture.binary),
        child.spawnFactory([])
      ).startExactConversationTurn(BUSINESS_PROMPT, {
        expectedConversationId: null,
        minimumCursor: 7,
        reader,
        now: () => OBSERVED_AT
      });
      const privatePayload = "stdout response, reasoning, and Authorization header must not escape";

      expect(child.stdout.listenerCount("data")).toBe(1);
      expect(turn).not.toHaveProperty("stdout");
      expect(turn).not.toHaveProperty("child");
      expect(Object.keys(turn).sort()).toEqual([
        "binding",
        "cancel",
        "exit",
        "processId",
        "promptChannel",
        "writeBusinessPrompt"
      ]);
      expect(turn.processId).toBe(571);
      expect(child.stdinText).toBe("");

      expect(turn.writeBusinessPrompt()).toEqual({ status: "accepted" });
      expect(child.stdinText).toBe(BUSINESS_PROMPT);
      child.stdout.write(streamLine({
        event: "init",
        conversation_id: CONVERSATION_ID,
        init: {
          reasoning: privatePayload,
          headers: { Authorization: privatePayload }
        }
      }));

      const binding = await turn.binding;
      expect(binding).toMatchObject({ conversationId: CONVERSATION_ID, cursor: 7 });
      expect(seen).toEqual([CONVERSATION_ID]);
      await expect(binding.observer.observeActivity()).resolves.toEqual({
        status: "observed",
        activity: {
          source: "sqlite_reconciliation",
          conversationId: CONVERSATION_ID,
          cursor: 7,
          observedAt: OBSERVED_AT,
          status: "ACTIVE"
        }
      });

      currentSnapshot = terminalSnapshot(CONVERSATION_ID);
      // Node may report process exit before its stdout pipe finishes draining.
      // The identity reader must remain attached until the matching result line.
      child.finish();
      child.stdout.end(streamLine({
        event: "result",
        result: {
          conversation_id: CONVERSATION_ID,
          response: privatePayload,
          reasoning: privatePayload,
          headers: { Authorization: privatePayload }
        }
      }));
      await expect(binding.streamCompletion).resolves.toEqual({
        status: "drained",
        conversationId: CONVERSATION_ID
      });
      await expect(binding.observer.observeTerminal()).resolves.toEqual({
        source: "sqlite_reconciliation",
        conversationId: CONVERSATION_ID,
        observedAt: OBSERVED_AT,
        status: "SUCCESS"
      });
      expect(seen).toEqual([CONVERSATION_ID, CONVERSATION_ID, CONVERSATION_ID]);
      expect(JSON.stringify(turn)).not.toContain(privatePayload);
      expect(JSON.stringify(binding)).not.toContain(privatePayload);
    } finally {
      fixture.cleanup();
    }
  });

  it("never selects another database and gates later stream mismatches before terminal evidence", async () => {
    const fixture = verifiedAgyBinary();
    try {
      const mismatchChild = new FakePromptFreeChild();
      const unexpectedReader = vi.fn(() => activeSnapshot(CONVERSATION_ID));
      const mismatchedTurn = new AgyCliSession(
        defaultConfig(fixture.binary),
        mismatchChild.spawnFactory([])
      ).startExactConversationTurn(BUSINESS_PROMPT, {
        expectedConversationId: CONVERSATION_ID,
        minimumCursor: 0,
        reader: { readSnapshot: unexpectedReader }
      });

      expect(mismatchedTurn.writeBusinessPrompt()).toEqual({ status: "accepted" });
      mismatchChild.stdout.end(streamLine({
        event: "init",
        conversation_id: OTHER_CONVERSATION_ID,
        init: { response: "untrusted other conversation" }
      }));
      await expect(mismatchedTurn.binding).rejects.toMatchObject({ code: "conversation_mismatch" });
      expect(unexpectedReader).not.toHaveBeenCalled();
      mismatchChild.finish();

      const child = new FakePromptFreeChild();
      const seen: string[] = [];
      let currentSnapshot: unknown = activeSnapshot(CONVERSATION_ID);
      const turn = new AgyCliSession(
        defaultConfig(fixture.binary),
        child.spawnFactory([])
      ).startExactConversationTurn(BUSINESS_PROMPT, {
        expectedConversationId: null,
        minimumCursor: 0,
        reader: {
          readSnapshot(conversationId) {
            seen.push(conversationId);
            return currentSnapshot as never;
          }
        },
        now: () => OBSERVED_AT
      });

      expect(turn.writeBusinessPrompt()).toEqual({ status: "accepted" });
      child.stdout.write(streamLine({ event: "init", conversation_id: CONVERSATION_ID }));
      const binding = await turn.binding;
      currentSnapshot = terminalSnapshot(CONVERSATION_ID);
      child.stdout.end(streamLine({
        event: "result",
        result: {
          conversation_id: OTHER_CONVERSATION_ID,
          response: "provider stdout must not become terminal evidence"
        }
      }));

      await expect(binding.streamCompletion).resolves.toEqual({
        status: "protocol_error",
        code: "conversation_mismatch"
      });
      await expect(binding.observer.observeActivity()).resolves.toEqual({ status: "unobserved" });
      await expect(binding.observer.observeTerminal()).resolves.toBeNull();
      expect(seen).toEqual([CONVERSATION_ID]);
      child.finish();
    } finally {
      fixture.cleanup();
    }
  });
});

interface SpawnCall {
  readonly command: string;
  readonly args: string[];
  readonly options: SpawnOptions;
}

class FakePromptFreeChild extends EventEmitter {
  stdinText = "";
  stdinEnded = false;
  readonly stdin: Writable;
  readonly stdout = new PassThrough();
  readonly stderr = Readable.from([]);
  exitCode: number | null = null;
  readonly pid = 571;

  constructor() {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        this.stdinText += chunk.toString();
        callback();
      },
      final: (callback) => {
        this.stdinEnded = true;
        callback();
      }
    });
  }

  finish(exitCode = 0): void {
    this.exitCode = exitCode;
    this.emit("exit", exitCode, null);
  }

  kill(): boolean {
    this.finish(-15);
    return true;
  }

  spawnFactory(calls: SpawnCall[]): SpawnFactory {
    return (command, args, options) => {
      calls.push({ command, args, options });
      return this as unknown as ReturnType<SpawnFactory>;
    };
  }
}

function defaultConfig(binary: VerifiedAgyBinary): AgyCliConfig {
  return {
    cwd: os.tmpdir(),
    additionalDirectories: [],
    agyPath: binary.executable,
    printTimeout: "5m0s",
    effort: undefined,
    mode: "default",
    sandbox: true,
    skipPermissions: false,
    interactivePermissions: false,
    promptInArgv: true,
    verifiedAgyBinary: binary,
    autoInstall: false,
    modelList: [],
    discoverModels: true,
    modelListTimeoutMs: DEFAULT_AGY_MODEL_LIST_TIMEOUT_MS,
    conversationsDir: path.join(os.tmpdir(), "not-read-by-injected-reader")
  };
}

function verifiedAgyBinary(): { binary: VerifiedAgyBinary; cleanup(): void } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-exact-conversation-turn-"));
  temporaryDirectories.push(directory);
  const executable = path.join(directory, "fake-agy");
  fs.writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' 'agy version 2.0.0.0'\n", "utf8");
  fs.chmodSync(executable, 0o700);
  return {
    binary: probeExactAgyBinaryVersion({ executable, cwd: os.tmpdir() }),
    cleanup: () => {
      const index = temporaryDirectories.indexOf(directory);
      if (index >= 0) temporaryDirectories.splice(index, 1);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}
