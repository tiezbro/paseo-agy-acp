// Shared step -> ACP update engine for both live streaming and history replay.
//
// Streaming and replay only really differ in how they treat the agent's text
// stream (step type 15):
//
//   - streaming emits the newly-appended slice each poll (text grows in place
//     at a fixed idx), keeps consecutive text rows under one message id, and
//     re-emits tool steps as `tool_call_update` when their status/content snapshot changes;
//   - replay buffers consecutive agent-text parts and flushes them as one
//     message at each boundary, applying narration filtering across the group.
//
// Everything else — tool calls, titles, user prompts — is identical, so it
// flows through the same per-step dispatcher (`sessionUpdateFromStep`).
// This class owns the one row loop; the two modes are just small branches
// inside it.

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { PlanEntry } from "../acp/agent-plan/index.js";
import { filterNarration, isNarration } from "./narration.js";
import { isSystemMessage, isSystemMessagePrefix } from "./system-message.js";
import type { FileContentCache } from "./tool-call-updates.js";
import type { StepRow } from "./types.js";
import { sessionUpdateFromStep } from "./updates.js";

export type TranslateMode = "stream" | "replay";

export interface TranslatorOptions {
  mode: TranslateMode;
  skipNarration: boolean;
  /** Project working dir, used to render display paths in tool calls. */
  cwd?: string;
}

function agentChunk(text: string, messageId: string): SessionUpdate {
  return {
    sessionUpdate: "agent_message_chunk",
    messageId,
    content: { type: "text", text }
  };
}

function thoughtChunk(text: string, messageId: string): SessionUpdate {
  return {
    sessionUpdate: "agent_thought_chunk",
    messageId,
    content: { type: "text", text }
  };
}

/** Stable signature of a tool/plan/thought update for progressive re-emission. */
function updateSnapshot(update: SessionUpdate): string {
  const raw = update as unknown as Record<string, unknown>;
  return JSON.stringify({
    sessionUpdate: raw.sessionUpdate,
    toolCallId: raw.toolCallId,
    name: raw.name,
    title: raw.title,
    kind: raw.kind,
    status: raw.status,
    content: raw.content,
    locations: raw.locations,
    rawInput: raw.rawInput,
    rawOutput: raw.rawOutput,
    messageId: raw.messageId,
    entries: raw.entries,
    plan: raw.plan,
    planId: raw.planId,
    _meta: raw._meta,
    text: raw.content && typeof raw.content === "object" ? (raw.content as { text?: string }).text : undefined
  });
}

function withStepMeta(update: SessionUpdate, stepIdx: number): SessionUpdate {
  const raw = update as unknown as Record<string, unknown>;
  const meta = (raw._meta as Record<string, unknown> | undefined) ?? {};
  if (meta.stepIdx === stepIdx) return update;
  return {
    ...raw,
    _meta: { ...meta, stepIdx }
  } as unknown as SessionUpdate;
}

function asToolCallUpdate(update: SessionUpdate): SessionUpdate {
  return {
    ...(update as object),
    sessionUpdate: "tool_call_update"
  } as SessionUpdate;
}

export class Translator {
  // Streaming: idx -> chars of agent text already emitted (for incremental diff).
  private readonly agentTextLengths = new Map<number, number>();
  // Streaming: thought messageId -> chars already emitted.
  private readonly thoughtTextLengths = new Map<string, number>();
  // Stream + replay: final provider-error messages already emitted.
  private readonly emittedProviderErrorMessageIds = new Set<string>();
  // Stream + replay: last emitted snapshot keyed by tool call id, or by plan id
  // + source row for plans (progressive lifecycle without cross-row replay).
  private readonly toolSnapshots = new Map<string, string>();
  // Stream + replay: last known file bodies from view_file / write_to_file (for diffs).
  private readonly fileContents: FileContentCache = new Map();
  // Stream + replay: previous plan entries keyed by plan id (stable entry-id reconciliation).
  private readonly planEntries: Map<string, PlanEntry[]> = new Map();
  // Candidate ACP location paths and their readability during the latest translation.
  readonly locationReadability = new Map<string, boolean>();
  // Replay: buffered consecutive agent-text parts, flushed at boundaries.
  private readonly pendingAgentParts: string[] = [];
  // Replay: message id for the current buffered agent-text group.
  private pendingAgentMessageId: string | null = null;
  private pendingAgentStartStepIdx: number | null = null;
  private pendingAgentEndStepIdx: number | null = null;

  private _lastTitle: string | null = null;
  private _lastStepIdx = -1;
  private _hadUpdates = false;

  constructor(private readonly opts: TranslatorOptions) {}

  /** Highest step idx seen so far. */
  get lastStepIdx(): number {
    return this._lastStepIdx;
  }

  /** Whether any update has been produced across all batches. */
  get hadUpdates(): boolean {
    return this._hadUpdates;
  }

  /**
   * Reset row-derived file state before replaying a complete prompt-scoped
   * snapshot. StreamPoller rereads all rows after its fixed base idx whenever
   * SQLite changes; rebuilding this cache makes oldText derivation independent
   * of the previous poll's terminal state.
   */
  resetFileContentsForFullReplay(): void {
    this.fileContents.clear();
  }

  /** Translate a batch of rows into ordered ACP updates, advancing state. */
  translate(rows: StepRow[]): SessionUpdate[] {
    const out: SessionUpdate[] = [];
    let streamingAgentMessageId: string | null = null;
    let streamingHasVisibleText = false;
    for (const [rowIndex, row] of rows.entries()) {
      let streamingNeedsSeparator = false;
      const canGrow = rowIndex === rows.length - 1 && row.status !== 3 && row.status !== 6 && row.status !== 7;
      if (this.opts.mode === "stream") {
        if (row.stepType === 15) {
          const text = row.stepPayload.agentText?.text ?? "";
          const isSysMsg = isSystemMessage(text);
          const isSysMsgPrefix = canGrow && isSystemMessagePrefix(text);
          if (text.length > 0 && !isSysMsg && !isSysMsgPrefix) streamingAgentMessageId ??= String(row.idx);
          const visible =
            text.length > 0 && !isSysMsg && !isSysMsgPrefix && !(this.opts.skipNarration && isNarration(text));
          streamingNeedsSeparator = visible && streamingHasVisibleText;
          if (visible) streamingHasVisibleText = true;
        } else {
          streamingAgentMessageId = null;
          streamingHasVisibleText = false;
        }
      }
      this.translateRow(row, out, streamingAgentMessageId, streamingNeedsSeparator, canGrow);
    }
    // Replay groups agent text per batch; a batch ends a message boundary.
    if (this.opts.mode === "replay") this.flushAgentBuffer(out);
    if (out.length > 0) this._hadUpdates = true;
    return out;
  }

  private translateRow(
    row: StepRow,
    out: SessionUpdate[],
    streamingAgentMessageId: string | null,
    streamingNeedsSeparator: boolean,
    canGrow: boolean
  ): void {
    this._lastStepIdx = Math.max(this._lastStepIdx, row.idx);

    switch (row.stepType) {
      case 15: // agent text chunk
        this.handleAgentText(row, out, streamingAgentMessageId, streamingNeedsSeparator, canGrow);
        return;

      case 23: // conversation title (+ optional think narration)
        this.handleTitle(row, out);
        return;

      case 14: // user prompt
        // The streaming client already has its own prompt; only replay re-emits it.
        if (this.opts.mode === "stream") return;
        this.flushAgentBuffer(out);
        this.pushDispatched(row, out);
        return;

      default: {
        // Tool calls and lifecycle steps. In replay, a tool call ends the
        // current agent message. In both modes, progressive status/content
        // changes re-emit as tool_call_update.
        if (this.opts.mode === "replay") {
          this.flushAgentBuffer(out);
        }
        this.pushDispatched(row, out);
      }
    }
  }

  private pushDispatched(row: StepRow, out: SessionUpdate[]): void {
    const update = sessionUpdateFromStep(row, {
      cwd: this.opts.cwd,
      fileContents: this.fileContents,
      planEntries: this.planEntries,
      locationReadability: this.locationReadability
    });
    if (Array.isArray(update)) {
      for (const item of update) this.emitProgressive(row.idx, item, out);
    } else if (update) {
      this.emitProgressive(row.idx, update, out);
    }
  }

  /**
   * Emit a tool/plan/thought update. Tools re-emit as `tool_call_update` when
   * the snapshot changes; plans re-emit as a full `plan` replacement when the
   * markdown-derived entries change. Unrelated update kinds pass through.
   */
  private emitProgressive(stepIdx: number, update: SessionUpdate, out: SessionUpdate[]): void {
    const raw = update as unknown as Record<string, unknown>;
    const kind = raw.sessionUpdate;

    if (kind === "agent_thought_chunk") {
      this.emitThought(stepIdx, update, out);
      return;
    }
    if (kind === "agent_message_chunk" && String(raw.messageId).startsWith("provider-error-")) {
      this.emitProviderError(stepIdx, update, out);
      return;
    }

    const stamped = withStepMeta(update, stepIdx);

    if (kind === "plan" || kind === "plan_update" || kind === "plan_removed") {
      const snapshot = updateSnapshot(stamped);
      const meta = raw._meta && typeof raw._meta === "object" ? (raw._meta as Record<string, unknown>) : null;
      const planId =
        (typeof raw.planId === "string" && raw.planId) ||
        (typeof meta?.["agy-acp/planId"] === "string" && (meta["agy-acp/planId"] as string)) ||
        undefined;
      // Scope dedupe to the source row: StreamPoller rereads all rows since the
      // turn began on every DB change, so a plan-level shared key would replay
      // each historical state (rollback) whenever a later row changes.
      const key = planId ? `plan:${planId}:${stepIdx}` : `plan:${stepIdx}`;
      const previous = this.toolSnapshots.get(key);
      if (previous === snapshot) return;
      this.toolSnapshots.set(key, snapshot);
      out.push(stamped);
      return;
    }

    if (kind !== "tool_call" && kind !== "tool_call_update") {
      out.push(stamped);
      return;
    }

    const snapshot = updateSnapshot(stamped);
    const toolId = typeof raw.toolCallId === "string" && raw.toolCallId.trim() ? raw.toolCallId.trim() : undefined;
    const key = toolId ? `tool:${toolId}` : `step:${stepIdx}`;
    const previous = this.toolSnapshots.get(key);
    if (previous === undefined) {
      this.toolSnapshots.set(key, snapshot);
      // First sight always uses create shape; v2 boundary may rewrite to upsert.
      out.push({ ...(stamped as object), sessionUpdate: "tool_call" } as SessionUpdate);
      return;
    }
    if (previous === snapshot) return;

    this.toolSnapshots.set(key, snapshot);
    out.push(asToolCallUpdate(stamped));
  }

  private emitThought(stepIdx: number, update: SessionUpdate, out: SessionUpdate[]): void {
    const raw = update as unknown as Record<string, unknown>;
    const content = raw.content as { type?: string; text?: string } | undefined;
    const text = typeof content?.text === "string" ? content.text : "";
    const messageId = typeof raw.messageId === "string" && raw.messageId.length > 0 ? raw.messageId : "thought";

    // Stream + replay: emit only the newly appended slice per messageId so
    // repeated polls of an unchanged thought step produce nothing.
    const emitted = this.thoughtTextLengths.get(messageId) ?? 0;
    if (text.length <= emitted) return;
    this.thoughtTextLengths.set(messageId, text.length);
    const delta = text.slice(emitted);
    if (delta.length > 0) out.push(withStepMeta(thoughtChunk(delta, messageId), stepIdx));
  }

  private emitProviderError(stepIdx: number, update: SessionUpdate, out: SessionUpdate[]): void {
    const raw = update as unknown as Record<string, unknown>;
    const content = raw.content as { type?: string; text?: string } | undefined;
    const text = typeof content?.text === "string" ? content.text : "";
    const messageId = typeof raw.messageId === "string" ? raw.messageId : `provider-error-${stepIdx}`;
    if (!text || this.emittedProviderErrorMessageIds.has(messageId)) return;
    this.emittedProviderErrorMessageIds.add(messageId);
    out.push(withStepMeta(agentChunk(text, messageId), stepIdx));
  }

  private handleTitle(row: StepRow, out: SessionUpdate[]): void {
    const title = row.stepPayload.titleUpdate?.title ?? null;
    const blocks = title?.split("\n\n");
    const currentTitle = blocks?.shift() || null;
    if (currentTitle !== this._lastTitle) {
      this._lastTitle = currentTitle;
      out.push(withStepMeta({ sessionUpdate: "session_info_update", title: currentTitle } as SessionUpdate, row.idx));
    }

    const narration = blocks?.filter((b) => b.trim().length > 0).join("\n\n") ?? "";
    if (!narration) return;

    // Title-attached "Think" narration is real agent thought, not a tool card.
    this.emitThought(row.idx, thoughtChunk(narration, `title-thought-${row.idx}`), out);
  }

  private handleAgentText(
    row: StepRow,
    out: SessionUpdate[],
    streamingAgentMessageId: string | null,
    streamingNeedsSeparator: boolean,
    canGrow: boolean
  ): void {
    const thought = row.stepPayload.agentText?.thought;
    if (thought) {
      this.emitThought(row.idx, thoughtChunk(thought, `agent-thought-${row.idx}`), out);
    }

    const text = row.stepPayload.agentText?.text ?? "";
    if (isSystemMessage(text)) return;
    if (this.opts.mode === "stream" && canGrow && isSystemMessagePrefix(text)) return;

    const messageId = streamingAgentMessageId ?? String(row.idx);

    if (this.opts.mode === "replay") {
      if (text.length > 0) {
        if (this.pendingAgentMessageId === null) {
          this.pendingAgentMessageId = messageId;
          this.pendingAgentStartStepIdx = row.idx;
        }
        this.pendingAgentEndStepIdx = row.idx;
        this.pendingAgentParts.push(text);
      }
      return;
    }

    // Streaming: emit only the slice appended since the last poll for this idx.
    // Chunks for the same step share one messageId (required by ACP v2).
    const emitted = this.agentTextLengths.get(row.idx) ?? 0;
    if (text.length <= emitted) return;
    this.agentTextLengths.set(row.idx, text.length);
    if (this.opts.skipNarration && isNarration(text)) return;
    const delta = text.slice(emitted);
    if (delta.length > 0) {
      out.push(agentChunk(emitted === 0 && streamingNeedsSeparator ? `\n${delta}` : delta, messageId));
    }
  }

  private flushAgentBuffer(out: SessionUpdate[]): void {
    if (this.pendingAgentParts.length === 0) return;
    const text = this.opts.skipNarration
      ? filterNarration(this.pendingAgentParts)
      : this.pendingAgentParts.join("\n");
    const messageId = this.pendingAgentMessageId ?? "agent";
    const startStepIdx = this.pendingAgentStartStepIdx;
    const endStepIdx = this.pendingAgentEndStepIdx;
    this.pendingAgentParts.length = 0;
    this.pendingAgentMessageId = null;
    this.pendingAgentStartStepIdx = null;
    this.pendingAgentEndStepIdx = null;
    if (text && text.length > 0) {
      const chunk = agentChunk(text, messageId);
      if (startStepIdx != null) {
        const stamped = withStepMeta(chunk, startStepIdx);
        if (endStepIdx != null && endStepIdx > startStepIdx) {
          ((stamped as unknown as Record<string, unknown>)._meta as Record<string, unknown>).endStepIdx = endStepIdx;
        }
        out.push(stamped);
      } else {
        out.push(chunk);
      }
    }
  }
}
