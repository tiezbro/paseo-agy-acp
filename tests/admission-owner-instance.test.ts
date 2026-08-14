import { describe, expect, it } from "vitest";
import {
  captureLinuxConnectorOwnerIdentity,
  ConnectorOwnerIdentityError,
  observePersistedLinuxConnectorOwnerIdentity,
  verifyPersistedLinuxConnectorOwnerIdentity,
  type LinuxConnectorOwnerIdentity,
  type OwnerInstanceDependencies
} from "../ACP Connector/admission/owner-instance.js";
import type { LinuxProcessEvidenceReaders } from "../Admission Controller/process-evidence.js";

const BOOT_ID = "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f31";
const PID = 4182;
const NAMESPACE_INODE = 4_026_531_836;
const CREATED_AT = "2026-08-09T12:34:56.789Z";
const OWNER_INSTANCE_ID = "4d6f4908-8b36-4d63-bcc0-3d690fcfb9ce";

function procStat(
  overrides: Partial<{
    pid: number;
    ppid: number;
    pgrp: number;
    session: number;
    startTimeTicks: string;
  }> = {}
): string {
  const values = {
    pid: PID,
    ppid: 3711,
    pgrp: 4182,
    session: 4182,
    startTimeTicks: "1234567890123",
    ...overrides
  };
  const fields = [
    "S",
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
  return `${values.pid} (agy connector) ${fields.join(" ")}\n`;
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

function dependencies(overrides: Partial<OwnerInstanceDependencies> = {}): OwnerInstanceDependencies {
  return {
    createOwnerInstanceId: () => OWNER_INSTANCE_ID,
    now: () => new Date(CREATED_AT),
    ...overrides
  };
}

function capturedIdentity(overrides: Partial<OwnerInstanceDependencies> = {}): LinuxConnectorOwnerIdentity {
  return captureLinuxConnectorOwnerIdentity(PID, readers(), dependencies(overrides));
}

describe("Linux connector owner instances", () => {
  it("creates an immutable identity from injected Linux process evidence", () => {
    const identity = capturedIdentity();

    expect(identity).toEqual({
      ownerInstanceId: OWNER_INSTANCE_ID,
      createdAt: CREATED_AT,
      bootId: BOOT_ID,
      pid: PID,
      startTimeTicks: "1234567890123",
      pidNamespaceInode: NAMESPACE_INODE,
      ppid: 3711,
      pgrp: 4182,
      session: 4182
    });
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it("uses cryptographic UUID v4 owner instance IDs by default", () => {
    const first = captureLinuxConnectorOwnerIdentity(PID, readers(), { now: () => new Date(CREATED_AT) });
    const second = captureLinuxConnectorOwnerIdentity(PID, readers(), { now: () => new Date(CREATED_AT) });

    expect(first.ownerInstanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second.ownerInstanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second.ownerInstanceId).not.toBe(first.ownerInstanceId);
  });

  it("rejects empty or malformed owner instance IDs and invalid clock timestamps", () => {
    for (const ownerInstanceId of ["", "   ", "connector-1", "00000000-0000-0000-0000-000000000000"]) {
      expect(() => capturedIdentity({ createOwnerInstanceId: () => ownerInstanceId })).toThrow(ConnectorOwnerIdentityError);
    }
    expect(() => capturedIdentity({ now: () => new Date("invalid") })).toThrow(ConnectorOwnerIdentityError);
  });

  it("verifies a persisted identity only when a fresh injected observation matches", () => {
    const persisted = capturedIdentity();

    expect(verifyPersistedLinuxConnectorOwnerIdentity(persisted, readers())).toBe(true);
    expect(verifyPersistedLinuxConnectorOwnerIdentity({ ...persisted, bootId: "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f32" }, readers())).toBe(false);
    expect(verifyPersistedLinuxConnectorOwnerIdentity({ ...persisted, pid: PID + 1 }, readers())).toBe(false);
    expect(verifyPersistedLinuxConnectorOwnerIdentity({ ...persisted, startTimeTicks: "1234567890124" }, readers())).toBe(false);
    expect(verifyPersistedLinuxConnectorOwnerIdentity({ ...persisted, pidNamespaceInode: NAMESPACE_INODE - 1 }, readers())).toBe(false);
    expect(verifyPersistedLinuxConnectorOwnerIdentity({ ...persisted, ppid: 1 }, readers())).toBe(false);
    expect(verifyPersistedLinuxConnectorOwnerIdentity({ ...persisted, pgrp: 1 }, readers())).toBe(false);
    expect(verifyPersistedLinuxConnectorOwnerIdentity({ ...persisted, session: 1 }, readers())).toBe(false);
  });

  it("fails closed for malformed persisted IDs or timestamps and unavailable evidence", () => {
    const persisted = capturedIdentity();

    for (const ownerInstanceId of ["", "not-a-uuid", "00000000-0000-0000-0000-000000000000"]) {
      expect(verifyPersistedLinuxConnectorOwnerIdentity({ ...persisted, ownerInstanceId }, readers())).toBe(false);
    }
    for (const createdAt of ["", "2026-02-30T00:00:00.000Z", "2026-08-09T12:34:56Z", "2026-08-09T12:34:56.789+00:00"]) {
      expect(verifyPersistedLinuxConnectorOwnerIdentity({ ...persisted, createdAt }, readers())).toBe(false);
    }
    for (const startTimeTicks of ["", "0", "not-a-timestamp", "001234567890123"]) {
      expect(verifyPersistedLinuxConnectorOwnerIdentity({ ...persisted, startTimeTicks }, readers())).toBe(false);
    }
    expect(verifyPersistedLinuxConnectorOwnerIdentity({ ...persisted, createdAt: 1234 }, readers())).toBe(false);
    expect(verifyPersistedLinuxConnectorOwnerIdentity({ ownerInstanceId: OWNER_INSTANCE_ID }, readers())).toBe(false);
    expect(verifyPersistedLinuxConnectorOwnerIdentity(null, readers())).toBe(false);
    expect(verifyPersistedLinuxConnectorOwnerIdentity(persisted, readers(undefined, { throwOnReadFile: true }))).toBe(false);
    expect(verifyPersistedLinuxConnectorOwnerIdentity(persisted, readers(undefined, { throwOnReadLink: true }))).toBe(false);
  });

  it("reports owner loss separately from PID reuse and unreadable procfs", () => {
    const persisted = capturedIdentity();
    const source = readers();
    const missing: LinuxProcessEvidenceReaders = {
      readFile(file) {
        if (file === `/proc/${PID}/stat`) throw Object.assign(new Error("gone"), { code: "ENOENT" });
        return source.readFile(file);
      },
      readLink: source.readLink
    };

    expect(observePersistedLinuxConnectorOwnerIdentity(persisted, readers())).toBe("same");
    expect(observePersistedLinuxConnectorOwnerIdentity(persisted, readers(procStat({ startTimeTicks: "1234567890124" })))).toBe(
      "pid_reused"
    );
    expect(observePersistedLinuxConnectorOwnerIdentity(persisted, missing)).toBe("gone");
    expect(observePersistedLinuxConnectorOwnerIdentity(persisted, readers(undefined, { throwOnReadFile: true }))).toBe(
      "unverifiable"
    );
  });
});
