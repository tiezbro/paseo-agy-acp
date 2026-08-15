import { isAbsolute, join } from "node:path";
import type { AdmissionPolicy } from "./controller.js";

export type AdmissionRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export interface DisabledAdmissionRuntimeConfig {
  readonly enabled: false;
}

export interface EnabledAdmissionRuntimeConfig {
  readonly enabled: true;
  readonly agentId: string;
  readonly stateDir: string;
  readonly databasePath: string;
  readonly policy: Readonly<AdmissionPolicy>;
}

export type AdmissionRuntimeConfig = DisabledAdmissionRuntimeConfig | EnabledAdmissionRuntimeConfig;

export class AdmissionRuntimeConfigError extends Error {
  constructor(message: string) {
    super(`admission runtime configuration error: ${message}`);
    this.name = "AdmissionRuntimeConfigError";
  }
}

export const DEFAULT_ADMISSION_POLICY: Readonly<AdmissionPolicy> = Object.freeze({
  maxActiveTurns: 3,
  maxConcurrentStarts: 1,
  minStartIntervalMs: 2_000,
  queueTimeoutMs: 30 * 60 * 1_000,
  capacityCooldownMs: 30_000
});

const DISABLED_CONFIG: DisabledAdmissionRuntimeConfig = Object.freeze({ enabled: false });

const POLICY_ENV = {
  maxActiveTurns: "AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS",
  maxConcurrentStarts: "AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS",
  minStartIntervalMs: "AGY_ACP_ADMISSION_MIN_START_INTERVAL_MS",
  queueTimeoutMs: "AGY_ACP_ADMISSION_QUEUE_TIMEOUT_MS",
  capacityCooldownMs: "AGY_ACP_ADMISSION_CAPACITY_COOLDOWN_MS"
} as const;

/**
 * Parse the future admission runtime's environment without creating state or
 * opening the controller. State-directory creation and permission checks stay
 * with the later runtime factory and key store.
 */
export function parseAdmissionRuntimeConfig(
  environment: AdmissionRuntimeEnvironment = process.env
): AdmissionRuntimeConfig {
  if (!isAdmissionExplicitlyEnabled(environment.AGY_ACP_ADMISSION_ENABLED)) {
    return DISABLED_CONFIG;
  }

  const stateDir = requireAbsoluteStateDirectory(environment.AGY_ACP_STATE_DIR);
  const agentId = requirePaseoAgentId(environment.PASEO_AGENT_ID);
  const policy = Object.freeze({
    maxActiveTurns: parsePolicyOverride(
      environment,
      POLICY_ENV.maxActiveTurns,
      DEFAULT_ADMISSION_POLICY.maxActiveTurns,
      (value) => value === 1 || value === 3
    ),
    maxConcurrentStarts: parsePolicyOverride(
      environment,
      POLICY_ENV.maxConcurrentStarts,
      DEFAULT_ADMISSION_POLICY.maxConcurrentStarts,
      (value) => value === 1
    ),
    minStartIntervalMs: parsePolicyOverride(
      environment,
      POLICY_ENV.minStartIntervalMs,
      DEFAULT_ADMISSION_POLICY.minStartIntervalMs,
      (value) => value >= DEFAULT_ADMISSION_POLICY.minStartIntervalMs
    ),
    queueTimeoutMs: parsePolicyOverride(
      environment,
      POLICY_ENV.queueTimeoutMs,
      DEFAULT_ADMISSION_POLICY.queueTimeoutMs,
      (value) => value > 0 && value <= DEFAULT_ADMISSION_POLICY.queueTimeoutMs
    ),
    capacityCooldownMs: parsePolicyOverride(
      environment,
      POLICY_ENV.capacityCooldownMs,
      DEFAULT_ADMISSION_POLICY.capacityCooldownMs,
      (value) => value >= DEFAULT_ADMISSION_POLICY.capacityCooldownMs
    )
  } satisfies AdmissionPolicy);

  return Object.freeze({
    enabled: true,
    agentId,
    stateDir,
    databasePath: join(stateDir, "runtime.sqlite"),
    policy
  });
}

function requirePaseoAgentId(value: string | undefined): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)
  ) {
    throw new AdmissionRuntimeConfigError(
      "PASEO_AGENT_ID is required when admission is enabled"
    );
  }
  return value;
}

function isAdmissionExplicitlyEnabled(value: string | undefined): boolean {
  if (value === undefined || value === "" || value === "0" || value === "false") return false;
  if (value === "1" || value === "true") return true;
  throw new AdmissionRuntimeConfigError("AGY_ACP_ADMISSION_ENABLED must be one of 1, true, 0, or false");
}

function requireAbsoluteStateDirectory(value: string | undefined): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new AdmissionRuntimeConfigError("AGY_ACP_STATE_DIR is required when admission is enabled");
  }
  if (value.includes("\0") || !isAbsolute(value)) {
    throw new AdmissionRuntimeConfigError("AGY_ACP_STATE_DIR must be an absolute path");
  }
  return value;
}

function parsePolicyOverride(
  environment: AdmissionRuntimeEnvironment,
  name: string,
  fallback: number,
  isConservative: (value: number) => boolean
): number {
  const raw = environment[name];
  if (raw === undefined) return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    throw new AdmissionRuntimeConfigError(`${name} must be a base-10 integer`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || !isConservative(value)) {
    throw new AdmissionRuntimeConfigError(`${name} is not a conservative admission policy value`);
  }
  return value;
}
