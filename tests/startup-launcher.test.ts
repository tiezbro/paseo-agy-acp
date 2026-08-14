import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { probeExactAgyBinaryVersion } from "../ACP Connector/agy/launch-spec.js";
import {
  AgyStartupLifetimeBindingError,
  launchAgyProcess,
  runRepositoryOwnedPromptFreePtyCanary,
  type AgyStartupLauncher
} from "../ACP Connector/agy/startup-launcher.js";

function probeFakeAgyVersion(startupLauncher?: AgyStartupLauncher) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-startup-launcher-"));
  const executable = path.join(dir, "fake-agy");
  try {
    fs.writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' 'agy version 2.0.0.0'\n", "utf8");
    fs.chmodSync(executable, 0o700);
    return probeExactAgyBinaryVersion({ executable, cwd: os.tmpdir(), startupLauncher });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("Agy startup launcher", () => {
  it("preserves the direct launch path when absent or disabled", () => {
    let starts = 0;
    const start = () => {
      starts += 1;
      return { marker: "legacy" };
    };
    const disabled: AgyStartupLauncher = {
      enabled: false,
      acquire: () => {
        throw new Error("disabled launcher must not acquire a permit");
      }
    };

    expect(launchAgyProcess(undefined, "model_turn", start)).toEqual({ marker: "legacy" });
    expect(launchAgyProcess(disabled, "auxiliary", start)).toEqual({ marker: "legacy" });
    expect(starts).toBe(2);
  });

  it("releases a model-turn start permit after spawn without owning execution capacity", () => {
    const events: string[] = [];
    const launcher: AgyStartupLauncher = {
      enabled: true,
      acquire: (classification) => {
        events.push(`acquire:${classification}`);
        return {
          release: () => events.push(`release:${classification}`)
        };
      }
    };

    const value = launchAgyProcess(launcher, "model_turn", () => {
      events.push("start");
      return 42;
    });

    expect(value).toBe(42);
    expect(events).toEqual(["acquire:model_turn", "start", "release:model_turn"]);
  });

  it("holds an exact synchronous version-probe permit through spawnSync return", () => {
    const events: string[] = [];
    expect(probeFakeAgyVersion(recordingLauncher(events)).version).toBe("2.0.0.0");
    expect(events).toEqual(["acquire:auxiliary", "release:auxiliary"]);
  });

  it("releases an exact synchronous version-probe permit on probe failure", () => {
    const events: string[] = [];
    expect(() => probeExactAgyBinaryVersion({
      executable: "/tmp/does-not-exist-agy-version-probe",
      cwd: os.tmpdir(),
      startupLauncher: recordingLauncher(events)
    })).toThrow("agy version probe failed");
    expect(events).toEqual(["acquire:auxiliary", "release:auxiliary"]);
  });

  it("holds a resident PTY permit until its terminal callback and releases exactly once", () => {
    const events: string[] = [];
    const exitListeners: Array<() => void> = [];
    const process = {
      onExit(listener: () => void) {
        exitListeners.push(listener);
        return { dispose() {} };
      }
    };
    const launcher = recordingLauncher(events);

    expect(launchAgyProcess(launcher, "resident_pty", () => process, "pty")).toBe(process);
    expect(events).toEqual(["acquire:resident_pty"]);

    exitListeners[0]();
    exitListeners[0]();
    expect(events).toEqual(["acquire:resident_pty", "release:resident_pty"]);
  });

  it("holds an auxiliary child-process permit until close", () => {
    const events: string[] = [];
    const process = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    process.exitCode = null;
    process.signalCode = null;

    expect(launchAgyProcess(recordingLauncher(events), "auxiliary", () => process, "child_process"))
      .toBe(process);
    process.emit("exit", 0, null);
    expect(events).toEqual(["acquire:auxiliary"]);
    process.exitCode = 0;
    process.emit("close", 0, null);
    process.emit("close", 0, null);
    expect(events).toEqual(["acquire:auxiliary", "release:auxiliary"]);
  });

  it("releases immediately when a returned child is already terminal", () => {
    const events: string[] = [];
    const process = Object.assign(new EventEmitter(), {
      exitCode: 0 as number | null,
      signalCode: null as NodeJS.Signals | null
    });

    launchAgyProcess(recordingLauncher(events), "auxiliary", () => process, "child_process");
    expect(events).toEqual(["acquire:auxiliary", "release:auxiliary"]);
  });

  it("releases an acquired permit when the process factory throws", () => {
    const events: string[] = [];
    const launcher: AgyStartupLauncher = {
      enabled: true,
      acquire: () => ({
        release: () => events.push("release")
      })
    };

    expect(() => launchAgyProcess(launcher, "auxiliary", () => {
      events.push("start");
      throw new Error("spawn failed");
    }, "child_process")).toThrow("spawn failed");
    expect(events).toEqual(["start", "release"]);
  });

  it("fails before spawn when a held classification has no lifetime contract", () => {
    const events: string[] = [];
    expect(() => launchAgyProcess(recordingLauncher(events), "auxiliary", () => {
      events.push("start");
      return {};
    })).toThrow("requires an explicit process lifetime");
    expect(events).toEqual([]);
  });

  it("fails closed and retains the permit for an unobservable spawned process", () => {
    const events: string[] = [];
    expect(() => launchAgyProcess(
      recordingLauncher(events),
      "auxiliary",
      () => ({ pid: 123 }),
      "child_process"
    )).toThrow(AgyStartupLifetimeBindingError);
    expect(events).toEqual(["acquire:auxiliary"]);
  });

  it("does not release for a PTY that fires synchronously but returns an invalid subscription", () => {
    const events: string[] = [];
    const process = {
      onExit(listener: () => void) {
        listener();
        return undefined;
      }
    };

    expect(() => launchAgyProcess(
      recordingLauncher(events),
      "resident_pty",
      () => process,
      "pty"
    )).toThrow(AgyStartupLifetimeBindingError);
    expect(events).toEqual(["acquire:resident_pty"]);
  });

  it("propagates a terminal release failure without misclassifying the process shape", () => {
    const releaseError = new Error("permit release failed");
    const process = Object.assign(new EventEmitter(), {
      exitCode: 0 as number | null,
      signalCode: null as NodeJS.Signals | null
    });
    const launcher: AgyStartupLauncher = {
      enabled: true,
      acquire: () => ({ release: () => { throw releaseError; } })
    };

    expect(() => launchAgyProcess(launcher, "auxiliary", () => process, "child_process"))
      .toThrow(releaseError);
  });

  it("does not invoke the process factory without a permit", () => {
    const launcher: AgyStartupLauncher = {
      enabled: true,
      acquire: () => {
        throw new Error("gate denied");
      }
    };
    let started = false;

    expect(() => launchAgyProcess(launcher, "auxiliary", () => {
      started = true;
      return undefined;
    }, "child_process")).toThrow("gate denied");
    expect(started).toBe(false);
  });

  it("does not expose a caller-controlled fresh PTY canary source", () => {
    const binary = probeFakeAgyVersion();
    let fakeChildCalls = 0;
    expect(runRepositoryOwnedPromptFreePtyCanary(
      binary,
      () => {
        fakeChildCalls += 1;
        return { exitCode: 0 };
      },
      []
    )).toBeUndefined();
    expect(fakeChildCalls).toBe(0);
  });
});

function recordingLauncher(events: string[]): AgyStartupLauncher {
  return {
    enabled: true,
    acquire(classification) {
      events.push(`acquire:${classification}`);
      return { release: () => events.push(`release:${classification}`) };
    }
  };
}
