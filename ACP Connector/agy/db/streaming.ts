// Live streaming poller for an in-flight prompt turn. Holds one open DB handle
// for the turn and drives the shared Translator in "stream" mode, emitting only
// newly-appended agent text and not-yet-sent tool steps on each poll.

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { ConversationDb } from "./database.js";
import { linuxProcessConversationId, newConversationId } from "./scan.js";
import { isSystemMessage, isSystemMessagePrefix } from "./system-message.js";
import { toolCallId } from "./tool-call-updates.js";
import { Translator } from "./translator.js";
import type { ModelProviderError } from "./step-payload.js";
import type { StepRow } from "./types.js";

export interface PendingInteraction {
  update: SessionUpdate;
  row: StepRow;
  toolName: string;
  /**
   * True when agy itself is blocked awaiting this decision (status 9, the
   * interactive confirmation menu). False for an edit that already completed
   * without ever pausing (accept-edits / skip-permissions / any non-gated
   * mode) — offered for review after the fact, since the write already
   * happened.
   */
  blocked: boolean;
}

export interface StreamOptions {
  dir: string;
  /** Bound conversation id, or null to bind the DB agy creates for a fresh prompt. */
  conversationId: string | null;
  /** Highest idx already delivered to the client before this turn. */
  baseStepIdx: number;
  skipNarration: boolean;
  cwd?: string;
  /** Snapshot of conversation ids before the prompt, for binding a new DB. */
  snapshot: Set<string> | null;
  /** Exact live agy PID used for ownership-safe Linux conversation binding. */
  processId?: number;
}

export class StreamPoller {
  private readonly translator: Translator;
  private db: ConversationDb | null = null;
  private boundId: string | null;
  private _pending: PendingInteraction[] = [];
  private _hasRows = false;
  private _busy = false;
  private _latestStepTerminal = false;
  private _terminalProviderError: ModelProviderError | null = null;
  private _latestAssistantMessageStepIdx = -1;
  private _latestToolCallStepIdx = -1;
  private _revision = 0;
  private dataVersion: number | null = null;
  private failedDataVersion: number | null = null;
  private failedDataVersionAttempts = 0;
  private rowSnapshot = "";
  private readonly activePending = new Map<string, PendingInteraction>();
  private readonly observedUserStepIdxs = new Set<number>();
  private _lastUserStepIdx = -1;
  private _latestSystemMessageStepIdx = -1;
  private _hasBackgroundWaiting = false;
  /** Launched background task id -> idx of the first row that carried it. */
  private readonly _launchedTaskIdxs = new Map<string, number>();
  private readonly _completedTaskIds = new Set<string>();

  constructor(private readonly opts: StreamOptions) {
    this.boundId = opts.conversationId;
    this.translator = new Translator({
      mode: "stream",
      skipNarration: opts.skipNarration,
      cwd: opts.cwd
    });
  }

  get conversationId(): string | null {
    return this.boundId;
  }

  get lastStepIdx(): number {
    return Math.max(this.translator.lastStepIdx, this.opts.baseStepIdx);
  }

  get hadUpdates(): boolean {
    return this.translator.hadUpdates;
  }

  /** User-prompt rows observed during this prompt-scoped polling session. */
  get userStepIdxs(): number[] {
    return [...this.observedUserStepIdxs];
  }

  get lastUserStepIdx(): number {
    return this._lastUserStepIdx;
  }

  get latestSystemMessageStepIdx(): number {
    return this._latestSystemMessageStepIdx;
  }

  get hasUnansweredSystemMessage(): boolean {
    // _lastUserStepIdx starts at -1, so `>` already excludes "no system message".
    return this._latestSystemMessageStepIdx > this._lastUserStepIdx;
  }

  /**
   * True while this user turn should stay open for background work.
   * Driven strictly by SQLite protobuf task_details launch and completion state.
   */
  get hasActiveBackgroundTasks(): boolean {
    return this._launchedTaskIdxs.size > this._completedTaskIds.size;
  }

  /** Newly observed status-9 tool calls from the most recent poll. */
  takePending(): PendingInteraction[] {
    const pending = this._pending;
    this._pending = [];
    return pending;
  }

  /** Requeue a still-blocked interaction when the TUI redraws an identical gate. */
  requeuePending(id: string): boolean {
    if (this._pending.some((interaction) => toolCallId(interaction.row) === id)) return false;
    const interaction = this.activePending.get(id);
    if (!interaction) return false;
    this._pending.push(interaction);
    return true;
  }

  get turnCompleteCandidate(): boolean {
    const latestContinuationBoundary = Math.max(
      this._latestToolCallStepIdx,
      this._latestSystemMessageStepIdx
    );
    return (
      this._hasRows &&
      !this._busy &&
      this._latestStepTerminal &&
      this._latestAssistantMessageStepIdx > latestContinuationBoundary
    );
  }

  get terminalProviderError(): ModelProviderError | null {
    return this._terminalProviderError;
  }

  /** Increments whenever the observed rows (including growing in-place rows) change. */
  get revision(): number { return this._revision; }

  /** Read steps appended since the turn began and translate the new ones. */
  poll(): SessionUpdate[] {
    if (this.boundId === null && this.opts.snapshot !== null) {
      this.boundId = this.opts.processId === undefined
        ? newConversationId(this.opts.dir, this.opts.snapshot)
        : linuxProcessConversationId(this.opts.dir, this.opts.processId);
    }
    if (this.boundId === null) return [];

    if (this.db === null) {
      this.db = ConversationDb.open(this.opts.dir, this.boundId);
      if (this.db === null) return [];
    }

    const dataVersion = this.db.dataVersion();
    if (this.dataVersion === dataVersion) return [];

    const rows = this.db.readAfter(this.opts.baseStepIdx);
    let latestAssistantMessageStepIdx = -1;
    for (const row of rows) {
      if (row.stepType === 14) {
        this.observedUserStepIdxs.add(row.idx);
        this._lastUserStepIdx = Math.max(this._lastUserStepIdx, row.idx);
      }
      if (row.task?.taskId && !this._launchedTaskIdxs.has(row.task.taskId)) {
        this._launchedTaskIdxs.set(row.task.taskId, row.idx);
      }
      if (
        row.task?.taskId &&
        row.stepType === 21 &&
        isTerminalStepStatus(row.status) &&
        typeof row.stepPayload.commandResult?.exitCode === "number"
      ) {
        // Some foreground commands carry task_details even though their
        // explicit command result is already terminal. They do not receive a
        // later background-task system message and must not keep the turn open.
        this._completedTaskIds.add(row.task.taskId);
      }
      const text = row.stepPayload.agentText?.text ?? "";
      if (
        row.stepType === 15 &&
        isTerminalStepStatus(row.status) &&
        text.trim().length > 0 &&
        !isSystemMessage(text) &&
        !isSystemMessagePrefix(text)
      ) {
        latestAssistantMessageStepIdx = Math.max(latestAssistantMessageStepIdx, row.idx);
      }
      // Defer completion tracking until a system message is terminal so a
      // still-streaming system-message envelope cannot close the wait early.
      // Generic stepType 101 turn-end markers without a system message payload
      // must NOT clear active tasks, as agy appends 101 at the end of every turn.
      if (
        isSystemMessage(text) &&
        isTerminalStepStatus(row.status)
      ) {
        this._latestSystemMessageStepIdx = Math.max(this._latestSystemMessageStepIdx, row.idx);
        // Rows are re-read on every poll, so an id-less lifecycle row observed
        // before a later launch would otherwise close that newer task on the
        // next revision. Only tasks launched BEFORE this row can complete here.
        const launchedBefore = [...this._launchedTaskIdxs]
          .filter(([, launchIdx]) => launchIdx < row.idx)
          .map(([taskId]) => taskId);
        let matchedTask = false;
        for (const taskId of launchedBefore) {
          if (taskId && textMentionsTaskId(text, taskId)) {
            this._completedTaskIds.add(taskId);
            matchedTask = true;
          }
        }
        // Lifecycle/system wake without an embedded task id (common for system message
        // wakes): close every still-pending launch so the turn cannot hang
        // forever waiting for a match that never arrives.
        if (!matchedTask) {
          for (const taskId of launchedBefore) {
            this._completedTaskIds.add(taskId);
          }
        }
      }
    }
    this._latestAssistantMessageStepIdx = latestAssistantMessageStepIdx;
    if (!rows.hasDecodeError) {
      this.dataVersion = dataVersion;
      this.failedDataVersion = null;
      this.failedDataVersionAttempts = 0;
    } else {
      if (this.failedDataVersion === dataVersion) {
        this.failedDataVersionAttempts++;
      } else {
        this.failedDataVersion = dataVersion;
        this.failedDataVersionAttempts = 1;
      }
      if (this.failedDataVersionAttempts >= 3) {
        this.dataVersion = dataVersion;
      }
    }
    const snapshot = JSON.stringify(rows.map((row) => [
      row.idx,
      row.stepType,
      row.status,
      row.stepPayload,
      row.error,
      row.permission,
      row.task
    ]));
    if (snapshot !== this.rowSnapshot) { this.rowSnapshot = snapshot; this._revision++; }
    this._hasRows = rows.length > 0;
    this._busy = rows.some((row) => row.status !== 3 && row.status !== 6 && row.status !== 7);
    const latest = rows.at(-1);
    const latestProviderError = latest?.stepPayload.modelProviderError;
    this._terminalProviderError =
      !rows.hasDecodeError &&
      latest !== undefined &&
      isTerminalStepStatus(latest.status) &&
      latestProviderError !== undefined &&
      latestProviderError.summary.trim().length > 0 &&
      latestProviderError.userMessage.trim() === latestProviderError.summary.trim()
        ? latestProviderError
        : null;
    // A turn can end on a completed agent message, but also on a terminal tool
    // step with no trailing message — most notably a denied/failed command
    // (status 7), after which agy returns to idle without emitting more text.
    // Gate completion on "latest step is terminal" (3/6/7), not "latest is an
    // agent message", so those turns don't hang until the deadline. Exclude
    // stepType 14 (user prompt), which is inserted with status 3 as the turn
    // opens before agy appends any assistant response steps.
    this._latestStepTerminal =
      !rows.hasDecodeError &&
      latest !== undefined &&
      latest.stepType !== 14 &&
      (latest.status === 3 || latest.status === 6 || latest.status === 7);
    // readAfter(baseStepIdx) is a complete prompt-scoped snapshot on every DB
    // change. Rebuild derived file history from those rows so completed writes
    // from a prior poll cannot become the oldText of an earlier historical row.
    this.translator.resetFileContentsForFullReplay();
    const updates = this.translator.translate(rows);
    const rowsByToolCallId = new Map(rows.map((row) => [toolCallId(row), row]));
    const blockedIds = new Set(rows.filter((row) => row.status === 9).map(toolCallId));
    for (const id of this.activePending.keys()) {
      if (!blockedIds.has(id)) this.activePending.delete(id);
    }
    for (const update of updates) {
      const raw = update as unknown as {
        status?: string;
        kind?: string;
        sessionUpdate?: string;
        toolCallId?: string;
        _meta?: { stepIdx?: unknown };
      };
      if (
        (raw.sessionUpdate === "tool_call" || raw.sessionUpdate === "tool_call_update") &&
        typeof raw._meta?.stepIdx === "number"
      ) {
        this._latestToolCallStepIdx = Math.max(this._latestToolCallStepIdx, raw._meta.stepIdx);
      }
      const blocked = raw.status === "pending";
      const id = String(raw.toolCallId);
      // Edits that complete without ever pausing (accept-edits / skip-permissions)
      // still get offered for review — see PendingInteraction.blocked.
      const completedEdit = raw.kind === "edit" && raw.status === "completed";
      if (!blocked && !completedEdit) continue;
      const row = rowsByToolCallId.get(id);
      if (row) {
        const interaction = {
          update,
          row,
          toolName: row.stepPayload.toolRun?.call?.namePrimary || row.stepPayload.toolRun?.call?.nameSecondary || "unknown",
          blocked
        };
        if (blocked) this.activePending.set(id, interaction);
        this._pending.push(interaction);
      }
    }
    return updates;
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }
}

/** status 3/6/7 — completed, cancelled/aborted, or failed. */
function isTerminalStepStatus(status: number): boolean {
  return status === 3 || status === 6 || status === 7;
}

/**
 * True when `text` contains `taskId` as a whole token (not a prefix of a longer
 * id). Avoids `task-1` matching inside `task-10`.
 */
function textMentionsTaskId(text: string, taskId: string): boolean {
  if (!taskId || !text) return false;
  let from = 0;
  while (from <= text.length) {
    const index = text.indexOf(taskId, from);
    if (index < 0) return false;
    const before = index === 0 ? "" : text[index - 1]!;
    const after = text[index + taskId.length] ?? "";
    const boundary = (ch: string) => ch === "" || !/[\w-]/.test(ch);
    if (boundary(before) && boundary(after)) return true;
    from = index + 1;
  }
  return false;
}
