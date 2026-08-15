import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcpAgent,
  composeAcpRuntime,
  runAcp
} from "../ACP Connector/acp/agent.js";
import * as installer from "../ACP Connector/agy/installer.js";
import type { AgyStartupLauncher } from "../ACP Connector/agy/startup-launcher.js";

const stateDirs: string[] = [];

function stateDir(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-acp-runtime-wiring-"));
  stateDirs.push(directory);
  return directory;
}

function runtimeEnvironment(directory: string): NodeJS.ProcessEnv {
  return {
    AGY_ACP_ADMISSION_ENABLED: "1",
    AGY_ACP_STATE_DIR: directory,
    PASEO_AGENT_ID: "agent-runtime-wiring",
    NODE_ENV: "test"
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of stateDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ACP shared-queue runtime wiring", () => {
  it("threads the exact startup launcher into initialize installation and auth probes", async () => {
    const startupLauncher: AgyStartupLauncher = {
      enabled: true,
      acquire: () => ({ release() {} })
    };
    const installed = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);
    const agent = new AcpAgent({
      stateDir: stateDir(),
      modelCacheEnabled: false,
      startupLauncher
    });

    await agent.initializeV1({ protocolVersion: 1, clientCapabilities: {} });
    expect(installed).toHaveBeenCalledWith(expect.objectContaining({ startupLauncher }));
    const authConfig = (agent as unknown as {
      authProbeConfig(cwd: string): { startupLauncher?: AgyStartupLauncher };
    }).authProbeConfig("/tmp");
    expect(authConfig.startupLauncher).toBe(startupLauncher);
  });

  it("composes the enabled shared queue and closes its SQLite owners idempotently", () => {
    const directory = stateDir();
    const composition = composeAcpRuntime({
      env: runtimeEnvironment(directory),
      modelCacheEnabled: false
    });

    expect(composition.options.turnAdmission).toBeDefined();
    expect(composition.sessionStore).toBeDefined();
    expect(existsSync(path.join(directory, "runtime.sqlite"))).toBe(true);
    expect(existsSync(path.join(directory, "sessions.json"))).toBe(false);
    composition.close();
    expect(() => composition.close()).not.toThrow();
  });

  it("starts the transport entrypoint with the enabled shared queue", async () => {
    const directory = stateDir();
    const input = new PassThrough();
    const output = new PassThrough();
    const installed = vi.spyOn(installer, "ensureAgyInstalled").mockResolvedValue(null);

    const connection = runAcp({
      env: runtimeEnvironment(directory),
      stdin: input,
      stdout: output,
      modelCacheEnabled: false
    });
    expect(installed).not.toHaveBeenCalled();
    expect(existsSync(path.join(directory, "runtime.sqlite"))).toBe(true);
    input.end();
    await connection.closed;
    output.end();
  });
});
