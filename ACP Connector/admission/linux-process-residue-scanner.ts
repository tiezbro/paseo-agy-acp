import { readdirSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import {
  captureLinuxProcessIdentity,
  isSameLinuxProcessIdentity,
  observeLinuxProcessIdentity,
  type LinuxProcessEvidenceReaders,
  type LinuxProcessIdentity
} from "../../Admission Controller/process-evidence.js";
import type {
  StartupRecoveryProcessInventory,
  StartupRecoveryProcessObservation,
  StartupRecoveryProcessSubject
} from "../../Admission Controller/startup-recovery-barrier.js";

const MAX_PID = 2_147_483_647;

export interface LinuxProcessResidueReaders extends LinuxProcessEvidenceReaders {
  listProcessIds(): readonly number[];
}

export interface LinuxProcessResidueScannerOptions {
  /** Exact verified executable used by the prompt-free `agy --print` path. */
  readonly agyExecutable: string;
  readonly readers?: LinuxProcessResidueReaders;
}

export class LinuxProcessResidueScannerConfigurationError extends Error {
  constructor() {
    super("linux process residue scanner configuration is invalid");
    this.name = "LinuxProcessResidueScannerConfigurationError";
  }
}

export const nativeLinuxProcessResidueReaders: LinuxProcessResidueReaders = Object.freeze({
  listProcessIds(): readonly number[] {
    return readdirSync("/proc", { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[1-9][0-9]*$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= MAX_PID);
  },
  readFile(filePath: string): string {
    return readFileSync(filePath, "utf8");
  },
  readLink(filePath: string): string {
    return readlinkSync(filePath, "utf8");
  }
});

/**
 * Read-only Linux scanner for the startup barrier. It never reads process
 * environments and never returns argv. Command lines are inspected only to
 * recognize the repository's prompt-free `--output-format stream-json` shape.
 */
export class LinuxProcessResidueScanner {
  readonly #agyExecutable: string;
  readonly #readers: LinuxProcessResidueReaders;

  constructor(options: LinuxProcessResidueScannerOptions) {
    if (!isPlainRecord(options) || !isAbsoluteExecutable(options.agyExecutable)) {
      throw new LinuxProcessResidueScannerConfigurationError();
    }
    const readers = options.readers ?? nativeLinuxProcessResidueReaders;
    if (!isReaders(readers)) throw new LinuxProcessResidueScannerConfigurationError();
    this.#agyExecutable = path.normalize(options.agyExecutable);
    this.#readers = readers;
  }

  inspect(subjectsInput: readonly StartupRecoveryProcessSubject[]): StartupRecoveryProcessInventory {
    const subjects = normalizeSubjects(subjectsInput);
    if (subjects === null) return unverifiableInventory();

    let listedProcessIds: readonly number[];
    try {
      listedProcessIds = this.#readers.listProcessIds();
    } catch {
      return unverifiableInventory();
    }
    const processIds = normalizeProcessIds(listedProcessIds);
    if (processIds === null) return unverifiableInventory();

    const observations: StartupRecoveryProcessObservation[] = [];
    let inventoryUnverifiable = false;
    for (const subject of subjects) {
      const connector = observeLinuxProcessIdentity(subject.processIdentity.connector, this.#readers);
      const child = observeLinuxProcessIdentity(subject.processIdentity.child, this.#readers);
      const residue = inspectKnownProcessGroup(subject.processIdentity.child, processIds, this.#readers);
      if (residue === "unverifiable") inventoryUnverifiable = true;
      observations.push(Object.freeze({
        requestId: subject.requestId,
        leaseId: subject.fence.leaseId,
        generation: subject.fence.generation,
        ownerInstanceId: subject.fence.ownerInstanceId,
        connector,
        child,
        residue
      }));
    }

    const knownChildren = subjects.map((subject) => subject.processIdentity.child);
    const untrackedResidue = inventoryUnverifiable
      ? "unverifiable"
      : inspectUntrackedPromptFreeAgy(
          processIds,
          knownChildren,
          this.#agyExecutable,
          this.#readers
        );
    return Object.freeze({ observations: Object.freeze(observations), untrackedResidue });
  }
}

export function createLinuxProcessResidueScanner(
  options: LinuxProcessResidueScannerOptions
): LinuxProcessResidueScanner {
  return new LinuxProcessResidueScanner(options);
}

function inspectKnownProcessGroup(
  expected: LinuxProcessIdentity,
  processIds: readonly number[],
  readers: LinuxProcessResidueReaders
): "empty" | "present" | "unverifiable" {
  let unverifiable = false;
  for (const pid of processIds) {
    let observed: LinuxProcessIdentity;
    try {
      observed = captureLinuxProcessIdentity(pid, readers);
    } catch (error) {
      if (isGone(error)) continue;
      unverifiable = true;
      continue;
    }
    if (
      observed.bootId === expected.bootId &&
      observed.pidNamespaceInode === expected.pidNamespaceInode &&
      observed.pgrp === expected.pgrp &&
      observed.session === expected.session
    ) {
      return "present";
    }
  }
  return unverifiable ? "unverifiable" : "empty";
}

function inspectUntrackedPromptFreeAgy(
  processIds: readonly number[],
  knownChildren: readonly LinuxProcessIdentity[],
  agyExecutable: string,
  readers: LinuxProcessResidueReaders
): "empty" | "present" | "unverifiable" {
  let unverifiable = false;
  for (const pid of processIds) {
    let executable: string;
    try {
      executable = path.normalize(readers.readLink(`/proc/${pid}/exe`));
    } catch (error) {
      if (isGone(error)) continue;
      unverifiable = true;
      continue;
    }
    if (executable !== agyExecutable) continue;

    let commandLine: string;
    try {
      commandLine = readers.readFile(`/proc/${pid}/cmdline`);
    } catch (error) {
      if (isGone(error)) continue;
      unverifiable = true;
      continue;
    }
    if (!isPromptFreeCommandLine(commandLine)) continue;

    let identity: LinuxProcessIdentity;
    try {
      identity = captureLinuxProcessIdentity(pid, readers);
    } catch (error) {
      if (isGone(error)) continue;
      unverifiable = true;
      continue;
    }
    if (!knownChildren.some((expected) => isSameLinuxProcessIdentity(expected, identity))) {
      return "present";
    }
  }
  return unverifiable ? "unverifiable" : "empty";
}

function isPromptFreeCommandLine(value: string): boolean {
  const argv = value.split("\0").filter((entry) => entry.length > 0);
  if (argv.length === 0) return false;
  const printIndex = argv.indexOf("--print");
  const outputIndex = argv.indexOf("--output-format");
  return printIndex > 0 && outputIndex > 0 && argv[outputIndex + 1] === "stream-json";
}

function normalizeSubjects(value: unknown): readonly StartupRecoveryProcessSubject[] | null {
  if (!Array.isArray(value)) return null;
  for (const subject of value) {
    if (!isPlainRecord(subject) || !isPlainRecord(subject.fence) || !isPlainRecord(subject.processIdentity)) {
      return null;
    }
    if (
      typeof subject.requestId !== "string" ||
      typeof subject.fence.leaseId !== "string" ||
      !Number.isSafeInteger(subject.fence.generation) ||
      typeof subject.fence.ownerInstanceId !== "string" ||
      !isPlainRecord(subject.processIdentity.connector) ||
      !isPlainRecord(subject.processIdentity.child)
    ) {
      return null;
    }
  }
  return value as readonly StartupRecoveryProcessSubject[];
}

function normalizeProcessIds(value: unknown): readonly number[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.slice();
  if (ids.some((pid) => !Number.isSafeInteger(pid) || pid < 1 || pid > MAX_PID)) return null;
  return Object.freeze([...new Set(ids as number[])].sort((left, right) => left - right));
}

function unverifiableInventory(): StartupRecoveryProcessInventory {
  return Object.freeze({ observations: Object.freeze([]), untrackedResidue: "unverifiable" });
}

function isAbsoluteExecutable(value: unknown): value is string {
  return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
}

function isReaders(value: unknown): value is LinuxProcessResidueReaders {
  return isPlainRecord(value) &&
    typeof value.listProcessIds === "function" &&
    typeof value.readFile === "function" &&
    typeof value.readLink === "function";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isGone(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
