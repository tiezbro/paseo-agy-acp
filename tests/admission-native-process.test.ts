import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdmissionController,
  type AdmissionPolicy
} from "../Admission Controller/controller.js";
import {
  captureLinuxProcessIdentity,
  type LinuxProcessEvidenceReaders,
  type LinuxProcessIdentity
} from "../Admission Controller/process-evidence.js";
import {
  recoverExitedAdmissionSeats,
  type AdmissionStartupRecoveryReaders
} from "../ACP Connector/admission/startup-recovery.js";
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
import { encodeStepPayload } from "./fixtures/step-encoder.js";

const BUSINESS_PROMPT = "S3-T19 native PTY prompt";
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

describe("S3-T19 native prompt-free PTY signal/descendant regression", () => {
  it("drives one fenced PTY write through AgyCliSession.prompt without hanging or residency", async () => {
    const requestId = "s3-t19-pipe-eof";
    const { admission, databasePath } = admissionFixture();
    const child = new FakeNativeAgyPty("normal");
    const calls: PtySpawnCall[] = [];
    const session = sessionFor(child, calls);
    const subject = coordinator(admission, requestId);

    await expect(withTimeout(subject.admit({
      sessionId: "pipe-eof-session",
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
    }), 2_000, "prompt-free PTY prompt")).resolves.toBe("end_turn");

    expect(calls).toHaveLength(1);
    expect(JSON.stringify([calls[0].args, calls[0].options.env])).not.toContain(BUSINESS_PROMPT);
    expect(calls[0].args).not.toContain("--print");
    expect(calls[0].args).not.toContain("--prompt-interactive");
    expect(child.writeAttempts).toBe(1);
    expect(child.writePayloads).toEqual([`\x1b[200~${BUSINESS_PROMPT}\x1b[201~\r`]);
    expect(child.killCalls).toBe(1);
    expect(requestSnapshot(databasePath, requestId)).toMatchObject({
      state: "completed",
      payloadCount: 0,
      leaseCount: 0,
      identityCount: 0
    });
  });

  it("turns SIGTERM into a typed AgyCliError and releases the admission seat", async () => {
    const requestId = "s3-t19-sigterm";
    const { admission, databasePath } = admissionFixture();
    const child = new FakeNativeAgyPty("sigterm");
    const session = sessionFor(child, []);
    const subject = coordinator(admission, requestId);

    await expect(withTimeout(subject.admit({
      sessionId: "sigterm-session",
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
    }), 2_000, "SIGTERM prompt")).rejects.toMatchObject({
      name: "AgyCliError",
      exitCode: -15
    });

    expect(child.writeAttempts).toBe(1);
    expect(child.signalEvents).toEqual(["SIGTERM"]);
    expect(requestSnapshot(databasePath, requestId)).toMatchObject({
      state: "failed",
      payloadCount: 0,
      leaseCount: 0,
      identityCount: 0
    });
    expect(eventKinds(admission).filter((kind) => kind === "request_released")).toHaveLength(1);
  });

  it("keeps SIGKILL as recovery_required debt with one dispatch attempt and no replayable payload", async () => {
    const requestId = "s3-t19-sigkill";
    const { admission, databasePath } = admissionFixture();
    const child = new FakeNativeAgyPty("sigkill");
    const calls: PtySpawnCall[] = [];
    const session = sessionFor(child, calls);
    const subject = coordinator(admission, requestId);

    await expect(withTimeout(subject.admit({
      sessionId: "sigkill-session",
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
    }), 2_000, "SIGKILL prompt")).rejects.toMatchObject({
      name: "AgyCliError",
      exitCode: null
    });

    expect(calls).toHaveLength(1);
    expect(child.signalEvents[0]).toBe("SIGKILL");
    expect(child.writeAttempts).toBe(1);
    expect(child.writePayloads).toEqual([`\x1b[200~${BUSINESS_PROMPT}\x1b[201~\r`]);
    expect(requestSnapshot(databasePath, requestId)).toMatchObject({
      state: "recovery_required",
      payloadCount: 0,
      leaseCount: 1,
      leasePhase: "recovery_required",
      identityCount: 1
    });
    expect(() => admission.readPayload(requestId, 4_000)).toThrow(/no payload/i);
    expect(admission.listRecoverableDispatches()).toHaveLength(1);
  });

  it("observes descendant residue by matching pgrp and session through injected proc readers", async () => {
    const requestId = "s3-t19-descendant";
    const { admission } = admissionFixture();
    const child = new FakeNativeAgyPty("sigkill");
    const session = sessionFor(child, []);
    const subject = coordinator(admission, requestId);

    await expect(withTimeout(subject.admit({
      sessionId: "descendant-session",
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
    }), 2_000, "descendant setup prompt")).rejects.toMatchObject({
      name: "AgyCliError",
      exitCode: null
    });

    const dispatch = admission.listRecoverableDispatches()[0];
    if (!dispatch?.processIdentity) throw new Error("missing recoverable process identity");
    const descendantPid = dispatch.processIdentity.child.pid + 10_000;
    const readers = descendantResidueReaders(dispatch.processIdentity, descendantPid);
    const descendant = captureLinuxProcessIdentity(descendantPid, readers);

    expect(descendant.pid).toBe(descendantPid);
    expect(descendant.pgrp).toBe(dispatch.processIdentity.child.pgrp);
    expect(descendant.session).toBe(dispatch.processIdentity.child.session);
    expect(recoverExitedAdmissionSeats(admission, {
      readers,
      now: () => 5_000
    })).toEqual({ inspected: 1, released: 0, retained: 1, markedRecoveryRequired: 1 });
    expect(admission.getRequest(requestId)?.state).toBe("recovery_required");
    expect(admission.listRecoverableDispatches()[0]?.phase).toBe("recovery_required");
  });
});

function admissionFixture(): { admission: AdmissionController; databasePath: string } {
  const stateDir = tempDir("admission");
  const databasePath = path.join(stateDir, "runtime.sqlite");
  const admission = new AdmissionController({
    databasePath,
    policy: POLICY,
    encryptionKey: Buffer.alloc(32, 71),
    contentFingerprintKey: Buffer.alloc(32, 72)
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
      throw new Error("S3-T19 native process tests should admit immediately");
    }
  });
}

function sessionFor(child: FakeNativeAgyPty, calls: PtySpawnCall[]): AgyCliSession {
  const fixture = verifiedAgyBinary();
  const conversationsDir = tempDir("conversations");
  child.bindConversations(conversationsDir);
  return new AgyCliSession(
    { ...defaultConfig(fixture.binary), conversationsDir },
    () => {
      throw new Error("native admission regression must not use print-mode spawn");
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `paseo-agy-s3-t19-${label}-`));
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

function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

interface PtySpawnCall {
  readonly command: string;
  readonly args: string[];
  readonly options: { cwd: string; env?: NodeJS.ProcessEnv; cols: number; rows: number };
}

type FakeTerminalMode = "normal" | "sigterm" | "sigkill";

class FakeNativeAgyPty implements PtyProcess {
  readonly pid = process.pid;
  readonly writePayloads: string[] = [];
  readonly signalEvents: string[] = [];
  writeAttempts = 0;
  killCalls = 0;
  #conversationsDir: string | undefined;
  readonly #dataListeners: Array<(data: string) => void> = [];
  readonly #exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];
  #terminal = false;

  constructor(private readonly mode: FakeTerminalMode) {
  }

  bindConversations(directory: string): void {
    this.#conversationsDir = directory;
  }

  start(): void {
    queueMicrotask(() => this.emitData("? for shortcuts"));
  }

  write(data: string): void {
    this.writeAttempts++;
    this.writePayloads.push(data);
    queueMicrotask(() => this.finishBusinessWrite());
  }

  kill(signal?: string): void {
    this.killCalls++;
    if (this.#terminal) return;
    this.signalEvents.push(signal ?? "SIGTERM");
    this.finish(signal === "SIGKILL" ? 9 : 15);
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    this.#dataListeners.push(listener);
    return { dispose() {} };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
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

  private finishBusinessWrite(): void {
    if (this.mode === "normal") {
      if (!this.#conversationsDir) throw new Error("native PTY conversations directory is missing");
      const db = createConversationDb(this.#conversationsDir, "native-pty");
      insertStep(db, {
        idx: 1,
        stepType: 15,
        status: 3,
        stepPayload: encodeStepPayload({ agentText: "native PTY turn done" })
      });
      db.close();
      this.emitData("? for shortcuts");
      return;
    }
    const signal = this.mode === "sigterm" ? 15 : 9;
    this.signalEvents.push(this.mode === "sigterm" ? "SIGTERM" : "SIGKILL");
    this.emitData(`terminated by ${this.signalEvents.at(-1)}\n`);
    this.finish(signal);
  }

  private finish(signal: number): void {
    if (this.#terminal) return;
    this.#terminal = true;
    for (const listener of this.#exitListeners) listener({ exitCode: 0, signal });
  }

  private emitData(data: string): void {
    for (const listener of this.#dataListeners) listener(data);
  }
}

type RecoverableProcessIdentity = NonNullable<
  ReturnType<AdmissionController["listRecoverableDispatches"]>[number]["processIdentity"]
>;

function descendantResidueReaders(
  processIdentity: RecoverableProcessIdentity,
  descendantPid: number
): AdmissionStartupRecoveryReaders {
  const descendant: LinuxProcessIdentity = Object.freeze({
    ...processIdentity.child,
    pid: descendantPid,
    ppid: processIdentity.child.pid,
    startTimeTicks: String(Number(processIdentity.child.startTimeTicks) + 1)
  });
  const identities = new Map<number, LinuxProcessIdentity>([[descendant.pid, descendant]]);
  return {
    listProcessIds: () => [descendant.pid],
    ...processEvidenceReaders(processIdentity.child.bootId, identities)
  };
}

function processEvidenceReaders(
  bootId: string,
  identities: ReadonlyMap<number, LinuxProcessIdentity>
): LinuxProcessEvidenceReaders {
  return {
    readFile(filePath) {
      if (filePath === "/proc/sys/kernel/random/boot_id") return `${bootId}\n`;
      const match = /^\/proc\/([1-9][0-9]*)\/stat$/.exec(filePath);
      const identity = match ? identities.get(Number(match[1])) : undefined;
      if (identity !== undefined) return processStat(identity);
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    },
    readLink(filePath) {
      const match = /^\/proc\/([1-9][0-9]*)\/ns\/pid$/.exec(filePath);
      const identity = match ? identities.get(Number(match[1])) : undefined;
      if (identity !== undefined) return `pid:[${identity.pidNamespaceInode}]`;
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    }
  };
}

function processStat(identity: LinuxProcessIdentity): string {
  const fields = [
    "S",
    String(identity.ppid),
    String(identity.pgrp),
    String(identity.session),
    "0",
    "-1",
    "4194560",
    "1",
    "0",
    "0",
    "0",
    "4",
    "2",
    "0",
    "0",
    "20",
    "0",
    "1",
    "0",
    identity.startTimeTicks,
    "0",
    "0"
  ];
  return `${identity.pid} (agy-descendant) ${fields.join(" ")}\n`;
}
