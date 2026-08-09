import { existsSync, readFileSync } from "node:fs";

export interface LegacySessionSnapshot {
  sessionId: string;
  cwd: string;
  additionalDirectories: string[];
  conversationId: string | null;
  lastStepIdx: number;
  model: string;
  reasoningEffort: string;
  mode?: string;
  v2UserMessageIdsByStep: Record<string, string>;
  updatedAt: string;
}

export type LegacySessionPreflight =
  | { status: "absent"; sessions: [] }
  | { status: "valid"; sessions: LegacySessionSnapshot[] };

/** A present legacy state file must never silently degrade into an empty store. */
export class LegacyStatePreflightError extends Error {
  constructor(message: string) {
    super(`legacy session preflight failed: ${message}`);
    this.name = "LegacyStatePreflightError";
  }
}

export function inspectLegacySessionStore(file: string): LegacySessionPreflight {
  if (!existsSync(file)) return { status: "absent", sessions: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new LegacyStatePreflightError("sessions.json is unreadable or invalid JSON");
  }
  if (!isRecord(parsed)) throw new LegacyStatePreflightError("root must be an object");
  if (!isRecord(parsed.sessions)) throw new LegacyStatePreflightError("sessions must be an object");

  return {
    status: "valid",
    sessions: Object.entries(parsed.sessions).map(([sessionId, raw]) => normalizeSession(sessionId, raw))
  };
}

function normalizeSession(sessionId: string, raw: unknown): LegacySessionSnapshot {
  if (!sessionId) throw new LegacyStatePreflightError("session id must not be empty");
  if (!isRecord(raw)) throw new LegacyStatePreflightError(`session ${sessionId} must be an object`);

  const cwd = readString(raw.cwd, `session ${sessionId}.cwd`);
  const additionalDirectories =
    raw.additionalDirectories === undefined
      ? readStringArray(raw.workspaces, `session ${sessionId}.workspaces`).filter((workspace) => workspace !== cwd)
      : readStringArray(raw.additionalDirectories, `session ${sessionId}.additionalDirectories`);
  const conversationId = readOptionalStringOrNull(raw.conversationId, `session ${sessionId}.conversationId`) ?? null;
  const lastStepIdx = readOptionalInteger(raw.lastStepIdx, `session ${sessionId}.lastStepIdx`) ?? -1;
  if (lastStepIdx < -1) throw new LegacyStatePreflightError(`session ${sessionId}.lastStepIdx must be at least -1`);

  return {
    sessionId,
    cwd,
    additionalDirectories,
    conversationId,
    lastStepIdx,
    model: readLegacyString(raw, "model", "modelId", `session ${sessionId}.model`),
    reasoningEffort: readLegacyString(
      raw,
      "reasoningEffort",
      "reasoningEffect",
      `session ${sessionId}.reasoningEffort`
    ),
    mode: readOptionalString(raw.mode, `session ${sessionId}.mode`),
    v2UserMessageIdsByStep: readMessageIdMap(raw.v2UserMessageIdsByStep, sessionId),
    updatedAt: readString(raw.updatedAt, `session ${sessionId}.updatedAt`)
  };
}

function readLegacyString(
  raw: Record<string, unknown>,
  currentKey: string,
  legacyKey: string,
  label: string
): string {
  if (raw[currentKey] !== undefined) return readString(raw[currentKey], label);
  if (raw[legacyKey] !== undefined) return readString(raw[legacyKey], label);
  throw new LegacyStatePreflightError(`${label} is required`);
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new LegacyStatePreflightError(`${label} must be a string`);
  return value;
}

function readOptionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return readString(value, label);
}

function readOptionalStringOrNull(value: unknown, label: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  return readString(value, label);
}

function readOptionalInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new LegacyStatePreflightError(`${label} must be an integer`);
  }
  return value;
}

function readStringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new LegacyStatePreflightError(`${label} must be an array of strings`);
  }
  return [...value];
}

function readMessageIdMap(value: unknown, sessionId: string): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new LegacyStatePreflightError(`session ${sessionId}.v2UserMessageIdsByStep must be an object`);
  }
  const entries = Object.entries(value);
  if (entries.some(([stepIndex, messageId]) => !/^\d+$/.test(stepIndex) || typeof messageId !== "string" || !messageId)) {
    throw new LegacyStatePreflightError(`session ${sessionId}.v2UserMessageIdsByStep contains an invalid entry`);
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
