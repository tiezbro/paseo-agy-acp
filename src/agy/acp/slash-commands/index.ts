// ACP Slash Commands: curated available_commands_update + prompt intercept for agy-acp.
// Docs: https://agentclientprotocol.com/protocol/v1/slash-commands
//
// ACP only needs name + description (and optional unstructured input hint).
// Clients send selected commands as normal session/prompt text like `/mode plan`.
//
// We advertise only commands this wrapper can honor without agy's TUI panels:
// session config surfaces already mapped to `agy --mode` / `--model` / `--effort`.
// Full TUI palette (/settings, /mcp, /help overlays, …) is intentionally omitted.

import type { AvailableCommand, ContentBlock, SessionUpdate } from "@agentclientprotocol/sdk";

export const MODE_SLASH = "mode";
export const PLAN_SLASH = "plan";
export const MODEL_SLASH = "model";
export const EFFORT_SLASH = "effort";
export const SKILLS_SLASH = "skills";

/** Commands advertised to clients for typeahead / slash menus. */
export const AVAILABLE_COMMANDS: readonly AvailableCommand[] = [
  {
    name: MODE_SLASH,
    description: "Set agy execution mode for this session (default, accept-edits, plan, dangerously-skip-permissions).",
    input: { hint: "default | accept-edits | plan | dangerously-skip-permissions" }
  },
  {
    name: PLAN_SLASH,
    description: "Switch to plan mode (agy --mode plan)."
  },
  {
    name: MODEL_SLASH,
    description: "Switch the model used for this session (agy --model).",
    input: { hint: "model slug or name" }
  },
  {
    name: EFFORT_SLASH,
    description: "Set reasoning effort for the current model (agy --effort).",
    input: { hint: "low | medium | high" }
  },
  {
    name: SKILLS_SLASH,
    description: "List skills discovered by agy for this session."
  }
];

/** ACP session update listing the curated command set. */
export function availableCommandsUpdate(): SessionUpdate {
  return {
    sessionUpdate: "available_commands_update",
    availableCommands: [...AVAILABLE_COMMANDS]
  };
}

export type ParsedSlashCommand = {
  name: string;
  /** Remainder after the command name; empty string when omitted. */
  input: string;
};

/**
 * Parse a prompt that is only a single slash command (optional free-text input).
 * Returns null when the text is not a pure slash invocation (mixed content,
 * attachments already flattened into non-slash text, multi-command, etc.).
 */
export function parseSlashCommand(promptText: string): ParsedSlashCommand | null {
  const trimmed = promptText.trim();
  // Single-line only: multi-line prompts are treated as ordinary user text.
  if (!trimmed || /[\r\n]/.test(trimmed)) return null;
  const match = /^\/([A-Za-z][\w-]*)(?:\s+(\S[\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  return {
    name: match[1].toLowerCase(),
    input: (match[2] ?? "").trim()
  };
}

/**
 * True when the client's original ContentBlocks are a pure text slash command
 * (exactly one non-empty text block, no images/resources/links).
 *
 * Slash interception must not fire on flattened resource bodies that merely
 * contain text like `/plan` — those should be forwarded to agy as normal
 * prompt content.
 */
export function isClientTextSlashPrompt(blocks: ContentBlock[]): boolean {
  let textBlock: Extract<ContentBlock, { type: "text" }> | undefined;
  for (const block of blocks) {
    if (block.type === "text") {
      if (block.text.trim().length === 0) continue;
      if (textBlock) return false;
      textBlock = block;
      continue;
    }
    // Any non-text block means this is not a client slash-menu selection.
    return false;
  }
  return textBlock !== undefined;
}

export type SlashConfigAction = {
  kind: "set_config";
  configId: "mode" | "model" | "reasoningEffort";
  value: string;
};

export type SlashInterpretResult =
  | { kind: "pass" }
  | { kind: "error"; message: string }
  | SlashConfigAction;

/**
 * Map a parsed slash command onto an ACP config change, or pass through to agy.
 * Model value resolution (slug / display name) is done by the caller with the
 * live catalog — this only validates structure for mode/effort and packages
 * the raw model input.
 */
export function interpretSlashCommand(parsed: ParsedSlashCommand): SlashInterpretResult {
  switch (parsed.name) {
    case PLAN_SLASH:
      if (parsed.input) {
        return { kind: "error", message: "/plan does not take arguments; use /mode plan or omit the input." };
      }
      return { kind: "set_config", configId: "mode", value: "plan" };

    case MODE_SLASH: {
      if (!parsed.input) {
        return {
          kind: "error",
          message: "Usage: /mode default | accept-edits | plan | dangerously-skip-permissions"
        };
      }
      const value = normalizeModeInput(parsed.input);
      if (!value) {
        return {
          kind: "error",
          message: `Unknown mode "${parsed.input}". Use: default | accept-edits | plan | dangerously-skip-permissions`
        };
      }
      return { kind: "set_config", configId: "mode", value };
    }

    case MODEL_SLASH: {
      if (!parsed.input) {
        return { kind: "error", message: "Usage: /model <slug or name>" };
      }
      return { kind: "set_config", configId: "model", value: parsed.input };
    }

    case EFFORT_SLASH: {
      if (!parsed.input) {
        return { kind: "error", message: "Usage: /effort low | medium | high" };
      }
      const value = normalizeEffortInput(parsed.input);
      if (!value) {
        return {
          kind: "error",
          message: `Unknown effort "${parsed.input}". Use: low | medium | high`
        };
      }
      return { kind: "set_config", configId: "reasoningEffort", value };
    }

    default:
      // Not in our curated set — leave as ordinary prompt text for agy.
      return { kind: "pass" };
  }
}

function normalizeModeInput(raw: string): string | null {
  const key = raw.trim().toLowerCase().replace(/_/g, "-");
  if (key === "default" || key === "accept-edits" || key === "plan" || key === "dangerously-skip-permissions") return key;
  // Common aliases
  if (key === "acceptedits" || key === "accept" || key === "auto") return "accept-edits";
  if (key === "planning") return "plan";
  if (
    key === "dangerouslyskippermissions" ||
    key === "skip-permissions" ||
    key === "skippermissions" ||
    key === "bypass" ||
    key === "dangerous" ||
    key === "yolo"
  ) return "dangerously-skip-permissions";
  return null;
}

function normalizeEffortInput(raw: string): string | null {
  const key = raw.trim().toLowerCase();
  if (key === "low" || key === "medium" || key === "high" || key === "none") return key;
  if (key === "med") return "medium";
  return null;
}

/**
 * Resolve a free-text model request against the session catalog.
 * Accepts ACP base slug, display name, or legacy agy base name (case-insensitive).
 */
export function resolveModelValue(
  raw: string,
  catalog: {
    baseModels(): string[];
    displayName(slug: string): string;
    slugForAgyBase?(agyBase: string): string | undefined;
  }
): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const bases = catalog.baseModels();
  if (bases.includes(trimmed)) return trimmed;

  const lower = trimmed.toLowerCase();
  for (const slug of bases) {
    if (slug.toLowerCase() === lower) return slug;
    if (catalog.displayName(slug).toLowerCase() === lower) return slug;
  }

  const fromLegacy = catalog.slugForAgyBase?.(trimmed);
  if (fromLegacy && bases.includes(fromLegacy)) return fromLegacy;

  // Prefix / contains match when unique
  const prefix = bases.filter(
    (slug) =>
      slug.toLowerCase().startsWith(lower) ||
      catalog.displayName(slug).toLowerCase().startsWith(lower)
  );
  if (prefix.length === 1) return prefix[0];

  return null;
}
