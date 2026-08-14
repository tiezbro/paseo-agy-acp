import { describe, expect, it } from "vitest";
import {
  LinuxProcessLifecycleAdapter,
  type AdmissionProcessLifecycleOwner,
  type AgyProcessLifecycleOwner,
  type LinuxProcessLifecycleRecord
} from "../ACP Connector/admission/process-lifecycle.js";
import type { LocalCancellationPhase, LocalProcessResidueProof } from "../ACP Connector/admission/cancellation.js";
import {
  createLinuxPreDispatchProofAuthority,
  verifyLinuxPreDispatchTerminationProof,
  type LinuxProcessEvidenceReaders,
  type LinuxProcessIdentity,
  type LinuxPreDispatchProofAuthority
} from "../Admission Controller/process-evidence.js";

const BOOT_ID = "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f31";
const OWNER_INSTANCE_ID = "4d6f4908-8b36-4d63-bcc0-3d690fcfb9ce";
const CONNECTOR_PID = 4182;
const CHILD_PID = 4183;
const NAMESPACE_INODE = 4_026_531_836;

interface ProcessRow {
  startTimeTicks: string;
  available: boolean;
  unreadable: boolean;
}

interface RigOptions {
  readonly revalidation?: { generationMatches: boolean; ownerMatches: boolean; cancelled?: boolean };
  readonly residue?: () => LocalProcessResidueProof;
  readonly onSignal?: (phase: LocalCancellationPhase) => void;
  readonly onChildStatRead?: (count: number, rows: Map<number, ProcessRow>) => void;
}

interface Rig {
  readonly adapter: LinuxProcessLifecycleAdapter;
  readonly events: string[];
  readonly readers: LinuxProcessEvidenceReaders;
  readonly rows: Map<number, ProcessRow>;
  readonly recoveries: string[];
  readonly proofAuthority: LinuxPreDispatchProofAuthority;
  setCancellationRequested(value: boolean): void;
}

function procStat(pid: number, startTimeTicks: string): string {
  const ppid = pid === CONNECTOR_PID ? 1 : CONNECTOR_PID;
  const pgrp = pid;
  const fields = [
    "S",
    String(ppid),
    String(pgrp),
    String(pgrp),
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
    startTimeTicks,
    "0",
    "0"
  ];
  return `${pid} (agy connector) ${fields.join(" ")}\n`;
}

function missingProcess(): never {
  throw Object.assign(new Error("process missing"), { code: "ENOENT" });
}

function rig(options: RigOptions = {}): Rig {
  const events: string[] = [];
  const recoveries: string[] = [];
  const rows = new Map<number, ProcessRow>([
    [CONNECTOR_PID, { startTimeTicks: "1234567890123", available: true, unreadable: false }],
    [CHILD_PID, { startTimeTicks: "1234567890124", available: true, unreadable: false }]
  ]);
  let cancellationRequested = options.revalidation?.cancelled ?? false;
  let childStatReads = 0;
  const proofAuthority = createLinuxPreDispatchProofAuthority(Buffer.alloc(32, 17));

  const readers: LinuxProcessEvidenceReaders = {
    readFile(path: string): string {
      if (path === "/proc/sys/kernel/random/boot_id") return `${BOOT_ID}\n`;
      const match = /^\/proc\/(\d+)\/stat$/.exec(path);
      if (match === null) throw new Error(`unexpected read: ${path}`);
      const pid = Number(match[1]);
      const row = rows.get(pid);
      if (!row?.available) return missingProcess();
      if (row.unreadable) throw new Error("procfs unavailable");
      if (pid === CHILD_PID) {
        childStatReads += 1;
        options.onChildStatRead?.(childStatReads, rows);
      }
      return procStat(pid, row.startTimeTicks);
    },
    readLink(path: string): string {
      const match = /^\/proc\/(\d+)\/ns\/pid$/.exec(path);
      if (match === null) throw new Error(`unexpected link: ${path}`);
      const row = rows.get(Number(match[1]));
      if (!row?.available) return missingProcess();
      if (row.unreadable) throw new Error("procfs unavailable");
      return `pid:[${NAMESPACE_INODE}]`;
    }
  };

  const controller: AdmissionProcessLifecycleOwner = {
    revalidate() {
      events.push("admission:revalidate");
      return {
        generationMatches: options.revalidation?.generationMatches ?? true,
        ownerMatches: options.revalidation?.ownerMatches ?? true,
        cancelled: cancellationRequested
      };
    },
    markRecoveryRequired(_fence, reason) {
      events.push("admission:recovery");
      recoveries.push(reason);
    }
  };

  const agy: AgyProcessLifecycleOwner = {
    async signal(phase) {
      events.push(`agy:signal:${phase}`);
      options.onSignal?.(phase);
    },
    async waitForExit(_identity, timeoutMs) {
      events.push(`agy:wait:${timeoutMs}`);
    },
    async queryResidue() {
      events.push("agy:residue");
      if (options.residue) return options.residue();
      const child = rows.get(CHILD_PID);
      return child?.available ? { root: "same", residue: "empty" } : { root: "gone", residue: "empty" };
    }
  };

  return {
    adapter: new LinuxProcessLifecycleAdapter({
      connectorPid: CONNECTOR_PID,
      readers,
      controller,
      agy,
      preDispatchProofSigner: proofAuthority,
      ownerDependencies: {
        createOwnerInstanceId: () => OWNER_INSTANCE_ID,
        now: () => new Date("2026-08-09T12:34:56.789Z")
      }
    }),
    events,
    readers,
    rows,
    recoveries,
    proofAuthority,
    setCancellationRequested(value: boolean) {
      cancellationRequested = value;
    }
  };
}

function activeRecord(subject: Rig): LinuxProcessLifecycleRecord {
  return preDispatchRecord(subject);
}

function preDispatchRecord(subject: Rig): LinuxProcessLifecycleRecord {
  const connector = subject.adapter.ownerIdentity;
  const child: LinuxProcessIdentity = Object.freeze({
    bootId: BOOT_ID,
    pid: CHILD_PID,
    startTimeTicks: "1234567890124",
    pidNamespaceInode: NAMESPACE_INODE,
    ppid: CONNECTOR_PID,
    pgrp: CHILD_PID,
    session: CHILD_PID
  });
  return Object.freeze({
    requestId: "request-42",
    leaseId: "lease-42",
    generation: 7,
    ownerInstanceId: connector.ownerInstanceId,
    processIdentity: Object.freeze({ connector, child }),
    promptChannel: "stdin"
  });
}

function preDispatchRecoveryRequest(record: LinuxProcessLifecycleRecord) {
  return {
    record,
    claim: {
      requestId: record.requestId,
      leaseId: record.leaseId,
      leaseGeneration: record.generation,
      recoveryGeneration: 1,
      claimantInstanceId: "recovery-a"
    },
    now: 1_011,
    phase: "starting" as const,
    dispatchIntent: "not_committed" as const
  };
}

describe("LinuxProcessLifecycleAdapter", () => {
  it("exposes no provider-start or business-prompt writer surface", () => {
    const subject = rig();

    expect("start" in subject.adapter).toBe(false);
    expect("writeBusinessPrompt" in subject.adapter).toBe(false);
  });

  it("treats heartbeat expiry as suspect only and does not reclaim or signal a process", () => {
    const subject = rig();

    expect(subject.adapter.observeHeartbeat({ heartbeatAt: 1_000, now: 1_010, ownerSuspectAfterMs: 10 })).toEqual({
      state: "suspect"
    });
    expect(subject.events).toEqual([]);
  });

  it("collects a signed pre-dispatch proof after owner and root termination without mutating admission state", async () => {
    const subject = rig({ residue: () => ({ root: "gone", residue: "empty" }) });
    const record = preDispatchRecord(subject);
    const owner = subject.rows.get(CONNECTOR_PID)!;
    const child = subject.rows.get(CHILD_PID)!;
    owner.available = false;
    child.available = false;

    const result = await subject.adapter.recoverPreDispatch(preDispatchRecoveryRequest(record));

    expect(result.outcome).toBe("proof");
    if (result.outcome !== "proof") throw new Error("expected a pre-dispatch proof");
    expect(verifyLinuxPreDispatchTerminationProof(result.proof, subject.proofAuthority)).toEqual(result.proof);
    expect(result.proof).toMatchObject({
      binding: {
        requestId: record.requestId,
        leaseId: record.leaseId,
        leaseGeneration: record.generation,
        recoveryGeneration: 1,
        claimantInstanceId: "recovery-a"
      },
      subject: {
        ownerInstanceId: record.ownerInstanceId,
        connectorCreatedAt: record.processIdentity.connector.createdAt,
        connector: {
          bootId: record.processIdentity.connector.bootId,
          pid: record.processIdentity.connector.pid,
          startTimeTicks: record.processIdentity.connector.startTimeTicks,
          pidNamespaceInode: record.processIdentity.connector.pidNamespaceInode,
          ppid: record.processIdentity.connector.ppid,
          pgrp: record.processIdentity.connector.pgrp,
          session: record.processIdentity.connector.session
        },
        child: record.processIdentity.child,
        promptChannel: record.promptChannel
      },
      observedAt: 1_011,
      owner: "gone",
      root: "gone",
      residue: "empty",
      proofHmac: expect.stringMatching(/^[0-9a-f]{64}$/)
    });
    expect(subject.events).toEqual(["agy:residue"]);
    expect(subject.recoveries).toEqual([]);
  });

  it("returns proof-only failures for alive, reused, missing, or remaining process evidence", async () => {
    const heartbeatOnly = rig();
    const heartbeatRecord = preDispatchRecord(heartbeatOnly);
    expect(heartbeatOnly.adapter.observeHeartbeat({ heartbeatAt: 1, now: 99, ownerSuspectAfterMs: 10 })).toEqual({
      state: "suspect"
    });
    expect(heartbeatOnly.events).toEqual([]);
    expect(heartbeatRecord.ownerInstanceId).toBe(OWNER_INSTANCE_ID);

    const alive = rig();
    const aliveResult = await alive.adapter.recoverPreDispatch(preDispatchRecoveryRequest(preDispatchRecord(alive)));
    expect(aliveResult).toEqual({ outcome: "not_proven", reason: "owner_alive" });
    expect(alive.events.filter((event) => event.startsWith("admission:"))).toEqual([]);

    const reused = rig();
    reused.rows.get(CONNECTOR_PID)!.startTimeTicks = "9999999999999";
    const reusedResult = await reused.adapter.recoverPreDispatch(preDispatchRecoveryRequest(preDispatchRecord(reused)));
    expect(reusedResult).toEqual({ outcome: "not_proven", reason: "owner_pid_reused" });
    expect(reused.events.filter((event) => event.startsWith("admission:"))).toEqual([]);

    const rootReused = rig();
    rootReused.rows.get(CONNECTOR_PID)!.available = false;
    rootReused.rows.get(CHILD_PID)!.startTimeTicks = "9999999999999";
    const rootReusedResult = await rootReused.adapter.recoverPreDispatch(
      preDispatchRecoveryRequest(preDispatchRecord(rootReused))
    );
    expect(rootReusedResult).toEqual({ outcome: "not_proven", reason: "pid_reused" });
    expect(rootReused.events.filter((event) => event.startsWith("admission:"))).toEqual([]);

    const unreadable = rig();
    unreadable.rows.get(CONNECTOR_PID)!.unreadable = true;
    const unreadableResult = await unreadable.adapter.recoverPreDispatch(preDispatchRecoveryRequest(preDispatchRecord(unreadable)));
    expect(unreadableResult).toEqual({ outcome: "not_proven", reason: "owner_unverifiable" });
    expect(unreadable.events.filter((event) => event.startsWith("admission:"))).toEqual([]);

    const descendants = rig({ residue: () => ({ root: "gone", residue: "present" }) });
    descendants.rows.get(CONNECTOR_PID)!.available = false;
    descendants.rows.get(CHILD_PID)!.available = false;
    const descendantResult = await descendants.adapter.recoverPreDispatch(
      preDispatchRecoveryRequest(preDispatchRecord(descendants))
    );
    expect(descendantResult).toEqual({ outcome: "not_proven", reason: "residue_present" });
    expect(descendants.events.filter((event) => event.startsWith("admission:"))).toEqual([]);
  });

  it("fails closed for PID reuse and partial cancellation without provider cancellation", async () => {
    const reused = rig();
    const reusedRecord = activeRecord(reused);
    reused.setCancellationRequested(true);
    reused.rows.get(CHILD_PID)!.startTimeTicks = "9999999999999";

    const reusedResult = await reused.adapter.cancel({
      record: reusedRecord,
      timeouts: { interruptMs: 1, terminateMs: 2, killMs: 3 }
    });

    expect(reusedResult).toMatchObject({
      outcome: "recovery_required",
      providerCancellation: "unconfirmed",
      reason: "cancellation_pid_reused"
    });
    expect(reused.events.filter((event) => event.startsWith("agy:signal:"))).toEqual([]);

    const partial = rig({
      residue: () => ({ root: "gone", residue: "present" }),
      onSignal(phase) {
        if (phase === "interrupt") partial.rows.get(CHILD_PID)!.available = false;
      }
    });
    const partialRecord = activeRecord(partial);
    partial.setCancellationRequested(true);
    const partialResult = await partial.adapter.cancel({
      record: partialRecord,
      timeouts: { interruptMs: 1, terminateMs: 2, killMs: 3 }
    });

    expect(partialResult).toMatchObject({
      outcome: "recovery_required",
      providerCancellation: "unconfirmed",
      reason: "cancellation_residue_present"
    });
    expect(partial.events.filter((event) => event.startsWith("agy:signal:"))).toEqual(["agy:signal:interrupt"]);
  });

  it("revalidates identity immediately before signaling so a PID reuse race cannot receive a signal", async () => {
    let armPidReuse = false;
    const subject = rig({
      onChildStatRead(count, rows) {
        // Read 1 is the escalator guard and read 2 is the signal-boundary guard.
        if (armPidReuse && count === 2) rows.get(CHILD_PID)!.startTimeTicks = "9999999999999";
      }
    });
    const record = activeRecord(subject);
    subject.setCancellationRequested(true);
    armPidReuse = true;

    const result = await subject.adapter.cancel({
      record,
      timeouts: { interruptMs: 1, terminateMs: 2, killMs: 3 }
    });

    expect(result).toMatchObject({ outcome: "recovery_required", reason: "cancellation_signal_failed" });
    expect(subject.events.filter((event) => event.startsWith("agy:signal:"))).toEqual([]);
  });

  it("turns a locally successful SIGKILL into recovery_required rather than provider cancelled", async () => {
    const subject = rig({
      onSignal(phase) {
        if (phase === "kill") subject.rows.get(CHILD_PID)!.available = false;
      }
    });
    const record = activeRecord(subject);
    subject.setCancellationRequested(true);

    const result = await subject.adapter.cancel({
      record,
      timeouts: { interruptMs: 1, terminateMs: 2, killMs: 3 }
    });

    expect(result).toMatchObject({
      outcome: "recovery_required",
      providerCancellation: "unconfirmed",
      reason: "local_sigkill"
    });
    expect(subject.events.filter((event) => event.startsWith("agy:signal:"))).toEqual([
      "agy:signal:interrupt",
      "agy:signal:terminate",
      "agy:signal:kill"
    ]);
    expect(subject.recoveries).toEqual(["local_sigkill"]);
  });
});
