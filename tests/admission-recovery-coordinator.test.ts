import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdmissionController,
  type AdmissionLease,
  type AdmissionPolicy
} from "../Admission Controller/controller.js";
import {
  AdmissionRecoveryCoordinator,
  type AdmissionRecoveryController,
  type AdmissionRecoveryRequired,
  type RecoveryLifecycleObserver
} from "../ACP Connector/admission/recovery-coordinator.js";
import {
  createLinuxPreDispatchProofAuthority,
  issueLinuxPreDispatchTerminationProof,
  type LinuxPreDispatchProofAuthority,
  type LinuxPreDispatchProofBinding,
  type LinuxPreDispatchProofSubject
} from "../Admission Controller/process-evidence.js";
import type {
  LinuxPreDispatchRecoveryRequest,
  LinuxPreDispatchRecoveryResult,
  LinuxProcessLifecycleRecord
} from "../ACP Connector/admission/process-lifecycle.js";

const stateDirs: string[] = [];
const DEFAULT_POLICY: AdmissionPolicy = {
  maxActiveTurns: 1,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 0,
  queueTimeoutMs: 30 * 60_000,
  capacityCooldownMs: 30_000
};
const OWNER_INSTANCE_ID = "4d6f4908-8b36-4d63-bcc0-3d690fcfb9ce";
const PROOF_AUTHORITY = createLinuxPreDispatchProofAuthority(Buffer.alloc(32, 23));

interface LifecycleRig {
  readonly observer: RecoveryLifecycleObserver;
  readonly heartbeatCalls: unknown[];
  readonly preDispatchCalls: unknown[];
}

function controller(): AdmissionController {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-recovery-coordinator-"));
  stateDirs.push(stateDir);
  return new AdmissionController({
    databasePath: path.join(stateDir, "runtime.sqlite"),
    policy: DEFAULT_POLICY,
    encryptionKey: Buffer.alloc(32, 7),
    contentFingerprintKey: Buffer.alloc(32, 8),
    claimTokenKey: Buffer.alloc(32, 9)
  });
}

function startingLease(admission: AdmissionController, requestId = "request-42"): AdmissionLease {
  admission.enqueueWithPayload(
    {
      requestId,
      sessionId: "session-42",
      parentId: "parent-42",
      fingerprint: `fingerprint-${requestId}`,
      provider: "antigravity",
      model: "claude-opus-4-6-thinking",
      now: 1_000
    },
    "prompt is encrypted before recovery",
    61_000
  );
  const lease = admission.admitNext(1_001, "dispatch-owner")!;
  admission.markStarting(lease, 1_002);
  return lease;
}

function recordFor(lease: AdmissionLease): LinuxProcessLifecycleRecord {
  return Object.freeze({
    requestId: lease.requestId,
    leaseId: lease.leaseId,
    generation: lease.generation,
    ownerInstanceId: OWNER_INSTANCE_ID,
    processIdentity: Object.freeze({
      connector: Object.freeze({
        ownerInstanceId: OWNER_INSTANCE_ID,
        createdAt: "2026-08-09T12:34:56.789Z",
        bootId: "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f31",
        pid: 4182,
        startTimeTicks: "1234567890123",
        pidNamespaceInode: 4_026_531_836,
        ppid: 1,
        pgrp: 4182,
        session: 4182
      }),
      child: Object.freeze({
        bootId: "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f31",
        pid: 4183,
        startTimeTicks: "1234567890124",
        pidNamespaceInode: 4_026_531_836,
        ppid: 4182,
        pgrp: 4183,
        session: 4183
      })
    }),
    promptChannel: "stdin"
  });
}

function subjectFor(record: LinuxProcessLifecycleRecord): LinuxPreDispatchProofSubject {
  return {
    ownerInstanceId: record.ownerInstanceId,
    connectorCreatedAt: record.processIdentity.connector.createdAt,
    connector: record.processIdentity.connector,
    child: record.processIdentity.child,
    promptChannel: record.promptChannel
  };
}

function proofFor(
  request: LinuxPreDispatchRecoveryRequest,
  binding: LinuxPreDispatchProofBinding = request.claim,
  authority: LinuxPreDispatchProofAuthority = PROOF_AUTHORITY
) {
  return issueLinuxPreDispatchTerminationProof(
    {
      binding,
      subject: subjectFor(request.record),
      observedAt: request.now,
      owner: "gone",
      root: "gone",
      residue: "empty"
    },
    authority
  );
}

function proven(request: LinuxPreDispatchRecoveryRequest): LinuxPreDispatchRecoveryResult {
  return Object.freeze({ outcome: "proof", proof: proofFor(request) });
}

function lifecycle(
  heartbeat: "current" | "suspect",
  preDispatch: (request: LinuxPreDispatchRecoveryRequest) => LinuxPreDispatchRecoveryResult
): LifecycleRig {
  const heartbeatCalls: unknown[] = [];
  const preDispatchCalls: unknown[] = [];
  return {
    observer: {
      observeHeartbeat(value) {
        heartbeatCalls.push(value);
        return Object.freeze({ state: heartbeat });
      },
      async recoverPreDispatch(value) {
        preDispatchCalls.push(value);
        return preDispatch(value as LinuxPreDispatchRecoveryRequest);
      }
    },
    heartbeatCalls,
    preDispatchCalls
  };
}

function coordinator(admission: AdmissionRecoveryController, observer: RecoveryLifecycleObserver): AdmissionRecoveryCoordinator {
  return new AdmissionRecoveryCoordinator({
    controller: admission,
    lifecycle: observer,
    claimantInstanceId: "recovery-a",
    preDispatchProofVerifier: PROOF_AUTHORITY
  });
}

function openClaim(
  subject: AdmissionRecoveryCoordinator,
  lease: AdmissionLease
): AdmissionRecoveryRequired & { readonly claim: NonNullable<AdmissionRecoveryRequired["claim"]> } {
  const result = subject.observeHeartbeat({
    leaseId: lease.leaseId,
    heartbeatAt: 1_000,
    now: 1_010,
    ownerSuspectAfterMs: 10
  });
  expect(result.outcome).toBe("recovery_required");
  if (result.outcome !== "recovery_required" || result.claim === undefined) {
    throw new Error("expected a durable recovery claim");
  }
  return Object.freeze({ ...result, claim: result.claim });
}

afterEach(() => {
  for (const stateDir of stateDirs.splice(0)) {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

describe("AdmissionRecoveryCoordinator", () => {
  it("turns an expired heartbeat into only a durable recovery claim", () => {
    const admission = controller();
    const lease = startingLease(admission);
    const subject = lifecycle("suspect", (request) => proven(request));
    const coordinatorUnderTest = coordinator(admission, subject.observer);

    const result = openClaim(coordinatorUnderTest, lease);

    expect(result).toMatchObject({
      outcome: "recovery_required",
      reason: "owner_suspect",
      claim: {
        requestId: lease.requestId,
        leaseId: lease.leaseId,
        leaseGeneration: lease.generation,
        recoveryGeneration: 1,
        claimantInstanceId: "recovery-a"
      }
    });
    expect(admission.getRequest(lease.requestId)?.state).toBe("recovery_required");
    expect(subject.heartbeatCalls).toEqual([
      { heartbeatAt: 1_000, now: 1_010, ownerSuspectAfterMs: 10 }
    ]);
    expect(subject.preDispatchCalls).toEqual([]);
  });

  it("does not create a recovery claim while the heartbeat remains current", () => {
    const admission = controller();
    const lease = startingLease(admission);
    const subject = lifecycle("current", (request) => proven(request));
    const coordinatorUnderTest = coordinator(admission, subject.observer);

    expect(
      coordinatorUnderTest.observeHeartbeat({
        leaseId: lease.leaseId,
        heartbeatAt: 1_009,
        now: 1_010,
        ownerSuspectAfterMs: 10
      })
    ).toEqual({ outcome: "current" });

    expect(admission.getRequest(lease.requestId)?.state).toBe("starting");
    expect(subject.preDispatchCalls).toEqual([]);
  });

  it("requeues only after a verified pre-dispatch observation and stores only HMAC attestations", async () => {
    const admission = controller();
    const lease = startingLease(admission);
    const record = recordFor(lease);
    const subject = lifecycle("suspect", (request) => proven(request));
    const coordinatorUnderTest = coordinator(admission, subject.observer);
    const opening = openClaim(coordinatorUnderTest, lease);

    const result = await coordinatorUnderTest.recoverPreDispatch({
      claim: opening.claim,
      record,
      now: 1_011
    });

    expect(result).toMatchObject({
      outcome: "requeued",
      plan: {
        accepted: true,
        action: "confirmed_not_dispatched_requeue",
        nextState: "queued",
        evidenceCode: "pre_dispatch_residue_empty",
        reasonCode: "owner_lost",
        actorHmac: expect.stringMatching(/^[0-9a-f]{64}$/),
        evidenceHmac: expect.stringMatching(/^[0-9a-f]{64}$/)
      }
    });
    expect(subject.preDispatchCalls).toEqual([
      { record, claim: opening.claim, now: 1_011, phase: "starting", dispatchIntent: "not_committed" }
    ]);
    expect(admission.getRequest(lease.requestId)?.state).toBe("queued");
  });

  it("keeps an alive owner, unverifiable evidence, and post-dispatch recovery required", async () => {
    const aliveAdmission = controller();
    const aliveLease = startingLease(aliveAdmission, "owner-alive");
    const aliveRecord = recordFor(aliveLease);
    const aliveLifecycle = lifecycle("suspect", () => ({ outcome: "not_proven", reason: "owner_alive" }));
    const aliveCoordinator = coordinator(aliveAdmission, aliveLifecycle.observer);
    const aliveClaim = openClaim(aliveCoordinator, aliveLease).claim;

    await expect(
      aliveCoordinator.recoverPreDispatch({ claim: aliveClaim, record: aliveRecord, now: 1_011 })
    ).resolves.toMatchObject({ outcome: "recovery_required", reason: "evidence_not_verified" });
    expect(aliveAdmission.getRequest(aliveLease.requestId)?.state).toBe("recovery_required");

    const unverifiableAdmission = controller();
    const unverifiableLease = startingLease(unverifiableAdmission, "unverifiable");
    const unverifiableRecord = recordFor(unverifiableLease);
    const unverifiableLifecycle = lifecycle("suspect", () => ({ outcome: "not_proven", reason: "owner_unverifiable" }));
    const unverifiableCoordinator = coordinator(unverifiableAdmission, unverifiableLifecycle.observer);
    const unverifiableClaim = openClaim(unverifiableCoordinator, unverifiableLease).claim;

    await expect(
      unverifiableCoordinator.recoverPreDispatch({ claim: unverifiableClaim, record: unverifiableRecord, now: 1_011 })
    ).resolves.toMatchObject({ outcome: "recovery_required", reason: "unverifiable_evidence" });
    expect(unverifiableAdmission.getRequest(unverifiableLease.requestId)?.state).toBe("recovery_required");

    const dispatchedAdmission = controller();
    const dispatchedLease = startingLease(dispatchedAdmission, "post-dispatch");
    dispatchedAdmission.markDispatchIntent(dispatchedLease, 1_003);
    const dispatchedRecord = recordFor(dispatchedLease);
    const dispatchedLifecycle = lifecycle("suspect", (request) => proven(request));
    const dispatchedCoordinator = coordinator(dispatchedAdmission, dispatchedLifecycle.observer);
    const dispatchedClaim = openClaim(dispatchedCoordinator, dispatchedLease).claim;

    await expect(
      dispatchedCoordinator.recoverPreDispatch({ claim: dispatchedClaim, record: dispatchedRecord, now: 1_011 })
    ).resolves.toMatchObject({ outcome: "recovery_required", reason: "resolution_rejected" });
    expect(dispatchedAdmission.getRequest(dispatchedLease.requestId)?.state).toBe("recovery_required");
  });

  it("does not resolve stale claimant or generation fences, and rejects note fields", async () => {
    const admission = controller();
    const lease = startingLease(admission);
    const record = recordFor(lease);
    const subject = lifecycle("suspect", (request) => proven(request));
    const coordinatorUnderTest = coordinator(admission, subject.observer);
    const claim = openClaim(coordinatorUnderTest, lease).claim;

    await expect(
      coordinatorUnderTest.recoverPreDispatch({
        claim: { ...claim, claimantInstanceId: "other-recovery-worker" },
        record,
        now: 1_011
      })
    ).resolves.toMatchObject({ outcome: "recovery_required", reason: "claim_mismatch" });
    await expect(
      coordinatorUnderTest.recoverPreDispatch({
        claim: { ...claim, recoveryGeneration: claim.recoveryGeneration + 1 },
        record,
        now: 1_011
      })
    ).resolves.toMatchObject({ outcome: "recovery_required", reason: "claim_mismatch" });
    await expect(
      coordinatorUnderTest.recoverPreDispatch({
        claim,
        record,
        now: 1_011,
        operatorNote: "the connector said this process is gone"
      })
    ).resolves.toMatchObject({ outcome: "recovery_required", reason: "invalid_request" });

    expect(subject.preDispatchCalls).toEqual([]);
    expect(admission.getRequest(lease.requestId)?.state).toBe("recovery_required");
  });

  it("rejects forged and stale signed proofs before a recovery resolution is applied", async () => {
    const admission = controller();
    const lease = startingLease(admission);
    const record = recordFor(lease);
    const resolveCalls: unknown[] = [];
    const guardedController: AdmissionRecoveryController = {
      recoverOwner: admission.recoverOwner.bind(admission),
      createRecoveryResolutionAttestations: admission.createRecoveryResolutionAttestations.bind(admission),
      resolveRecovery(input, now) {
        resolveCalls.push({ input, now });
        return admission.resolveRecovery(input, now);
      }
    };
    const forgedLifecycle = lifecycle("suspect", (request) => {
      const proof = proofFor(request);
      return Object.freeze({
        outcome: "proof" as const,
        proof: {
          ...proof,
          proofHmac: `${proof.proofHmac[0] === "0" ? "1" : "0"}${proof.proofHmac.slice(1)}`
        }
      });
    });
    const forgedCoordinator = coordinator(guardedController, forgedLifecycle.observer);
    const claim = openClaim(forgedCoordinator, lease).claim;

    await expect(
      forgedCoordinator.recoverPreDispatch({ claim, record, now: 1_011 })
    ).resolves.toMatchObject({ outcome: "recovery_required", reason: "forged_proof" });

    const staleLifecycle = lifecycle("suspect", (request) =>
      Object.freeze({
        outcome: "proof" as const,
        proof: proofFor(request, {
          ...request.claim,
          recoveryGeneration: request.claim.recoveryGeneration + 1
        })
      })
    );
    const staleCoordinator = coordinator(guardedController, staleLifecycle.observer);

    await expect(
      staleCoordinator.recoverPreDispatch({ claim, record, now: 1_011 })
    ).resolves.toMatchObject({ outcome: "recovery_required", reason: "stale_proof" });

    expect(resolveCalls).toEqual([]);
    expect(admission.getRequest(lease.requestId)?.state).toBe("recovery_required");
  });

  it("survives coordinator loss and applies a valid pre-dispatch resolution exactly once", async () => {
    const admission = controller();
    const lease = startingLease(admission);
    const record = recordFor(lease);
    const subject = lifecycle("suspect", (request) => proven(request));
    const resolveCalls: unknown[] = [];
    const guardedController: AdmissionRecoveryController = {
      recoverOwner: admission.recoverOwner.bind(admission),
      createRecoveryResolutionAttestations: admission.createRecoveryResolutionAttestations.bind(admission),
      resolveRecovery(input, now) {
        resolveCalls.push({ input, now });
        return admission.resolveRecovery(input, now);
      }
    };
    const failedCoordinator = coordinator(guardedController, subject.observer);
    const claim = openClaim(failedCoordinator, lease).claim;

    // Closing the first coordinator models a worker loss after the durable claim exists.
    failedCoordinator.close();
    const resumedCoordinator = coordinator(guardedController, subject.observer);
    const resolved = await resumedCoordinator.recoverPreDispatch({ claim, record, now: 1_011 });
    const replayCoordinator = coordinator(guardedController, subject.observer);
    const replayed = await replayCoordinator.recoverPreDispatch({ claim, record, now: 1_012 });

    expect(resolved).toMatchObject({ outcome: "requeued", claim });
    expect(replayed).toMatchObject({ outcome: "recovery_required", reason: "claim_mismatch" });
    expect(resolveCalls).toHaveLength(1);
    expect(admission.getRequest(lease.requestId)?.state).toBe("queued");
    expect(subject.preDispatchCalls).toHaveLength(1);
  });
});
