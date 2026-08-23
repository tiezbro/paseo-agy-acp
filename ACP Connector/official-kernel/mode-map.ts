import { isRecord } from "./json-rpc.js";

/** Official live session modes from agy_acp_server_20260818_01_RC01. */
export const OFFICIAL_MODE_IDS = ["default", "auto_edit", "yolo"] as const;
export type OfficialModeId = (typeof OFFICIAL_MODE_IDS)[number];

const LEGACY_TO_OFFICIAL: Readonly<Record<string, OfficialModeId>> = Object.freeze({
  default: "default",
  auto_edit: "auto_edit",
  yolo: "yolo",
  "accept-edits": "auto_edit",
  accept_edits: "auto_edit",
  plan: "default",
  "dangerously-skip-permissions": "yolo",
  dangerously_skip_permissions: "yolo"
});

export function mapToOfficialModeId(mode: string): OfficialModeId {
  return LEGACY_TO_OFFICIAL[mode] ?? "default";
}

export function rewriteModeFields(params: unknown): unknown {
  if (!isRecord(params)) return params;
  const next: Record<string, unknown> = { ...params };
  for (const key of ["modeId", "mode", "currentModeId"] as const) {
    const value = next[key];
    if (typeof value === "string") next[key] = mapToOfficialModeId(value);
  }
  const optionId = next.configId ?? next.id;
  if ((optionId === "mode" || optionId === "session_mode") && typeof next.value === "string") {
    next.value = mapToOfficialModeId(next.value);
  }
  if (isRecord(next._meta) && typeof next._meta.mode === "string") {
    next._meta = { ...next._meta, mode: mapToOfficialModeId(next._meta.mode) };
  }
  return next;
}
