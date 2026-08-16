import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
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
  type SpawnFactory,
  type SpawnOptions
} from "../ACP Connector/agy/cli.js";
import {
  probeExactAgyBinaryVersion,
  type VerifiedAgyBinary
} from "../ACP Connector/agy/launch-spec.js";

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
  it("maps an accepted production stdin dispatch to durable active exactly once", async () => {
    const requestId = "s3-t12-accepted";
    const { admission, databasePath } = admissionFixture();
    const child = new FakeNativeAgyProcess({ writeAccepted: true });
    const calls: SpawnCall[] = [];
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
    expect(child.writeAttempts).toBe(1);
    expect(child.writePayloads).toEqual([BUSINESS_PROMPT]);
    expect(child.endPayloads).toEqual([undefined]);
    expect(child.legacyEndPayloads).toEqual([]);
    expect(child.killedWith).toBeUndefined();
    expect(requestSnapshot(databasePath, requestId)).toMatchObject({
      state: "completed",
      payloadCount: 0,
      leaseCount: 0,
      identityCount: 0
    });
    expect(eventKinds(admission).filter((kind) => kind === "request_active")).toHaveLength(1);
  });

  it("maps an unprovable production stdin write to durable dispatch_ambiguous with one attempt", async () => {
    const requestId = "s3-t12-ambiguous";
    const { admission, databasePath } = admissionFixture();
    const child = new FakeNativeAgyProcess({ writeAccepted: false });
    const calls: SpawnCall[] = [];
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
    expect(child.writePayloads).toEqual([BUSINESS_PROMPT]);
    expect(child.endPayloads).toEqual([undefined]);
    expect(child.legacyEndPayloads).toEqual([]);
    expect(child.killedWith).toBe(process.platform === "win32" ? undefined : "SIGINT");
    expect(requestSnapshot(databasePath, requestId)).toMatchObject({
      state: "dispatch_ambiguous",
      leaseCount: 1,
      leasePhase: "dispatch_ambiguous",
      identityCount: 1
    });
    expect(eventKinds(admission).filter((kind) => kind === "request_dispatch_ambiguous")).toHaveLength(1);
  });

  it("maps a blocked pre-identity dispatch to the admission ambiguous bridge without replaying business input", async () => {
    const requestId = "s3-t12-blocked-pre-identity";
    const { admission, databasePath } = admissionFixture();
    const child = new FakeNativeAgyProcess({ processId: null, writeAccepted: true });
    const calls: SpawnCall[] = [];
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
    expect(child.endPayloads).toEqual([]);
    expect(child.legacyEndPayloads).toEqual([]);
    expect(requestSnapshot(databasePath, requestId)).toMatchObject({
      state: "recovery_required",
      payloadCount: 0,
      leaseCount: 1,
      leasePhase: "recovery_required",
      identityCount: 0
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

function sessionFor(child: FakeNativeAgyProcess, calls: SpawnCall[]): AgyCliSession {
  const fixture = verifiedAgyBinary();
  return new AgyCliSession(
    { ...defaultConfig(fixture.binary), conversationsDir: tempDir("conversations") },
    child.spawnFactory(calls)
  );
}

function requestSnapshot(file: string, requestId: string): {
  readonly state: string;
  readonly payloadCount: number;
  readonly leaseCount: number;
  readonly leasePhase: string | null;
  readonly identityCount: number;
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
    return {
      state: request.state,
      payloadCount: payload.count,
      leaseCount: leaseCount.count,
      leasePhase: lease?.phase ?? null,
      identityCount: identities.count
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
    printTimeout: "250ms",
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

interface SpawnCall {
  readonly command: string;
  readonly args: string[];
  readonly options: SpawnOptions;
}

interface FakeNativeAgyProcessOptions {
  readonly writeAccepted: boolean;
  readonly processId?: number | null;
}

class FakeNativeAgyProcess extends EventEmitter {
  readonly stdout = Readable.from([]);
  readonly stderr = Readable.from([]);
  readonly pid: number | undefined;
  exitCode: number | null = null;
  readonly writePayloads: string[] = [];
  readonly endPayloads: Array<string | undefined> = [];
  readonly legacyEndPayloads: string[] = [];
  writeAttempts = 0;
  killedWith: NodeJS.Signals | undefined;
  readonly stdin: {
    write: (data: string) => boolean;
    end: (data?: string) => void;
  };
  #terminal = false;

  constructor(private readonly options: FakeNativeAgyProcessOptions) {
    super();
    this.pid = options.processId === null ? undefined : options.processId ?? process.pid;
    this.stdin = {
      write: (data: string) => {
        this.writeAttempts += 1;
        this.writePayloads.push(data);
        return this.options.writeAccepted;
      },
      end: (data?: string) => {
        this.endPayloads.push(data);
        if (data !== undefined) this.legacyEndPayloads.push(data);
        this.queueExit();
      }
    };
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killedWith = signal ?? "SIGTERM";
    this.finish(signal === "SIGKILL" ? -9 : -15, this.killedWith);
    return true;
  }

  spawnFactory(calls: SpawnCall[]): SpawnFactory {
    return (command, args, options) => {
      calls.push({ command, args, options });
      this.queueExit();
      return this as unknown as ReturnType<SpawnFactory>;
    };
  }

  private queueExit(): void {
    queueMicrotask(() => this.finish(0, null));
  }

  private finish(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.exitCode = exitCode;
    this.emit("exit", exitCode, signal);
  }
}
