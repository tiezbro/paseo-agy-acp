import { join } from "node:path";
import { createAdmissionRuntime, type AdmissionRuntime } from "../admission/runtime.js";
import { AdmissionTurnCoordinator } from "../admission/turn-coordinator.js";
import type { AgyAdmissionDispatchBoundary } from "../admission/dispatch-boundary.js";

export function officialAdmissionStateDir(stateDir: string): string {
  return join(stateDir, "official-kernel");
}

export function isAdmissionEnabled(environment: NodeJS.ProcessEnv): boolean {
  const enabled = environment.AGY_ACP_ADMISSION_ENABLED;
  return enabled === "1" || enabled === "true";
}

export function isAdmissionDiscoveryEnvironment(environment: NodeJS.ProcessEnv): boolean {
  const agentId = environment.PASEO_AGENT_ID;
  return isAdmissionEnabled(environment) && (agentId === undefined || agentId.length === 0);
}

export function issueAdmittedOfficialPromptWrite(
  boundary: AgyAdmissionDispatchBoundary,
  processId: number,
  write: () => void
): void {
  boundary.prepare(processId);
  const intent = boundary as AgyAdmissionDispatchBoundary & { commitDispatchIntent?: () => void };
  intent.commitDispatchIntent?.();
  boundary.beforePromptWrite();
  try {
    write();
  } catch (error) {
    const ambiguous = boundary as AgyAdmissionDispatchBoundary & { markDispatchAmbiguous?: () => void };
    ambiguous.markDispatchAmbiguous?.();
    throw error;
  }
  boundary.afterPromptWrite();
}

export function createOfficialAdmission(
  environment: NodeJS.ProcessEnv
): { runtime: AdmissionRuntime; coordinator: AdmissionTurnCoordinator } | undefined {
  if (isAdmissionDiscoveryEnvironment(environment)) return undefined;
  if (!isAdmissionEnabled(environment)) return undefined;
  const parentStateDir = environment.AGY_ACP_STATE_DIR;
  const isolated: NodeJS.ProcessEnv = {
    ...environment,
    AGY_ACP_STATE_DIR:
      parentStateDir && parentStateDir.length > 0
        ? officialAdmissionStateDir(parentStateDir)
        : parentStateDir
  };
  const runtime = createAdmissionRuntime(isolated);
  if (runtime === null) return undefined;
  return {
    runtime,
    coordinator: new AdmissionTurnCoordinator({
      controller: runtime.controller,
      agentId: isolated.PASEO_AGENT_ID
    })
  };
}
