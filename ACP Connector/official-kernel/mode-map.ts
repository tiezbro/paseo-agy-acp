import { isRecord } from "./json-rpc.js";

/** Official live session modes from antigravity-acp 1.5.2. */
export const OFFICIAL_MODE_IDS = ["default", "auto_edit", "yolo"] as const;
export type OfficialModeId = (typeof OFFICIAL_MODE_IDS)[number];

const LEGACY_TO_OFFICIAL: Readonly<Record<string, OfficialModeId>> = Object.freeze({
  default: "default",
  auto_edit: "auto_edit",
  yolo: "yolo",
  "accept-edits": "auto_edit",
  accept_edits: "auto_edit",
  "dangerously-skip-permissions": "yolo",
  dangerously_skip_permissions: "yolo"
});

export function mapToOfficialModeId(mode: string): string {
  // Only translate known aliases. The kernel owns validation and future modes.
  return Object.hasOwn(LEGACY_TO_OFFICIAL, mode) ? LEGACY_TO_OFFICIAL[mode] : mode;
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

/** Paseo extension: the selected official mode owns all permission decisions. */
export function describeOfficialModes(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const next = { ...value };
  // Paseo 优先读取扁平 models；继续使用 2.9.1 的官方分组配置。
  delete next.models;
  if (isRecord(next.modes) && Array.isArray(next.modes.availableModes)) {
    next.modes = { ...next.modes, availableModes: next.modes.availableModes.map(describeMode) };
  }
  if (Array.isArray(next.configOptions)) {
    next.configOptions = next.configOptions.map(option => {
      if (!isRecord(option) || !Array.isArray(option.options)) return option;
      if (option.category === "model") return { ...option, options: option.options.map(describeModel) };
      if (option.category !== "mode") return option;
      return { ...option, options: option.options.map(describeMode) };
    });
  }
  return next;
}

function describeModel(option: unknown): unknown {
  if (!isRecord(option)) return option;
  if (Array.isArray(option.options)) return { ...option, options: option.options.map(describeModel) };
  if (typeof option.name !== "string") return option;
  // 仅清理菜单文案；value、具体模型 ID 和内核的档位解析保持原值。
  const name = option.name.replace(/(?:\s+\((?:thinking|minimal|low|medium|high|xhigh|extra high|max)(?: thinking)?\))+$/i, "");
  return name ? { ...option, name } : option;
}

function describeMode(option: unknown): unknown {
  if (!isRecord(option)) return option;
  if (Array.isArray(option.options)) return { ...option, options: option.options.map(describeMode) };
  const id = option.id ?? option.value;
  if (id !== "default" && id !== "auto_edit" && id !== "yolo") return option;
  return { ...option, _meta: { ...(isRecord(option._meta) ? option._meta : {}), "paseo.dev/unattended": id === "yolo" } };
}
