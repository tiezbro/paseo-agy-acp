// Minimal protobuf encoder for building `steps` table fixtures in tests. Only
// covers the fields our decoder (ACP Connector/agy/db/step-payload.ts) actually reads;
// field numbers must match that module's decode side exactly.

import { BinaryWriter } from "@bufbuild/protobuf/wire";

function submessage(writer: BinaryWriter, fieldNo: number, bytes: Uint8Array): void {
  writer.tag(fieldNo, 2).bytes(bytes);
}

export function encodeToolCall(call: {
  callId?: string;
  namePrimary?: string;
  rawInputJson?: string;
  nameSecondary?: string;
}): Uint8Array {
  const w = new BinaryWriter();
  if (call.callId) w.tag(1, 2).string(call.callId);
  if (call.namePrimary) w.tag(2, 2).string(call.namePrimary);
  if (call.rawInputJson) w.tag(3, 2).string(call.rawInputJson);
  if (call.nameSecondary) w.tag(9, 2).string(call.nameSecondary);
  return w.finish();
}

export function encodeToolRun(run: { call?: Uint8Array; titlePrimary?: string; titleSecondary?: string }): Uint8Array {
  const w = new BinaryWriter();
  if (run.call) submessage(w, 4, run.call);
  if (run.titlePrimary) w.tag(30, 2).string(run.titlePrimary);
  if (run.titleSecondary) w.tag(31, 2).string(run.titleSecondary);
  return w.finish();
}

export function encodeAgentText(text: string | { text?: string; thought?: string }, thought?: string): Uint8Array {
  const w = new BinaryWriter();
  if (typeof text === "object") {
    if (text.text) w.tag(1, 2).string(text.text);
    if (text.thought) w.tag(3, 2).string(text.thought);
  } else {
    if (text) w.tag(1, 2).string(text);
    if (thought) w.tag(3, 2).string(thought);
  }
  return w.finish();
}

export function encodeTitleUpdate(title: string): Uint8Array {
  const w = new BinaryWriter();
  w.tag(4, 2).string(title);
  return w.finish();
}

export function encodeUserPrompt(text: string): Uint8Array {
  const w = new BinaryWriter();
  w.tag(2, 2).string(text);
  return w.finish();
}

export function encodeCommandResult(result: {
  cwd?: string;
  exitCode?: number;
  output?: string;
  command?: string;
}): Uint8Array {
  const w = new BinaryWriter();
  if (result.cwd) w.tag(2, 2).string(result.cwd);
  if (result.exitCode !== undefined) w.tag(6, 0).int64(result.exitCode);
  if (result.output) w.tag(21, 2).string(result.output);
  if (result.command) {
    w.tag(23, 2).string(result.command);
    w.tag(25, 2).string(result.command);
  }
  return w.finish();
}

export function encodeWebSearchResult(result: { query?: string; refinedQueryOrUrl?: string }): Uint8Array {
  const w = new BinaryWriter();
  if (result.query) w.tag(1, 2).string(result.query);
  if (result.refinedQueryOrUrl) w.tag(5, 2).string(result.refinedQueryOrUrl);
  return w.finish();
}

export function encodeUrlContentResult(result: {
  url?: string;
  title?: string;
  description?: string;
  body?: string;
  contentPath?: string;
}): Uint8Array {
  const w = new BinaryWriter();
  if (result.url) w.tag(1, 2).string(result.url);

  // document submessage (field 2): title=4, body nested at 6.3.2, description=7
  if (result.title || result.description || result.body) {
    const doc = new BinaryWriter();
    if (result.title) doc.tag(4, 2).string(result.title);
    if (result.body) {
      const bodyInner = new BinaryWriter();
      bodyInner.tag(2, 2).string(result.body);
      const bodyWrap = new BinaryWriter();
      submessage(bodyWrap, 3, bodyInner.finish());
      submessage(doc, 6, bodyWrap.finish());
    }
    if (result.description) doc.tag(7, 2).string(result.description);
    submessage(w, 2, doc.finish());
  }

  if (result.contentPath) w.tag(6, 2).string(result.contentPath);
  return w.finish();
}

export function encodeModelProviderError(error: {
  summary?: string;
  diagnostic?: string;
  responseJson?: string;
  userMessage?: string;
}): Uint8Array {
  const details = new BinaryWriter();
  if (error.summary) details.tag(2, 2).string(error.summary);
  if (error.diagnostic) details.tag(3, 2).string(error.diagnostic);
  if (error.responseJson) details.tag(5, 2).string(error.responseJson);
  if (error.userMessage) details.tag(9, 2).string(error.userMessage);

  const wrapper = new BinaryWriter();
  submessage(wrapper, 3, details.finish());
  return wrapper.finish();
}

export function encodeViewFileResult(result: {
  fileUri?: string;
  startLine?: number;
  endLine?: number;
  content?: string;
}): Uint8Array {
  const w = new BinaryWriter();
  if (result.fileUri) w.tag(1, 2).string(result.fileUri);
  if (result.startLine !== undefined) w.tag(2, 0).int64(result.startLine);
  if (result.endLine !== undefined) w.tag(3, 0).int64(result.endLine);
  if (result.content !== undefined) w.tag(4, 2).string(result.content);
  return w.finish();
}

/** grep_search hit: 1 = relative path, 2 = line number (varint),
 *  3 = matched text, 4 = absolute path. Mirrors `decodeSearchHit`. */
export function encodeSearchHit(hit: {
  field1?: string;
  field2?: number;
  field3?: string;
  field4?: string;
}): Uint8Array {
  const w = new BinaryWriter();
  if (hit.field1) w.tag(1, 2).string(hit.field1);
  if (hit.field2 !== undefined) w.tag(2, 0).int64(hit.field2);
  if (hit.field3) w.tag(3, 2).string(hit.field3);
  if (hit.field4) w.tag(4, 2).string(hit.field4);
  return w.finish();
}

export function encodeGrepSearchResult(result: {
  query?: string;
  includeGlob?: string;
  textOutput?: string;
  hits?: Uint8Array[];
  shellCommand?: string;
  cwdUri?: string;
}): Uint8Array {
  const w = new BinaryWriter();
  if (result.query) w.tag(1, 2).string(result.query);
  if (result.includeGlob) w.tag(2, 2).string(result.includeGlob);
  if (result.textOutput) w.tag(3, 2).string(result.textOutput);
  for (const hit of result.hits ?? []) submessage(w, 4, hit);
  if (result.shellCommand) w.tag(10, 2).string(result.shellCommand);
  if (result.cwdUri) w.tag(11, 2).string(result.cwdUri);
  return w.finish();
}

export function encodeTaskDetails(task: { taskId?: string; logUri?: string; description?: string }): Uint8Array {
  const w = new BinaryWriter();
  if (task.taskId) w.tag(1, 2).string(task.taskId);
  if (task.logUri) w.tag(2, 2).string(task.logUri);
  if (task.description) w.tag(3, 2).string(task.description);
  return w.finish();
}

/** permissions column: { 2: { 1: { 1: kind, 2: value }, 2: decision } }. */
export function encodePermissions(info: { kind?: string; value?: string; decision?: number }): Uint8Array {
  const target = new BinaryWriter();
  if (info.kind) target.tag(1, 2).string(info.kind);
  if (info.value) target.tag(2, 2).string(info.value);

  const entry = new BinaryWriter();
  submessage(entry, 1, target.finish());
  if (info.decision !== undefined) entry.tag(2, 0).int64(info.decision);

  const w = new BinaryWriter();
  submessage(w, 2, entry.finish());
  return w.finish();
}

export function encodeStepPayload(opts: {
  toolRun?: Uint8Array;
  agentText?: string | { text?: string; thought?: string } | Uint8Array;
  titleUpdate?: string;
  userPrompt?: string;
  commandResult?: Uint8Array;
  viewFile?: Uint8Array;
  grepSearch?: Uint8Array;
  webSearch?: Uint8Array;
  urlContent?: Uint8Array;
  modelProviderError?: Uint8Array;
}): Uint8Array {
  const w = new BinaryWriter();
  if (opts.toolRun) submessage(w, 5, opts.toolRun);
  if (opts.grepSearch) submessage(w, 13, opts.grepSearch);
  if (opts.viewFile) submessage(w, 14, opts.viewFile);
  if (opts.userPrompt !== undefined) submessage(w, 19, encodeUserPrompt(opts.userPrompt));
  if (opts.agentText !== undefined) {
    const bytes = opts.agentText instanceof Uint8Array ? opts.agentText : encodeAgentText(opts.agentText);
    submessage(w, 20, bytes);
  }
  if (opts.modelProviderError) submessage(w, 24, opts.modelProviderError);
  if (opts.commandResult) submessage(w, 28, opts.commandResult);
  if (opts.titleUpdate !== undefined) submessage(w, 30, encodeTitleUpdate(opts.titleUpdate));
  if (opts.urlContent) submessage(w, 40, opts.urlContent);
  if (opts.webSearch) submessage(w, 42, opts.webSearch);
  return w.finish();
}
