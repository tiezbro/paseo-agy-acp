import { describe, expect, it } from "vitest";
import {
  captureLinuxProcessIdentity,
  createLinuxPreDispatchProofAuthority,
  issueLinuxPreDispatchTerminationProof,
  isSameLinuxProcessIdentity,
  observeLinuxProcessIdentity,
  parseLinuxProcessStat,
  ProcessEvidenceError,
  verifyLinuxPreDispatchTerminationProof,
  type LinuxProcessEvidenceReaders,
  type LinuxProcessIdentity,
  type LinuxPreDispatchProofPayload
} from "../Admission Controller/process-evidence.js";

const BOOT_ID = "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f31";
const PID = 4182;
const NAMESPACE_INODE = 4_026_531_836;

function procStat(
  overrides: Partial<{
    pid: number;
    comm: string;
    state: string;
    ppid: number;
    pgrp: number;
    session: number;
    startTimeTicks: string;
  }> = {}
): string {
  const values = {
    pid: PID,
    comm: "agy worker (interactive)",
    state: "S",
    ppid: 3711,
    pgrp: 4182,
    session: 4182,
    startTimeTicks: "1234567890123",
    ...overrides
  };

  // Fields 3 through 22 from proc_pid_stat(5), ending at starttime.
  const fields = [
    values.state,
    String(values.ppid),
    String(values.pgrp),
    String(values.session),
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
    values.startTimeTicks,
    "0",
    "0"
  ];
  return `${values.pid} (${values.comm}) ${fields.join(" ")}\n`;
}

function readers(
  stat = procStat(),
  overrides: Partial<{
    bootId: string;
    namespace: string;
    throwOnReadFile: boolean;
    throwOnReadLink: boolean;
  }> = {}
): LinuxProcessEvidenceReaders {
  return {
    readFile(file: string): string {
      if (overrides.throwOnReadFile) throw new Error("unavailable");
      if (file === "/proc/sys/kernel/random/boot_id") return `${overrides.bootId ?? BOOT_ID}\n`;
      if (file === `/proc/${PID}/stat`) return stat;
      throw new Error(`unexpected file read: ${file}`);
    },
    readLink(file: string): string {
      if (overrides.throwOnReadLink) throw new Error("unavailable");
      if (file === `/proc/${PID}/ns/pid`) return overrides.namespace ?? `pid:[${NAMESPACE_INODE}]`;
      throw new Error(`unexpected link read: ${file}`);
    }
  };
}

function capturedIdentity(): LinuxProcessIdentity {
  return captureLinuxProcessIdentity(PID, readers());
}

function preDispatchProofPayload(): LinuxPreDispatchProofPayload {
  const identity = capturedIdentity();
  return {
    binding: {
      requestId: "request-42",
      leaseId: "lease-42",
      leaseGeneration: 7,
      recoveryGeneration: 1,
      claimantInstanceId: "recovery-a"
    },
    subject: {
      ownerInstanceId: "4d6f4908-8b36-4d63-bcc0-3d690fcfb9ce",
      connectorCreatedAt: "2026-08-09T12:34:56.789Z",
      connector: identity,
      child: identity,
      promptChannel: "stdin"
    },
    observedAt: 1_011,
    owner: "gone",
    root: "gone",
    residue: "empty"
  };
}

describe("Linux admission process evidence", () => {
  it("captures all process identity evidence through injected readers", () => {
    expect(captureLinuxProcessIdentity(PID, readers())).toEqual({
      bootId: BOOT_ID,
      pid: PID,
      startTimeTicks: "1234567890123",
      pidNamespaceInode: NAMESPACE_INODE,
      ppid: 3711,
      pgrp: 4182,
      session: 4182
    });
  });

  it("parses /proc stat at the final parenthesis when comm contains spaces and parentheses", () => {
    const stat = procStat({ comm: "agy ) worker (interactive) with spaces", startTimeTicks: "987654321" });

    expect(parseLinuxProcessStat(stat)).toEqual({
      pid: PID,
      startTimeTicks: "987654321",
      ppid: 3711,
      pgrp: 4182,
      session: 4182
    });
    expect(captureLinuxProcessIdentity(PID, readers(stat)).startTimeTicks).toBe("987654321");
  });

  it("rejects unavailable, malformed, mismatched, or out-of-range process evidence", () => {
    expect(() => captureLinuxProcessIdentity(0, readers())).toThrow(ProcessEvidenceError);
    expect(() => captureLinuxProcessIdentity(1.5, readers())).toThrow(ProcessEvidenceError);
    expect(() => captureLinuxProcessIdentity(Number.MAX_SAFE_INTEGER + 1, readers())).toThrow(ProcessEvidenceError);
    expect(() => captureLinuxProcessIdentity(PID, readers(undefined, { throwOnReadFile: true }))).toThrow(ProcessEvidenceError);
    expect(() => captureLinuxProcessIdentity(PID, readers(undefined, { throwOnReadLink: true }))).toThrow(ProcessEvidenceError);
    expect(() => captureLinuxProcessIdentity(PID, readers("not a proc stat"))).toThrow(ProcessEvidenceError);
    expect(() => captureLinuxProcessIdentity(PID, readers(procStat({ pid: PID + 1 })))).toThrow(ProcessEvidenceError);
    expect(() => captureLinuxProcessIdentity(PID, readers(procStat({ ppid: -1 })))).toThrow(ProcessEvidenceError);
    expect(() => captureLinuxProcessIdentity(PID, readers(procStat({ pgrp: -1 })))).toThrow(ProcessEvidenceError);
    expect(() => captureLinuxProcessIdentity(PID, readers(procStat({ session: -1 })))).toThrow(ProcessEvidenceError);
    expect(() => captureLinuxProcessIdentity(PID, readers(procStat({ startTimeTicks: "0" })))).toThrow(ProcessEvidenceError);
    expect(() => captureLinuxProcessIdentity(PID, readers(procStat({ startTimeTicks: "18446744073709551616" })))).toThrow(ProcessEvidenceError);
    expect(() => captureLinuxProcessIdentity(PID, readers(undefined, { bootId: "not-a-boot-id" }))).toThrow(ProcessEvidenceError);
    expect(() => captureLinuxProcessIdentity(PID, readers(undefined, { namespace: "pid:[0]" }))).toThrow(ProcessEvidenceError);
    expect(() => captureLinuxProcessIdentity(PID, readers(undefined, { namespace: "pid:[4294967296]" }))).toThrow(ProcessEvidenceError);
    expect(() => captureLinuxProcessIdentity(PID, readers(undefined, { namespace: "user:[4026531836]" }))).toThrow(ProcessEvidenceError);
  });

  it("compares every field and fails closed for missing or malformed persisted evidence", () => {
    const expected = capturedIdentity();

    expect(isSameLinuxProcessIdentity(expected, { ...expected })).toBe(true);
    expect(isSameLinuxProcessIdentity(expected, { ...expected, bootId: "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f32" })).toBe(false);
    expect(isSameLinuxProcessIdentity(expected, { ...expected, pid: PID + 1 })).toBe(false);
    expect(isSameLinuxProcessIdentity(expected, { ...expected, startTimeTicks: "1234567890124" })).toBe(false);
    expect(isSameLinuxProcessIdentity(expected, { ...expected, pidNamespaceInode: NAMESPACE_INODE - 1 })).toBe(false);
    expect(isSameLinuxProcessIdentity(expected, { ...expected, ppid: 3712 })).toBe(false);
    expect(isSameLinuxProcessIdentity(expected, { ...expected, pgrp: 4183 })).toBe(false);
    expect(isSameLinuxProcessIdentity(expected, { ...expected, session: 4183 })).toBe(false);
    expect(isSameLinuxProcessIdentity(expected, { ...expected, startTimeTicks: "001234567890123" })).toBe(false);
    expect(isSameLinuxProcessIdentity(expected, { ...expected, pidNamespaceInode: 0 })).toBe(false);
    expect(isSameLinuxProcessIdentity(expected, { pid: PID })).toBe(false);
    expect(isSameLinuxProcessIdentity(expected, null)).toBe(false);
  });

  it("distinguishes a gone PID from PID reuse and unverifiable procfs evidence", () => {
    const expected = capturedIdentity();
    const source = readers();
    const missing: LinuxProcessEvidenceReaders = {
      readFile(file) {
        if (file === `/proc/${PID}/stat`) throw Object.assign(new Error("gone"), { code: "ENOENT" });
        return source.readFile(file);
      },
      readLink: source.readLink
    };

    expect(observeLinuxProcessIdentity(expected, readers())).toBe("same");
    expect(observeLinuxProcessIdentity(expected, readers(procStat({ startTimeTicks: "1234567890124" })))).toBe("pid_reused");
    expect(observeLinuxProcessIdentity(expected, missing)).toBe("gone");
    expect(observeLinuxProcessIdentity(expected, readers(undefined, { throwOnReadFile: true }))).toBe("unverifiable");
    expect(observeLinuxProcessIdentity({ pid: PID }, readers())).toBe("unverifiable");
  });

  it("issues a canonical HMAC proof that fails closed when forged", () => {
    const authority = createLinuxPreDispatchProofAuthority(Buffer.alloc(32, 9));
    const proof = issueLinuxPreDispatchTerminationProof(preDispatchProofPayload(), authority);

    expect(verifyLinuxPreDispatchTerminationProof(proof, authority)).toEqual(proof);
    expect(
      verifyLinuxPreDispatchTerminationProof(
        { ...proof, observedAt: proof.observedAt + 1 },
        authority
      )
    ).toBeNull();
    expect(
      verifyLinuxPreDispatchTerminationProof(
        {
          ...proof,
          proofHmac: `${proof.proofHmac[0] === "0" ? "1" : "0"}${proof.proofHmac.slice(1)}`
        },
        authority
      )
    ).toBeNull();

    authority.close();
    expect(verifyLinuxPreDispatchTerminationProof(proof, authority)).toBeNull();
    expect(() => issueLinuxPreDispatchTerminationProof(preDispatchProofPayload(), authority)).toThrow(ProcessEvidenceError);
  });
});
