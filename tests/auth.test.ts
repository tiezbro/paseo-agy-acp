import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import * as installer from "../src/agy/installer.js";
import {
  AUTH_METHOD_TERMINAL_LOGIN,
  formatAuthProbeError,
  isKnownAuthMethodId,
  looksUnauthenticated,
  runInteractiveAgyLogin,
  v1AuthMethods,
  v2AuthMethods,
  type InteractiveLoginSpawn
} from "../src/agy/auth.js";
import { AgyCliError, type AgyCliBackend } from "../src/agy/cli.js";

/** Minimal fake for the login child process: an EventEmitter with a `kill` that
 *  simulates the child exiting shortly after receiving a signal. */
class FakeLoginChild extends EventEmitter {
  killedWith: string[] = [];
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killedWith.push(String(signal));
    queueMicrotask(() => this.emit("exit", null, signal ?? "SIGTERM"));
    return true;
  }
}

describe("auth methods", () => {
  it("advertises a single terminal login method", () => {
    const v1 = v1AuthMethods();
    expect(v1).toEqual([
      expect.objectContaining({
        type: "terminal",
        id: AUTH_METHOD_TERMINAL_LOGIN,
        args: ["--login"]
      })
    ]);

    const v2 = v2AuthMethods();
    expect(v2).toEqual([
      expect.objectContaining({
        type: "terminal",
        methodId: AUTH_METHOD_TERMINAL_LOGIN,
        args: ["--login"]
      })
    ]);
  });

  it("recognizes known method ids", () => {
    expect(isKnownAuthMethodId(AUTH_METHOD_TERMINAL_LOGIN)).toBe(true);
    expect(isKnownAuthMethodId("other")).toBe(false);
  });

  it("includes a legacy _meta['terminal-auth'] payload for clients without native terminal-auth support", () => {
    for (const method of [...v1AuthMethods(), ...v2AuthMethods()]) {
      const meta = (method as { _meta?: Record<string, unknown> })._meta;
      const terminalAuth = meta?.["terminal-auth"] as
        | { label: string; command: string; args: string[] }
        | undefined;
      expect(terminalAuth?.label).toBeTruthy();
      expect(terminalAuth?.command).toBe(process.execPath);
      expect(terminalAuth?.args.at(-1)).toBe("--login");
    }
  });
});

describe("auth probe helpers", () => {
  it("detects not-logged-in errors", () => {
    const err = new AgyCliError(
      "agy models exited with status 1: error getting token source: You are not logged into Antigravity.",
      ["agy", "models"],
      1,
      "You are not logged into Antigravity."
    );
    expect(formatAuthProbeError(err)).toBe("You are not logged into Antigravity.");
    expect(looksUnauthenticated(formatAuthProbeError(err))).toBe(true);
  });
});

describe("runInteractiveAgyLogin", () => {
  it("auto-closes the terminal once agy models reports a successful login", async () => {
    vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue("agy");

    const child = new FakeLoginChild();
    let listModelsCalls = 0;
    const backend = {
      listModels: vi.fn(async () => {
        listModelsCalls += 1;
        // Not authenticated on the first poll, signed in from the second one.
        return listModelsCalls >= 2 ? ["gemini-3.5-flash"] : [];
      })
    } as unknown as AgyCliBackend;
    const spawnLogin: InteractiveLoginSpawn = () => child as unknown as ChildProcess;

    const code = await runInteractiveAgyLogin({
      env: {},
      cwd: "/tmp",
      backend,
      spawnLogin,
      pollIntervalMs: 5,
      killGraceMs: 20
    });

    expect(code).toBe(0);
    expect(child.killedWith).toContain("SIGTERM");
    expect(listModelsCalls).toBeGreaterThanOrEqual(2);
  });

  it("returns the child's own exit code when the user quits before login succeeds", async () => {
    vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue("agy");

    const child = new FakeLoginChild();
    const backend = {
      listModels: vi.fn(async () => [])
    } as unknown as AgyCliBackend;
    const spawnLogin: InteractiveLoginSpawn = () => child as unknown as ChildProcess;

    const codePromise = runInteractiveAgyLogin({
      env: {},
      cwd: "/tmp",
      backend,
      spawnLogin,
      pollIntervalMs: 5,
      killGraceMs: 20
    });

    // The user exits agy manually (e.g. Ctrl+C) before the background poll ever succeeds.
    setTimeout(() => child.emit("exit", 130, null), 10);

    const code = await codePromise;
    expect(code).toBe(130);
    expect(child.killedWith).toEqual([]);
  });
});
