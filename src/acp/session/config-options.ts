// ACP session config options: builds the `mode` / `model` / `reasoningEffort`
// wire options and applies changes to a live session. Model/reasoningEffort
// selection math itself lives in agy/model/selection.ts (no ACP types).
// Docs: https://agentclientprotocol.com/protocol/v1/session-modes

import type { SessionConfigOption as V1SessionConfigOption } from "@agentclientprotocol/sdk";
import type { SessionConfigOption as V2SessionConfigOption } from "@agentclientprotocol/sdk/experimental/v2";
import { isSessionModeId, SESSION_MODE_IDS } from "../../agy/cli.js";
import {
  defaultReasoningEffortForBase,
  modelConfigOption,
  reasoningEffortConfigOption,
  reasoningEffortValues
} from "../../agy/model/catalog.js";
import { applyModelSelection } from "../../agy/model/selection.js";
import { modeConfigOption, MODE_CONFIG_ID } from "./modes.js";
import type { SessionState } from "./types.js";

export const MODEL_CONFIG_ID = "model";
export const REASONING_EFFORT_CONFIG_ID = "reasoningEffort";

export function readConfigValue(params: { value?: unknown; type?: string }): unknown {
  return params.value;
}

export function sessionConfigOptionsV1(session: SessionState): V1SessionConfigOption[] {
  return [
    modeConfigOption(session.agy.config.mode),
    modelConfigOption(session.selectedBaseModel, session.catalog),
    reasoningEffortConfigOption(
      session.selectedBaseModel,
      session.selectedReasoningEffort,
      session.catalog
    )
  ];
}

/** v2 renames config option `id` → `configId`. */
export function sessionConfigOptionsV2(session: SessionState): V2SessionConfigOption[] {
  return sessionConfigOptionsV1(session).map(v1ConfigOptionToV2);
}

function v1ConfigOptionToV2(option: V1SessionConfigOption): V2SessionConfigOption {
  const { id, ...rest } = option as V1SessionConfigOption & { id: string };
  return { ...rest, configId: id } as V2SessionConfigOption;
}

/**
 * Apply a `mode` / `model` / `reasoningEffort` config option change to a live
 * session, then persist the updated binding.
 */
export async function applyConfigOption(
  sessionId: string,
  configId: string,
  value: unknown,
  deps: {
    requireSession(sessionId: string): SessionState;
    persistSession(sessionId: string, session: SessionState): Promise<void>;
  }
): Promise<void> {
  const session = deps.requireSession(sessionId);
  if (configId === MODE_CONFIG_ID) {
    if (typeof value !== "string" || !isSessionModeId(value)) {
      throw new Error(`Mode must be one of: ${SESSION_MODE_IDS.join(", ")}`);
    }
    session.agy.setMode(value);
    await deps.persistSession(sessionId, session);
    return;
  }

  if (configId === MODEL_CONFIG_ID) {
    if (typeof value !== "string") {
      throw new Error("Model config value must be a string");
    }
    if (!session.catalog.baseModels().includes(value)) {
      throw new Error(`Unknown model: ${value}`);
    }

    session.selectedBaseModel = value;
    session.selectedReasoningEffort = defaultReasoningEffortForBase(value, session.catalog);
    applyModelSelection(
      session.agy,
      session.selectedBaseModel,
      session.selectedReasoningEffort,
      session.catalog
    );
    await deps.persistSession(sessionId, session);
    return;
  }

  if (configId === REASONING_EFFORT_CONFIG_ID) {
    if (typeof value !== "string") {
      throw new Error("reasoningEffort config value must be a string");
    }
    const allowedEfforts = reasoningEffortValues(session.selectedBaseModel, session.catalog);
    if (!allowedEfforts.includes(value)) {
      throw new Error(`Unknown reasoningEffort: ${value}`);
    }

    session.selectedReasoningEffort = value;
    applyModelSelection(
      session.agy,
      session.selectedBaseModel,
      session.selectedReasoningEffort,
      session.catalog
    );
    await deps.persistSession(sessionId, session);
    return;
  }

  throw new Error(`Unknown config option: ${configId}`);
}
