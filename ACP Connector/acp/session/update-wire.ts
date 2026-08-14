// `session/update` payload wire mapping (v1-shaped builders → v1 wire / draft
// v2). Distinct from update.ts, which owns the actual `client.notify(...)`
// call sites for out-of-band updates (mode/config/available-commands) — this
// file only shapes the payload for any given update, including the ones
// streamed from the agy db layer during a prompt turn.
// Docs: https://agentclientprotocol.com/protocol/v1/prompt-turn
//
// The agy db layer emits v1-shaped updates (with required messageIds on message
// chunks). v1 clients receive them as-is; v2 clients get the draft-v2 mapping
// (tool_call → tool_call_update, structured diffs, cancelled status, agent-owned
// terminals for execute tools, etc.).

import type { SessionUpdate as V1SessionUpdate } from "@agentclientprotocol/sdk";
import type { SessionUpdate as V2SessionUpdate } from "@agentclientprotocol/sdk/experimental/v2";
import { asRecord, executeTerminalMeta, terminalUpdateForExecute } from "../terminal/index.js";
import type { ClientToolCallNameCapability } from "../initialize.js";

export interface WireTransformOptions {
  clientToolCallName?: ClientToolCallNameCapability;
  allowToolCallName?: boolean;
}

/** Absolute-path friendly git_patch text for a single-file text change. */
export function gitPatchForFile(
  path: string,
  oldText: string | null | undefined,
  newText: string
): string {
  const oldLines = (oldText ?? "").split("\n");
  const newLines = newText.split("\n");
  // Trailing empty line from split of empty string is fine for the line counts.
  if (oldText == null || oldText === "") {
    const body = newLines.map((line) => `+${line}`).join("\n");
    return [
      `diff --git ${path} ${path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ ${path}`,
      `@@ -0,0 +1,${Math.max(newLines.length, 1)} @@`,
      body
    ].join("\n");
  }

  const body = [
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`)
  ].join("\n");
  return [
    `diff --git ${path} ${path}`,
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -1,${Math.max(oldLines.length, 1)} +1,${Math.max(newLines.length, 1)} @@`,
    body
  ].join("\n");
}

function toolContentToV2(item: Record<string, unknown>): Record<string, unknown> {
  const clean = cleanContentItem(item) as Record<string, unknown>;
  if (clean.type !== "diff") {
    return clean;
  }

  const path = typeof item.path === "string" ? item.path : "";
  const oldText = (item.oldText as string | null | undefined) ?? null;
  const newText = typeof item.newText === "string" ? item.newText : "";
  const operation = oldText == null || oldText === "" ? "add" : "modify";

  return {
    type: "diff",
    changes: [
      {
        operation,
        path,
        fileType: "text"
      }
    ],
    patch: path
      ? {
          format: "git_patch",
          text: gitPatchForFile(path, oldText, newText)
        }
      : null
  };
}

function mapToolStatusForV2(status: unknown): unknown {
  return status;
}

function mapToolStatusForV1(status: unknown): unknown {
  // v1 has no `cancelled` tool-call status.
  return status === "cancelled" ? "failed" : status;
}

function withTerminalContent(
  content: unknown,
  terminalId: string,
  status?: string
): Record<string, unknown>[] {
  const items = Array.isArray(content)
    ? (content.map((item) =>
        item && typeof item === "object"
          ? toolContentToV2(item as Record<string, unknown>)
          : item
      ) as Record<string, unknown>[])
    : [];

  const nonTerminalItems = items.filter((item) => item?.type !== "terminal");

  // Terminal content blocks are display-only embeds for active executions.
  // Once execution completes, fails, or cancels (or before it starts in pending),
  // drop the terminal block so clients like Zed that evict finished terminals
  // don't throw "Terminal with id ... not found" errors when processing tool_call_update.
  if (status === "in_progress") {
    return [{ type: "terminal", terminalId }, ...nonTerminalItems];
  }

  return nonTerminalItems;
}

function cleanContentItem(item: unknown): unknown {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const rec = { ...(item as Record<string, unknown>) };
    delete rec.kind;
    return rec;
  }
  return item;
}

export type TerminalOutputTracker = Map<string, string>;
export type ToolCallContentTracker = Map<string, number>;

const MAX_TERMINAL_TRACKER_SIZE = 500;

export function createTerminalOutputTracker(): TerminalOutputTracker {
  return new Map<string, string>();
}

export function createToolCallContentTracker(): ToolCallContentTracker {
  return new Map<string, number>();
}

const defaultTerminalOutputTracker = createTerminalOutputTracker();
const defaultV2TerminalOutputTracker = createTerminalOutputTracker();
const defaultToolCallContentTracker = createToolCallContentTracker();

export function resetTerminalOutputTracker(): void {
  defaultTerminalOutputTracker.clear();
  defaultV2TerminalOutputTracker.clear();
  defaultToolCallContentTracker.clear();
}

function setTrackedOutput(
  tracker: TerminalOutputTracker,
  terminalId: string,
  output: string
): void {
  if (!tracker.has(terminalId) && tracker.size >= MAX_TERMINAL_TRACKER_SIZE) {
    const oldestKey = tracker.keys().next().value;
    if (oldestKey !== undefined) {
      tracker.delete(oldestKey);
    }
  }
  tracker.set(terminalId, output);
}

function setTrackedToolContentCount(
  tracker: ToolCallContentTracker,
  toolCallId: string,
  count: number
): void {
  if (!tracker.has(toolCallId) && tracker.size >= MAX_TERMINAL_TRACKER_SIZE) {
    const oldestKey = tracker.keys().next().value;
    if (oldestKey !== undefined) {
      tracker.delete(oldestKey);
    }
  }
  tracker.set(toolCallId, count);
}

/** Identity cast for the v1 wire format (builders already emit v1 shapes). */
export function sessionUpdateToV1(
  update: V1SessionUpdate,
  tracker: TerminalOutputTracker = defaultTerminalOutputTracker,
  options?: WireTransformOptions
): V1SessionUpdate {
  const raw = update as unknown as Record<string, unknown>;
  if (raw.sessionUpdate === "tool_call" || raw.sessionUpdate === "tool_call_update") {
    const allowName = options?.allowToolCallName ?? (options?.clientToolCallName ? options.clientToolCallName.name === true : true);
    const v1Update: Record<string, unknown> = {
      ...raw,
      status: mapToolStatusForV1(raw.status)
    };
    if (!allowName) {
      delete v1Update.name;
    }

    if (Array.isArray(v1Update.content)) {
      v1Update.content = v1Update.content.map(cleanContentItem);
    }

    // Attach v1 terminal metadata (_meta.terminal_info/output/exit) for execute tool calls
    // so ACP v1 clients (like Zed) can render terminal output panels.
    // Docs: https://agentclientprotocol.com/protocol/v1/terminals
    if (raw.kind === "execute") {
      const meta = executeTerminalMeta(update);
      if (meta) {
        const metaObj: Record<string, unknown> = {
          ...(raw._meta as Record<string, unknown> ?? {})
        };
        metaObj.terminal_info = { terminal_id: meta.terminalId };
        if (meta.output != null && meta.output.length > 0) {
          const previousOutput = tracker.get(meta.terminalId) ?? "";
          if (meta.output.startsWith(previousOutput) && meta.output.length > previousOutput.length) {
            const newChunk = meta.output.slice(previousOutput.length);
            metaObj.terminal_output = { data: Buffer.from(newChunk, "utf8").toString("base64") };
            setTrackedOutput(tracker, meta.terminalId, meta.output);
          } else if (meta.output !== previousOutput) {
            // terminal_output in ACP v1 is append-only. Do not append a reset snapshot
            // to an existing terminal stream; track the replacement for future chunks.
            setTrackedOutput(tracker, meta.terminalId, meta.output);
          }
        }
        const finished =
          meta.status === "completed" ||
          meta.status === "failed" ||
          meta.status === "cancelled";
        if (finished) {
          tracker.delete(meta.terminalId);
          const terminalExit: Record<string, unknown> = {};
          if (typeof meta.exitCode === "number") {
            terminalExit.exit_code = meta.exitCode;
          } else if (meta.status === "cancelled") {
            terminalExit.signal = "SIGINT";
            terminalExit.exit_code = 130;
          } else {
            terminalExit.exit_code = meta.status === "failed" ? 1 : 0;
          }
          metaObj.terminal_exit = terminalExit;
        } else if (typeof meta.exitCode === "number") {
          metaObj.terminal_exit = { exit_code: meta.exitCode };
        }
        v1Update._meta = metaObj;
      }
    }

    return v1Update as V1SessionUpdate;
  }
  // Drop agent-private plan _meta keys from the v1 wire (entries stay).
  if (raw.sessionUpdate === "plan" && raw._meta && typeof raw._meta === "object") {
    const { _meta: _drop, ...rest } = raw;
    return rest as V1SessionUpdate;
  }
  // plan_removed is v2-only; v1 clients don't support it.
  // Translate to an empty plan update so v1 clients clear their plan UI.
  if (raw.sessionUpdate === "plan_removed") {
    return {
      sessionUpdate: "plan",
      entries: []
    } as V1SessionUpdate;
  }
  return update;
}

/**
 * Map a builder-emitted (v1-shaped) update onto a single draft ACP v2 update.
 * Prefer {@link expandSessionUpdateToV2} on the wire — execute tools also emit
 * a sibling `terminal_update`.
 */
export function sessionUpdateToV2(
  update: V1SessionUpdate,
  options?: WireTransformOptions
): V2SessionUpdate {
  const raw = { ...(update as unknown as Record<string, unknown>) };
  const allowName = options?.allowToolCallName ?? (options?.clientToolCallName ? options.clientToolCallName.name === true : true);
  if (!allowName) {
    delete raw.name;
  }

  if (raw.sessionUpdate === "tool_call") {
    raw.sessionUpdate = "tool_call_update";
    raw.status = mapToolStatusForV2(raw.status);
    if (Array.isArray(raw.content)) {
      raw.content = raw.content.map((item) =>
        item && typeof item === "object"
          ? toolContentToV2(item as Record<string, unknown>)
          : item
      );
    }
    return raw as V2SessionUpdate;
  }

  if (
    raw.sessionUpdate === "agent_message_chunk" ||
    raw.sessionUpdate === "user_message_chunk" ||
    raw.sessionUpdate === "agent_thought_chunk"
  ) {
    if (typeof raw.messageId !== "string" || raw.messageId.length === 0) {
      raw.messageId = "msg_unknown";
    }
    return raw as V2SessionUpdate;
  }

  if (raw.sessionUpdate === "tool_call_update" && Array.isArray(raw.content)) {
    raw.content = raw.content.map((item) =>
      item && typeof item === "object"
        ? toolContentToV2(item as Record<string, unknown>)
        : item
    );
    return raw as V2SessionUpdate;
  }

  // Classic v1 `plan` / `plan_update` → draft v2 `plan_update` with structured items or markdown.
  // Prefer markdown content when the translator stashed it in _meta.
  if (raw.sessionUpdate === "plan" || (raw.sessionUpdate === "plan_update" && !raw.plan)) {
    return planToV2(raw);
  }

  if (raw.sessionUpdate === "plan_removed") {
    const meta = asRecord(raw._meta);
    const planId =
      (typeof raw.planId === "string" && raw.planId) ||
      (typeof meta?.["agy-acp/planId"] === "string" && meta["agy-acp/planId"]) ||
      "agy-plan";
    return {
      sessionUpdate: "plan_removed",
      planId
    } as V2SessionUpdate;
  }

  return raw as V2SessionUpdate;
}

function planToV2(raw: Record<string, unknown>): V2SessionUpdate {
  const meta = asRecord(raw._meta);
  const planId =
    (typeof meta?.["agy-acp/planId"] === "string" && meta["agy-acp/planId"]) ||
    (typeof meta?.["agy-acp/planPath"] === "string" && `file:${meta["agy-acp/planPath"]}`) ||
    "agy-plan";
  const markdown =
    typeof meta?.["agy-acp/planMarkdown"] === "string" ? meta["agy-acp/planMarkdown"] : null;
  const entries = Array.isArray(raw.entries) ? raw.entries : [];

  // When structured entries with IDs are available, emit the schema-defined
  // `items` variant so v2 clients receive entry IDs.
  if (entries.length > 0) {
    return {
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId,
        entries
      }
    } as V2SessionUpdate;
  }

  // Fall back to markdown variant when no structured entries exist.
  if (markdown !== null && markdown.length > 0) {
    return {
      sessionUpdate: "plan_update",
      plan: {
        type: "markdown",
        planId,
        content: markdown
      }
    } as V2SessionUpdate;
  }

  return {
    sessionUpdate: "plan_update",
    plan: {
      type: "items",
      planId,
      entries
    }
  } as V2SessionUpdate;
}

/**
 * Expand one v1-shaped update into one or more v2 session updates.
 * Execute tools produce `terminal_update`, optional `terminal_output_chunk`,
 * and `tool_call_update` with a display-only `{ type: "terminal", terminalId }`
 * content block. Progressive tool call updates emit `tool_call_content_chunk`.
 */
export function expandSessionUpdateToV2(
  update: V1SessionUpdate,
  terminalTracker: TerminalOutputTracker = defaultV2TerminalOutputTracker,
  toolContentTracker: ToolCallContentTracker = defaultToolCallContentTracker,
  options?: WireTransformOptions
): V2SessionUpdate[] {
  const meta = executeTerminalMeta(update);

  if (!meta) {
    const v2Update = sessionUpdateToV2(update, options);
    return processV2ToolContentChunks(v2Update, toolContentTracker);
  }

  const previousOutput = terminalTracker.get(meta.terminalId) ?? "";
  let terminalChunk: V2SessionUpdate | null = null;
  if (
    meta.output != null &&
    meta.output.startsWith(previousOutput) &&
    meta.output.length > previousOutput.length
  ) {
    const newChunk = meta.output.slice(previousOutput.length);
    setTrackedOutput(terminalTracker, meta.terminalId, meta.output);
    terminalChunk = {
      sessionUpdate: "terminal_output_chunk",
      terminalId: meta.terminalId,
      data: Buffer.from(newChunk, "utf8").toString("base64")
    } as V2SessionUpdate;
  } else if (meta.output != null && meta.output !== previousOutput) {
    setTrackedOutput(terminalTracker, meta.terminalId, meta.output);
  }

  const finished =
    meta.status === "completed" ||
    meta.status === "failed" ||
    meta.status === "cancelled";

  const tool = sessionUpdateToV2(update, options) as unknown as Record<string, unknown>;
  tool.content = withTerminalContent(tool.content, meta.terminalId, meta.status);
  const toolV2Updates = processV2ToolContentChunks(tool as V2SessionUpdate, toolContentTracker);

  const hasExitStatus = finished || typeof meta.exitCode === "number";
  const updates: V2SessionUpdate[] = [];

  if (terminalChunk && hasExitStatus) {
    // When newly observed terminal output arrives at process completion,
    // emit start metadata first, then the output chunk, then exitStatus.
    // This prevents clients from evicting/closing the terminal before reading the chunk.
    const startTerminalUpdate = terminalUpdateForExecute(meta, {
      includeOutput: false,
      includeExitStatus: false
    });
    const exitTerminalUpdate = terminalUpdateForExecute(meta, {
      includeOutput: false,
      includeExitStatus: true
    });
    updates.push(startTerminalUpdate);
    updates.push(terminalChunk);
    updates.push(exitTerminalUpdate);
  } else {
    const terminalUpdate = terminalUpdateForExecute(meta, { includeOutput: !terminalChunk });
    updates.push(terminalUpdate);
    if (terminalChunk) {
      updates.push(terminalChunk);
    }
  }

  updates.push(...toolV2Updates);

  return updates;
}

function processV2ToolContentChunks(
  v2Update: V2SessionUpdate,
  toolContentTracker: ToolCallContentTracker
): V2SessionUpdate[] {
  const raw = v2Update as unknown as Record<string, unknown>;
  if (
    raw.sessionUpdate !== "tool_call_update" ||
    typeof raw.toolCallId !== "string" ||
    !raw.toolCallId
  ) {
    return [v2Update];
  }

  const toolCallId = raw.toolCallId;
  const contentItems = Array.isArray(raw.content)
    ? (raw.content as Record<string, unknown>[])
    : [];

  const finished =
    raw.status === "completed" ||
    raw.status === "failed" ||
    raw.status === "cancelled";

  if (!toolContentTracker.has(toolCallId)) {
    setTrackedToolContentCount(toolContentTracker, toolCallId, contentItems.length);
    if (finished) {
      toolContentTracker.delete(toolCallId);
    }
    return [v2Update];
  }

  const prevCount = toolContentTracker.get(toolCallId)!;
  const updates: V2SessionUpdate[] = [];
  if (contentItems.length > prevCount) {
    for (let i = prevCount; i < contentItems.length; i++) {
      updates.push({
        sessionUpdate: "tool_call_content_chunk",
        toolCallId,
        content: contentItems[i]
      } as V2SessionUpdate);
    }
    setTrackedToolContentCount(toolContentTracker, toolCallId, contentItems.length);
  }

  if (finished) {
    toolContentTracker.delete(toolCallId);
  }

  updates.push(v2Update);
  return updates;
}
