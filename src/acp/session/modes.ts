// Native ACP Session Modes & mode config option definitions.
// Docs: https://agentclientprotocol.com/protocol/v1/session-modes

import type { SessionConfigOption as V1SessionConfigOption, SessionModeState } from "@agentclientprotocol/sdk";
import type { SessionModeId } from "../../agy/cli.js";

export const MODE_CONFIG_ID = "mode";

/** Shared labels/descriptions for config option `mode` and native ACP session modes. */
export const AGY_MODE_OPTIONS: ReadonlyArray<{
  value: SessionModeId;
  name: string;
  description: string;
}> = [
  {
    value: "default",
    name: "Default",
    description: "Request review before file writes (agy default; omits --mode)."
  },
  {
    value: "accept-edits",
    name: "Accept Edits",
    description: "Apply file edits without interactive write review (agy --mode accept-edits)."
  },
  {
    value: "plan",
    name: "Plan",
    description: "Plan-oriented execution (agy --mode plan)."
  }
];

/** Native ACP session mode state (v1 `modes` on new/load/resume). Same ids as config `mode`. */
export function sessionModeState(mode: SessionModeId): SessionModeState {
  return {
    currentModeId: mode,
    availableModes: AGY_MODE_OPTIONS.map((option) => ({
      id: option.value,
      name: option.name,
      description: option.description
    }))
  };
}

export function modeConfigOption(mode: SessionModeId): V1SessionConfigOption {
  return {
    id: MODE_CONFIG_ID,
    name: "Mode",
    description:
      "agy execution mode (--mode). Default reviews writes; Accept Edits applies file changes; Plan focuses on planning.",
    category: "mode",
    type: "select",
    currentValue: mode,
    options: AGY_MODE_OPTIONS.map((option) => ({
      value: option.value,
      name: option.name,
      description: option.description
    }))
  };
}
