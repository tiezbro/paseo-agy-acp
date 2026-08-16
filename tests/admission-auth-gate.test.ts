import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcpAgent,
  composeAcpRuntime,
  type AcpAgentOptions
} from "../ACP Connector/agent.js";
import * as installer from "../ACP Connector/agy/installer.js";
import type { PtyFactory, PtyProcess, SpawnFactory } from "../ACP Connector/agy/cli.js";

const TEST_MODELS_OUTPUT =
  "gemini-3.5-flash-medium\ngemini-3.5-flash-high\nclaude-opus-4-6-thinking\n";

const stateDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of stateDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Admission auth gate", () => {
  it("fails closed for all v1/v2 auth entry points when Admission is enabled", async () => {
    vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);
    const composition = composeAcpRuntime({
      env: admissionEnvironment(stateDir("enabled")),
      ...legacyAuthOptions()
    });
    const agent = new AcpAgent(composition.options);

    try {
      const outcomes = await authOutcomes(agent);

      expect(outcomes).toEqual([
        admissionAuthRejected("authenticate"),
        admissionAuthRejected("loginAuth"),
        admissionAuthRejected("logout"),
        admissionAuthRejected("logoutAuth")
      ]);
    } finally {
      composition.close();
    }
  });

  it("preserves disabled legacy auth and logout behavior", async () => {
    vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);
    const writes: string[] = [];
    const agent = new AcpAgent({
      env: { NODE_ENV: "test" },
      ...legacyAuthOptions(writes)
    });

    await expect(agent.authenticate({ methodId: "agy-login" })).resolves.toEqual({});
    await expect(agent.loginAuth({ methodId: "agy-login" })).resolves.toEqual({});
    await expect(agent.logout({})).resolves.toEqual({});
    await expect(agent.logoutAuth({})).resolves.toEqual({});
    expect(writes).toEqual(["/logout\r", "/logout\r"]);
  });
});

function stateDir(label: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), `paseo-agy-acp-auth-${label}-`));
  stateDirs.push(directory);
  return directory;
}

function admissionEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    AGY_ACP_ADMISSION_ENABLED: "1",
    AGY_ACP_STATE_DIR: directory,
    PASEO_AGENT_ID: "agent-auth-gate",
    NODE_ENV: "test"
  };
}

function legacyAuthOptions(writes: string[] = []): AcpAgentOptions {
  return {
    argv: ["--no-interactive-permissions"],
    stateDir: stateDir("legacy"),
    modelCacheEnabled: false,
    spawnProcess: loggedInSpawn as unknown as SpawnFactory,
    ptyFactory: { spawn: () => new LogoutPty(writes) } as unknown as PtyFactory
  };
}

async function authOutcomes(agent: AcpAgent): Promise<AuthOutcome[]> {
  return Promise.all([
    authOutcome("authenticate", () => agent.authenticate({ methodId: "agy-login" })),
    authOutcome("loginAuth", () => agent.loginAuth({ methodId: "agy-login" })),
    authOutcome("logout", () => agent.logout({})),
    authOutcome("logoutAuth", () => agent.logoutAuth({}))
  ]);
}

type AuthMethod = "authenticate" | "loginAuth" | "logout" | "logoutAuth";

type AuthOutcome =
  | {
      method: AuthMethod;
      rejected: true;
      code: number;
      message: string;
      data: unknown;
    }
  | {
      method: AuthMethod;
      resolved: true;
    };

async function authOutcome(method: AuthMethod, run: () => Promise<unknown>): Promise<AuthOutcome> {
  try {
    await run();
    return { method, resolved: true };
  } catch (error) {
    const record = error as { code?: unknown; message?: unknown; data?: unknown };
    return {
      method,
      rejected: true,
      code: typeof record.code === "number" ? record.code : 0,
      message: typeof record.message === "string" ? record.message : "",
      data: record.data
    };
  }
}

function admissionAuthRejected(method: AuthMethod): AuthOutcome {
  return {
    method,
    rejected: true,
    code: -32600,
    message: expect.stringContaining("Admission is enabled") as unknown as string,
    data: {
      code: "admission_auth_disabled",
      method
    }
  };
}

function loggedInSpawn(_command: string, args: string[]) {
  if (args[0] === "models") return new FakeProcess([TEST_MODELS_OUTPUT]);
  return new FakeProcess(["ok"]);
}

class FakeProcess extends EventEmitter {
  stdin = new Writable({ write: (_chunk, _encoding, callback) => callback() });
  stdout: Readable;
  stderr: Readable;
  exitCode = 0;
  pid = 1;

  constructor(chunks: string[]) {
    super();
    this.stdout = Readable.from(chunks);
    this.stderr = Readable.from([]);
    queueMicrotask(() => this.emit("exit", this.exitCode, null));
  }

  kill(): boolean {
    this.exitCode = -15;
    this.emit("exit", -15, "SIGTERM");
    return true;
  }
}

class LogoutPty implements PtyProcess {
  readonly #writes: string[];
  readonly #exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];

  constructor(writes: string[]) {
    this.#writes = writes;
  }

  write(data: string): void {
    this.#writes.push(data);
    queueMicrotask(() => this.exit());
  }

  kill(): void {
    this.exit();
  }

  onData(listener: (data: string) => void): { dispose(): void } {
    queueMicrotask(() => listener("? for shortcuts"));
    return { dispose() {} };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void } {
    this.#exitListeners.push(listener);
    return { dispose() {} };
  }

  private exit(): void {
    for (const listener of this.#exitListeners) listener({ exitCode: 0 });
  }
}
