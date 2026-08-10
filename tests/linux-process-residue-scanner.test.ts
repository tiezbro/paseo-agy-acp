import { describe, expect, it } from "vitest";
import {
  LinuxProcessResidueScanner,
  LinuxProcessResidueScannerConfigurationError,
  type LinuxProcessResidueReaders
} from "../src/admission/linux-process-residue-scanner.js";
import type { StartupRecoveryProcessSubject } from "../src/admission/startup-recovery-barrier.js";

const BOOT_ID = "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f31";
const OWNER_ID = "4d6f4908-8b36-4d63-bcc0-3d690fcfb9ce";
const AGY = "/opt/agy/bin/agy";

interface ProcessFixture {
  readonly pid: number;
  readonly ppid: number;
  readonly pgrp: number;
  readonly session: number;
  readonly startTimeTicks: string;
  readonly executable?: string;
  readonly argv?: readonly string[];
}

describe("LinuxProcessResidueScanner", () => {
  it("reports exact known process and process-group residue without returning argv", () => {
    const connector = fixture({ pid: 100, ppid: 1, pgrp: 100, session: 100, startTimeTicks: "1000" });
    const child = fixture({
      pid: 101,
      ppid: 100,
      pgrp: 101,
      session: 101,
      startTimeTicks: "1001",
      executable: AGY,
      argv: [AGY, "--print", "--output-format", "stream-json"]
    });
    const scanner = new LinuxProcessResidueScanner({
      agyExecutable: AGY,
      readers: readers([connector, child])
    });

    const inventory = scanner.inspect([subject(connector, child)]);

    expect(inventory).toEqual({
      observations: [{
        requestId: "request-1",
        leaseId: "lease-1",
        generation: 1,
        ownerInstanceId: OWNER_ID,
        connector: "same",
        child: "same",
        residue: "present"
      }],
      untrackedResidue: "empty"
    });
    expect(JSON.stringify(inventory)).not.toContain("--output-format");
  });

  it("proves an empty known process group when both exact processes are gone", () => {
    const connector = fixture({ pid: 100, ppid: 1, pgrp: 100, session: 100, startTimeTicks: "1000" });
    const child = fixture({ pid: 101, ppid: 100, pgrp: 101, session: 101, startTimeTicks: "1001" });
    const scanner = new LinuxProcessResidueScanner({ agyExecutable: AGY, readers: readers([]) });

    expect(scanner.inspect([subject(connector, child)])).toEqual({
      observations: [{
        requestId: "request-1",
        leaseId: "lease-1",
        generation: 1,
        ownerInstanceId: OWNER_ID,
        connector: "gone",
        child: "gone",
        residue: "empty"
      }],
      untrackedResidue: "empty"
    });
  });

  it("treats a reused known PID running prompt-free agy as untracked residue", () => {
    const connector = fixture({ pid: 100, ppid: 1, pgrp: 100, session: 100, startTimeTicks: "1000" });
    const expectedChild = fixture({ pid: 101, ppid: 100, pgrp: 101, session: 101, startTimeTicks: "1001" });
    const reusedChild = fixture({
      pid: 101,
      ppid: 1,
      pgrp: 700,
      session: 700,
      startTimeTicks: "9001",
      executable: AGY,
      argv: [AGY, "--print", "--output-format", "stream-json"]
    });
    const scanner = new LinuxProcessResidueScanner({
      agyExecutable: AGY,
      readers: readers([reusedChild])
    });

    const inventory = scanner.inspect([subject(connector, expectedChild)]);
    expect(inventory.observations[0]).toMatchObject({ connector: "gone", child: "pid_reused", residue: "empty" });
    expect(inventory.untrackedResidue).toBe("present");
  });

  it("detects an untracked prompt-free agy child but ignores a manual argv prompt", () => {
    const promptFree = fixture({
      pid: 201,
      ppid: 1,
      pgrp: 201,
      session: 201,
      startTimeTicks: "2001",
      executable: AGY,
      argv: [AGY, "--print", "--output-format", "stream-json"]
    });
    const manual = fixture({
      pid: 202,
      ppid: 1,
      pgrp: 202,
      session: 202,
      startTimeTicks: "2002",
      executable: AGY,
      argv: [AGY, "--print", "manual-secret-prompt"]
    });

    expect(new LinuxProcessResidueScanner({
      agyExecutable: AGY,
      readers: readers([promptFree])
    }).inspect([]).untrackedResidue).toBe("present");
    expect(new LinuxProcessResidueScanner({
      agyExecutable: AGY,
      readers: readers([manual])
    }).inspect([]).untrackedResidue).toBe("empty");
  });

  it("fails closed on an unreadable process inventory or malformed subject", () => {
    const failing: LinuxProcessResidueReaders = {
      listProcessIds() {
        throw new Error("private underlying detail");
      },
      readFile() {
        throw new Error("unused");
      },
      readLink() {
        throw new Error("unused");
      }
    };
    const scanner = new LinuxProcessResidueScanner({ agyExecutable: AGY, readers: failing });
    expect(scanner.inspect([])).toEqual({ observations: [], untrackedResidue: "unverifiable" });
    expect(scanner.inspect([{} as StartupRecoveryProcessSubject])).toEqual({
      observations: [],
      untrackedResidue: "unverifiable"
    });
  });

  it("rejects relative executables and incomplete reader capabilities", () => {
    expect(() => new LinuxProcessResidueScanner({ agyExecutable: "agy" })).toThrow(
      LinuxProcessResidueScannerConfigurationError
    );
    expect(() => new LinuxProcessResidueScanner({
      agyExecutable: AGY,
      readers: {} as LinuxProcessResidueReaders
    })).toThrow(LinuxProcessResidueScannerConfigurationError);
  });
});

function subject(connector: ProcessFixture, child: ProcessFixture): StartupRecoveryProcessSubject {
  return Object.freeze({
    requestId: "request-1",
    fence: Object.freeze({ leaseId: "lease-1", generation: 1, ownerInstanceId: OWNER_ID }),
    processIdentity: Object.freeze({
      promptChannel: "stdin" as const,
      connector: Object.freeze({
        ownerInstanceId: OWNER_ID,
        createdAt: "2026-08-09T12:34:56.789Z",
        ...identity(connector)
      }),
      child: Object.freeze(identity(child))
    })
  });
}

function identity(process: ProcessFixture) {
  return {
    bootId: BOOT_ID,
    pid: process.pid,
    startTimeTicks: process.startTimeTicks,
    pidNamespaceInode: 4_026_531_836,
    ppid: process.ppid,
    pgrp: process.pgrp,
    session: process.session
  };
}

function fixture(input: ProcessFixture): ProcessFixture {
  return Object.freeze(input);
}

function readers(processes: readonly ProcessFixture[]): LinuxProcessResidueReaders {
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  return {
    listProcessIds: () => processes.map((process) => process.pid),
    readFile(filePath) {
      if (filePath === "/proc/sys/kernel/random/boot_id") return `${BOOT_ID}\n`;
      const match = /^\/proc\/(\d+)\/(stat|cmdline)$/.exec(filePath);
      if (!match) throw gone();
      const process = byPid.get(Number(match[1]));
      if (!process) throw gone();
      if (match[2] === "cmdline") return `${(process.argv ?? []).join("\0")}\0`;
      return stat(process);
    },
    readLink(filePath) {
      const match = /^\/proc\/(\d+)\/(ns\/pid|exe)$/.exec(filePath);
      if (!match) throw gone();
      const process = byPid.get(Number(match[1]));
      if (!process) throw gone();
      return match[2] === "ns/pid" ? "pid:[4026531836]" : process.executable ?? "/usr/bin/node";
    }
  };
}

function stat(process: ProcessFixture): string {
  const fields = [
    "S",
    String(process.ppid),
    String(process.pgrp),
    String(process.session),
    ...Array.from({ length: 15 }, () => "0"),
    process.startTimeTicks
  ];
  return `${process.pid} (agy worker) ${fields.join(" ")}\n`;
}

function gone(): NodeJS.ErrnoException {
  const error = new Error("gone") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}
