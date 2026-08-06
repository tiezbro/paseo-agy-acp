// ACP Tool Calls: session/request_permission option menus for agy status-9 tools.
// Docs: https://agentclientprotocol.com/protocol/v1/tool-calls

import type { SessionUpdate } from "@agentclientprotocol/sdk";

/**
 * Option ids for permission menus and ask_question.
 * Edit tools use standard ACP ids (`allow-once` / `reject-once` / `allow-always`)
 * so clients can map them to native Keep / Reject UI.
 */
export type PermissionChoice = string;

export interface PermissionMenuOption {
  optionId: PermissionChoice;
  kind: "allow_once" | "allow_always" | "reject_once";
  name: string;
}

export interface AskQuestionPrompt {
  question: string;
  options: string[];
  multiSelect: boolean;
}

export interface AskQuestionPayload {
  questions: AskQuestionPrompt[];
  questionCount: number;
  question: string;
  options: string[];
  multiSelect: boolean;
}

/**
 * Status-9 tools that can be answered through ACP `session/request_permission`
 * and PTY key injection. `ask_question` is handled separately (MCQ, not a
 * permission panel).
 */
export function isBridgeablePermissionTool(toolName: string): boolean {
  if (!toolName || toolName === "ask_question") return false;
  if (toolName === "run_command") return true;
  if (toolName === "ask_permission") return true;
  if (toolName === "manage_task") return true;
  if (toolName === "view_file" || toolName === "list_dir") return true;
  if (isEditToolName(toolName)) return true;
  return false;
}

export function isEditToolName(toolName: string): boolean {
  return Boolean(toolName) && /write|replace|edit|patch/.test(toolName);
}

/** True when an ACP tool_call update is a file edit (kind or tool name). */
export function isEditToolCall(toolCall: SessionUpdate): boolean {
  const raw = toolCall as unknown as Record<string, unknown>;
  if (raw.kind === "edit") return true;
  return false;
}

/** True when this status-9 tool can be bridged (permission menu, multi-select MCQ, or elicitation). */
export function canBridgeInteraction(
  toolName: string,
  toolCall?: SessionUpdate,
  options?: { hasElicitation?: boolean }
): boolean {
  if (isBridgeablePermissionTool(toolName)) return true;
  if (toolName !== "ask_question" || !toolCall) return false;
  if (options?.hasElicitation) return true;
  const ask = parseAskQuestion(toolCall);
  return ask != null && isBridgeableAskQuestion(ask);
}

export const MAX_BRIDGABLE_MULTI_SELECT_OPTIONS = 6;

/** ask_question is safe to bridge when it has non-empty options for all questions. */
export function isBridgeableAskQuestion(ask: AskQuestionPayload): boolean {
  return (
    ask.questionCount > 0 &&
    ask.questions.every((q) => {
      if (q.options.length === 0) return false;
      if (q.multiSelect && q.options.length > MAX_BRIDGABLE_MULTI_SELECT_OPTIONS) return false;
      return true;
    })
  );
}

/** Normalize client-selected option ids (standard ACP or legacy agy-*). */
export function normalizePermissionChoice(choice: string): PermissionChoice {
  switch (choice) {
    case "allow-once":
    case "allow_once":
      return "agy-allow-once";
    case "allow-always":
    case "allow_always":
      return "agy-allow-settings";
    case "allow-conversation":
      return "agy-allow-conversation";
    case "reject-once":
    case "reject_once":
    case "reject":
      return "agy-reject-once";
    default:
      return choice;
  }
}

export function permissionKeys(choice: PermissionChoice): string | null {
  const id = normalizePermissionChoice(choice);
  switch (id) {
    case "agy-allow-once": return "\r";
    case "agy-allow-conversation": return "\x1b[B\r";
    case "agy-allow-settings": return "\x1b[B\x1b[B\r";
    case "agy-reject-once": return "\x1b[B\x1b[B\x1b[B\r";
    default: return null;
  }
}

/**
 * Map an ACP option id to PTY keypresses for the given interaction.
 * Returns null when the choice cannot be applied safely.
 */
export function interactionKeys(
  choice: PermissionChoice,
  toolName: string,
  toolCall?: SessionUpdate,
  questionIndex = 0
): string | null {
  if (choice.startsWith("pty-keys:")) {
    return choice.slice("pty-keys:".length);
  }

  if (toolName === "ask_question") {
    if (choice === "agy-q-skip" || choice.endsWith("-skip")) return "\x1b"; // Esc — cancel / skip modal
    if (!toolCall) return null;
    const ask = parseAskQuestion(toolCall);
    if (!ask || !isBridgeableAskQuestion(ask)) return null;

    let targetQIndex = questionIndex;
    let rest = choice;

    const qMatch = /^agy-q-q(\d+)-(.*)$/.exec(choice);
    if (qMatch) {
      targetQIndex = Number(qMatch[1]);
      rest = `agy-q-${qMatch[2]}`;
    }

    if (targetQIndex < 0 || targetQIndex >= ask.questions.length) return null;
    const q = ask.questions[targetQIndex];

    const match = /^agy-q-(.*)$/.exec(rest);
    if (!match) return null;
    const spec = match[1];

    if (spec === "skip") return "\x1b";

    let selectedIndices: number[] = [];
    if (spec === "all") {
      selectedIndices = q.options.map((_, idx) => idx);
    } else if (spec === "none" || spec === "submit") {
      selectedIndices = [];
    } else {
      let rawSpec = spec;
      if (rawSpec.startsWith("ms:") || rawSpec.startsWith("select:")) {
        rawSpec = rawSpec.slice(rawSpec.indexOf(":") + 1);
      }
      const parts = rawSpec.split(/[,+]/).map((s) => s.trim()).filter(Boolean);
      for (const p of parts) {
        const num = Number(p);
        if (Number.isInteger(num) && num >= 0 && num < q.options.length) {
          selectedIndices.push(num);
        } else {
          return null;
        }
      }
    }

    if (!q.multiSelect) {
      if (selectedIndices.length !== 1) return null;
      const index = selectedIndices[0];
      return `${"\x1b[B".repeat(index)}\r`;
    } else {
      const sorted = Array.from(new Set(selectedIndices)).sort((a, b) => a - b);
      let currentPos = 0;
      let keys = "";
      for (const targetPos of sorted) {
        const moves = targetPos - currentPos;
        if (moves > 0) {
          keys += "\x1b[B".repeat(moves);
        }
        keys += " ";
        currentPos = targetPos;
      }
      keys += "\r";
      return keys;
    }
  }

  // Edit tools: map standard ACP allow/reject onto agy's 4-row menu.
  // Accept/allow-once → first row; always-allow → settings row; reject → last row.
  if (isEditToolName(toolName)) {
    const id = normalizePermissionChoice(choice);
    if (id === "agy-allow-once") return "\r";
    if (id === "agy-allow-settings") return "\x1b[B\x1b[B\r";
    if (id === "agy-allow-conversation") return "\x1b[B\r";
    if (id === "agy-reject-once") return "\x1b[B\x1b[B\x1b[B\r";
    return null;
  }

  return permissionKeys(choice);
}

function pickString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function toolRawInput(toolCall: SessionUpdate): Record<string, unknown> {
  const raw = toolCall as unknown as Record<string, unknown>;
  return raw.rawInput && typeof raw.rawInput === "object" && !Array.isArray(raw.rawInput)
    ? raw.rawInput as Record<string, unknown>
    : {};
}

/** Parse ask_question rawInput into a stable shape for bridging. */
export function parseAskQuestion(toolCall: SessionUpdate): AskQuestionPayload | null {
  const input = toolRawInput(toolCall);
  const questionsRaw = input.questions ?? input.Questions;
  const questionsList = Array.isArray(questionsRaw) ? questionsRaw : [];
  if (questionsList.length === 0) return null;

  const questions: AskQuestionPrompt[] = [];
  for (let i = 0; i < questionsList.length; i++) {
    const item = questionsList[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    let question = pickString(entry, "question", "Question") ?? "";
    if (!question && i === 0) {
      question = String((toolCall as unknown as { title?: unknown }).title ?? "Question");
    }
    const optionsRaw = entry.options ?? entry.Options;
    const optionsList = Array.isArray(optionsRaw) ? optionsRaw : [];
    const options = optionsList
      .map((opt) => {
        if (typeof opt === "string") return opt.trim();
        if (opt && typeof opt === "object" && !Array.isArray(opt)) {
          return pickString(opt as Record<string, unknown>, "label", "Label", "text", "Text", "id", "Id") ?? "";
        }
        return "";
      })
      .filter(Boolean);
    const multiSelect = Boolean(entry.is_multi_select ?? entry.isMultiSelect ?? entry.IsMultiSelect);
    questions.push({
      question,
      options,
      multiSelect
    });
  }

  if (questions.length === 0) return null;

  return {
    questions,
    questionCount: questions.length,
    question: questions[0].question,
    options: questions[0].options,
    multiSelect: questions[0].multiSelect
  };
}

/** Build ACP permission options for the given pending tool interaction. */
export function permissionOptions(
  toolCall: SessionUpdate,
  toolName?: string,
  questionIndex = 0
): PermissionMenuOption[] {
  if (toolName === "ask_question") {
    return askQuestionOptions(toolCall, questionIndex);
  }

  // agy's sandbox-bypass request (run a command / read a file outside the
  // sandbox). Its TUI menu is the same 4-row layout as run_command
  // (Yes / always-in-conversation / persist / No), so the standard
  // permissionKeys navigation applies.
  if (toolName === "ask_permission") {
    return askPermissionOptions(toolCall);
  }

  // manage_task gated actions (kill, send_input). Same 4-row TUI layout.
  if (toolName === "manage_task") {
    return manageTaskOptions(toolCall);
  }

  // File edits: standard ACP option ids/kinds so clients can render native
  // Keep / Reject (or equivalent) review UI against the tool_call diff.
  if (isEditToolName(toolName ?? "") || (toolName == null && isEditToolCall(toolCall))) {
    return standardEditPermissionOptions();
  }

  const raw = toolCall as unknown as Record<string, unknown>;
  const input = toolRawInput(toolCall);
  const command = pickString(input, "CommandLine", "commandLine", "command");
  const filePath = pickString(
    input,
    "TargetFile",
    "targetFile",
    "AbsolutePath",
    "absolutePath",
    "FilePath",
    "DirectoryPath",
    "directoryPath"
  );

  const useCommandMenu =
    toolName === "run_command" ||
    ((toolName == null || toolName === "") && Boolean(command) && !filePath);

  if (useCommandMenu) {
    const target = command ?? String(raw.title ?? "this command");
    return [
      { optionId: "agy-allow-once", kind: "allow_once", name: "Yes" },
      {
        optionId: "agy-allow-conversation",
        kind: "allow_always",
        name: `Yes, and always allow in this conversation for commands that start with '${target}'`
      },
      {
        optionId: "agy-allow-settings",
        kind: "allow_always",
        name: `Yes, and always allow for commands that start with '${target}' (Persist to settings.json)`
      },
      { optionId: "agy-reject-once", kind: "reject_once", name: "No" }
    ];
  }

  // Generic tool menus (e.g. read_file) from agy 1.1.5 TUI strings.
  const grant = permissionGrantLabel(toolName, filePath, raw.title);
  return [
    { optionId: "agy-allow-once", kind: "allow_once", name: "Yes" },
    {
      optionId: "agy-allow-conversation",
      kind: "allow_always",
      name: `Yes, and always allow '${grant}' in this conversation`
    },
    {
      optionId: "agy-allow-settings",
      kind: "allow_always",
      name: `Yes, and always allow '${grant}' (Persist to settings.json)`
    },
    { optionId: "agy-reject-once", kind: "reject_once", name: "No" }
  ];
}

/**
 * Standard ACP permission options for file edits.
 * Clients (Zed, Grok Build as ACP host, etc.) key off `kind` for Keep/Reject UI.
 * @see https://agentclientprotocol.com/protocol/v1/tool-calls#requesting-permission
 */
function standardEditPermissionOptions(): PermissionMenuOption[] {
  return [
    { optionId: "allow-once", kind: "allow_once", name: "Allow" },
    { optionId: "allow-always", kind: "allow_always", name: "Always allow" },
    { optionId: "reject-once", kind: "reject_once", name: "Reject" }
  ];
}

/**
 * Options for agy's `manage_task` gated actions (kill, send_input, etc.).
 * The TUI renders the standard 4-row permission menu, so the standard
 * permissionKeys navigation applies.
 */
function manageTaskOptions(toolCall: SessionUpdate): PermissionMenuOption[] {
  const input = toolRawInput(toolCall);
  const action = pickString(input, "Action", "action") ?? "manage";
  const taskId = pickString(input, "TaskId", "taskId");
  const target = taskId ? `manage_task ${action} (${taskId})` : `manage_task ${action}`;
  return [
    { optionId: "agy-allow-once", kind: "allow_once", name: "Yes" },
    {
      optionId: "agy-allow-conversation",
      kind: "allow_always",
      name: `Yes, and always allow '${target}' in this conversation`
    },
    {
      optionId: "agy-allow-settings",
      kind: "allow_always",
      name: `Yes, and always allow '${target}' (Persist to settings.json)`
    },
    { optionId: "agy-reject-once", kind: "reject_once", name: "No" }
  ];
}

/**
 * Options for agy's `ask_permission` sandbox-bypass request. rawInput carries
 * `Action` (e.g. `run_command` / `read_file`), `Target`, and `Reason`; the TUI
 * renders the standard 4-row permission menu, so we mirror run_command's ids.
 */
function askPermissionOptions(toolCall: SessionUpdate): PermissionMenuOption[] {
  const input = toolRawInput(toolCall);
  const raw = toolCall as unknown as Record<string, unknown>;
  const target =
    pickString(input, "Target", "target", "CommandLine", "commandLine", "command") ??
    pickString(input, "toolAction", "ToolAction") ??
    (typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "this action");
  return [
    { optionId: "agy-allow-once", kind: "allow_once", name: "Yes" },
    {
      optionId: "agy-allow-conversation",
      kind: "allow_always",
      name: `Yes, and always allow '${target}' in this conversation`
    },
    {
      optionId: "agy-allow-settings",
      kind: "allow_always",
      name: `Yes, and always allow '${target}' (Persist to settings.json)`
    },
    { optionId: "agy-reject-once", kind: "reject_once", name: "No" }
  ];
}

export function askQuestionOptions(toolCall: SessionUpdate, questionIndex = 0): PermissionMenuOption[] {
  const ask = parseAskQuestion(toolCall);
  if (!ask || !isBridgeableAskQuestion(ask)) {
    return [{ optionId: "agy-q-skip", kind: "reject_once", name: "Skip" }];
  }

  const qIndex = questionIndex >= 0 && questionIndex < ask.questions.length ? questionIndex : 0;
  const q = ask.questions[qIndex];
  if (!q || q.options.length === 0) {
    return [{ optionId: "agy-q-skip", kind: "reject_once", name: "Skip" }];
  }

  const prefix = ask.questions.length > 1 ? `agy-q-q${qIndex}-` : "agy-q-";

  if (!q.multiSelect) {
    const options: PermissionMenuOption[] = q.options.map((name, index) => ({
      optionId: `${prefix}${index}`,
      kind: "allow_once" as const,
      name
    }));
    options.push({ optionId: `${prefix}skip`, kind: "reject_once", name: "Skip" });
    return options;
  }

  const options: PermissionMenuOption[] = [];
  const n = q.options.length;

  const MAX_SUBSET_OPTIONS = 128;

  if (n <= 7) {
    const totalSubsets = 1 << n;
    for (let mask = 1; mask < totalSubsets; mask++) {
      const indices: number[] = [];
      for (let i = 0; i < n; i++) {
        if ((mask & (1 << i)) !== 0) indices.push(i);
      }
      if (indices.length === 1) {
        options.push({
          optionId: `${prefix}${indices[0]}`,
          kind: "allow_once" as const,
          name: q.options[indices[0]]
        });
      } else if (indices.length === n) {
        options.push({
          optionId: `${prefix}all`,
          kind: "allow_once" as const,
          name: `Select All (${indices.map((i) => q.options[i]).join(" + ")})`
        });
      } else {
        options.push({
          optionId: `${prefix}${indices.join(",")}`,
          kind: "allow_once" as const,
          name: indices.map((i) => q.options[i]).join(" + ")
        });
      }
    }
  } else {
    function generateCombos(start: number, combo: number[], k: number) {
      if (options.length >= MAX_SUBSET_OPTIONS - 3) return;
      if (combo.length === k) {
        const key = combo.join(",");
        if (combo.length === 1) {
          options.push({
            optionId: `${prefix}${combo[0]}`,
            kind: "allow_once" as const,
            name: q.options[combo[0]]
          });
        } else {
          options.push({
            optionId: `${prefix}${key}`,
            kind: "allow_once" as const,
            name: combo.map((i) => q.options[i]).join(" + ")
          });
        }
        return;
      }
      for (let i = start; i < n; i++) {
        combo.push(i);
        generateCombos(i + 1, combo, k);
        combo.pop();
        if (options.length >= MAX_SUBSET_OPTIONS - 3) break;
      }
    }

    for (let k = 1; k < n; k++) {
      generateCombos(0, [], k);
      if (options.length >= MAX_SUBSET_OPTIONS - 3) break;
    }

    options.push({
      optionId: `${prefix}all`,
      kind: "allow_once" as const,
      name: "Select All"
    });
  }

  options.push({
    optionId: `${prefix}none`,
    kind: "allow_once" as const,
    name: "Submit (None selected)"
  });
  options.push({ optionId: `${prefix}skip`, kind: "reject_once", name: "Skip" });
  return options;
}

/** Format the grant pattern shown in agy menus / settings.allow rules. */
function permissionGrantLabel(
  toolName: string | undefined,
  filePath: string | undefined,
  title: unknown
): string {
  const isRead = toolName === "view_file" || toolName === "list_dir";
  const kind = isRead ? "read_file" : "write_file";
  if (filePath) return `${kind}(${filePath})`;
  if (typeof title === "string" && title.trim()) return title.trim();
  return `${kind}(*)`;
}
