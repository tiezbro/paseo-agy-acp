// Renders decoded agy tool-run steps (`StepPayload.toolRun` plus its typed
// result variants) into ACP `tool_call` updates. Shared helpers first, then one
// builder per tool family, grouped by the ACP `ToolKind` they map to.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionUpdate, ToolKind } from "@agentclientprotocol/sdk";
import type { ErrorDetails, PermissionInfo, TaskDetails } from "./columns.js";
import {
  isPlanFile,
  planIdForPath,
  planRemovedFromPath,
  planUpdateFromMarkdown,
  type PlanEntry
} from "../acp/agent-plan/index.js";
import type { SearchHit } from "./step-payload.js";
import type { StepRow } from "./types.js";

/** Absolute path -> last known file body from prior view_file / write steps. */
export type FileContentCache = Map<string, string>;

/** Options shared by tool builders that need project context. */
export interface UpdateContext {
  cwd?: string;
  /** Prior file contents for full-file write diffs. */
  fileContents?: FileContentCache;
  /** Plan id -> entries of the previous plan snapshot (stable entry-id reconciliation). */
  planEntries?: Map<string, PlanEntry[]>;
  /** Candidate location path -> readability observed while translating. */
  locationReadability?: Map<string, boolean>;
}

/** Cap on fetched URL / large tool bodies surfaced in session updates. */
export const MAX_TOOL_BODY_CHARS = 32_000;

// --- shared helpers ----------------------------------------------------------

/** Parse the JSON-encoded tool arguments (`toolRun.call.rawInputJson`), tolerating
 *  missing or malformed payloads. Every builder below needs these args. */
export function parseRawInput(stepRow: StepRow): unknown {
  const rawJson = stepRow.stepPayload.toolRun?.call?.rawInputJson;
  if (typeof rawJson === "string" && rawJson.trim().length > 0) {
    try {
      return JSON.parse(rawJson);
    } catch {
      return null;
    }
  }
  return null;
}

/** Stable tool-call id: agy's own call id when present, else a synthetic id
 *  derived from the step's position and type. */
export function toolCallId(stepRow: StepRow): string {
  return stepRow.stepPayload.toolRun?.call?.callId.trim() || `agy-${stepRow.idx}-${stepRow.stepType}`;
}

/** Map agy's step `status` column to an ACP tool_call status.
 *  1/2 = active/in progress, 3 = completed, 6 = cancelled/aborted, 7 = failed,
 *  9 = generic RequestedInteraction (represented as pending for inspection).
 *  `cancelled` is ACP v2; v1 clients map it to `failed` at the protocol boundary. */
function toolCallStatus(stepRow: StepRow): "pending" | "in_progress" | "completed" | "failed" | "cancelled" {
  switch (stepRow.status) {
    case 9:
      return "pending";
    case 1:
    case 2:
      return "in_progress";
    case 6:
      return "cancelled";
    case 7:
      return "failed";
    default:
      return "completed";
  }
}

function textBlock(text: string): Record<string, unknown> {
  return { type: "content", content: { type: "text", text } };
}

function fencedCodeBlock(text: string): string {
  const longestBacktickRun = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}\n${text}\n${fence}`;
}

function codeBlock(text: string): Record<string, unknown> {
  return textBlock(fencedCodeBlock(text));
}

function outputCodeBlock(text: string): Record<string, unknown> {
  const block = textBlock(fencedCodeBlock(text));
  block.kind = "output";
  return block;
}

function errorBlock(e: ErrorDetails): Record<string, unknown> {
  const message = e.message.trim() || e.detail.trim() || "Tool call failed";
  const detail = e.detail.trim() && e.detail.trim() !== message ? `\n${e.detail.trim()}` : "";
  return codeBlock(`Error: ${message}${detail}`);
}

/** Map agy permission decision varint to a short outcome label.
 *  Observed values: 0 = denied, 1 = granted. */
export function permissionOutcome(decision: number): "denied" | "granted" | "unknown" {
  if (decision === 0) return "denied";
  if (decision === 1) return "granted";
  return "unknown";
}

function permissionBlock(p: PermissionInfo): Record<string, unknown> {
  const target = p.value.trim() ? ` (${p.value.trim()})` : "";
  const kind = p.kind || "unknown";
  const outcome = permissionOutcome(p.decision);
  const label =
    outcome === "denied"
      ? `Permission denied: ${kind}${target}`
      : outcome === "granted"
        ? `Permission granted: ${kind}${target}`
        : `Permission requested: ${kind}${target}`;
  return textBlock(label);
}

/** Truncate a large tool body for editor-friendly display. */
export function truncateToolBody(text: string, max = MAX_TOOL_BODY_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n… (truncated, ${text.length - max} more chars)`, truncated: true };
}

function taskBlock(t: TaskDetails): Record<string, unknown> {
  const lines = [t.description, t.taskId && `Task: ${t.taskId}`, t.logUri && `Log: ${t.logUri}`].filter(
    (line): line is string => Boolean(line)
  );
  return textBlock(lines.join("\n"));
}

/** Decoded agy tool identity, preferring the primary field when both exist. */
export function decodedToolName(stepRow: StepRow): string {
  return (
    stepRow.stepPayload.toolRun?.call?.namePrimary ||
    stepRow.stepPayload.toolRun?.call?.nameSecondary ||
    ""
  );
}

/**
 * Build a `tool_call` update with the envelope common to every tool step: the
 * parsed args become `rawInput`, a decoded error becomes `rawOutput` plus a
 * content block, and `permissions`/`task_details` (when present) are appended
 * as content. Every builder below routes through here.
 */
export function toolCallUpdate(opts: {
  stepRow: StepRow;
  title: string;
  kind: ToolKind;
  name?: string;
  status?: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  content?: Record<string, unknown>[];
  locations?: Record<string, unknown>[];
}): SessionUpdate {
  const { stepRow, title, kind, name: nameOpt, status = toolCallStatus(stepRow), content, locations } = opts;

  const blocks: Record<string, unknown>[] = [...(content ?? [])];
  if (stepRow.task) blocks.push(taskBlock(stepRow.task));
  if (stepRow.permission) blocks.push(permissionBlock(stepRow.permission));
  if (stepRow.error) blocks.push(errorBlock(stepRow.error));

  const rawInput = parseRawInput(stepRow);
  const rawOutput = stepRow.error
    ? { message: stepRow.error.message || stepRow.error.detail, detail: stepRow.error.detail, stackTrace: stepRow.error.stackTrace }
    : undefined;

  const name =
    nameOpt ||
    decodedToolName(stepRow) ||
    undefined;

  // Emit `tool_call` (v1 create shape). The v2 boundary rewrites this to
  // `tool_call_update` (first update creates the call).
  return {
    sessionUpdate: "tool_call",
    toolCallId: toolCallId(stepRow),
    ...(name ? { name } : {}),
    title,
    kind,
    status,
    ...(blocks.length > 0 ? { content: blocks } : {}),
    ...(locations && locations.length > 0 ? { locations } : {}),
    ...(rawInput != null ? { rawInput } : {}),
    ...(rawOutput != null ? { rawOutput } : {})
  } as SessionUpdate;
}

/** Absolute path -> project-relative path for display; unchanged if outside cwd. */
function toDisplayPath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;
  const resolvedCwd = path.resolve(cwd);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile === resolvedCwd || resolvedFile.startsWith(resolvedCwd + path.sep)) {
    return path.relative(resolvedCwd, resolvedFile);
  }
  return filePath;
}

/** Best-effort ACP tool kind for tools without a dedicated builder. */
function toolKind(name: string): ToolKind {
  const n = name.toLowerCase();
  if (/write|edit|patch|replace/.test(n)) return "edit";
  if (/delete|remove/.test(n)) return "delete";
  if (/move|rename/.test(n)) return "move";
  if (/read|view|list/.test(n)) return "read";
  if (/grep|search|find/.test(n)) return "search";
  if (/command|execute|terminal/.test(n)) return "execute";
  if (/think|thought|reason/.test(n)) return "think";
  if (/url|fetch/.test(n)) return "fetch";
  return "other";
}

/** True when a tool name is pure agent reasoning (emit agent_thought_chunk). */
export function isThoughtToolName(name: string): boolean {
  return /^(think|thought|reason|reasoning)$/i.test(name.trim());
}

/** Build an agent_thought_chunk from a think-style tool step. */
export function thoughtUpdate(stepRow: StepRow): SessionUpdate {
  const rawInput = parseRawInput(stepRow);
  const fromInput =
    asStr(pick(rawInput, "Thought", "thought", "Text", "text", "Content", "content"))?.trim() ?? "";
  const title =
    asStr(stepRow.stepPayload.toolRun?.titlePrimary)?.trim() ||
    asStr(stepRow.stepPayload.toolRun?.titleSecondary)?.trim() ||
    "";
  const text = fromInput || title || "Thinking";
  return {
    sessionUpdate: "agent_thought_chunk",
    messageId: toolCallId(stepRow),
    content: { type: "text", text }
  } as SessionUpdate;
}

function pick(o: unknown, ...keys: string[]): unknown {
  if (o === null || typeof o !== "object" || Array.isArray(o)) return undefined;
  for (const key of keys) {
    if (key in o) return (o as Record<string, unknown>)[key];
  }
  return undefined;
}

function asStr(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNum(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim().length > 0) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Convert a valid `file://` URL to a path; reject malformed URLs without throwing. */
function fsPath(p: string | null | undefined): string | null {
  if (!p) return null;
  if (!p.startsWith("file://")) return p;
  try {
    return fileURLToPath(p);
  } catch {
    return null;
  }
}

/** Resolve relative or `file://` path against session cwd. */
function resolvePath(filePath: string | null | undefined, cwd?: string): string | null {
  const p = fsPath(filePath);
  if (!p) return null;
  if (path.isAbsolute(p)) return path.resolve(p);
  return cwd ? path.resolve(cwd, p) : path.resolve(p);
}

/** Return true if `filePath` is positively known to be a readable file. */
export function isReadableFile(filePath: string | null | undefined): boolean {
  if (!filePath) return false;
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function isReadableLocation(filePath: string | null, ctx?: UpdateContext): boolean {
  if (!filePath) return false;
  const readable = isReadableFile(filePath);
  ctx?.locationReadability?.set(filePath, readable);
  return readable;
}

// --- per-tool builders --------------------------------------------------------
// agy's rawInputJson keys are inconsistently PascalCase/camelCase across tool
// versions (`TargetFile` vs `targetFile`), so every lookup below tries both.

/**
 * True when a view_file step looks safe to cache as the full file body for
 * later write diffs. Reject mid-file slices; accept start-at-beginning reads
 * that either omit an end bound or reach the file's reported total.
 */
function isFullFileView(opts: {
  startLine: number;
  endLine: number | null;
  nextLine?: number | null;
  fileSizeOrTotal?: number | null;
}): boolean {
  if (opts.startLine > 1) return false;
  if (opts.endLine === null || opts.endLine === 0) return true;
  // nextLine 0/undefined after a complete read; or end covers reported total lines.
  if (opts.nextLine === 0) return true;
  if (opts.fileSizeOrTotal != null && opts.fileSizeOrTotal > 0 && opts.endLine >= opts.fileSizeOrTotal) {
    return true;
  }
  return false;
}

/** Step types 8/9/17(view_file|list_dir): a file read or directory listing. */
export function readUpdate(stepRow: StepRow, ctx?: UpdateContext): SessionUpdate {
  const cwd = ctx?.cwd;
  const fileContents = ctx?.fileContents;
  const { stepPayload, stepType } = stepRow;
  const toolRun = stepPayload.toolRun;
  const rawInput = parseRawInput(stepRow);
  const displayCwd = fsPath(cwd) ?? undefined;
  const nameFromCall = decodedToolName(stepRow);
  const view = stepPayload.viewFile;
  const list = stepPayload.listDirectory;

  let title = "Read";
  let name = "view_file";
  const content: Record<string, unknown>[] = [];
  const locations: Record<string, unknown>[] = [];

  if (list || nameFromCall === "list_dir" || stepType === 9) {
    name = nameFromCall || "list_dir";
    const dir = fsPath(asStr(list?.dirUri)) ?? fsPath(asStr(pick(rawInput, "DirectoryPath", "directoryPath")));
    const shown = dir ? toDisplayPath(dir, displayCwd) : "";
    title = shown ? `Read ${shown}` : "Read directory";

    const entries = (list?.entries ?? []).filter((e) => e.name.trim().length > 0);
    if (entries.length > 0) {
      content.push(codeBlock(entries.map((e) => `${e.name}${e.isDirectory !== 0 ? "/" : ""}`).join("\n")));
    }
  } else {
    name = nameFromCall || "view_file";
    const filePath =
      fsPath(asStr(pick(rawInput, "AbsolutePath", "absolutePath", "FilePath"))) ?? fsPath(asStr(view?.fileUri));
    const resolvedFile = resolvePath(filePath, displayCwd);
    const shown = filePath ? toDisplayPath(filePath, displayCwd) : "";
    const startLine = asNum(pick(rawInput, "StartLine", "startLine")) ?? asNum(view?.startLine) ?? 1;
    const endLine = asNum(pick(rawInput, "EndLine", "endLine")) ?? asNum(view?.endLine);
    const locationLine = startLine === 0 ? 1 : startLine;

    title = shown ? `Read ${shown}` : "Read file";
    if (shown && endLine !== null) title += `:${locationLine}-${endLine}`;
    if (isReadableLocation(resolvedFile, ctx)) locations.push({ path: resolvedFile, line: locationLine });

    const body = asStr(view?.content);
    if (body) {
      content.push(codeBlock(body));
      // Only cache full-file views; ranged slices would corrupt later write diffs.
      if (
        filePath &&
        fileContents &&
        isFullFileView({
          startLine,
          endLine,
          nextLine: asNum(view?.nextLine),
          fileSizeOrTotal: asNum(view?.fileSizeOrTotal)
        })
      ) {
        fileContents.set(path.resolve(resolvedFile ?? filePath), body);
      }
    }
  }

  return toolCallUpdate({ stepRow, title, kind: "read", name, content, locations });
}

/** Render grep hits into readable, pipe-joined lines. `field2` is the line
 *  number (a varint in the wire format); coerce it to a string for display. */
function renderHits(hits: SearchHit[] | undefined): string {
  if (!hits || hits.length === 0) return "";
  return hits
    .map((h) => [h.field1, h.field2 ? String(h.field2) : "", h.field3, h.field4, h.field5]
      .filter((v) => v.trim().length > 0)
      .join(" | "))
    .filter((line) => line.length > 0)
    .join("\n");
}

/** Step types 7/33(grep_search|search_web): a filesystem or web search. */
export function searchUpdate(stepRow: StepRow, ctx?: UpdateContext): SessionUpdate {
  const cwd = ctx?.cwd;
  const { stepPayload, stepType } = stepRow;
  const nameFromCall = decodedToolName(stepRow);
  const rawInput = parseRawInput(stepRow);
  const displayCwd = fsPath(cwd) ?? undefined;
  const grep = stepPayload.grepSearch;

  let title = "Search";
  let name = "search_web";
  const content: Record<string, unknown>[] = [];
  const locations: Record<string, unknown>[] = [];

  if (grep || nameFromCall === "grep_search" || stepType === 7) {
    name = nameFromCall || "grep_search";
    const query = asStr(grep?.query) ?? asStr(pick(rawInput, "Query", "query")) ?? "";
    const searchPath = fsPath(asStr(pick(rawInput, "SearchPath", "searchPath"))) ?? fsPath(asStr(grep?.cwdUri));
    const resolvedPath = resolvePath(searchPath, displayCwd);
    const shown = searchPath ? toDisplayPath(searchPath, displayCwd) : "";
    title = shown ? `Search '${query}' ${shown}` : `Search '${query}'`;
    if (isReadableLocation(resolvedPath, ctx)) locations.push({ path: resolvedPath });

    const body = asStr(grep?.textOutput)?.trim() || renderHits(grep?.hits) || asStr(grep?.shellCommand)?.trim();
    if (body) content.push(codeBlock(body));
  } else {
    name = nameFromCall || "search_web";
    // search_web: field 42 carries query metadata; hit lists are not persisted.
    const web = stepPayload.webSearch;
    const query =
      asStr(web?.query)?.trim() || asStr(pick(rawInput, "query", "Query"))?.trim() || "";
    title = query ? `Web search ${query}` : "Web search";

    const lines: string[] = [];
    if (query) lines.push(`Query: ${query}`);
    const secondary = asStr(web?.refinedQueryOrUrl)?.trim() ?? "";
    if (secondary && secondary !== query) {
      lines.push(secondary.startsWith("http") ? `URL: ${secondary}` : `Refined: ${secondary}`);
    }
    if (lines.length > 0) content.push(codeBlock(lines.join("\n")));
  }

  return toolCallUpdate({ stepRow, title, kind: "search", name, content, locations });
}

/** Step type 21 (run_command): a shell command execution. */
export function executeUpdate(stepRow: StepRow): SessionUpdate {
  const toolRun = stepRow.stepPayload.toolRun;
  const commandResult = stepRow.stepPayload.commandResult;
  const rawInput = parseRawInput(stepRow);
  const command =
    asStr(pick(rawInput, "CommandLine", "commandLine", "command")) ??
    (commandResult?.command?.trim() ? commandResult.command : null);
  const firstLine = (command?.split("\n")[0] ?? "").trim();
  const summary = asStr(pick(rawInput, "toolSummary", "ToolSummary"))?.trim();
  const action = asStr(pick(rawInput, "toolAction", "ToolAction"))?.trim();
  const title =
    firstLine ||
    summary ||
    action ||
    asStr(toolRun?.titlePrimary)?.trim() ||
    asStr(toolRun?.titleSecondary)?.trim() ||
    "Command Execution";

  const content: Record<string, unknown>[] = [];
  if (command?.trim()) {
    content.push(codeBlock(command.trim()));
  }
  const output = commandResult?.output ?? "";
  if (output.trim()) {
    content.push(outputCodeBlock(output));
  }

  // Prefer explicit Cwd from args; fall back to command-result cwd.
  const commandCwd =
    fsPath(asStr(pick(rawInput, "Cwd", "cwd"))) ??
    fsPath(commandResult?.cwd?.trim() ? commandResult.cwd : null);
  const locations: Record<string, unknown>[] = [];

  const name = decodedToolName(stepRow) || "run_command";

  const update = toolCallUpdate({
    stepRow,
    title,
    kind: "execute",
    name,
    content,
    locations
  }) as SessionUpdate & { rawOutput?: unknown; rawInput?: unknown };

  // When the command was recovered from commandResult.command (rawInputJson
  // missing/malformed), inject it into rawInput so downstream consumers
  // (e.g. executeTerminalMeta) can always find it via rawInput.CommandLine
  // instead of falling back to title (which may now be toolSummary).
  if (command && update.rawInput != null && typeof update.rawInput === "object" && !Array.isArray(update.rawInput)) {
    const input = update.rawInput as Record<string, unknown>;
    if (!input.CommandLine && !input.commandLine && !input.command) {
      input.CommandLine = command;
    }
  }

  // Attach structured exit when finished and present (without dropping error rawOutput).
  const status = toolCallStatus(stepRow);
  const finished = status === "completed" || status === "failed" || status === "cancelled";
  if (commandResult && typeof commandResult.exitCode === "number" && finished) {
    const rawOut =
      update.rawOutput && typeof update.rawOutput === "object" && !Array.isArray(update.rawOutput)
        ? { ...(update.rawOutput as Record<string, unknown>) }
        : {};
    rawOut.exitCode = commandResult.exitCode;
    update.rawOutput = rawOut;
  }
  return update;
}

/** Prefer a real document title over agy's generic "Live Content" label. */
function fetchTitle(docTitle: string, url: string, toolRun: StepRow["stepPayload"]["toolRun"]): string {
  const generic = !docTitle || /^live content$/i.test(docTitle);
  if (!generic) return `Fetch ${docTitle}`;
  if (url) return `Fetch ${url}`;
  return (
    asStr(toolRun?.titlePrimary)?.trim() ||
    asStr(toolRun?.titleSecondary)?.trim() ||
    "Fetch URL"
  );
}

/** Step type 31 (read_url_content): fetch URL + optional decoded body (field 40). */
export function fetchUpdate(stepRow: StepRow): SessionUpdate {
  const toolRun = stepRow.stepPayload.toolRun;
  const rawInput = parseRawInput(stepRow);
  const urlContent = stepRow.stepPayload.urlContent;
  const url =
    asStr(urlContent?.url)?.trim() || asStr(pick(rawInput, "Url", "url"))?.trim() || "";

  const docTitle = asStr(urlContent?.title)?.trim() || "";
  const title = fetchTitle(docTitle, url, toolRun);

  const content: Record<string, unknown>[] = [];
  if (url) content.push(textBlock(url));
  const description = asStr(urlContent?.description)?.trim() || "";
  if (docTitle || description) {
    const meta = [docTitle && `Title: ${docTitle}`, description && `Description: ${description}`]
      .filter(Boolean)
      .join("\n");
    if (meta) content.push(textBlock(meta));
  }

  const body = asStr(urlContent?.body) ?? "";
  let truncated = false;
  if (body.trim()) {
    const sliced = truncateToolBody(body);
    truncated = sliced.truncated;
    content.push(codeBlock(sliced.text));
  }

  const name = decodedToolName(stepRow) || "read_url_content";

  const update = toolCallUpdate({ stepRow, title, kind: "fetch", name, content }) as SessionUpdate & {
    rawOutput?: unknown;
  };

  if (urlContent && !stepRow.error) {
    update.rawOutput = {
      url: url || undefined,
      title: docTitle || undefined,
      description: description || undefined,
      contentPath: urlContent.contentPath || undefined,
      bodyChars: body.length || undefined,
      truncated: truncated || undefined
    };
  }
  return update;
}

/**
 * Apply replace/multi_replace chunks to a prior plan body (first-occurrence
 * replacements, matching agy replace_file_content semantics).
 */
function applyReplacementChunks(prior: string, chunks: unknown[]): string | null {
  let body = prior;
  for (const chunk of chunks) {
    const newText = asStr(pick(chunk, "ReplacementContent", "replacementContent"));
    if (newText === null) return null;
    const oldText = asStr(pick(chunk, "TargetContent", "targetContent"));
    if (oldText === null) return null;
    const idx = body.indexOf(oldText);
    if (idx === -1) return null;
    body = body.slice(0, idx) + newText + body.slice(idx + oldText.length);
  }
  return body;
}

/** Best-effort post-edit plan body for replace_file_content / multi_replace. */
function planBodyAfterReplacementEdits(
  stepRow: StepRow,
  resolvedTarget: string,
  fileContents: FileContentCache | undefined,
  rawInput: unknown
): string | null {
  const chunksRaw = pick(rawInput, "ReplacementChunks", "replacementChunks");
  const chunks = Array.isArray(chunksRaw) ? chunksRaw : [rawInput];
  const cacheKey = path.resolve(resolvedTarget);
  const prior = fileContents?.get(cacheKey);

  if (prior !== undefined) {
    const applied = applyReplacementChunks(prior, chunks);
    if (applied !== null) return applied;
  }

  // Completed replaces: on-disk artifact is the source of truth after agy applies the edit.
  if (toolCallStatus(stepRow) === "completed") {
    try {
      if (fs.existsSync(resolvedTarget) && fs.statSync(resolvedTarget).isFile()) {
        return fs.readFileSync(resolvedTarget, "utf8");
      }
    } catch {
      // ignore unreadable paths
    }
  }
  return null;
}

/** Step type 5 (write_to_file|replace_file_content|multi_replace_file_content),
 *  and step 17 artifact writes (e.g. a generated `plan.md` for user review).
 *  Brain plan markdown becomes a structured ACP `plan` update (not an edit tool). */
export function editUpdate(stepRow: StepRow, ctx?: UpdateContext): SessionUpdate | SessionUpdate[] {
  const cwd = ctx?.cwd;
  const fileContents = ctx?.fileContents;
  const rawInput = parseRawInput(stepRow);
  const displayCwd = fsPath(cwd) ?? undefined;

  const targetFile = fsPath(asStr(pick(rawInput, "TargetFile", "targetFile"))) ?? "";
  const resolvedTarget = resolvePath(targetFile, displayCwd) ?? targetFile;
  const fullContent = asStr(pick(rawInput, "CodeContent", "codeContent"));
  const status = toolCallStatus(stepRow);

  // Brain plan artifacts → structured plan session update (v1 `plan` / v2 plan_update / plan_removed).
  // Only write_to_file carries CodeContent; replace/multi_replace carry ReplacementChunks instead.
  // Cache writes only after status completed so denied/failed edits cannot poison later replace
  // derivation. Replacement-derived plan bodies also require completed. write_to_file still
  // publishes requested CodeContent immediately (requested full body) without caching until done.
  // Empty body + completed write/replace → plan_removed; incomplete empty edits fall through.
  if (isPlanFile(targetFile)) {
    const isReplaceEdit = fullContent === null;
    let planBody: string | null = null;
    if (!isReplaceEdit) {
      planBody = fullContent;
    } else {
      planBody = planBodyAfterReplacementEdits(stepRow, resolvedTarget, fileContents, rawInput);
    }

    if (planBody !== null) {
      // Derive plan identity from the normalized absolute path so relative and
      // absolute references to the same artifact share one plan id (and one
      // entry-id lineage) instead of splitting into divergent plans.
      const planId = planIdForPath(resolvedTarget);
      if (planBody.trim().length === 0) {
        if (status === "completed") {
          fileContents?.set(path.resolve(resolvedTarget), planBody);
          // Removal ends the plan's entry-id lineage; a re-created plan starts fresh.
          ctx?.planEntries?.delete(planId);
          return planRemovedFromPath(resolvedTarget);
        }
        // Incomplete/failed empty edit: preserve tool_call lifecycle, do not remove plan.
      } else if (!isReplaceEdit || status === "completed") {
        // Only successful writes update the content cache used by later replace derivation.
        if (status === "completed") {
          fileContents?.set(path.resolve(resolvedTarget), planBody);
        }
        // Reconcile entry ids against the previous snapshot so duplicate-row
        // inserts/reorders do not reshuffle ids of surviving tasks.
        const update = planUpdateFromMarkdown(resolvedTarget, planBody, ctx?.planEntries?.get(planId));
        ctx?.planEntries?.set(planId, (update as unknown as { entries: PlanEntry[] }).entries);
        return update;
      }
      // Incomplete/failed replace with a nonempty speculative body: keep tool lifecycle.
    }
  }

  const shown = targetFile ? toDisplayPath(targetFile, displayCwd) : "";
  const title = shown ? `Edit ${shown}` : "Edit";

  const content: Record<string, unknown>[] = [];
  const locations: Record<string, unknown>[] = [];

  let name = decodedToolName(stepRow);

  if (fullContent !== null) {
    if (!name || name === "edit") name = "write_to_file";
    // write_to_file: the whole file content is the new text.
    if (targetFile) {
      // Prefer prior view_file/write content as oldText when known; otherwise null
      // (new file or prior content never observed in this translator pass).
      const cacheKey = path.resolve(resolvedTarget);
      const prior = fileContents?.get(cacheKey) ?? null;
      content.push({ type: "diff", path: targetFile, oldText: prior, newText: fullContent });
      // Pending/failed writes describe proposed content, not a new baseline.
      // Preserve the prior body until completion so the completed lifecycle
      // update still carries a meaningful oldText instead of newText→newText.
      if (status === "completed") {
        fileContents?.set(cacheKey, fullContent);
      }
      if (isReadableLocation(resolvedTarget, ctx)) locations.push({ path: resolvedTarget });
    }
  } else {
    // replace_file_content (one inline chunk) or multi_replace_file_content
    // (a ReplacementChunks array) — normalize both to a list of chunks.
    const chunksRaw = pick(rawInput, "ReplacementChunks", "replacementChunks");
    const chunks = Array.isArray(chunksRaw) ? chunksRaw : [rawInput];
    if (!name || name === "edit") {
      name = Array.isArray(chunksRaw) ? "multi_replace_file_content" : "replace_file_content";
    }

    for (const chunk of chunks) {
      const newText = asStr(pick(chunk, "ReplacementContent", "replacementContent"));
      if (newText === null || !targetFile) continue;
      const oldText = asStr(pick(chunk, "TargetContent", "targetContent"));
      content.push({ type: "diff", path: targetFile, oldText, newText });

      if (isReadableLocation(resolvedTarget, ctx)) {
        const line = asNum(pick(chunk, "StartLine", "startLine"));
        locations.push(line !== null ? { path: resolvedTarget, line } : { path: resolvedTarget });
      }
    }
  }

  return toolCallUpdate({ stepRow, title, kind: "edit", name, content, locations });
}

/** Step type 138 (ask_question): the agent poses one or more multiple-choice questions. */
export function questionUpdate(stepRow: StepRow): SessionUpdate {
  const toolRun = stepRow.stepPayload.toolRun;
  const rawInput = parseRawInput(stepRow);
  const questionsRaw = pick(rawInput, "questions", "Questions");
  const questions = Array.isArray(questionsRaw) ? questionsRaw : [];

  const firstQuestion = asStr(pick(questions[0], "question", "Question"))?.trim();
  const title =
    firstQuestion || asStr(toolRun?.titlePrimary)?.trim() || asStr(toolRun?.titleSecondary)?.trim() || "Ask question";

  const content: Record<string, unknown>[] = [];
  for (const q of questions) {
    const question = asStr(pick(q, "question", "Question"))?.trim();
    if (!question) continue;
    const optionsRaw = pick(q, "options", "Options");
    const options = Array.isArray(optionsRaw) ? optionsRaw : [];
    const lines = [question, ...options.map((opt) => asStr(opt) ?? asStr(pick(opt, "label", "Label"))).filter((label): label is string => Boolean(label)).map((label) => `  - ${label}`)];
    content.push(textBlock(lines.join("\n")));
  }

  const name = decodedToolName(stepRow) || "ask_question";

  return toolCallUpdate({ stepRow, title, kind: "other", name, content });
}

/** Step type 127 (invoke_subagent): delegates one or more tasks to subagents. */
export function subagentUpdate(stepRow: StepRow): SessionUpdate {
  const toolRun = stepRow.stepPayload.toolRun;
  const rawInput = parseRawInput(stepRow);
  const subagentsRaw = pick(rawInput, "Subagents", "subagents");
  const subagents = Array.isArray(subagentsRaw) ? subagentsRaw : [];

  const title =
    subagents.length > 0
      ? `Delegate to ${subagents.length} subagent${subagents.length > 1 ? "s" : ""}`
      : asStr(toolRun?.titleSecondary)?.trim() || asStr(toolRun?.titlePrimary)?.trim() || "Invoke subagent";

  const content = subagents
    .map((s) => asStr(pick(s, "Prompt", "prompt"))?.trim())
    .filter((prompt): prompt is string => Boolean(prompt))
    .map(codeBlock);

  const name = decodedToolName(stepRow) || "invoke_subagent";

  return toolCallUpdate({ stepRow, title, kind: "other", name, content });
}

/**
 * Step type 132 orchestration tools (manage_task/schedule/send_message/
 * manage_subagents), plus the generic fallback for any tool without a
 * dedicated builder above.
 */
export function otherUpdate(stepRow: StepRow): SessionUpdate {
  const toolRun = stepRow.stepPayload.toolRun;
  const name = decodedToolName(stepRow);
  const rawInput = parseRawInput(stepRow);

  switch (name) {
    case "manage_task": {
      const action = asStr(pick(rawInput, "Action", "action"))?.trim() || "manage";
      const taskId = asStr(pick(rawInput, "TaskId", "taskId"));
      return toolCallUpdate({
        stepRow,
        title: `Manage task ${action}`,
        kind: "other",
        name: "manage_task",
        content: taskId ? [textBlock(`Task: ${taskId}`)] : []
      });
    }
    case "schedule": {
      const duration = asStr(pick(rawInput, "DurationSeconds", "durationSeconds"));
      const prompt = asStr(pick(rawInput, "Prompt", "prompt"))?.trim();
      return toolCallUpdate({
        stepRow,
        title: duration ? `Schedule timer (${duration}s)` : "Schedule timer",
        kind: "other",
        name: "schedule",
        content: prompt ? [textBlock(prompt)] : []
      });
    }
    case "send_message": {
      const message = asStr(pick(rawInput, "Message", "message"))?.trim();
      return toolCallUpdate({
        stepRow,
        title: "Send message to subagent",
        kind: "other",
        name: "send_message",
        content: message ? [textBlock(message)] : []
      });
    }
    case "manage_subagents": {
      const action = asStr(pick(rawInput, "Action", "action"))?.trim() || "manage";
      return toolCallUpdate({ stepRow, title: `Subagents: ${action}`, kind: "other", name: "manage_subagents" });
    }
  }

  // Generic fallback: prefer the human-readable summary, then the generic tool
  // titles, then the raw tool name (toolAction is often misleading, so last resort).
  const title =
    asStr(toolRun?.titlePrimary)?.trim() ||
    asStr(pick(rawInput, "toolSummary", "ToolSummary"))?.trim() ||
    asStr(toolRun?.titleSecondary)?.trim() ||
    name ||
    "Tool";

  const content: Record<string, unknown>[] = [];
  if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    const { toolAction: _toolAction, toolSummary: _toolSummary, ...rest } = rawInput as Record<string, unknown>;
    if (Object.keys(rest).length > 0) content.push(codeBlock(JSON.stringify(rest, null, 2)));
  }

  return toolCallUpdate({ stepRow, title, kind: toolKind(name), name, content });
}
