import { describe, expect, it } from "vitest";
import {
  AgyPromptFreeDispatchBoundary,
  type AgyDispatchBoundaryDependencies,
  type AgyDispatchFence,
  type AgyDispatchProcess
} from "../ACP Connector/agy/dispatch-boundary.js";

interface FakeProcess {
  readonly pid: number;
}

interface ProcessIdentity {
  readonly pid: number;
  readonly startToken: string;
}

const FENCE: AgyDispatchFence = {
  requestId: "request-1",
  leaseId: "lease-1",
  generation: 7,
  ownerInstanceId: "connector-1"
};

function fakeProcess(
  writeInitialPrompt: AgyDispatchProcess<FakeProcess, ProcessIdentity>["writeInitialPrompt"],
  promptChannel: "stdin" | "pty" = "stdin"
): AgyDispatchProcess<FakeProcess, ProcessIdentity> {
  return {
    process: { pid: 42 },
    identity: { pid: 42, startToken: "boot-1:100" },
    promptChannel,
    writeInitialPrompt
  };
}

function dependencies(
  overrides: Partial<AgyDispatchBoundaryDependencies<FakeProcess, ProcessIdentity>> = {}
): AgyDispatchBoundaryDependencies<FakeProcess, ProcessIdentity> {
  return {
    spawnPromptFree: () => fakeProcess(() => ({ status: "accepted" })),
    persistProcessIdentity: () => ({ status: "recorded" }),
    recheckCancellation: () => ({ generationMatches: true, ownerMatches: true, cancelled: false }),
    commitDispatchIntent: () => ({ status: "committed" }),
    ...overrides
  };
}

describe("AgyPromptFreeDispatchBoundary", () => {
  it("starts prompt-free, persists identity, fences cancellation, commits intent, then writes synchronously once", () => {
    const prompt = "business prompt must not reach spawn metadata";
    const calls: string[] = [];
    let spawnArgs: unknown[] = [];
    let persisted: unknown;
    let rechecked: unknown;
    let committed: unknown;
    let written: string | undefined;
    let commitMicrotaskRan = false;

    const boundary = new AgyPromptFreeDispatchBoundary(
      prompt,
      FENCE,
      dependencies({
        spawnPromptFree: (...args) => {
          calls.push("spawn");
          spawnArgs = args;
          return fakeProcess((value) => {
            calls.push("write");
            written = value;
            expect(commitMicrotaskRan).toBe(false);
            return { status: "accepted" };
          });
        },
        persistProcessIdentity: (record) => {
          calls.push("persist");
          persisted = record;
          return { status: "recorded" };
        },
        recheckCancellation: (record) => {
          calls.push("recheck");
          rechecked = record;
          return { generationMatches: true, ownerMatches: true, cancelled: false };
        },
        commitDispatchIntent: (record) => {
          calls.push("commit");
          committed = record;
          queueMicrotask(() => { commitMicrotaskRan = true; });
          return { status: "committed" };
        }
      })
    );

    expect(boundary.run()).toMatchObject({ state: "active", promptChannel: "stdin", writeAttempts: 1 });
    expect(calls).toEqual(["spawn", "persist", "recheck", "commit", "write"]);
    expect(spawnArgs).toEqual([]);
    expect(written).toBe(prompt);
    expect(persisted).toEqual({ ...FENCE, processIdentity: { pid: 42, startToken: "boot-1:100" }, promptChannel: "stdin" });
    expect(rechecked).toEqual(persisted);
    expect(committed).toEqual(persisted);
    expect(JSON.stringify([persisted, rechecked, committed])).not.toContain(prompt);
  });

  it("keeps a post-record stale or cancelled fence dispatch_ambiguous without writing", () => {
    for (const recheckCancellation of [
      () => ({ generationMatches: false, ownerMatches: true, cancelled: false }),
      () => ({ generationMatches: true, ownerMatches: false, cancelled: false }),
      () => ({ generationMatches: true, ownerMatches: true, cancelled: true })
    ]) {
      let writes = 0;
      const boundary = new AgyPromptFreeDispatchBoundary(
        "do not write",
        FENCE,
        dependencies({
          spawnPromptFree: () => fakeProcess(() => {
            writes += 1;
            return { status: "accepted" };
          }),
          recheckCancellation
        })
      );

      expect(boundary.run()).toMatchObject({ state: "dispatch_ambiguous", writeAttempts: 0 });
      expect(writes).toBe(0);
    }
  });

  it("retains the spawned process in a failed identity result so the caller can terminate it", () => {
    const candidate = {
      ...fakeProcess(() => ({ status: "accepted" })),
      identity: undefined
    } as unknown as AgyDispatchProcess<FakeProcess, ProcessIdentity>;
    const boundary = new AgyPromptFreeDispatchBoundary(
      "do not write without identity",
      FENCE,
      dependencies({ spawnPromptFree: () => candidate })
    );

    expect(boundary.run()).toMatchObject({
      state: "blocked",
      reason: "process_identity_unrecorded",
      process: candidate.process,
      writeAttempts: 0
    });
  });

  it("keeps a post-record dispatch-intent replay fault dispatch_ambiguous without writing", () => {
    for (const commitDispatchIntent of [
      () => ({ status: "not_committed" as const }),
      () => { throw new Error("fsync failed"); }
    ]) {
      let writes = 0;
      const boundary = new AgyPromptFreeDispatchBoundary(
        "do not write before durable intent",
        FENCE,
        dependencies({
          spawnPromptFree: () => fakeProcess(() => {
            writes += 1;
            return { status: "accepted" };
          }),
          commitDispatchIntent
        })
      );

      expect(boundary.run()).toMatchObject({ state: "dispatch_ambiguous", writeAttempts: 0 });
      expect(writes).toBe(0);
    }
  });

  it("treats partial, thrown, and unprovable writes as dispatch_ambiguous without retrying", () => {
    for (const writeInitialPrompt of [
      () => ({ status: "ambiguous" as const }),
      () => undefined,
      () => { throw new Error("stream closed after a partial write"); }
    ]) {
      let writes = 0;
      const boundary = new AgyPromptFreeDispatchBoundary(
        "write once only",
        FENCE,
        dependencies({
          spawnPromptFree: () => fakeProcess(() => {
            writes += 1;
            return writeInitialPrompt();
          })
        })
      );

      expect(boundary.run()).toMatchObject({ state: "dispatch_ambiguous", writeAttempts: 1 });
      expect(boundary.run()).toMatchObject({ state: "dispatch_ambiguous", writeAttempts: 1 });
      expect(writes).toBe(1);
    }
  });

  it("refuses a fresh PTY dispatch without a version-specific fake canary", () => {
    let writes = 0;
    const boundary = new AgyPromptFreeDispatchBoundary(
      "do not write to an uncertified PTY",
      FENCE,
      dependencies({
        spawnPromptFree: () => fakeProcess(() => {
          writes += 1;
          return { status: "accepted" };
        }, "pty")
      })
    );

    expect(boundary.run()).toMatchObject({ state: "blocked", reason: "fresh_pty_uncertified", writeAttempts: 0 });
    expect(writes).toBe(0);
  });

  it("permits a fresh PTY dispatch only after its injected fake-version canary succeeds", () => {
    const calls: string[] = [];
    const boundary = new AgyPromptFreeDispatchBoundary(
      "pty prompt",
      FENCE,
      dependencies({
        spawnPromptFree: () => fakeProcess((prompt) => {
          calls.push(`write:${prompt}`);
          return { status: "accepted" };
        }, "pty"),
        verifyFreshPtyCanary: (record) => {
          calls.push(`canary:${record.processIdentity.startToken}`);
          return { status: "verified" };
        },
        persistProcessIdentity: () => {
          calls.push("persist");
          return { status: "recorded" };
        },
        recheckCancellation: () => {
          calls.push("recheck");
          return { generationMatches: true, ownerMatches: true, cancelled: false };
        },
        commitDispatchIntent: () => {
          calls.push("commit");
          return { status: "committed" };
        }
      })
    );

    expect(boundary.run()).toMatchObject({ state: "active", promptChannel: "pty", writeAttempts: 1 });
    expect(calls).toEqual(["canary:boot-1:100", "persist", "recheck", "commit", "write:pty prompt"]);
  });
});
