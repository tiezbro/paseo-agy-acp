// Translates a single decoded conversation step into an ACP `session/update`.
// Non-tool step types (agent text, titles, lifecycle markers, user prompts) are
// handled directly here; tool-run steps are routed by tool name to a builder in
// tool-call-updates.ts.

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import {
  decodedToolName,
  editUpdate,
  executeUpdate,
  fetchUpdate,
  isThoughtToolName,
  otherUpdate,
  questionUpdate,
  readUpdate,
  searchUpdate,
  subagentUpdate,
  thoughtUpdate,
  type UpdateContext
} from "./tool-call-updates.js";
import type { StepRow } from "./types.js";
import { isSystemMessage } from "./system-message.js";

export type { UpdateContext } from "./tool-call-updates.js";

/**
 * Step types recorded by agy for its own bookkeeping, with no user-facing ACP
 * representation:
 *   90  ephemeral_message    — system reminders injected into model context
 *   98  conversation_history — prior-conversation summaries injected as context
 *   101 stop_hook            — termination/auto-proceed decisions
 */
const LIFECYCLE_STEP_TYPES = new Set<number>([90, 98, 101]);

function isFinalQuotaExhaustion(stepRow: StepRow): boolean {
  if (stepRow.status !== 3 && stepRow.status !== 6 && stepRow.status !== 7) return false;

  const providerError = stepRow.stepPayload.modelProviderError;
  if (!providerError) return false;

  const summary = providerError.summary.trim();
  const userMessage = providerError.userMessage.trim();
  if (!summary || userMessage !== summary) return false;

  try {
    const parsed = JSON.parse(providerError.responseJson) as {
      error?: {
        code?: unknown;
        status?: unknown;
        details?: Array<{ reason?: unknown }>;
      };
    };
    return (
      parsed.error?.code === 429 &&
      parsed.error.status === "RESOURCE_EXHAUSTED" &&
      parsed.error.details?.some((detail) => detail.reason === "QUOTA_EXHAUSTED") === true
    );
  } catch {
    return false;
  }
}

function quotaExhaustionUpdate(stepRow: StepRow): SessionUpdate | null {
  if (!isFinalQuotaExhaustion(stepRow)) return null;
  return {
    sessionUpdate: "agent_message_chunk",
    messageId: `provider-error-${stepRow.idx}`,
    content: {
      type: "text",
      text: stepRow.stepPayload.modelProviderError!.userMessage.trim()
    }
  };
}

/** Step type 15 — a chunk of the agent's streamed text message (+ optional thought). */
function agentUpdate(stepRow: StepRow): SessionUpdate | SessionUpdate[] | null {
  const text = stepRow.stepPayload.agentText?.text ?? "";
  const thought = stepRow.stepPayload.agentText?.thought;

  const hasText = text.length > 0 && !isSystemMessage(text);

  if (thought) {
    const updates: SessionUpdate[] = [
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: thought },
        messageId: `agent-thought-${stepRow.idx}`
      }
    ];
    if (hasText) {
      updates.push({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
        messageId: String(stepRow.idx)
      });
    }
    return updates;
  }

  if (!hasText) return null;

  return {
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text },
    messageId: String(stepRow.idx)
  };
}

/**
 * Step type 23 — the conversation's title was (re)generated. agy packs an
 * optional "Think" narration after the title, separated by a blank line.
 * (Streaming/replay also handle type 23 in Translator.handleTitle; this path
 * remains for direct callers of sessionUpdateFromStep.)
 */
function titleUpdate(stepRow: StepRow): SessionUpdate[] {
  const title = stepRow.stepPayload.titleUpdate?.title || null;
  const parts = title?.split("\n\n");
  const currentTitle = parts?.shift() || null;

  const updates: SessionUpdate[] = [{ sessionUpdate: "session_info_update", title: currentTitle }];

  const narration = parts?.filter((p) => p.trim().length > 0);
  if (!narration || narration.length === 0) return updates;

  updates.push({
    sessionUpdate: "agent_thought_chunk",
    messageId: `title-thought-${stepRow.idx}`,
    content: { type: "text", text: narration.join("\n\n") }
  });
  return updates;
}

/**
 * Step type 14 — the user's prompt/input that opened a turn.
 *
 * Live encoding (`contentBlocksToPrompt`) forwards client text/URI/body only
 * plus agy `@path` image transport — no adapter framing prose. Older tagged
 * envelopes (`<user_text>`, `<resource_link>`, `<embedded_resource>`) wrapped
 * EVERY block of the prompt, so a historical row consists solely of envelope
 * tags joined by newlines. Only unwrap when the envelopes cover the entire
 * text; a raw prompt that merely quotes a legacy-looking tag among other
 * prose must replay verbatim instead of being shredded into resource blocks
 * with the surrounding text discarded.
 */
function userPromptUpdate(stepRow: StepRow): SessionUpdate[] {
  const up = stepRow.stepPayload.userPrompt;
  const rawText = up?.text || up?.content?.text || "";
  const text = rawText.trim();

  const blockPattern =
    /<user_text>\n([\s\S]*?)\n<\/user_text>|<resource_link uri="(.*?)" title="(.*?)"\/>|<embedded_resource uri="(.*?)">\n([\s\S]*?)\n<\/embedded_resource>/g;

  const matches = [...text.matchAll(blockPattern)];
  const isLegacyEnvelope = matches.length > 0 && text.replace(blockPattern, "").trim().length === 0;

  const blocks: Record<string, unknown>[] = [];
  if (isLegacyEnvelope) {
    for (const match of matches) {
      if (match[1] !== undefined) {
        blocks.push({ type: "text", text: match[1] });
      } else if (match[2] !== undefined) {
        const uri = match[2].replace(/&quot;/g, '"');
        const title = (match[3] || "").replace(/&quot;/g, '"');
        blocks.push({ type: "resource_link", uri, name: title, title });
      } else if (match[4] !== undefined) {
        blocks.push({
          type: "resource",
          resource: { uri: match[4].replace(/&quot;/g, '"'), text: match[5] || "" }
        });
      }
    }
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: rawText });

  return blocks.map((content) => ({ sessionUpdate: "user_message_chunk", content, messageId: String(stepRow.idx) })) as SessionUpdate[];
}

/** Route a tool step to its builder by tool name (used for step type 17, which
 *  mixes view_file/run_command/edits/artifact wrappers under one type, and as
 *  the fallback for any other unrecognized step type). Returns null when the
 *  step carries no actual tool call (e.g. type-17 artifact progress wrappers
 *  have a tool-run header but no `call`), so we don't emit empty tool_calls. */
function buildByToolName(stepRow: StepRow, ctx?: UpdateContext): SessionUpdate | SessionUpdate[] | null {
  const name = decodedToolName(stepRow);
  if (!name) return null;

  if (isThoughtToolName(name)) return thoughtUpdate(stepRow);
  if (name === "view_file" || name === "list_dir") return readUpdate(stepRow, ctx);
  if (name === "grep_search" || name === "search_web") return searchUpdate(stepRow, ctx);
  if (name === "run_command") return executeUpdate(stepRow);
  if (name === "read_url_content") return fetchUpdate(stepRow);
  if (name === "invoke_subagent") return subagentUpdate(stepRow);
  if (name === "ask_question") return questionUpdate(stepRow);
  if (/write|replace|edit|patch/.test(name)) return editUpdate(stepRow, ctx);
  return otherUpdate(stepRow);
}

/**
 * Translate one conversation step into an ACP update. Step-type map:
 *   14            user prompt            -> user_message_chunk
 *   15            agent text chunk       -> agent_message_chunk
 *   23            title update           -> session_info_update (+ think)
 *   5             file edit              -> tool_call (edit)
 *   17            mixed artifact tools   -> routed by tool name (or skipped)
 *   8, 9          view_file / list_dir   -> tool_call (read)
 *   7, 33         grep / web search      -> tool_call (search)
 *   21            run_command            -> tool_call (execute)
 *   31            read_url_content       -> tool_call (fetch)
 *   127           invoke_subagent        -> tool_call (other)
 *   138           ask_question           -> tool_call (other)
 *   132           orchestration tools    -> tool_call (generic fallback)
 *   90, 98, 101   lifecycle/system       -> null (skipped)
 *   default       unknown tool step      -> tool_call (generic) or null
 */
export function sessionUpdateFromStep(
  stepRow: StepRow,
  ctx?: UpdateContext
): SessionUpdate | SessionUpdate[] | null {
  switch (stepRow.stepType) {
    case 14:
      return userPromptUpdate(stepRow);
    case 15:
      return agentUpdate(stepRow);
    case 23:
      return titleUpdate(stepRow);
    case 5:
      return editUpdate(stepRow, ctx);
    case 17:
      return quotaExhaustionUpdate(stepRow) ?? buildByToolName(stepRow, ctx);
    case 8:
    case 9:
      return readUpdate(stepRow, ctx);
    case 7:
    case 33:
      return searchUpdate(stepRow, ctx);
    case 21:
      return executeUpdate(stepRow);
    case 31:
      return fetchUpdate(stepRow);
    case 127:
      return subagentUpdate(stepRow);
    case 138:
      return questionUpdate(stepRow);
    case 132:
      return otherUpdate(stepRow);
    default:
      if (LIFECYCLE_STEP_TYPES.has(stepRow.stepType)) return null;
      return buildByToolName(stepRow, ctx);
  }
}
