import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const DEFAULT_OFFICIAL_BIN = path.join(
  homedir(),
  ".local/opt/agy-acp-server-agy_acp_server_20260818_01_RC01/agy-acp-server-canary"
);

export function resolveOfficialBinary(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.PASEO_AGY_ACP_OFFICIAL_BIN?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_OFFICIAL_BIN;
}

export function officialSpawnArgs(binary: string): string[] {
  const base = path.basename(binary);
  if (base.endsWith(".par") || base === "agy_acp_server.par") return ["--uid="];
  return [];
}

export function spawnOfficialKernel(
  environment: NodeJS.ProcessEnv = process.env
): ChildProcessWithoutNullStreams {
  const binary = resolveOfficialBinary(environment);
  if (!existsSync(binary)) {
    throw new Error(
      `official Antigravity ACP kernel is missing at ${binary}; set PASEO_AGY_ACP_OFFICIAL_BIN`
    );
  }
  const child = spawn(binary, officialSpawnArgs(binary), {
    cwd: path.dirname(binary),
    env: environment,
    stdio: ["pipe", "pipe", "pipe"]
  });
  if (child.stdin === null || child.stdout === null || child.stderr === null) {
    child.kill("SIGKILL");
    throw new Error("official kernel stdio pipes are unavailable");
  }
  child.stderr.pipe(process.stderr);
  return child;
}
