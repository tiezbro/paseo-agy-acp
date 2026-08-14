import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => {
  throw new Error("admission runtime configuration must not load the filesystem");
});

import {
  AdmissionRuntimeConfigError,
  DEFAULT_ADMISSION_POLICY,
  parseAdmissionRuntimeConfig
} from "../Admission Controller/runtime-config.js";

const enabledEnvironment = {
  AGY_ACP_ADMISSION_ENABLED: "1",
  AGY_ACP_STATE_DIR: "/var/lib/paseo-agy-acp",
  PASEO_AGENT_ID: "agent-runtime-config"
};

describe("Admission Controller runtime configuration", () => {
  it("is disabled by default without loading or validating runtime state", () => {
    const config = parseAdmissionRuntimeConfig({
      AGY_ACP_STATE_DIR: "relative-and-intentionally-invalid",
      AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS: "not-a-number"
    });

    expect(config).toEqual({ enabled: false });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("requires an explicit recognized enable value", () => {
    expect(parseAdmissionRuntimeConfig({ AGY_ACP_ADMISSION_ENABLED: "false" })).toEqual({ enabled: false });
    expect(parseAdmissionRuntimeConfig({ AGY_ACP_ADMISSION_ENABLED: "0" })).toEqual({ enabled: false });
    expect(() => parseAdmissionRuntimeConfig({ AGY_ACP_ADMISSION_ENABLED: "true" })).toThrow(/AGY_ACP_STATE_DIR/);
    expect(() => parseAdmissionRuntimeConfig({ AGY_ACP_ADMISSION_ENABLED: "yes" })).toThrow(AdmissionRuntimeConfigError);
  });

  it("builds an immutable enabled configuration with conservative defaults", () => {
    const config = parseAdmissionRuntimeConfig(enabledEnvironment);

    expect(config).toEqual({
      enabled: true,
      agentId: "agent-runtime-config",
      stateDir: "/var/lib/paseo-agy-acp",
      databasePath: "/var/lib/paseo-agy-acp/runtime.sqlite",
      policy: DEFAULT_ADMISSION_POLICY
    });
    expect(config.enabled).toBe(true);
    if (config.enabled) {
      expect(Object.isFrozen(config)).toBe(true);
      expect(Object.isFrozen(config.policy)).toBe(true);
    }
  });

  it("requires an absolute state directory only after admission is explicitly enabled", () => {
    expect(() => parseAdmissionRuntimeConfig({ ...enabledEnvironment, AGY_ACP_STATE_DIR: "relative-state" })).toThrow(
      /absolute/
    );
    expect(() => parseAdmissionRuntimeConfig({ AGY_ACP_ADMISSION_ENABLED: "1" })).toThrow(/AGY_ACP_STATE_DIR/);
  });

  it("requires a stable Paseo agent identity before enabled state can be constructed", () => {
    for (const agentId of [undefined, "", " agent", "agent/child", "agent\\child", "x".repeat(257)]) {
      expect(() => parseAdmissionRuntimeConfig({
        ...enabledEnvironment,
        PASEO_AGENT_ID: agentId
      })).toThrow(/PASEO_AGENT_ID/);
    }
  });

  it("accepts only policy overrides that preserve the confirmed conservative limits", () => {
    const config = parseAdmissionRuntimeConfig({
      ...enabledEnvironment,
      AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS: "1",
      AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS: "1",
      AGY_ACP_ADMISSION_MIN_START_INTERVAL_MS: "5000",
      AGY_ACP_ADMISSION_QUEUE_TIMEOUT_MS: "60000",
      AGY_ACP_ADMISSION_CAPACITY_COOLDOWN_MS: "60000"
    });

    expect(config).toMatchObject({
      enabled: true,
      policy: {
        maxActiveTurns: 1,
        maxConcurrentStarts: 1,
        minStartIntervalMs: 5000,
        queueTimeoutMs: 60000,
        capacityCooldownMs: 60000
      }
    });
  });

  it("defaults to two shared active Antigravity seats and accepts only one or two", () => {
    expect(DEFAULT_ADMISSION_POLICY.maxActiveTurns).toBe(2);
    for (const maxActiveTurns of [1, 2]) {
      const config = parseAdmissionRuntimeConfig({
        ...enabledEnvironment,
        AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS: String(maxActiveTurns)
      });
      expect(config.enabled && config.policy.maxActiveTurns).toBe(maxActiveTurns);
    }
  });

  it("fails closed for unknown enable values and unsafe or malformed policy overrides", () => {
    const invalidEnvironments = [
      { ...enabledEnvironment, AGY_ACP_ADMISSION_ENABLED: "enabled" },
      { ...enabledEnvironment, AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS: "0" },
      { ...enabledEnvironment, AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS: "3" },
      { ...enabledEnvironment, AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS: "1.5" },
      { ...enabledEnvironment, AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS: "2" },
      { ...enabledEnvironment, AGY_ACP_ADMISSION_MIN_START_INTERVAL_MS: "1999" },
      { ...enabledEnvironment, AGY_ACP_ADMISSION_QUEUE_TIMEOUT_MS: "1800001" },
      { ...enabledEnvironment, AGY_ACP_ADMISSION_CAPACITY_COOLDOWN_MS: "29999" },
      { ...enabledEnvironment, AGY_ACP_ADMISSION_QUEUE_TIMEOUT_MS: "1.5" }
    ];

    for (const environment of invalidEnvironments) {
      expect(() => parseAdmissionRuntimeConfig(environment)).toThrow(AdmissionRuntimeConfigError);
    }
  });
});
