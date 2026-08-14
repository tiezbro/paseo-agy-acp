import { randomUUID } from "node:crypto";
import {
  captureLinuxProcessIdentity,
  isSameLinuxProcessIdentity,
  observeLinuxProcessIdentity,
  type LinuxProcessEvidenceReaders,
  type LinuxProcessIdentity,
  type LinuxProcessIdentityState
} from "../../Admission Controller/process-evidence.js";

const OWNER_INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO_UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** A connector-local owner token paired with immutable Linux process evidence. */
export interface LinuxConnectorOwnerIdentity extends LinuxProcessIdentity {
  readonly ownerInstanceId: string;
  readonly createdAt: string;
}

/** Conservative result of checking a persisted connector owner record. */
export type LinuxConnectorOwnerIdentityState = LinuxProcessIdentityState;

/** Injectable nondeterministic dependencies keep tests away from runtime state and real processes. */
export interface OwnerInstanceDependencies {
  readonly createOwnerInstanceId?: () => string;
  readonly now?: () => Date;
}

export class ConnectorOwnerIdentityError extends Error {
  constructor(message: string) {
    super(`connector owner identity error: ${message}`);
    this.name = "ConnectorOwnerIdentityError";
  }
}

/**
 * Capture the current connector owner record without persisting it. Callers
 * must supply process-evidence readers explicitly so the boundary is visible.
 */
export function captureLinuxConnectorOwnerIdentity(
  pid: number,
  readers: LinuxProcessEvidenceReaders,
  dependencies: OwnerInstanceDependencies = {}
): LinuxConnectorOwnerIdentity {
  const ownerInstanceId = createOwnerInstanceId(dependencies.createOwnerInstanceId ?? randomUUID);
  const createdAt = captureTimestamp(dependencies.now ?? (() => new Date()));
  const processIdentity = captureLinuxProcessIdentity(pid, readers);

  return Object.freeze({
    ownerInstanceId,
    createdAt,
    ...processIdentity
  });
}

/**
 * Re-observe the persisted record's PID and return false for every malformed,
 * unavailable, or mismatched condition. It never reads or writes runtime files.
 */
export function verifyPersistedLinuxConnectorOwnerIdentity(
  persisted: unknown,
  readers: LinuxProcessEvidenceReaders
): boolean {
  return observePersistedLinuxConnectorOwnerIdentity(persisted, readers) === "same";
}

/**
 * Re-observe a persisted connector owner without treating PID existence as
 * ownership. Malformed owner records and unreadable procfs both fail closed.
 */
export function observePersistedLinuxConnectorOwnerIdentity(
  persisted: unknown,
  readers: LinuxProcessEvidenceReaders
): LinuxConnectorOwnerIdentityState {
  const expected = normalizePersistedOwnerIdentity(persisted);
  return expected === null ? "unverifiable" : observeLinuxProcessIdentity(expected, readers);
}

function createOwnerInstanceId(factory: () => string): string {
  let ownerInstanceId: unknown;
  try {
    ownerInstanceId = factory();
  } catch {
    throw new ConnectorOwnerIdentityError("owner instance ID generation failed");
  }
  return requireOwnerInstanceId(ownerInstanceId);
}

function captureTimestamp(now: () => Date): string {
  let value: unknown;
  try {
    const date = now();
    value = date instanceof Date ? date.toISOString() : undefined;
  } catch {
    throw new ConnectorOwnerIdentityError("creation timestamp is unavailable");
  }
  return requireTimestamp(value, "creation timestamp");
}

function normalizePersistedOwnerIdentity(value: unknown): LinuxConnectorOwnerIdentity | null {
  if (!isRecord(value)) return null;

  try {
    const processIdentity = {
      bootId: value.bootId,
      pid: value.pid,
      startTimeTicks: value.startTimeTicks,
      pidNamespaceInode: value.pidNamespaceInode,
      ppid: value.ppid,
      pgrp: value.pgrp,
      session: value.session
    } as LinuxProcessIdentity;
    if (!isSameLinuxProcessIdentity(processIdentity, processIdentity)) return null;

    return Object.freeze({
      ownerInstanceId: requireOwnerInstanceId(value.ownerInstanceId),
      createdAt: requireTimestamp(value.createdAt, "persisted timestamp"),
      ...processIdentity
    });
  } catch {
    return null;
  }
}

function requireOwnerInstanceId(value: unknown): string {
  if (typeof value !== "string" || !OWNER_INSTANCE_ID_PATTERN.test(value)) {
    throw new ConnectorOwnerIdentityError("owner instance ID must be a canonical UUID v4");
  }
  return value;
}

function requireTimestamp(value: unknown, name: string): string {
  if (typeof value !== "string" || !ISO_UTC_TIMESTAMP_PATTERN.test(value)) {
    throw new ConnectorOwnerIdentityError(`${name} must be a canonical UTC timestamp`);
  }

  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new ConnectorOwnerIdentityError(`${name} must be a valid UTC timestamp`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
