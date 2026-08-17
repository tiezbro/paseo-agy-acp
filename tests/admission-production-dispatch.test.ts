import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdmissionController,
  type AdmissionPolicy
} from "../Admission Controller/controller.js";
import { AdmissionTurnCoordinator } from "../ACP Connector/admission/turn-coordinator.js";
import { TurnClaim } from "../ACP Connector/acp/session/turn-scheduler.js";
import {
  AgyCliSession,
  DEFAULT_AGY_MODEL_LIST_TIMEOUT_MS,
  type AgyCliConfig,
  type PtyFactory,
  type PtyProcess
} from "../ACP Connector/agy/cli.js";
import {
  probeExactAgyBinaryVersion,
  type VerifiedAgyBinary
} from "../ACP Connector/agy/launch-spec.js";
import { createConversationDb, insertStep } from "./fixtures/conversation-db.js";
import {
  encodeModelProviderError,
  encodeStepPayload
} from "./fixtures/step-encoder.js";

const BUSINESS_PROMPT = "S3-T12 business prompt must be fenced once";
const POLICY: AdmissionPolicy = {
  maxActiveTurns: 1,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};
const tempDirs: string[] = [];
const controllers: AdmissionController[] = [];

afterEach(() => {
  for (const admission of controllers.splice(0)) admission.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("S3-T12 production prompt-free dispatch wiring", () => {
  it("maps an accepted production prompt-free PTY dispatch to durable active exactly once", async () => {
    const requestId = "s3-t12-accepted";
    const { admission, databasePath } = admissionFixture();
    const conversations = tempDir("conversations");
    const child = new FakeNativeAgyPty({ conversations });
    const calls: PtySpawnCall[] = [];
    const session = sessionFor(child, calls);
    const subject = coordinator(admission, requestId);

    await expect(subject.admit({
      sessionId: "accepted-session",
      model: "model-test",
      promptText: BUSINESS_PROMPT,
      claim: new TurnClaim("foreground"),
      execute: (boundary) => session.prompt(
        BUSINESS_PROMPT,
        async () => {},
        undefined,
        undefined,
        undefined,
        boundary
      )
    })).resolves.toBe("end_turn");

    expect(calls).toHaveLength(1);
    expect(JSON.stringify([calls[0].args, calls[0].options.env])).not.toContain(BUSINESS_PROMPT);
    expect(calls[0].args).not.toContain("--print");
    expect(calls[0].args).not.toContain("--prompt-interactive");
    expect(child.writeAttempts).toBe(1);
    expect(child.writePayloads).toEqual([`\x1b[200~${BUSINESS_PROMPT}\x1b[201~\r`]);
    expect(child.killSignals).toEqual([undefined]);
    expect(requestSnapshot(databasePath, requestId)).toMatchObject({
      state: "completed",
      payloadCount: 0,
      leaseCount: 0,
      identityCount: 0,
      promptChannel: null
    });
    expect(eventKinds(admission).filter((kind) => kind === "request_active")).toHaveLength(1);
  });

  it("settles a persisted terminal provider error as failed instead of recovery debt", async () => {
    const requestId = "s3-t12-terminal-provider-error";
    const { admission, databasePath } = admissionFixture();
    const conversations = tempDir("conversations");
    const child = new FakeNativeAgyPty({ conversations, terminalProviderError: true });
    const calls: PtySpawnCall[] = [];
    const session = sessionFor(child, calls);
    const subject = coordinator(admission, requestId);

    await expect(subject.admit({
      sessionId: "terminal-provider-error-session",
      model: "model-test",
      promptText: BUSINESS_PROMPT,
      claim: new TurnClaim("foreground"),
      execute: (boundary) => session.prompt(
        BUSINESS_PROMPT,
        async () => {},
        undefined,
        undefined,
        undefined,
        boundary
      )
    })).rejects.toMatchObject({
      name: "AgyCliError",
      message: expect.stringContaining("FAILED_PRECONDITION")
    });

    expect(child.writeAttempts).toBe(1);
    expect(requestSnapshot(databasePath, requestId)).toMatchObject({
      state: "failed",
      payloadCount: 0,
      leaseCount: 0,
      identityCount: 0
    });
    expect(eventKinds(admission).filter((kind) => kind === "request_provider_terminal")).toHaveLength(1);
    expect(eventKinds(admission).filter((kind) => kind === "request_released")).toHaveLength(1);
  });

  it("maps an unprovable production PTY write to durable dispatch_ambiguous with one attempt", async () => {
    const requestId = "s3-t12-ambiguous";
    const { admission, databasePath } = admissionFixture();
    const child = new FakeNativeAgyPty({ writeThrows: true });
    const calls: PtySpawnCall[] = [];
    const session = sessionFor(child, calls);
    const subject = coordinator(admission, requestId);

    await expect(subject.admit({
      sessionId: "ambiguous-session",
      model: "model-test",
      promptText: BUSINESS_PROMPT,
      claim: new TurnClaim("foreground"),
      execute: (boundary) => session.prompt(
        BUSINESS_PROMPT,
        async () => {},
        undefined,
        undefined,
        undefined,
        boundary
      )
    })).rejects.toMatchObject({
      name: "AgyPromptFreeDispatchError",
      state: "dispatch_ambiguous"
    });

    expect(calls).toHaveLength(1);
    expect(child.writeAttempts).toBe(1);
    expect(child.writePayloads).toEqual([`\x1b[200~${BUSINESS_PROMPT}\x1b[201~\r`]);
    expect(child.killSignals).toEqual([undefined]);
    expect(requestSnapshot(databasePath, requestId)).toMatchObject({
      state: "dispatch_ambiguous",
      leaseCount: 1,
      leasePhase: "dispatch_ambiguous",
      identityCount: 1,
      promptChannel: "pty"
    });
    expect(eventKinds(admission).filter((kind) => kind === "request_dispatch_ambiguous")).toHaveLength(1);
  });

  it("maps a blocked pre-identity dispatch to the admission ambiguous bridge without replaying business input", async () => {
    const requestId = "s3-t12-blocked-pre-identity";
    const { admission, databasePath } = admissionFixture();
    const child = new FakeNativeAgyPty({ processId: null });
    const calls: PtySpawnCall[] = [];
    const session = sessionFor(child, calls);
    const subject = coordinator(admission, requestId);

    await expect(subject.admit({
      sessionId: "blocked-session",
      model: "model-test",
      promptText: BUSINESS_PROMPT,
      claim: new TurnClaim("foreground"),
      execute: (boundary) => session.prompt(
        BUSINESS_PROMPT,
        async () => {},
        undefined,
        undefined,
        undefined,
        boundary
      )
    })).rejects.toMatchObject({
      name: "AgyPromptFreeDispatchError",
      state: "blocked",
      reason: "process_identity_unrecorded"
    });

    expect(calls).toHaveLength(1);
    expect(child.writeAttempts).toBe(0);
    expect(child.writePayloads).toEqual([]);
    expect(child.killSignals).toEqual([undefined]);
    expect(requestSnapshot(databasePath, requestId)).toMatchObject({
      state: "recovery_required",
      payloadCount: 0,
      leaseCount: 1,
      leasePhase: "recovery_required",
      identityCount: 0,
      promptChannel: null
    });
    expect(eventKinds(admission).filter((kind) => kind === "request_recovery_required")).toHaveLength(1);
  });
});

function admissionFixture(): { admission: AdmissionController; databasePath: string } {
  const stateDir = tempDir("admission");
  const databasePath = path.join(stateDir, "runtime.sqlite");
  const admission = new AdmissionController({
    databasePath,
    policy: POLICY,
    encryptionKey: Buffer.alloc(32, 61),
    contentFingerprintKey: Buffer.alloc(32, 62)
  });
  controllers.push(admission);
  return { admission, databasePath };
}

function coordinator(admission: AdmissionController, requestId: string): AdmissionTurnCoordinator {
  let now = 10_000;
  return new AdmissionTurnCoordinator({
    controller: admission,
    agentId: `${requestId}-agent`,
    connectorPid: process.pid,
    now: () => ++now,
    createRequestId: () => requestId,
    queuePollIntervalMs: 1,
    progressIntervalMs: 1,
    heartbeatIntervalMs: 1,
    wait: async () => {
      throw new Error("S3-T12 production dispatch tests should admit immediately");
    }
  });
}

function sessionFor(child: FakeNativeAgyPty, calls: PtySpawnCall[]): AgyCliSession {
  const fixture = verifiedAgyBinary();
  const conversationsDir = child.conversations ?? tempDir("conversations");
  return new AgyCliSession(
    { ...defaultConfig(fixture.binary), conversationsDir },
    () => {
      throw new Error("admission production dispatch must not use print-mode spawn");
    },
    child.ptyFactory(calls)
  );
}

function requestSnapshot(file: string, requestId: string): {
  readonly state: string;
  readonly payloadCount: number;
  readonly leaseCount: number;
  readonly leasePhase: string | null;
  readonly identityCount: number;
  readonly promptChannel: string | null;
} {
  const db = new Database(file, { readonly: true });
  try {
    const request = db.prepare("SELECT state FROM turn_requests WHERE request_id = ?").get(requestId) as {
      state: string;
    };
    const payload = db.prepare("SELECT COUNT(*) AS count FROM turn_payloads WHERE request_id = ?")
      .get(requestId) as { count: number };
    const leaseCount = db.prepare("SELECT COUNT(*) AS count FROM leases WHERE request_id = ?")
      .get(requestId) as { count: number };
    const lease = db.prepare("SELECT phase FROM leases WHERE request_id = ?")
      .get(requestId) as { phase: string } | undefined;
    const identities = db.prepare("SELECT COUNT(*) AS count FROM lease_process_identities WHERE request_id = ?")
      .get(requestId) as { count: number };
    const identity = db.prepare(
      "SELECT prompt_channel AS promptChannel FROM lease_process_identities WHERE request_id = ?"
    ).get(requestId) as { promptChannel: string } | undefined;
    return {
      state: request.state,
      payloadCount: payload.count,
      leaseCount: leaseCount.count,
      leasePhase: lease?.phase ?? null,
      identityCount: identities.count,
      promptChannel: identity?.promptChannel ?? null
    };
  } finally {
    db.close();
  }
}

function eventKinds(admission: AdmissionController): string[] {
  return admission
    .readSanitizedEvents({ afterEventSeq: 0, limit: 100 })
    .map((event) => event.kind);
}

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `paseo-agy-s3-t12-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function defaultConfig(binary: VerifiedAgyBinary): AgyCliConfig {
  return {
    cwd: tempDir("workspace"),
    additionalDirectories: [],
    agyPath: binary.executable,
    printTimeout: "1s",
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
    conversationsDir: tempDir("default-conversations")
  };
}

function verifiedAgyBinary(): { binary: VerifiedAgyBinary } {
  const dir = tempDir("fake-agy-bin");
  const executable = path.join(dir, "fake-agy");
  fs.writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' 'agy version 2.0.0.0'\n", "utf8");
  fs.chmodSync(executable, 0o700);
  return {
    binary: probeExactAgyBinaryVersion({ executable, cwd: dir })
  };
}

interface PtySpawnCall {
  readonly command: string;
  readonly args: string[];
  readonly options: { cwd: string; env?: NodeJS.ProcessEnv; cols: number; rows: number };
}

interface FakeNativeAgyPtyOptions {
  readonly conversations?: string;
  readonly writeThrows?: boolean;
  readonly processId?: number | null;
  readonly terminalProviderError?: boolean;
}

class FakeNativeAgyPty implements PtyProcess {
  readonly pid: number | undefined;
  readonly conversations: string | undefined;
  readonly writePayloads: string[] = [];
  readonly killSignals: Array<string | undefined> = [];
  writeAttempts = 0;
  readonly #dataListeners: Array<(data: string) => void> = [];
  readonly #exitListeners: Array<(event: { exitCode: number }) => void> = [];
  #terminal = false;

  constructor(private readonly options: FakeNativeAgyPtyOptions) {
    this.pid = options.processId === null ? undefined : options.processId ?? process.pid;
    this.conversations = options.conversations;
  }

  start(): void {
    queueMicrotask(() => this.emitData("? for shortcuts"));
  }

  write(data: string): void {
    this.writeAttempts++;
    this.writePayloads.push(data);
    if (this.options.writeThrows) throw new Error("PTY write acceptance is unprovable");
    if (this.conversations) {
      const db = createConversationDb(this.conversations, "production-dispatch");
      if (this.options.terminalProviderError) {
        const message = "FAILED_PRECONDITION (code 400): provider rejected the completed request";
        insertStep(db, {
          idx: 1,
          stepType: 17,
          status: 3,
          stepPayload: encodeStepPayload({
            modelProviderError: encodeModelProviderError({
              summary: message,
              diagnostic: "HTTP 400 Bad Request",
              responseJson: JSON.stringify({
                error: { code: 400, message: "provider rejected the completed request", status: "FAILED_PRECONDITION" }
              }),
              userMessage: message
            })
          })
        });
      } else {
        insertStep(db, {
          idx: 1,
          stepType: 15,
          status: 3,
          stepPayload: encodeStepPayload({ agentText: "production PTY turn done" })
        });
      }
      db.close();
      queueMicrotask(() => this.emitData("? for shortcuts"));
    }
  }

  kill(signal?: string): void {
    this.killSignals.push(signal);
    if (this.#terminal) return;
    this.#terminal = true;
    for (const listener of this.#exitListeners) listener({ exitCode: signal === "SIGKILL" ? -9 : 0 });
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.#dataListeners.push(listener);
    return { dispose() {} };
  }

  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void } {
    this.#exitListeners.push(listener);
    return { dispose() {} };
  }

  ptyFactory(calls: PtySpawnCall[]): PtyFactory {
    return { spawn: (command, args, options) => {
      calls.push({ command, args, options });
      this.start();
      return this;
    } };
  }

  private emitData(data: string): void {
    for (const listener of this.#dataListeners) listener(data);
  }
}
