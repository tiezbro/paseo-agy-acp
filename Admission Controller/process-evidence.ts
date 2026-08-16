import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";

const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";
const MAX_PID = 2_147_483_647;
const MAX_PID_NAMESPACE_INODE = 4_294_967_295;
const MAX_START_TIME_TICKS = 18_446_744_073_709_551_615n;
const BOOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/;
const SIGNED_DECIMAL_PATTERN = /^-?[0-9]+$/;
const PROCESS_STATES = new Set(["R", "S", "D", "Z", "T", "t", "W", "X", "x", "K", "P", "I"]);
const MAX_IDENTIFIER_LENGTH = 256;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HMAC_PATTERN = /^[0-9a-f]{64}$/;
const PRE_DISPATCH_PROOF_DOMAIN = "paseo-agy-acp/linux-pre-dispatch-proof/v1";

export interface LinuxProcessEvidenceReaders {
  readFile(path: string): string;
  readLink(path: string): string;
}

/** Immutable Linux evidence used to distinguish a PID from a later PID reuse. */
export interface LinuxProcessIdentity {
  readonly bootId: string;
  readonly pid: number;
  readonly startTimeTicks: string;
  readonly pidNamespaceInode: number;
  readonly ppid: number;
  readonly pgrp: number;
  readonly session: number;
}

export interface LinuxProcessStatEvidence {
  readonly pid: number;
  readonly startTimeTicks: string;
  readonly ppid: number;
  readonly pgrp: number;
  readonly session: number;
}

/** The durable recovery claim fields that a process proof must bind exactly. */
export interface LinuxPreDispatchProofBinding {
  readonly requestId: string;
  readonly leaseId: string;
  readonly leaseGeneration: number;
  readonly recoveryGeneration: number;
  readonly claimantInstanceId: string;
}

/** The immutable local process record observed for a pre-dispatch proof. */
export interface LinuxPreDispatchProofSubject {
  readonly ownerInstanceId: string;
  readonly connectorCreatedAt: string;
  readonly connector: LinuxProcessIdentity;
  readonly child: LinuxProcessIdentity;
  readonly promptChannel: "stdin" | "pty";
}

/** The signed payload for the only automatic pre-dispatch recovery path. */
export interface LinuxPreDispatchProofPayload {
  readonly binding: LinuxPreDispatchProofBinding;
  readonly subject: LinuxPreDispatchProofSubject;
  readonly observedAt: number;
  readonly owner: "gone";
  readonly root: "gone";
  readonly residue: "empty";
}

/** A proof producer needs only signing capability, never controller mutation. */
export interface LinuxPreDispatchProofSigner {
  signPreDispatchProof(payload: LinuxPreDispatchProofPayload): string;
}

/** A recovery coordinator needs only verification capability. */
export interface LinuxPreDispatchProofVerifier {
  verifyPreDispatchProof(payload: LinuxPreDispatchProofPayload, proofHmac: string): boolean;
}

export interface LinuxPreDispatchProofAuthority extends LinuxPreDispatchProofSigner, LinuxPreDispatchProofVerifier {
  close(): void;
}

/** An HMAC-authenticated, claim-bound observation of an empty pre-dispatch process tree. */
export interface LinuxPreDispatchTerminationProof extends LinuxPreDispatchProofPayload {
  readonly proofHmac: string;
}

/** A conservative observation of a persisted process identity. */
export type LinuxProcessIdentityState = "same" | "gone" | "pid_reused" | "unverifiable";
export type LinuxProcessGroupState = "empty" | "present" | "unverifiable";

export class ProcessEvidenceError extends Error {
  readonly kind: "process_gone" | "unverifiable";

  constructor(message: string, kind: "process_gone" | "unverifiable" = "unverifiable") {
    super(`process evidence error: ${message}`);
    this.name = "ProcessEvidenceError";
    this.kind = kind;
  }
}

/**
 * The production readers are explicit so callers can inject a deterministic
 * filesystem view in tests and never inspect a real process by accident.
 */
export const nativeLinuxProcessEvidenceReaders: LinuxProcessEvidenceReaders = Object.freeze({
  readFile(path: string): string {
    return readFileSync(path, "utf8");
  },
  readLink(path: string): string {
    return readlinkSync(path, "utf8");
  }
});

/**
 * Construct the local proof authority from a caller-owned 32-byte key. The
 * adapter receives only the signing half; the coordinator receives only the
 * verification half, so process inspection cannot mutate durable state.
 */
export function createLinuxPreDispatchProofAuthority(key: Buffer): LinuxPreDispatchProofAuthority {
  if (!Buffer.isBuffer(key) || key.length !== 32) {
    throw new ProcessEvidenceError("pre-dispatch proof key must be exactly 32 bytes");
  }
  const secret = Buffer.from(key);
  let closed = false;

  return Object.freeze({
    signPreDispatchProof(value: LinuxPreDispatchProofPayload): string {
      if (closed) throw new ProcessEvidenceError("pre-dispatch proof authority is closed");
      const payload = normalizeLinuxPreDispatchProofPayload(value);
      if (payload === null) throw new ProcessEvidenceError("pre-dispatch proof payload is invalid");
      return preDispatchProofHmac(secret, payload);
    },
    verifyPreDispatchProof(value: LinuxPreDispatchProofPayload, proofHmac: string): boolean {
      if (closed) return false;
      const payload = normalizeLinuxPreDispatchProofPayload(value);
      if (payload === null || !isHmac(proofHmac)) return false;
      return sameHmac(preDispatchProofHmac(secret, payload), proofHmac);
    },
    close(): void {
      if (closed) return;
      closed = true;
      secret.fill(0);
    }
  });
}

/** Sign a normalized proof payload without giving the caller access to the signing key. */
export function issueLinuxPreDispatchTerminationProof(
  value: unknown,
  signer: unknown
): LinuxPreDispatchTerminationProof {
  const payload = normalizeLinuxPreDispatchProofPayload(value);
  if (payload === null || !isProofSigner(signer)) {
    throw new ProcessEvidenceError("pre-dispatch proof inputs are invalid");
  }

  let proofHmac: unknown;
  try {
    proofHmac = signer.signPreDispatchProof(payload);
  } catch {
    throw new ProcessEvidenceError("pre-dispatch proof could not be signed");
  }
  if (!isHmac(proofHmac)) throw new ProcessEvidenceError("pre-dispatch proof signature is invalid");

  return Object.freeze({ ...payload, proofHmac });
}

/** Return a copied proof only when its shape and HMAC both verify. */
export function verifyLinuxPreDispatchTerminationProof(
  value: unknown,
  verifier: unknown
): LinuxPreDispatchTerminationProof | null {
  const proof = normalizeLinuxPreDispatchTerminationProof(value);
  if (proof === null || !isProofVerifier(verifier)) return null;

  try {
    return verifier.verifyPreDispatchProof(proofPayload(proof), proof.proofHmac) === true ? proof : null;
  } catch {
    return null;
  }
}

/** Validate and copy a claim binding before it becomes part of a signed proof. */
export function validateLinuxPreDispatchProofBinding(value: unknown): LinuxPreDispatchProofBinding | null {
  const record = exactRecord(value, [
    "requestId",
    "leaseId",
    "leaseGeneration",
    "recoveryGeneration",
    "claimantInstanceId"
  ]);
  if (
    record === null ||
    !isIdentifier(record.requestId) ||
    !isIdentifier(record.leaseId) ||
    !isPositiveSafeInteger(record.leaseGeneration) ||
    !isPositiveSafeInteger(record.recoveryGeneration) ||
    !isIdentifier(record.claimantInstanceId)
  ) {
    return null;
  }

  return Object.freeze({
    requestId: record.requestId,
    leaseId: record.leaseId,
    leaseGeneration: record.leaseGeneration,
    recoveryGeneration: record.recoveryGeneration,
    claimantInstanceId: record.claimantInstanceId
  });
}

/** Capture the Linux-only evidence needed to recognize one process instance. */
export function captureLinuxProcessIdentity(
  pid: number,
  readers: LinuxProcessEvidenceReaders = nativeLinuxProcessEvidenceReaders
): LinuxProcessIdentity {
  const expectedPid = requirePositiveNumber(pid, "pid", MAX_PID);
  requireReaders(readers);

  const bootId = parseBootId(readEvidence(() => readers.readFile(BOOT_ID_PATH)));
  const stat = parseLinuxProcessStat(readEvidence(() => readers.readFile(`/proc/${expectedPid}/stat`), "process"));
  if (stat.pid !== expectedPid) throw new ProcessEvidenceError("stat PID does not match the requested PID");
  const pidNamespaceInode = parsePidNamespaceInode(
    readEvidence(() => readers.readLink(`/proc/${expectedPid}/ns/pid`), "process")
  );

  return Object.freeze({
    bootId,
    pid: expectedPid,
    startTimeTicks: stat.startTimeTicks,
    pidNamespaceInode,
    ppid: stat.ppid,
    pgrp: stat.pgrp,
    session: stat.session
  });
}

/**
 * Re-observe a persisted process without reducing a reused PID to a liveness
 * check. Only a direct ENOENT from the process-specific procfs paths is gone;
 * malformed or inaccessible evidence remains unverifiable.
 */
export function observeLinuxProcessIdentity(
  expected: unknown,
  readers: LinuxProcessEvidenceReaders = nativeLinuxProcessEvidenceReaders
): LinuxProcessIdentityState {
  const normalizedExpected = normalizeIdentity(expected);
  if (normalizedExpected === null) return "unverifiable";

  try {
    const observed = captureLinuxProcessIdentity(normalizedExpected.pid, readers);
    return isSameLinuxProcessIdentity(normalizedExpected, observed) ? "same" : "pid_reused";
  } catch (error) {
    return error instanceof ProcessEvidenceError && error.kind === "process_gone" ? "gone" : "unverifiable";
  }
}

/**
 * Inspect process-group residue without accepting PID existence as identity.
 * Only a fully enumerable process list with no matching boot/ns/pgrp/session
 * residue is empty; malformed rows and unreadable procfs fail closed.
 */
export function inspectLinuxProcessGroup(
  expected: unknown,
  processIds: readonly number[],
  readers: LinuxProcessEvidenceReaders = nativeLinuxProcessEvidenceReaders
): LinuxProcessGroupState {
  const normalizedExpected = normalizeIdentity(expected);
  if (normalizedExpected === null || !Array.isArray(processIds)) return "unverifiable";

  let unverifiable = false;
  for (const pid of processIds) {
    if (!isPositiveSafeInteger(pid) || pid > MAX_PID) {
      unverifiable = true;
      continue;
    }

    let observed: LinuxProcessIdentity;
    try {
      observed = captureLinuxProcessIdentity(pid, readers);
    } catch (error) {
      if (error instanceof ProcessEvidenceError && error.kind === "process_gone") continue;
      unverifiable = true;
      continue;
    }

    if (
      observed.bootId === normalizedExpected.bootId &&
      observed.pidNamespaceInode === normalizedExpected.pidNamespaceInode &&
      observed.pgrp === normalizedExpected.pgrp &&
      observed.session === normalizedExpected.session
    ) {
      return "present";
    }
  }

  return unverifiable ? "unverifiable" : "empty";
}

/**
 * Parse the evidence-bearing fields in /proc/<pid>/stat.
 *
 * The comm field is not escaped by procfs, so its final parenthesis is the
 * only safe delimiter: comm itself may contain both spaces and parentheses.
 */
export function parseLinuxProcessStat(value: unknown): LinuxProcessStatEvidence {
  const stat = requireSingleLine(value, "stat");
  const openingParenthesis = stat.indexOf(" (");
  const closingParenthesis = stat.lastIndexOf(")");
  if (openingParenthesis <= 0 || closingParenthesis < openingParenthesis + 2) {
    throw new ProcessEvidenceError("stat record has an invalid comm delimiter");
  }

  const pid = parsePositiveDecimal(stat.slice(0, openingParenthesis), "stat PID", MAX_PID);
  const trailingFields = stat.slice(closingParenthesis + 1);
  if (!trailingFields.startsWith(" ")) throw new ProcessEvidenceError("stat record has no process state");

  const fields = trailingFields.trim().split(/\s+/);
  if (fields.length < 20 || !PROCESS_STATES.has(fields[0])) {
    throw new ProcessEvidenceError("stat record is incomplete or has an invalid process state");
  }
  if (fields.slice(1).some((field) => !SIGNED_DECIMAL_PATTERN.test(field))) {
    throw new ProcessEvidenceError("stat record has malformed numeric fields");
  }

  return Object.freeze({
    pid,
    ppid: parsePositiveDecimal(fields[1], "parent PID", MAX_PID),
    pgrp: parsePositiveDecimal(fields[2], "process group", MAX_PID),
    session: parsePositiveDecimal(fields[3], "session", MAX_PID),
    startTimeTicks: parseStartTimeTicks(fields[19])
  });
}

/**
 * Return false rather than throwing when persisted evidence is incomplete,
 * malformed, or differs in any identity field.
 */
export function isSameLinuxProcessIdentity(expected: unknown, observed: unknown): boolean {
  const left = normalizeIdentity(expected);
  const right = normalizeIdentity(observed);
  if (left === null || right === null) return false;

  return (
    left.bootId === right.bootId &&
    left.pid === right.pid &&
    left.startTimeTicks === right.startTimeTicks &&
    left.pidNamespaceInode === right.pidNamespaceInode &&
    left.ppid === right.ppid &&
    left.pgrp === right.pgrp &&
    left.session === right.session
  );
}

function normalizeLinuxPreDispatchProofPayload(value: unknown): LinuxPreDispatchProofPayload | null {
  const record = exactRecord(value, ["binding", "subject", "observedAt", "owner", "root", "residue"]);
  if (
    record === null ||
    record.owner !== "gone" ||
    record.root !== "gone" ||
    record.residue !== "empty" ||
    !isTimestamp(record.observedAt)
  ) {
    return null;
  }

  const binding = validateLinuxPreDispatchProofBinding(record.binding);
  const subject = normalizeLinuxPreDispatchProofSubject(record.subject);
  return binding === null || subject === null
    ? null
    : Object.freeze({
        binding,
        subject,
        observedAt: record.observedAt,
        owner: "gone",
        root: "gone",
        residue: "empty"
      });
}

function normalizeLinuxPreDispatchTerminationProof(value: unknown): LinuxPreDispatchTerminationProof | null {
  const record = exactRecord(value, ["binding", "subject", "observedAt", "owner", "root", "residue", "proofHmac"]);
  if (record === null || !isHmac(record.proofHmac)) return null;

  const payload = normalizeLinuxPreDispatchProofPayload({
    binding: record.binding,
    subject: record.subject,
    observedAt: record.observedAt,
    owner: record.owner,
    root: record.root,
    residue: record.residue
  });
  return payload === null ? null : Object.freeze({ ...payload, proofHmac: record.proofHmac });
}

function normalizeLinuxPreDispatchProofSubject(value: unknown): LinuxPreDispatchProofSubject | null {
  const record = exactRecord(value, ["ownerInstanceId", "connectorCreatedAt", "connector", "child", "promptChannel"]);
  if (
    record === null ||
    !isIdentifier(record.ownerInstanceId) ||
    !isCanonicalTimestamp(record.connectorCreatedAt) ||
    (record.promptChannel !== "stdin" && record.promptChannel !== "pty")
  ) {
    return null;
  }

  const connector = normalizeIdentity(record.connector);
  const child = normalizeIdentity(record.child);
  return connector === null || child === null
    ? null
    : Object.freeze({
        ownerInstanceId: record.ownerInstanceId,
        connectorCreatedAt: record.connectorCreatedAt,
        connector: Object.freeze(connector),
        child: Object.freeze(child),
        promptChannel: record.promptChannel
      });
}

function proofPayload(proof: LinuxPreDispatchTerminationProof): LinuxPreDispatchProofPayload {
  return Object.freeze({
    binding: proof.binding,
    subject: proof.subject,
    observedAt: proof.observedAt,
    owner: proof.owner,
    root: proof.root,
    residue: proof.residue
  });
}

function preDispatchProofHmac(key: Buffer, payload: LinuxPreDispatchProofPayload): string {
  return createHmac("sha256", key).update(canonicalPreDispatchProofPayload(payload), "utf8").digest("hex");
}

function canonicalPreDispatchProofPayload(payload: LinuxPreDispatchProofPayload): string {
  const binding = payload.binding;
  const subject = payload.subject;
  return JSON.stringify([
    PRE_DISPATCH_PROOF_DOMAIN,
    [
      binding.requestId,
      binding.leaseId,
      binding.leaseGeneration,
      binding.recoveryGeneration,
      binding.claimantInstanceId
    ],
    [
      subject.ownerInstanceId,
      subject.connectorCreatedAt,
      subject.promptChannel,
      processIdentityValues(subject.connector),
      processIdentityValues(subject.child)
    ],
    payload.observedAt,
    payload.owner,
    payload.root,
    payload.residue
  ]);
}

function processIdentityValues(identity: LinuxProcessIdentity): readonly [string, number, string, number, number, number, number] {
  return [
    identity.bootId,
    identity.pid,
    identity.startTimeTicks,
    identity.pidNamespaceInode,
    identity.ppid,
    identity.pgrp,
    identity.session
  ];
}

function isProofSigner(value: unknown): value is LinuxPreDispatchProofSigner {
  return hasMethod(value, "signPreDispatchProof");
}

function isProofVerifier(value: unknown): value is LinuxPreDispatchProofVerifier {
  return hasMethod(value, "verifyPreDispatchProof");
}

function hasMethod(value: unknown, name: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  try {
    return typeof (value as Record<string, unknown>)[name] === "function";
  } catch {
    return false;
  }
}

function exactRecord(value: unknown, expectedKeys: readonly string[]): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== expectedKeys.length || Object.getOwnPropertySymbols(value).length !== 0) return null;

    const record: Record<string, unknown> = Object.create(null);
    for (const key of expectedKeys) {
      if (!names.includes(key)) return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) return null;
      record[key] = descriptor.value;
    }
    return record;
  } catch {
    return null;
  }
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_UTC_TIMESTAMP_PATTERN.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isHmac(value: unknown): value is string {
  return typeof value === "string" && HMAC_PATTERN.test(value);
}

function sameHmac(expected: string, candidate: string): boolean {
  if (!isHmac(expected) || !isHmac(candidate)) return false;
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(candidate, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeIdentity(value: unknown): LinuxProcessIdentity | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const identity = value as Record<string, unknown>;
  try {
    return {
      bootId: parseBootId(identity.bootId),
      pid: requirePositiveNumber(identity.pid, "pid", MAX_PID),
      startTimeTicks: parseStartTimeTicks(identity.startTimeTicks),
      pidNamespaceInode: requirePositiveNumber(identity.pidNamespaceInode, "PID namespace inode", MAX_PID_NAMESPACE_INODE),
      ppid: requirePositiveNumber(identity.ppid, "parent PID", MAX_PID),
      pgrp: requirePositiveNumber(identity.pgrp, "process group", MAX_PID),
      session: requirePositiveNumber(identity.session, "session", MAX_PID)
    };
  } catch {
    return null;
  }
}

function requireReaders(readers: unknown): asserts readers is LinuxProcessEvidenceReaders {
  if (
    typeof readers !== "object" ||
    readers === null ||
    typeof (readers as LinuxProcessEvidenceReaders).readFile !== "function" ||
    typeof (readers as LinuxProcessEvidenceReaders).readLink !== "function"
  ) {
    throw new ProcessEvidenceError("filesystem readers are invalid");
  }
}

function readEvidence(read: () => string, subject: "system" | "process" = "system"): string {
  try {
    const value = read();
    if (typeof value !== "string") throw new Error("reader did not return text");
    return value;
  } catch (error) {
    if (subject === "process" && isMissingProcessEvidence(error)) {
      throw new ProcessEvidenceError("process evidence is absent", "process_gone");
    }
    throw new ProcessEvidenceError("required process evidence is unavailable");
  }
}

function isMissingProcessEvidence(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  try {
    return (error as { code?: unknown }).code === "ENOENT";
  } catch {
    return false;
  }
}

function parseBootId(value: unknown): string {
  const bootId = requireSingleLine(value, "boot ID");
  if (!BOOT_ID_PATTERN.test(bootId) || /^0{8}-0{4}-0{4}-0{4}-0{12}$/i.test(bootId)) {
    throw new ProcessEvidenceError("boot ID is malformed");
  }
  return bootId.toLowerCase();
}

function parsePidNamespaceInode(value: unknown): number {
  const target = requireSingleLine(value, "PID namespace");
  const match = /^pid:\[([1-9][0-9]*)\]$/.exec(target);
  if (match === null) throw new ProcessEvidenceError("PID namespace is malformed");
  return parsePositiveDecimal(match[1], "PID namespace inode", MAX_PID_NAMESPACE_INODE);
}

function parseStartTimeTicks(value: unknown): string {
  if (typeof value !== "string" || !POSITIVE_DECIMAL_PATTERN.test(value)) {
    throw new ProcessEvidenceError("start time is malformed");
  }
  const ticks = BigInt(value);
  if (ticks > MAX_START_TIME_TICKS) throw new ProcessEvidenceError("start time is out of range");
  return value;
}

function parsePositiveDecimal(value: string, name: string, maximum: number): number {
  if (!POSITIVE_DECIMAL_PATTERN.test(value)) throw new ProcessEvidenceError(`${name} is malformed`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new ProcessEvidenceError(`${name} is out of range`);
  }
  return parsed;
}

function requirePositiveNumber(value: unknown, name: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ProcessEvidenceError(`${name} must be a positive integer in range`);
  }
  return value;
}

function requireSingleLine(value: unknown, name: string): string {
  if (typeof value !== "string") throw new ProcessEvidenceError(`${name} is unavailable`);
  const withoutNewline = value.endsWith("\n") ? value.slice(0, -1) : value;
  const line = withoutNewline.endsWith("\r") ? withoutNewline.slice(0, -1) : withoutNewline;
  if (line.length === 0 || line.includes("\n") || line.includes("\r")) {
    throw new ProcessEvidenceError(`${name} is malformed`);
  }
  return line;
}
