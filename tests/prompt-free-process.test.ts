import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  AgyCliBackend,
  AgyCliSession,
  DEFAULT_AGY_MODEL_LIST_TIMEOUT_MS,
  DEFAULT_CONVERSATIONS_DIR,
  type AgyCliConfig,
  type SpawnFactory,
  type SpawnOptions
} from "../ACP Connector/agy/cli.js";
import {
  isExactFreshPtyAgyLaunch,
  probeExactAgyBinaryVersion,
  type VerifiedAgyBinary
} from "../ACP Connector/agy/launch-spec.js";
import { AgyPromptFreeDispatchBoundary } from "../ACP Connector/agy/dispatch-boundary.js";
import { observeAgyStreamJsonIdentity } from "../ACP Connector/agy/stream-json-identity.js";

const BUSINESS_PROMPT = "business prompt: request-scoped-zeta-42";

describe("Agy prompt-free process", () => {
  it("starts an exact verified stdin child without a prompt write and consumes its write capability once", () => {
    const fixture = verifiedAgyBinary();
    try {
      const child = new FakePromptFreeChild();
      const calls: SpawnCall[] = [];
      const session = new AgyCliSession({
        ...defaultConfig(fixture.binary),
        env: {
          PATH: "/bin",
          AGY_PROMPT_LEAK: BUSINESS_PROMPT,
          SAFE_VALUE: "kept"
        }
      }, child.spawnFactory(calls));

      const process = session.startPromptFreeProcess(BUSINESS_PROMPT);

      expect(process.promptChannel).toBe("stdin");
      expect(process.stdout).toBe(child.stdout);
      expect(child.stdout.listenerCount("data")).toBe(0);
      expect(calls).toHaveLength(1);
      expect(child.stdinText).toBe("");
      expect(calls[0].args).not.toContain(BUSINESS_PROMPT);
      expect(JSON.stringify(calls[0].options.env)).not.toContain(BUSINESS_PROMPT);
      expect(calls[0].options.env).toMatchObject({ PATH: "/bin", SAFE_VALUE: "kept" });
      expect(calls[0].options.launchSpecification).toMatchObject({
        agyVersion: fixture.binary.version,
        launcherFingerprint: fixture.binary.launcherFingerprint,
        transport: "stdin",
        processTitle: "agy-acp:prompt-free-print"
      });
      const launch = calls[0].options.launchSpecification!;
      const outputFormat = calls[0].args.indexOf("--output-format");
      expect(outputFormat).toBeGreaterThanOrEqual(0);
      expect(calls[0].args.slice(outputFormat, outputFormat + 2)).toEqual([
        "--output-format",
        "stream-json"
      ]);
      expect(calls[0].args.filter((value) => value === "--output-format")).toHaveLength(1);
      expect(launch.argv.join("\u0000")).not.toContain(BUSINESS_PROMPT);
      expect(JSON.stringify(launch.environment)).not.toContain(BUSINESS_PROMPT);
      expect(launch.processTitle).not.toContain(BUSINESS_PROMPT);
      expect(launch.temporaryFilePath).not.toContain(BUSINESS_PROMPT);
      expect(launch.launcherDiagnostics.join("\u0000")).not.toContain(BUSINESS_PROMPT);
      expect(isExactFreshPtyAgyLaunch(
        launch,
        fixture.binary.version,
        fixture.binary.launcherFingerprint
      )).toBe(false);

      expect(process.writeBusinessPrompt()).toEqual({ status: "accepted" });
      expect(process.writeBusinessPrompt()).toEqual({ status: "ambiguous" });
      expect(child.stdinText).toBe(BUSINESS_PROMPT);
      expect(child.stdinEnded).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("exposes the same request-scoped primitive from AgyCliBackend", () => {
    const fixture = verifiedAgyBinary();
    try {
      const child = new FakePromptFreeChild();
      const calls: SpawnCall[] = [];
      const backend = new AgyCliBackend(child.spawnFactory(calls));

      const process = backend.startPromptFreeProcess(defaultConfig(fixture.binary), BUSINESS_PROMPT);

      expect(process.child).toBe(child);
      expect(process.promptChannel).toBe("stdin");
      expect(child.stdinText).toBe("");
      expect(calls).toHaveLength(1);
    } finally {
      fixture.cleanup();
    }
  });

  it("forwards stdout unchanged to the identity-only reader without retaining a provider response", async () => {
    const fixture = verifiedAgyBinary();
    try {
      const child = new FakePromptFreeChild();
      const process = new AgyCliSession(
        defaultConfig(fixture.binary),
        child.spawnFactory([])
      ).startPromptFreeProcess(BUSINESS_PROMPT);
      const identity = observeAgyStreamJsonIdentity(process.stdout);
      const conversationId = "c3b66b04-872b-4fbe-a3a4-058a026ef20a";
      const response = "provider response must remain outside the primitive";

      child.stdout.end(
        `{\"event\":\"init\",\"conversation_id\":\"${conversationId}\"}\n` +
        `{\"event\":\"result\",\"result\":{\"conversation_id\":\"${conversationId}\",\"response\":\"${response}\"}}\n`
      );

      await expect(identity.identity).resolves.toEqual({ conversationId });
      await expect(identity.completion).resolves.toEqual({ status: "drained", conversationId });
      expect(process).not.toHaveProperty("response");
      expect(process).not.toHaveProperty("bufferedResponse");
    } finally {
      fixture.cleanup();
    }
  });

  it("rejects missing, copied, or mismatched exact identities before a child can start", () => {
    const fixture = verifiedAgyBinary();
    try {
      const calls: SpawnCall[] = [];
      const child = new FakePromptFreeChild();
      const spawn = child.spawnFactory(calls);

      expect(() => new AgyCliSession({
        ...defaultConfig(fixture.binary),
        verifiedAgyBinary: undefined
      }, spawn).startPromptFreeProcess(BUSINESS_PROMPT)).toThrow(/verified identity/i);
      expect(calls).toEqual([]);

      const copiedIdentity = Object.freeze({ ...fixture.binary }) as VerifiedAgyBinary;
      expect(() => new AgyCliSession({
        ...defaultConfig(fixture.binary),
        verifiedAgyBinary: copiedIdentity
      }, spawn).startPromptFreeProcess(BUSINESS_PROMPT)).toThrow(/verified identity/i);
      expect(calls).toEqual([]);

      expect(() => new AgyCliSession({
        ...defaultConfig(fixture.binary),
        agyPath: path.join(os.tmpdir(), "different-agy"),
        verifiedAgyBinary: fixture.binary
      }, spawn).startPromptFreeProcess(BUSINESS_PROMPT)).toThrow(/verified identity/i);
      expect(calls).toEqual([]);
      expect(child.stdinText).toBe("");
    } finally {
      fixture.cleanup();
    }
  });

  it("does not write when spawn fails and does not retry the failed start", () => {
    const fixture = verifiedAgyBinary();
    try {
      const calls: SpawnCall[] = [];
      const session = new AgyCliSession(defaultConfig(fixture.binary), (command, args, options) => {
        calls.push({ command, args, options });
        throw new Error("fake spawn failure");
      });

      expect(() => session.startPromptFreeProcess(BUSINESS_PROMPT)).toThrow(/failed to start/i);
      expect(calls).toHaveLength(1);
      expect(JSON.stringify(calls[0].options.launchSpecification)).not.toContain(BUSINESS_PROMPT);
    } finally {
      fixture.cleanup();
    }
  });

  it("leaves identity and intent failures outside the primitive with zero prompt writes", () => {
    const fixture = verifiedAgyBinary();
    try {
      const identityChild = new FakePromptFreeChild();
      const identityProcess = new AgyCliSession(
        defaultConfig(fixture.binary),
        identityChild.spawnFactory([])
      ).startPromptFreeProcess(BUSINESS_PROMPT);
      const identityBoundary = new AgyPromptFreeDispatchBoundary(
        BUSINESS_PROMPT,
        dispatchFence(),
        {
          spawnPromptFree: () => ({
            process: identityProcess.child,
            identity: undefined,
            promptChannel: identityProcess.promptChannel,
            writeInitialPrompt: () => identityProcess.writeBusinessPrompt()
          }),
          persistProcessIdentity: () => ({ status: "recorded" }),
          recheckCancellation: () => ({ generationMatches: true, ownerMatches: true, cancelled: false }),
          commitDispatchIntent: () => ({ status: "committed" })
        }
      );

      expect(identityBoundary.run()).toMatchObject({
        state: "blocked",
        reason: "process_identity_unrecorded",
        writeAttempts: 0
      });
      expect(identityChild.stdinText).toBe("");

      const intentChild = new FakePromptFreeChild();
      const intentProcess = new AgyCliSession(
        defaultConfig(fixture.binary),
        intentChild.spawnFactory([])
      ).startPromptFreeProcess(BUSINESS_PROMPT);
      const intentBoundary = new AgyPromptFreeDispatchBoundary(
        BUSINESS_PROMPT,
        dispatchFence(),
        {
          spawnPromptFree: () => ({
            process: intentProcess.child,
            identity: { startToken: "boot-1:100" },
            promptChannel: intentProcess.promptChannel,
            writeInitialPrompt: () => intentProcess.writeBusinessPrompt()
          }),
          persistProcessIdentity: () => ({ status: "recorded" }),
          recheckCancellation: () => ({ generationMatches: true, ownerMatches: true, cancelled: false }),
          commitDispatchIntent: () => ({ status: "not_committed" })
        }
      );

      expect(intentBoundary.run()).toMatchObject({
        state: "dispatch_ambiguous",
        writeAttempts: 0
      });
      expect(intentChild.stdinText).toBe("");
    } finally {
      fixture.cleanup();
    }
  });

  it("allows an external dispatcher boundary to consume the captured prompt exactly once", () => {
    const fixture = verifiedAgyBinary();
    try {
      const child = new FakePromptFreeChild();
      const process = new AgyCliSession(
        defaultConfig(fixture.binary),
        child.spawnFactory([])
      ).startPromptFreeProcess(BUSINESS_PROMPT);
      const boundary = new AgyPromptFreeDispatchBoundary(
        BUSINESS_PROMPT,
        dispatchFence(),
        {
          spawnPromptFree: () => ({
            process: process.child,
            identity: { startToken: "boot-1:100" },
            promptChannel: process.promptChannel,
            writeInitialPrompt: () => process.writeBusinessPrompt()
          }),
          persistProcessIdentity: () => ({ status: "recorded" }),
          recheckCancellation: () => ({ generationMatches: true, ownerMatches: true, cancelled: false }),
          commitDispatchIntent: () => ({ status: "committed" })
        }
      );

      expect(boundary.run()).toMatchObject({ state: "active", writeAttempts: 1 });
      expect(boundary.run()).toMatchObject({ state: "active", writeAttempts: 1 });
      expect(child.stdinText).toBe(BUSINESS_PROMPT);
      expect(child.stdinEnded).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  it("does not replay a business write after an exited child and exposes cancellation through exit", async () => {
    const fixture = verifiedAgyBinary();
    try {
      const failedChild = new FakePromptFreeChild(1);
      const failedProcess = new AgyCliSession(
        defaultConfig(fixture.binary),
        failedChild.spawnFactory([])
      ).startPromptFreeProcess(BUSINESS_PROMPT);

      expect(failedProcess.writeBusinessPrompt()).toEqual({ status: "ambiguous" });
      expect(failedProcess.writeBusinessPrompt()).toEqual({ status: "ambiguous" });
      expect(failedChild.stdinText).toBe("");
      await expect(failedProcess.exit).resolves.toEqual({ exitCode: 1, signal: null });

      const erroredChild = new FakePromptFreeChild();
      const erroredProcess = new AgyCliSession(
        defaultConfig(fixture.binary),
        erroredChild.spawnFactory([])
      ).startPromptFreeProcess(BUSINESS_PROMPT);
      erroredChild.emit("error", new Error("provider child failure"));

      expect(erroredProcess.writeBusinessPrompt()).toEqual({ status: "ambiguous" });
      expect(erroredChild.stdinText).toBe("");
      await expect(erroredProcess.exit).resolves.toEqual({ exitCode: null, signal: null });

      const cancellableChild = new FakePromptFreeChild();
      const cancellableProcess = new AgyCliSession(
        defaultConfig(fixture.binary),
        cancellableChild.spawnFactory([])
      ).startPromptFreeProcess(BUSINESS_PROMPT);
      cancellableProcess.cancel();

      expect(cancellableChild.stdinText).toBe("");
      expect(cancellableChild.killedWith).toBe(process.platform === "win32" ? undefined : "SIGINT");
      await expect(cancellableProcess.exit).resolves.toEqual({
        exitCode: -15,
        signal: process.platform === "win32" ? "SIGTERM" : "SIGINT"
      });
    } finally {
      fixture.cleanup();
    }
  });

  it("does not import or invoke the dispatch boundary from the primitive module", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "ACP Connector/agy/prompt-free-process.ts"), "utf8");
    expect(source).not.toContain("dispatch-boundary");
    expect(source).not.toContain("AgyPromptFreeDispatchBoundary");
    expect(source).not.toContain("JSON.parse");
    expect(source).not.toContain("stdout.on(");
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
  readonly pid = 42;
  killedWith: string | undefined;

  constructor(exitCode: number | null = null) {
    super();
    this.exitCode = exitCode;
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

  kill(signal?: string): boolean {
    this.killedWith = signal;
    this.exitCode = -15;
    this.emit("exit", this.exitCode, signal ?? "SIGTERM");
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
    conversationsDir: DEFAULT_CONVERSATIONS_DIR
  };
}

function verifiedAgyBinary(): { binary: VerifiedAgyBinary; cleanup(): void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-prompt-free-process-"));
  const executable = path.join(dir, "fake-agy");
  fs.writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' 'agy version 2.0.0.0'\n", "utf8");
  fs.chmodSync(executable, 0o700);
  return {
    binary: probeExactAgyBinaryVersion({ executable, cwd: os.tmpdir() }),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
  };
}

function dispatchFence() {
  return {
    requestId: "request-1",
    leaseId: "lease-1",
    generation: 7,
    ownerInstanceId: "connector-1"
  };
}
