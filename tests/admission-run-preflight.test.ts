import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const kernel = vi.hoisted(() => ({
  ensureManagedOfficialKernel: vi.fn(async () => {
    throw new Error("ensureManagedOfficialKernel reached");
  }),
  spawnOfficialKernel: vi.fn(() => {
    throw new Error("spawnOfficialKernel reached");
  })
}));

vi.mock("../ACP Connector/official-kernel/ensure-managed-kernel.js", () => ({
  ensureManagedOfficialKernel: kernel.ensureManagedOfficialKernel
}));
vi.mock("../ACP Connector/official-kernel/spawn.js", () => ({
  spawnOfficialKernel: kernel.spawnOfficialKernel
}));

import {
  createOfficialAdmission,
  isAdmissionDiscoveryEnvironment
} from "../ACP Connector/official-kernel/admission-fence.js";
import { runOfficialKernel } from "../ACP Connector/official-kernel/run.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "agy-acp-preflight-"));
  kernel.ensureManagedOfficialKernel.mockClear();
  kernel.spawnOfficialKernel.mockClear();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function validAdmissionEnvironment(): NodeJS.ProcessEnv {
  return {
    AGY_ACP_ADMISSION_ENABLED: "1",
    AGY_ACP_STATE_DIR: path.join(root, "state"),
    PASEO_AGENT_ID: "preflight-agent"
  };
}

function expectNothingStarted(): void {
  expect(kernel.ensureManagedOfficialKernel).not.toHaveBeenCalled();
  expect(kernel.spawnOfficialKernel).not.toHaveBeenCalled();
  // The key and the runtime database live inside the state directory, so its
  // absence also proves no key was generated and no database was opened.
  expect(existsSync(path.join(root, "state"))).toBe(false);
}

describe("official kernel admission preflight", () => {
  it.each(["darwin", "win32"] as const)(
    "rejects a valid admission configuration on %s before resolving or spawning the kernel",
    async (platform) => {
      await expect(runOfficialKernel({ env: validAdmissionEnvironment(), version: "test", platform }))
        .rejects.toThrow(new RegExp(`only supported on linux.*current platform is ${platform}`));
      expectNothingStarted();
    }
  );

  it("reports the unsupported platform before other admission configuration errors", async () => {
    await expect(runOfficialKernel({
      env: { AGY_ACP_ADMISSION_ENABLED: "1", PASEO_AGENT_ID: "preflight-agent" },
      version: "test",
      platform: "darwin"
    })).rejects.toThrow(/only supported on linux/);
    expectNothingStarted();
  });

  it("lets a valid admission configuration on linux reach kernel resolution", async () => {
    await expect(runOfficialKernel({ env: validAdmissionEnvironment(), version: "test", platform: "linux" }))
      .rejects.toThrow(/ensureManagedOfficialKernel reached/);
    expect(kernel.ensureManagedOfficialKernel).toHaveBeenCalledTimes(1);
    expect(kernel.spawnOfficialKernel).not.toHaveBeenCalled();
  });

  it("rejects invalid enabled admission before resolving the managed kernel", async () => {
    await expect(runOfficialKernel({
      env: { AGY_ACP_ADMISSION_ENABLED: "1", PASEO_AGENT_ID: "preflight-agent" },
      version: "test",
      platform: "linux"
    })).rejects.toThrow(/AGY_ACP_STATE_DIR/);
    expectNothingStarted();
  });

  it.each(["TRUE", "True", "yes", "on", " 1"])(
    "rejects malformed AGY_ACP_ADMISSION_ENABLED=%j instead of running unfenced",
    async (value) => {
      await expect(runOfficialKernel({
        env: { ...validAdmissionEnvironment(), AGY_ACP_ADMISSION_ENABLED: value },
        version: "test",
        platform: "linux"
      })).rejects.toThrow(/AGY_ACP_ADMISSION_ENABLED must be one of 1, true, 0, or false/);
      expectNothingStarted();
    }
  );

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["0", "0"],
    ["false", "false"]
  ])("starts the ordinary provider on darwin and win32 when admission is %s", async (_label, value) => {
    for (const platform of ["darwin", "win32"] as const) {
      kernel.ensureManagedOfficialKernel.mockClear();
      await expect(runOfficialKernel({
        env: { AGY_ACP_ADMISSION_ENABLED: value, PASEO_AGENT_ID: "provider-agent" },
        version: "test",
        platform
      })).rejects.toThrow(/ensureManagedOfficialKernel reached/);
      expect(kernel.ensureManagedOfficialKernel).toHaveBeenCalledTimes(1);
    }
  });

  it.each(["darwin", "win32"] as const)(
    "keeps provider discovery without an agent identity available on %s",
    async (platform) => {
      await expect(runOfficialKernel({
        env: { AGY_ACP_ADMISSION_ENABLED: "1", PASEO_AGENT_ID: "" },
        version: "test",
        platform
      })).rejects.toThrow(/ensureManagedOfficialKernel reached/);
      expect(kernel.ensureManagedOfficialKernel).toHaveBeenCalledTimes(1);
    }
  );
});

describe("official kernel admission enable flag", () => {
  it("fails closed in the proxy fence instead of treating a malformed flag as disabled", () => {
    const environment = { ...validAdmissionEnvironment(), AGY_ACP_ADMISSION_ENABLED: "TRUE" };
    expect(() => isAdmissionDiscoveryEnvironment({ ...environment, PASEO_AGENT_ID: "" }))
      .toThrow(/AGY_ACP_ADMISSION_ENABLED/);
    expect(() => createOfficialAdmission(environment)).toThrow(/AGY_ACP_ADMISSION_ENABLED/);
    expect(existsSync(path.join(root, "state"))).toBe(false);
  });
});
