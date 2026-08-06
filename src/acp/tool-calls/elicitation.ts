import * as v1 from "@agentclientprotocol/sdk";
import type { AgentContext as V1AgentContext, SessionUpdate } from "@agentclientprotocol/sdk";
import * as v2 from "@agentclientprotocol/sdk/experimental/v2";
import type { AgentContext as V2AgentContext } from "@agentclientprotocol/sdk/experimental/v2";
import { parseAskQuestion } from "./permissions.js";

export interface ClientElicitationCapability {
  form: boolean;
  url: boolean;
}

/** Send `elicitation/complete` notification to v1 client when a URL elicitation completes. */
export async function notifyElicitationCompleteV1(
  client: V1AgentContext,
  elicitationId: string
): Promise<void> {
  await client.notify(v1.methods.client.elicitation.complete, { elicitationId });
}

/** Send `elicitation/complete` notification to v2 client when a URL elicitation completes. */
export async function notifyElicitationCompleteV2(
  client: V2AgentContext,
  elicitationId: string
): Promise<void> {
  await client.notify(v2.methods.client.elicitation.complete, { elicitationId });
}

export type ElicitationMode = "form" | "url";
export type ElicitationAction = "accept" | "decline" | "cancel" | string;

export interface ElicitationCreateRequestParams {
  sessionId?: string;
  requestId?: number | string;
  toolCallId?: string;
  mode: ElicitationMode;
  message: string;
  requestedSchema?: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  elicitationId?: string;
  url?: string;
}

export interface ElicitationCreateResponseResult {
  action: ElicitationAction;
  content?: Record<string, unknown>;
}

export interface ElicitationCompleteNotificationParams {
  elicitationId: string;
}

export interface AskQuestionItem {
  question: string;
  options: string[];
  multiSelect: boolean;
}

export interface AskQuestionPayloadFull {
  question: string;
  items: AskQuestionItem[];
  questionCount: number;
}

function sanitizePtyText(value: unknown): string {
  return String(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function toolRawInput(toolCall: SessionUpdate): Record<string, unknown> {
  const raw = toolCall as unknown as Record<string, unknown>;
  return raw.rawInput && typeof raw.rawInput === "object" && !Array.isArray(raw.rawInput)
    ? (raw.rawInput as Record<string, unknown>)
    : {};
}

function pickString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** Parse all questions inside ask_question toolCall payload. */
export function parseAskQuestionFull(toolCall: SessionUpdate): AskQuestionPayloadFull | null {
  const input = toolRawInput(toolCall);
  const questionsRaw = input.questions ?? input.Questions;
  const questionsList = Array.isArray(questionsRaw) ? questionsRaw : [];
  if (questionsList.length === 0) {
    const fallback = parseAskQuestion(toolCall);
    if (!fallback) return null;
    return {
      question: fallback.question,
      questionCount: fallback.questionCount,
      items: [
        {
          question: fallback.question,
          options: fallback.options,
          multiSelect: fallback.multiSelect
        }
      ]
    };
  }

  const items: AskQuestionItem[] = [];
  for (const entryRaw of questionsList) {
    if (!entryRaw || typeof entryRaw !== "object" || Array.isArray(entryRaw)) continue;
    const entry = entryRaw as Record<string, unknown>;
    const question =
      pickString(entry, "question", "Question") ??
      String((toolCall as unknown as { title?: unknown }).title ?? "Question");
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
    items.push({ question, options, multiSelect });
  }

  if (items.length === 0) return null;

  return {
    question: items[0].question,
    questionCount: items.length,
    items
  };
}

/** Build elicitation/create params for an ask_question tool call. */
/** Build elicitation/create params for an ask_question tool call. */
export function buildElicitationRequestFromAskQuestion(
  toolCall: SessionUpdate,
  sessionId: string,
  questionIndex = 0
): ElicitationCreateRequestParams | null {
  const parsed = parseAskQuestionFull(toolCall);
  if (!parsed || parsed.items.length === 0) return null;

  const raw = toolCall as unknown as Record<string, unknown>;
  const toolCallId = typeof raw.toolCallId === "string" ? raw.toolCallId : undefined;

  const qIdx = questionIndex >= 0 && questionIndex < parsed.items.length ? questionIndex : 0;
  const item = parsed.items[qIdx];
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  const key = `q${qIdx}`;
  required.push(key);

  if (item.options.length > 0 && !item.multiSelect) {
    properties[key] = {
      type: "string",
      title: item.question,
      oneOf: item.options.map((opt) => ({ const: opt, title: opt }))
    };
  } else if (item.options.length > 0 && item.multiSelect) {
    properties[key] = {
      type: "array",
      title: item.question,
      items: {
        anyOf: item.options.map((opt) => ({ const: opt, title: opt }))
      }
    };
  } else {
    // Free-text input
    properties[key] = {
      type: "string",
      title: item.question
    };
  }

  const message =
    parsed.items.length > 1
      ? `[Question ${qIdx + 1}/${parsed.items.length}] ${item.question}`
      : item.question;

  return {
    sessionId,
    toolCallId,
    mode: "form",
    message,
    requestedSchema: {
      type: "object",
      properties,
      required
    }
  };
}

/** Convert user elicitation submission into PTY keys for ask_question. */
export function encodeElicitationKeys(
  toolCall: SessionUpdate,
  content?: Record<string, unknown>,
  questionIndex = 0
): string | null {
  if (!content) return "\x1b";

  const parsed = parseAskQuestionFull(toolCall);
  if (!parsed || parsed.items.length === 0) return null;

  const qIdx = questionIndex >= 0 && questionIndex < parsed.items.length ? questionIndex : 0;
  const item = parsed.items[qIdx];
  const key = `q${qIdx}`;
  const val = content[key] ?? content[item.question] ?? content["q0"] ?? content["q"];

  if (val == null) return "\x1b";

  if (item.options.length > 0 && !item.multiSelect) {
    const strVal = sanitizePtyText(val).trim();
    let index = item.options.findIndex((opt) => opt === strVal);
    if (index === -1) {
      const num = Number(strVal);
      if (!isNaN(num) && num >= 0 && num < item.options.length) {
        index = num;
      }
    }
    if (index >= 0) {
      return `${"\x1b[B".repeat(index)}\r`;
    } else {
      return `${strVal}\r`;
    }
  } else if (item.options.length > 0 && item.multiSelect) {
    const selected = Array.isArray(val) ? val.map(String) : [String(val)];
    const selectedIndices = new Set<number>();
    for (const sel of selected) {
      const idx = item.options.findIndex((opt) => opt === sel.trim());
      if (idx >= 0) selectedIndices.add(idx);
      else {
        const num = Number(sel);
        if (!isNaN(num) && num >= 0 && num < item.options.length) {
          selectedIndices.add(num);
        }
      }
    }

    if (selectedIndices.size === 0) {
      return "\r";
    } else {
      let keys = "";
      const maxIdx = Math.max(...selectedIndices);
      for (let k = 0; k <= maxIdx; k++) {
        if (selectedIndices.has(k)) {
          keys += " ";
        }
        if (k < maxIdx) {
          keys += "\x1b[B";
        }
      }
      keys += "\r";
      return keys;
    }
  } else {
    const textVal = sanitizePtyText(val);
    return `${textVal}\r`;
  }
}
