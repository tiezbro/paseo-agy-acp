import { describe, expect, it } from "vitest";
import {
  LocalProcessCancellationConfigurationError,
  LocalProcessCancellationEscalator,
  type LocalCancellationPhase,
  type LocalProcessCancellationDependencies,
  type LocalProcessIdentityState,
  type LocalProcessResidueProof
} from "../ACP Connector/admission/cancellation.js";
import type { LinuxProcessIdentity } from "../Admission Controller/process-evidence.js";

const IDENTITY: LinuxProcessIdentity = Object.freeze({
  bootId: "f4bca3da-9bd5-4f2e-89b8-5e12e5ee8f31",
  pid: 4182,
  startTimeTicks: "1234567890123",
  pidNamespaceInode: 4_026_531_836,
  ppid: 3711,
  pgrp: 4182,
  session: 4182
});

interface Rig {
  readonly dependencies: LocalProcessCancellationDependencies;
  readonly events: string[];
}

function rig(
  identityStates: LocalProcessIdentityState[],
  residueProofs: LocalProcessResidueProof[],
  options: Partial<{
    signalError: LocalCancellationPhase;
    waitError: LocalCancellationPhase;
    residueError: boolean;
  }> = {}
): Rig {
  const events: string[] = [];
  let phase: LocalCancellationPhase | undefined;

  return {
    events,
    dependencies: {
      async reverifyIdentity(identity) {
        events.push(`verify:${identity.pid}`);
        return identityStates.shift() ?? "same";
      },
      async signal(nextPhase, identity) {
        phase = nextPhase;
        events.push(`signal:${nextPhase}:${identity.pid}`);
        if (options.signalError === nextPhase) throw new Error("signal unavailable");
      },
      async wait(timeoutMs) {
        events.push(`wait:${timeoutMs}`);
        if (options.waitError === phase) throw new Error("wait unavailable");
      },
      async queryResidue(identity) {
        events.push(`residue:${identity.pid}`);
        if (options.residueError) throw new Error("residue unavailable");
        const proof = residueProofs.shift();
        if (!proof) throw new Error("missing residue proof");
        return proof;
      }
    }
  };
}

function request(overrides: Partial<{ interruptMs: number; terminateMs: number; killMs: number }> = {}) {
  return {
    identity: IDENTITY,
    timeouts: {
      interruptMs: 17,
      terminateMs: 29,
      killMs: 43,
      ...overrides
    }
  };
}

describe("LocalProcessCancellationEscalator", () => {
  it("escalates interrupt, terminate, and kill with the exact injected timeouts", async () => {
    const subject = rig(
      ["same", "same", "same"],
      [
        { root: "same", residue: "empty" },
        { root: "same", residue: "present" },
        { root: "gone", residue: "empty" }
      ]
    );

    const result = await new LocalProcessCancellationEscalator(subject.dependencies).cancel(request());

    expect(result).toEqual({
      outcome: "locally_terminated",
      providerCancellation: "unconfirmed",
      businessTurn: "not_retried",
      attemptedPhases: ["interrupt", "terminate", "kill"],
      terminalPhase: "kill"
    });
    expect(subject.events).toEqual([
      "verify:4182",
      "signal:interrupt:4182",
      "wait:17",
      "residue:4182",
      "verify:4182",
      "signal:terminate:4182",
      "wait:29",
      "residue:4182",
      "verify:4182",
      "signal:kill:4182",
      "wait:43",
      "residue:4182"
    ]);
  });

  it("stops after the first phase only when the root is gone and residue is proven empty", async () => {
    const subject = rig(["same"], [{ root: "gone", residue: "empty" }]);

    const result = await new LocalProcessCancellationEscalator(subject.dependencies).cancel(request());

    expect(result).toEqual({
      outcome: "locally_terminated",
      providerCancellation: "unconfirmed",
      businessTurn: "not_retried",
      attemptedPhases: ["interrupt"],
      terminalPhase: "interrupt"
    });
    expect(subject.events).toEqual(["verify:4182", "signal:interrupt:4182", "wait:17", "residue:4182"]);
  });

  it("does not signal an already-gone root before residue is proven empty", async () => {
    const subject = rig(["gone"], [{ root: "gone", residue: "empty" }]);

    const result = await new LocalProcessCancellationEscalator(subject.dependencies).cancel(request());

    expect(result).toEqual({
      outcome: "locally_terminated",
      providerCancellation: "unconfirmed",
      businessTurn: "not_retried",
      attemptedPhases: [],
      terminalPhase: "already_gone"
    });
    expect(subject.events).toEqual(["verify:4182", "residue:4182"]);
  });

  it("fails closed without signaling when the PID has been reused", async () => {
    const subject = rig(["pid_reused"], []);

    const result = await new LocalProcessCancellationEscalator(subject.dependencies).cancel(request());

    expect(result).toEqual({
      outcome: "recovery_required",
      providerCancellation: "unconfirmed",
      businessTurn: "not_retried",
      attemptedPhases: [],
      reason: "pid_reused"
    });
    expect(subject.events).toEqual(["verify:4182"]);
  });

  it("fails closed without another signal when identity becomes unverifiable between phases", async () => {
    const subject = rig(["same", "unverifiable"], [{ root: "same", residue: "empty" }]);

    const result = await new LocalProcessCancellationEscalator(subject.dependencies).cancel(request());

    expect(result).toEqual({
      outcome: "recovery_required",
      providerCancellation: "unconfirmed",
      businessTurn: "not_retried",
      attemptedPhases: ["interrupt"],
      reason: "identity_unverifiable"
    });
    expect(subject.events).toEqual(["verify:4182", "signal:interrupt:4182", "wait:17", "residue:4182", "verify:4182"]);
  });

  it("requires both root absence and empty residue before declaring local termination", async () => {
    const subject = rig(["same"], [{ root: "gone", residue: "present" }]);

    const result = await new LocalProcessCancellationEscalator(subject.dependencies).cancel(request());

    expect(result).toEqual({
      outcome: "recovery_required",
      providerCancellation: "unconfirmed",
      businessTurn: "not_retried",
      attemptedPhases: ["interrupt"],
      reason: "residue_present"
    });
    expect(subject.events).toEqual(["verify:4182", "signal:interrupt:4182", "wait:17", "residue:4182"]);
  });

  it("fails closed when residue cannot be proven after a phase", async () => {
    const subject = rig(["same"], [], { residueError: true });

    const result = await new LocalProcessCancellationEscalator(subject.dependencies).cancel(request());

    expect(result).toEqual({
      outcome: "recovery_required",
      providerCancellation: "unconfirmed",
      businessTurn: "not_retried",
      attemptedPhases: ["interrupt"],
      reason: "residue_query_failed"
    });
    expect(subject.events).toEqual(["verify:4182", "signal:interrupt:4182", "wait:17", "residue:4182"]);
  });

  it("queries residue after a failed signal and never retries the phase or business turn", async () => {
    const subject = rig(["same"], [{ root: "same", residue: "empty" }], { signalError: "interrupt" });

    const result = await new LocalProcessCancellationEscalator(subject.dependencies).cancel(request());

    expect(result).toEqual({
      outcome: "recovery_required",
      providerCancellation: "unconfirmed",
      businessTurn: "not_retried",
      attemptedPhases: ["interrupt"],
      reason: "signal_failed"
    });
    expect(subject.events).toEqual(["verify:4182", "signal:interrupt:4182", "residue:4182"]);
  });

  it("queries residue after a failed wait and does not escalate further", async () => {
    const subject = rig(["same"], [{ root: "same", residue: "empty" }], { waitError: "interrupt" });

    const result = await new LocalProcessCancellationEscalator(subject.dependencies).cancel(request());

    expect(result).toEqual({
      outcome: "recovery_required",
      providerCancellation: "unconfirmed",
      businessTurn: "not_retried",
      attemptedPhases: ["interrupt"],
      reason: "wait_failed"
    });
    expect(subject.events).toEqual(["verify:4182", "signal:interrupt:4182", "wait:17", "residue:4182"]);
  });

  it("copies and freezes the expected identity before dependencies observe it", async () => {
    const original = { ...IDENTITY };
    let verifiedIdentity: LinuxProcessIdentity | undefined;
    let signalledIdentity: LinuxProcessIdentity | undefined;
    const dependencies: LocalProcessCancellationDependencies = {
      async reverifyIdentity(identity) {
        verifiedIdentity = identity;
        original.pid = 9999;
        return "same";
      },
      async signal(_phase, identity) {
        signalledIdentity = identity;
      },
      async wait() {},
      async queryResidue() {
        return { root: "gone", residue: "empty" };
      }
    };

    await new LocalProcessCancellationEscalator(dependencies).cancel({
      identity: original,
      timeouts: { interruptMs: 0, terminateMs: 0, killMs: 0 }
    });

    expect(verifiedIdentity).not.toBe(original);
    expect(verifiedIdentity?.pid).toBe(4182);
    expect(signalledIdentity?.pid).toBe(4182);
    expect(Object.isFrozen(verifiedIdentity)).toBe(true);
  });

  it("rejects timeout values that cannot be used as exact non-negative integers", () => {
    const subject = rig([], []);
    const escalator = new LocalProcessCancellationEscalator(subject.dependencies);

    expect(() => escalator.cancel(request({ interruptMs: 1.5 }))).toThrow(LocalProcessCancellationConfigurationError);
    expect(() => escalator.cancel(request({ terminateMs: -1 }))).toThrow(LocalProcessCancellationConfigurationError);
    expect(() => escalator.cancel(request({ killMs: Number.MAX_SAFE_INTEGER + 1 }))).toThrow(
      LocalProcessCancellationConfigurationError
    );
    expect(subject.events).toEqual([]);
  });

  it("does not let a non-enumerable timeout bypass exact-integer validation", () => {
    const subject = rig([], []);
    const timeouts = Object.create(null) as { interruptMs: number; terminateMs: number; killMs: number };
    Object.defineProperties(timeouts, {
      interruptMs: { value: 1.5, enumerable: false },
      terminateMs: { value: 0, enumerable: false },
      killMs: { value: 0, enumerable: false }
    });

    expect(() => new LocalProcessCancellationEscalator(subject.dependencies).cancel({ identity: IDENTITY, timeouts })).toThrow(
      LocalProcessCancellationConfigurationError
    );
    expect(subject.events).toEqual([]);
  });
});
