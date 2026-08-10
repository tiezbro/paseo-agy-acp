import { describe, expect, it } from "vitest";
import {
  planRecoveryResolution,
  validateRecoveryClaimToken,
  type RecoveryClaimToken,
  type RecoveryResolution,
  type RecoveryResolutionContext
} from "../src/admission/recovery-resolution.js";

const ACTOR_HMAC = "a".repeat(64);
const EVIDENCE_HMAC = "b".repeat(64);

const CLAIM: RecoveryClaimToken = Object.freeze({
  requestId: "request-42",
  leaseId: "lease-42",
  leaseGeneration: 7,
  recoveryGeneration: 3,
  claimantInstanceId: "recovery-operator-42"
});

function context(overrides: Partial<RecoveryResolutionContext> = {}): RecoveryResolutionContext {
  return {
    state: "recovery_required",
    claim: CLAIM,
    ...overrides
  };
}

function resolution(
  overrides: Partial<RecoveryResolution> = {}
): RecoveryResolution {
  return {
    claim: { ...CLAIM },
    action: "confirmed_not_dispatched_requeue",
    evidenceCode: "pre_dispatch_residue_empty",
    reasonCode: "owner_lost",
    actorHmac: ACTOR_HMAC,
    evidenceHmac: EVIDENCE_HMAC,
    ...overrides
  };
}

describe("recovery resolution planning", () => {
  it("normalizes a complete fenced recovery claim token without retaining caller ownership", () => {
    const original = { ...CLAIM };
    const token = validateRecoveryClaimToken(original);

    expect(token).toEqual(CLAIM);
    expect(token).not.toBe(original);
    expect(Object.isFrozen(token)).toBe(true);

    original.requestId = "changed-after-validation";
    expect(token?.requestId).toBe("request-42");
  });

  it("rejects malformed recovery fences before planning a transition", () => {
    for (const claim of [
      { ...CLAIM, requestId: "" },
      { ...CLAIM, leaseId: "   " },
      { ...CLAIM, claimantInstanceId: "" },
      { ...CLAIM, leaseGeneration: 0 },
      { ...CLAIM, recoveryGeneration: -1 },
      { ...CLAIM, recoveryGeneration: Number.MAX_SAFE_INTEGER + 1 },
      { ...CLAIM, requestId: "request\n42" }
    ]) {
      expect(validateRecoveryClaimToken(claim)).toBeNull();
      expect(planRecoveryResolution(context(), resolution({ claim } as RecoveryResolution))).toEqual({
        accepted: false,
        nextState: "recovery_required",
        rejectionCode: "invalid_resolution"
      });
    }
  });

  it("plans requeue only from proof that dispatch never occurred and residue is empty", () => {
    const plan = planRecoveryResolution(context(), resolution());

    expect(plan).toEqual({
      accepted: true,
      action: "confirmed_not_dispatched_requeue",
      nextState: "queued",
      claim: CLAIM,
      evidenceCode: "pre_dispatch_residue_empty",
      reasonCode: "owner_lost",
      actorHmac: ACTOR_HMAC,
      evidenceHmac: EVIDENCE_HMAC
    });
    expect(Object.isFrozen(plan)).toBe(true);

    for (const evidenceCode of ["provider_completed", "provider_cancelled", "unknown_release"]) {
      expect(
        planRecoveryResolution(context(), resolution({ evidenceCode } as RecoveryResolution))
      ).toEqual({
        accepted: false,
        nextState: "recovery_required",
        rejectionCode: "evidence_mismatch"
      });
    }
  });

  it("maps confirmed provider terminal evidence to the matching terminal state only", () => {
    expect(
      planRecoveryResolution(
        context(),
        resolution({ action: "confirmed_completed", evidenceCode: "provider_completed" })
      )
    ).toMatchObject({ accepted: true, action: "confirmed_completed", nextState: "completed" });

    expect(
      planRecoveryResolution(
        context(),
        resolution({ action: "confirmed_cancelled", evidenceCode: "provider_cancelled" })
      )
    ).toMatchObject({ accepted: true, action: "confirmed_cancelled", nextState: "cancelled" });

    expect(
      planRecoveryResolution(
        context(),
        resolution({ action: "confirmed_completed", evidenceCode: "provider_cancelled" })
      )
    ).toEqual({
      accepted: false,
      nextState: "recovery_required",
      rejectionCode: "evidence_mismatch"
    });
  });

  it("maps an acknowledged unknown release only to recovery_resolved", () => {
    const plan = planRecoveryResolution(
      context(),
      resolution({
        action: "acknowledge_unknown_release",
        evidenceCode: "unknown_release",
        reasonCode: "unknown_release"
      })
    );

    expect(plan).toMatchObject({
      accepted: true,
      action: "acknowledge_unknown_release",
      nextState: "recovery_resolved"
    });
    expect(plan).not.toMatchObject({ nextState: "completed" });
    expect(plan).not.toMatchObject({ nextState: "cancelled" });
  });

  it("fails closed when any field of the supplied claim differs from the expected fence", () => {
    for (const claim of [
      { ...CLAIM, requestId: "other-request" },
      { ...CLAIM, leaseId: "other-lease" },
      { ...CLAIM, leaseGeneration: CLAIM.leaseGeneration + 1 },
      { ...CLAIM, recoveryGeneration: CLAIM.recoveryGeneration + 1 },
      { ...CLAIM, claimantInstanceId: "other-operator" }
    ]) {
      expect(planRecoveryResolution(context(), resolution({ claim }))).toEqual({
        accepted: false,
        nextState: "recovery_required",
        rejectionCode: "claim_mismatch"
      });
    }
  });

  it("rejects non-recovery contexts, malformed attestations, unbounded reasons, and raw notes", () => {
    expect(planRecoveryResolution(context({ state: "active" as "recovery_required" }), resolution())).toEqual({
      accepted: false,
      nextState: "recovery_required",
      rejectionCode: "invalid_context"
    });

    for (const candidate of [
      resolution({ action: "requeue" as "confirmed_not_dispatched_requeue" }),
      resolution({ actorHmac: ACTOR_HMAC.toUpperCase() }),
      resolution({ evidenceHmac: "c".repeat(63) }),
      resolution({ reasonCode: "operator wrote a free-form explanation" as "owner_lost" }),
      { ...resolution(), notes: "do not persist this" },
      { ...resolution(), rawTranscript: "provider transcript" }
    ]) {
      expect(planRecoveryResolution(context(), candidate)).toEqual({
        accepted: false,
        nextState: "recovery_required",
        rejectionCode: "invalid_resolution"
      });
    }
  });

  it("fails closed when reflective validation encounters hostile object shapes", () => {
    const proxy = new Proxy(resolution(), {
      ownKeys() {
        throw new Error("unavailable");
      }
    });

    expect(planRecoveryResolution(context(), proxy)).toEqual({
      accepted: false,
      nextState: "recovery_required",
      rejectionCode: "invalid_resolution"
    });

    const revoked = Proxy.revocable(resolution(), {});
    revoked.revoke();
    expect(planRecoveryResolution(context(), revoked.proxy)).toEqual({
      accepted: false,
      nextState: "recovery_required",
      rejectionCode: "invalid_resolution"
    });

    const accessor = { ...resolution() } as Record<string, unknown>;
    Object.defineProperty(accessor, "actorHmac", {
      enumerable: true,
      get() {
        throw new Error("must not execute untrusted accessors");
      }
    });

    expect(planRecoveryResolution(context(), accessor)).toEqual({
      accepted: false,
      nextState: "recovery_required",
      rejectionCode: "invalid_resolution"
    });
  });
});
