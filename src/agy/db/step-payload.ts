// Decoder for the protobuf blob in the `step_payload` column of agy's
// per-conversation SQLite databases (`~/.gemini/antigravity-cli/conversations/<id>.db`).
//
// agy does not publish a .proto schema for this format. The field numbers
// below were determined by inspecting real conversation databases (informed by
// the open-source reverse-engineering in shubzkothekar/antigravity-acp). They
// describe an external binary format agy already writes, so treat the field
// numbers/wire types as load-bearing facts, not a design to be reshuffled —
// but the decoding *code* here is our own compact hand-rolled reader rather
// than a generated client, built on the generic `readMessage` walker in
// ./protowire.ts instead of one bespoke switch statement per message.

import { BinaryReader } from "@bufbuild/protobuf/wire";
import { readInt, readMessage, readSubmessage } from "./protowire.js";

export interface ToolCall {
  callId: string;
  namePrimary: string;
  rawInputJson: string;
  nameSecondary: string;
}

export interface ToolRun {
  call: ToolCall | undefined;
  titlePrimary: string;
  titleSecondary: string;
}

/** One grep_search hit. Field numbers are reverse-engineered from real agy
 *  conversation DBs: 1 = relative file path, 2 = line number (varint),
 *  3 = matched line text, 4 = absolute file path. Field 5 has not been
 *  observed populated in real DBs but is retained for forward-compat. */
export interface SearchHit {
  field1: string;
  /** 1-based line number of the match, or 0 when agy omits it. */
  field2: number;
  field3: string;
  field4: string;
  field5: string;
}

export interface WriteFileResult {
  summary: string;
}

export interface GrepSearchResult {
  query: string;
  includeGlob: string;
  textOutput: string;
  hits: SearchHit[];
  shellCommand: string;
  cwdUri: string;
}

export interface ViewFileResult {
  fileUri: string;
  startLine: number;
  endLine: number;
  content: string;
  nextLine: number;
  fileSizeOrTotal: number;
}

export interface DirEntry {
  name: string;
  isDirectory: number;
  fileSize: number;
}

export interface ListDirectoryResult {
  dirUri: string;
  entries: DirEntry[];
}

export interface UserPromptContent {
  text: string;
}

export interface UserPrompt {
  text: string;
  content: UserPromptContent | undefined;
}

export interface AgentText {
  text: string;
  thought?: string;
}

export interface TitleUpdate {
  title: string;
}

/**
 * Step-payload field 28 — run_command result (decoded from real conversation DBs).
 * Field numbers are load-bearing reverse-engineered facts, not a public schema.
 */
export interface CommandResult {
  cwd: string;
  exitCode?: number;
  /** Shell stdout/stderr text when present (may include truncation markers). */
  output: string;
  command: string;
}

/**
 * Step-payload field 42 — search_web result metadata.
 * Full hit lists are not persisted by agy; only query / refined query (or
 * search URL) appear in the conversation DB.
 */
export interface WebSearchResult {
  query: string;
  /** Refined query text, or a Google search URL, depending on the step. */
  refinedQueryOrUrl: string;
}

/**
 * Step-payload field 40 — read_url_content result.
 * Body text is often huge HTML; callers should truncate for UI display.
 */
export interface UrlContentResult {
  url: string;
  title: string;
  description: string;
  /** Fetched document body when embedded in the payload. */
  body: string;
  /** Optional path to a brain artifact with the full content. */
  contentPath: string;
}

/**
 * Step-payload field 24 — model/provider error wrapper.
 *
 * Observed layout in real conversation DBs:
 *   24 → 3 → {
 *     2: provider summary,
 *     3: HTTP / stack diagnostic,
 *     5: structured response JSON,
 *     9: retry or final user-facing message
 *   }
 */
export interface ModelProviderError {
  summary: string;
  diagnostic: string;
  responseJson: string;
  userMessage: string;
}

/** The blob in the `task_details` column. */
export interface TaskDetails {
  taskId: string;
  logUri: string;
  description: string;
}

/** The blob in the `step_payload` column. Step-type meaning:
 *  5,7,8,9,17,21,33,101,138 = tool run; 15 = agent text; 23 = title update. */
export interface StepPayload {
  validityCheck: number;
  toolRun: ToolRun | undefined;
  writeFile: WriteFileResult | undefined;
  grepSearch: GrepSearchResult | undefined;
  viewFile: ViewFileResult | undefined;
  listDirectory: ListDirectoryResult | undefined;
  userPrompt: UserPrompt | undefined;
  agentText: AgentText | undefined;
  titleUpdate: TitleUpdate | undefined;
  commandResult: CommandResult | undefined;
  webSearch: WebSearchResult | undefined;
  urlContent: UrlContentResult | undefined;
  modelProviderError: ModelProviderError | undefined;
}

function decodeToolCall(bytes: Uint8Array): ToolCall {
  return readMessage(bytes, { callId: "", namePrimary: "", rawInputJson: "", nameSecondary: "" }, {
    1: (m, r) => (m.callId = r.string()),
    2: (m, r) => (m.namePrimary = r.string()),
    3: (m, r) => (m.rawInputJson = r.string()),
    9: (m, r) => (m.nameSecondary = r.string())
  });
}

function decodeToolRun(bytes: Uint8Array): ToolRun {
  return readMessage<ToolRun>(bytes, { call: undefined, titlePrimary: "", titleSecondary: "" }, {
    4: (m, r) => (m.call = readSubmessage(r, decodeToolCall)),
    30: (m, r) => (m.titlePrimary = r.string()),
    31: (m, r) => (m.titleSecondary = r.string())
  });
}

function decodeSearchHit(bytes: Uint8Array): SearchHit {
  return readMessage(bytes, { field1: "", field2: 0, field3: "", field4: "", field5: "" }, {
    1: (m, r) => (m.field1 = r.string()),
    2: (m, r) => (m.field2 = readInt(r)),
    3: (m, r) => (m.field3 = r.string()),
    4: (m, r) => (m.field4 = r.string()),
    5: (m, r) => (m.field5 = r.string())
  });
}

function decodeWriteFileResult(bytes: Uint8Array): WriteFileResult {
  return readMessage(bytes, { summary: "" }, {
    26: (m, r) => (m.summary = r.string())
  });
}

function decodeGrepSearchResult(bytes: Uint8Array): GrepSearchResult {
  return readMessage<GrepSearchResult>(
    bytes,
    { query: "", includeGlob: "", textOutput: "", hits: [], shellCommand: "", cwdUri: "" },
    {
      1: (m, r) => (m.query = r.string()),
      2: (m, r) => (m.includeGlob = r.string()),
      3: (m, r) => (m.textOutput = r.string()),
      4: (m, r) => m.hits.push(readSubmessage(r, decodeSearchHit)),
      10: (m, r) => (m.shellCommand = r.string()),
      11: (m, r) => (m.cwdUri = r.string())
    }
  );
}

function decodeViewFileResult(bytes: Uint8Array): ViewFileResult {
  return readMessage(
    bytes,
    { fileUri: "", startLine: 0, endLine: 0, content: "", nextLine: 0, fileSizeOrTotal: 0 },
    {
      1: (m, r) => (m.fileUri = r.string()),
      2: (m, r) => (m.startLine = readInt(r)),
      3: (m, r) => (m.endLine = readInt(r)),
      4: (m, r) => (m.content = r.string()),
      11: (m, r) => (m.nextLine = readInt(r)),
      12: (m, r) => (m.fileSizeOrTotal = readInt(r))
    }
  );
}

function decodeDirEntry(bytes: Uint8Array): DirEntry {
  return readMessage(bytes, { name: "", isDirectory: 0, fileSize: 0 }, {
    1: (m, r) => (m.name = r.string()),
    2: (m, r) => (m.isDirectory = readInt(r)),
    4: (m, r) => (m.fileSize = readInt(r))
  });
}

function decodeListDirectoryResult(bytes: Uint8Array): ListDirectoryResult {
  return readMessage<ListDirectoryResult>(bytes, { dirUri: "", entries: [] }, {
    1: (m, r) => (m.dirUri = r.string()),
    3: (m, r) => m.entries.push(readSubmessage(r, decodeDirEntry))
  });
}

function decodeUserPromptContent(bytes: Uint8Array): UserPromptContent {
  return readMessage(bytes, { text: "" }, { 1: (m, r) => (m.text = r.string()) });
}

function decodeUserPrompt(bytes: Uint8Array): UserPrompt {
  return readMessage<UserPrompt>(bytes, { text: "", content: undefined }, {
    2: (m, r) => (m.text = r.string()),
    3: (m, r) => (m.content = readSubmessage(r, decodeUserPromptContent))
  });
}

function decodeAgentText(bytes: Uint8Array): AgentText {
  return readMessage<AgentText>(bytes, { text: "" }, {
    1: (m, r) => (m.text = r.string()),
    3: (m, r) => (m.thought = r.string())
  });
}

function decodeTitleUpdate(bytes: Uint8Array): TitleUpdate {
  return readMessage(bytes, { title: "" }, { 4: (m, r) => (m.title = r.string()) });
}

/**
 * Strip leading non-text bytes sometimes present before command output text
 * (truncation metadata / control chars from the wire format).
 */
export function sanitizeCommandOutput(raw: string): string {
  if (!raw) return raw;
  let start = 0;
  while (start < raw.length) {
    const code = raw.charCodeAt(start);
    // Keep normal whitespace; drop other C0 controls and DEL.
    if (code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f)) break;
    start += 1;
  }
  return raw.slice(start);
}

function decodeCommandResult(bytes: Uint8Array): CommandResult {
  return readMessage<CommandResult>(
    bytes,
    { cwd: "", output: "", command: "" },
    {
      2: (m, r) => (m.cwd = r.string()),
      6: (m, r) => (m.exitCode = readInt(r)),
      21: (m, r) => (m.output = sanitizeCommandOutput(r.string())),
      // 23 and 25 both carry the command line in observed DBs; prefer first non-empty.
      23: (m, r) => {
        const command = r.string();
        if (!m.command) m.command = command;
      },
      25: (m, r) => {
        const command = r.string();
        if (!m.command) m.command = command;
      }
    }
  );
}

function decodeWebSearchResult(bytes: Uint8Array): WebSearchResult {
  return readMessage(bytes, { query: "", refinedQueryOrUrl: "" }, {
    1: (m, r) => (m.query = r.string()),
    5: (m, r) => (m.refinedQueryOrUrl = r.string())
  });
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Extract the fetched document body from the nested url-content wrapper.
 * Observed layout: field 6 → field 3 → field 2 (string body). Falls back to
 * the largest nested UTF-8 string when field numbers differ.
 */
function extractUrlContentBody(bytes: Uint8Array): string {
  let body = "";
  readMessage(bytes, {}, {
    3: (_m, r) => {
      const inner = r.bytes();
      readMessage(inner, {}, {
        2: (_m2, r2) => {
          body = r2.string();
        }
      });
    }
  });
  if (body) return body;
  return extractLargestString(bytes);
}

/** Fallback walker: largest nested UTF-8 string (does not re-parse text as protobuf). */
function extractLargestString(bytes: Uint8Array, depth = 0): string {
  if (depth > 6) return "";
  let best = "";
  const reader = new BinaryReader(bytes);
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const wire = tag & 7;
    if (wire === 0) {
      reader.int64();
    } else if (wire === 1) {
      reader.skip(1);
    } else if (wire === 5) {
      reader.skip(5);
    } else if (wire === 2) {
      const slice = reader.bytes();
      let asStr: string | null = null;
      try {
        asStr = utf8Decoder.decode(slice);
      } catch {
        asStr = null;
      }
      if (asStr !== null && !asStr.includes("\0")) {
        // Valid UTF-8 text: take it if longest, but do not re-walk as a message
        // (re-parsing HTML/JSON as protobuf is expensive and meaningless).
        if (asStr.length > best.length) best = asStr;
        continue;
      }
      if (slice.length > 32) {
        const nested = extractLargestString(slice, depth + 1);
        if (nested.length > best.length) best = nested;
      }
    } else {
      break;
    }
  }
  return best;
}

function decodeUrlContentDocument(bytes: Uint8Array): {
  title: string;
  description: string;
  body: string;
} {
  const doc = readMessage(bytes, { title: "", description: "", body: "" }, {
    4: (m, r) => (m.title = r.string()),
    6: (m, r) => {
      const nested = r.bytes();
      const body = extractUrlContentBody(nested);
      if (body.length > m.body.length) m.body = body;
    },
    7: (m, r) => (m.description = r.string())
  });
  return doc;
}

function decodeUrlContentResult(bytes: Uint8Array): UrlContentResult {
  return readMessage<UrlContentResult>(
    bytes,
    { url: "", title: "", description: "", body: "", contentPath: "" },
    {
      1: (m, r) => {
        const url = r.string();
        if (!m.url) m.url = url;
      },
      2: (m, r) => {
        const doc = readSubmessage(r, decodeUrlContentDocument);
        if (doc.title) m.title = doc.title;
        if (doc.description) m.description = doc.description;
        if (doc.body) m.body = doc.body;
      },
      3: (m, r) => {
        const url = r.string();
        if (!m.url) m.url = url;
      },
      6: (m, r) => (m.contentPath = r.string())
    }
  );
}

function decodeModelProviderErrorDetails(bytes: Uint8Array): ModelProviderError {
  return readMessage(
    bytes,
    { summary: "", diagnostic: "", responseJson: "", userMessage: "" },
    {
      2: (m, r) => (m.summary = r.string()),
      3: (m, r) => (m.diagnostic = r.string()),
      5: (m, r) => (m.responseJson = r.string()),
      9: (m, r) => (m.userMessage = r.string())
    }
  );
}

function decodeModelProviderError(bytes: Uint8Array): ModelProviderError | undefined {
  let details: ModelProviderError | undefined;
  readMessage(bytes, {}, {
    3: (_m, r) => (details = readSubmessage(r, decodeModelProviderErrorDetails))
  });
  return details;
}

export function decodeTaskDetails(bytes: Uint8Array): TaskDetails {
  return readMessage(bytes, { taskId: "", logUri: "", description: "" }, {
    1: (m, r) => (m.taskId = r.string()),
    2: (m, r) => (m.logUri = r.string()),
    4: (m, r) => (m.description = r.string())
  });
}

export function decodeStepPayload(bytes: Uint8Array): StepPayload {
  return readMessage<StepPayload>(
    bytes,
    {
      validityCheck: 0,
      toolRun: undefined,
      writeFile: undefined,
      grepSearch: undefined,
      viewFile: undefined,
      listDirectory: undefined,
      userPrompt: undefined,
      agentText: undefined,
      titleUpdate: undefined,
      commandResult: undefined,
      webSearch: undefined,
      urlContent: undefined,
      modelProviderError: undefined
    },
    {
      1: (m, r) => (m.validityCheck = readInt(r)),
      5: (m, r) => (m.toolRun = readSubmessage(r, decodeToolRun)),
      10: (m, r) => (m.writeFile = readSubmessage(r, decodeWriteFileResult)),
      13: (m, r) => (m.grepSearch = readSubmessage(r, decodeGrepSearchResult)),
      14: (m, r) => (m.viewFile = readSubmessage(r, decodeViewFileResult)),
      15: (m, r) => (m.listDirectory = readSubmessage(r, decodeListDirectoryResult)),
      19: (m, r) => (m.userPrompt = readSubmessage(r, decodeUserPrompt)),
      20: (m, r) => (m.agentText = readSubmessage(r, decodeAgentText)),
      24: (m, r) => (m.modelProviderError = readSubmessage(r, decodeModelProviderError)),
      28: (m, r) => (m.commandResult = readSubmessage(r, decodeCommandResult)),
      30: (m, r) => (m.titleUpdate = readSubmessage(r, decodeTitleUpdate)),
      40: (m, r) => (m.urlContent = readSubmessage(r, decodeUrlContentResult)),
      42: (m, r) => (m.webSearch = readSubmessage(r, decodeWebSearchResult))
    }
  );
}
