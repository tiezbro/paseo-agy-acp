import { readdirSync } from "node:fs";
import type { AdmissionController } from "../../Admission Controller/controller.js";
import {
  captureLinuxProcessIdentity,
  nativeLinuxProcessEvidenceReaders,
  observeLinuxProcessIdentity,
  type LinuxProcessEvidenceReaders,
  type LinuxProcessIdentity,
  type LinuxProcessIdentityState
} from "../../Admission Controller/process-evidence.js";
import { observePersistedLinuxConnectorOwnerIdentity } from "./owner-instance.js";

const MAX_PID = 2_147_483_647;

export interface AdmissionStartupRecoveryReaders extends LinuxProcessEvidenceReaders {
  listProcessIds(): readonly number[];
}

export interface AdmissionStartupRecoveryOptions {
  readonly readers?: AdmissionStartupRecoveryReaders;
  readonly now?: () => number;
}

export interface AdmissionStartupRecoverySummary {
  readonly inspected: number;
  readonly released: number;
  readonly retained: number;
  readonly markedRecoveryRequired: number;
}

export const nativeAdmissionStartupRecoveryReaders: AdmissionStartupRecoveryReaders = Object.freeze({
  ...nativeLinuxProcessEvidenceReaders,
  listProcessIds(): readonly number[] {
    return readdirSync("/proc", { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[1-9][0-9]*$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && pid <= MAX_PID);
  }
});

/**
 * Conservatively reconcile durable seats when an enabled connector starts.
 * This code can only inspect process evidence and settle an existing fence; it
 * cannot enqueue, start, write, replay, or deliver a business prompt.
 */
export function recoverExitedAdmissionSeats(
  controller: AdmissionController,
  options: AdmissionStartupRecoveryOptions = {}
): AdmissionStartupRecoverySummary {
  const readers = options.readers ?? nativeAdmissionStartupRecoveryReaders;
  const now = readNow(options.now ?? Date.now);
  let processIds: readonly number[] | null;
  try {
    processIds = normalizeProcessIds(readers.listProcessIds());
  } catch {
    processIds = null;
  }

  let released = 0;
  let retained = 0;
  let markedRecoveryRequired = 0;
  for (const queuedOwner of controller.listRecoverableQueuedOwners()) {
    const owner = observePersistedLinuxConnectorOwnerIdentity(queuedOwner.owner, readers);
    if (!isGoneIdentity(owner)) continue;
    try {
      controller.settleQueuedOwnerDeath(queuedOwner.requestId, queuedOwner.owner.ownerInstanceId, now);
    } catch {
      // A concurrent owner may have admitted, cancelled, or otherwise settled the request.
    }
  }

  const dispatches = controller.listRecoverableDispatches();
  for (const dispatch of dispatches) {
    const identity = dispatch.processIdentity;
    if (identity === null || processIds === null) {
      retained += 1;
      continue;
    }

    const connector = observePersistedLinuxConnectorOwnerIdentity(identity.connector, readers);
    if (connector === "same" || connector === "unverifiable") {
      retained += 1;
      continue;
    }

    const child = observeLinuxProcessIdentity(identity.child, readers);
    const residue = inspectProcessGroup(identity.child, processIds, readers);
    if (isGoneIdentity(child) && residue === "empty") {
      try {
        controller.releaseExitedRecoverySeat(dispatch.fence, now);
        released += 1;
        continue;
      } catch {
        retained += 1;
        continue;
      }
    }

    if (child !== "unverifiable" && residue !== "unverifiable") {
      try {
        controller.markExecutionRecoveryRequired(dispatch.fence, now);
        markedRecoveryRequired += 1;
      } catch {
        // A concurrent owner may have advanced or settled the exact fence.
      }
    }
    retained += 1;
  }

  return Object.freeze({
    inspected: dispatches.length,
    released,
    retained,
    markedRecoveryRequired
  });
}

function inspectProcessGroup(
  expected: LinuxProcessIdentity,
  processIds: readonly number[],
  readers: LinuxProcessEvidenceReaders
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

function normalizeProcessIds(value: unknown): readonly number[] | null {
  if (!Array.isArray(value)) return null;
  const ids = value.slice();
  if (ids.some((pid) => !Number.isSafeInteger(pid) || pid < 1 || pid > MAX_PID)) return null;
  return Object.freeze([...new Set(ids as number[])].sort((left, right) => left - right));
}

function isGoneIdentity(value: LinuxProcessIdentityState): boolean {
  return value === "gone" || value === "pid_reused";
}

function isGone(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" || (error as { code?: unknown }).code === "ESRCH");
}

function readNow(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("admission startup recovery clock is invalid");
  return value;
}
