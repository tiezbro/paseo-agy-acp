// Reflect *arbitrary* filesystem edits agy made during a turn — including ones
// that never surface as a recognized structured edit tool-call (e.g. edits made
// through `run_command` or an edit payload the translator doesn't decode). The
// edit/diff translator (db/tool-call-updates.ts) + bridge (edit/bridge.ts) only
// cover recognized edits; without this, Zed/Git can show files agy modified
// while ACP emits no corresponding diff update or fs/write-through (see #76).
//
// The snapshot models one thing only: *the content the client has already been
// told each file holds*. Two invariants keep that model honest and keep this
// module out of the business of reimplementing agy's edit semantics or Git's
// ignore semantics:
//
//  1. Content only ever enters the snapshot by reading disk — never by
//     replaying a structured diff onto a remembered body. When a recognized
//     edit is reported to the client, the caller calls
//     {@link observeEditedPaths} for its paths and the on-disk bytes at that
//     moment become the new "client knows this" state. A snippet matcher can
//     never reliably reproduce what agy actually wrote (the file may already
//     carry a later shell edit, the snippet may repeat, a chunk may not
//     apply), and a wrong guess produces a duplicate or destructive synthetic
//     edit. The tradeoff is that an unrecognized change made to the *same*
//     path *earlier in the same turn* is folded into the structured edit
//     instead of being emitted separately; the client's final view still
//     matches disk, which is what #76 asks for.
//  2. Files are keyed by physical identity (`fs.realpath`), and every path
//     comparison happens between strings produced by the *same* root spelling.
//     Aliased/overlapping workspace roots therefore collapse to one entry
//     instead of producing two ACP edits for one physical change, and no
//     lexical `startsWith` ever has to compare a symlinked spelling against a
//     canonical one.
//
// Changes we can't represent as a text diff (binary/oversized/deleted, or a
// file whose pre-turn content was never captured) are reported to the caller
// so it can surface the limitation instead of silently dropping them.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream, promises as fs } from "node:fs";
import * as path from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

const execFileAsync = promisify(execFile);

/** Files larger than this are treated as out-of-scope (reported, not diffed). */
export const MAX_TEXT_BYTES = 1024 * 1024;
/** Directories never worth scanning for agy edits (non-git roots only). */
const SKIP_DIRS = new Set([".git", "node_modules"]);
const LS_FILES_MAX_BUFFER = 64 * 1024 * 1024;

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export interface FileRecord {
  /** Absolute path in the first configured root spelling — what we emit. */
  path: string;
  /** Physical identity (`fs.realpath`); the snapshot's map key. */
  canonicalPath: string;
  sha1: string;
  size: number;
  /** utf-8 contents, or null when binary or oversized (out of scope for a diff). */
  text: string | null;
}

/** A configured workspace root, in both the configured and physical spelling. */
export interface WorkspaceRoot {
  display: string;
  canonical: string;
}

export interface WorkingTreeSnapshot {
  /** Deduplicated by physical identity, in configured order (cwd first). */
  roots: WorkspaceRoot[];
  /** canonical path -> content the client has been told the file holds. */
  files: Map<string, FileRecord>;
  /**
   * Absolute paths (files or directories) the listing deliberately skipped:
   * gitignored entries, symlinks, and the non-git walker's skip list. Recorded
   * in the same root spelling as {@link files}, so a path that only becomes
   * visible later (agy edited an ignore rule) is recognizable as pre-existing
   * rather than invented as a creation whose pre-turn content we never had.
   */
  excluded: string[];
}

export interface ReflectedEdit {
  path: string;
  /** Pre-edit content; null when the file is newly created this turn. */
  oldText: string | null;
  newText: string;
}

export type UnsupportedReason = "binary" | "oversized" | "deleted" | "previously-excluded";

export interface UnsupportedChange {
  path: string;
  reason: UnsupportedReason;
}

export interface ReconcileResult {
  reflected: ReflectedEdit[];
  unsupported: UnsupportedChange[];
}

/** True when `buf` decodes as UTF-8 without replacement. */
export function isValidUtf8(buf: Buffer): boolean {
  try {
    utf8Decoder.decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve configured roots to `{ display, canonical }`, dropping roots that
 * alias a root already listed. The first configured spelling (normally the
 * session cwd) is what emitted paths use.
 */
async function resolveRoots(rootPaths: string[]): Promise<WorkspaceRoot[]> {
  const seen = new Set<string>();
  const roots: WorkspaceRoot[] = [];
  for (const rootPath of rootPaths) {
    const display = path.resolve(rootPath);
    let canonical = display;
    try {
      canonical = await fs.realpath(display);
    } catch {
      // Keep the unresolved spelling; listing decides whether it is readable.
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    roots.push({ display, canonical });
  }
  return roots;
}

interface Listing {
  files: string[];
  excluded: string[];
}

function splitNulList(stdout: string): string[] {
  return stdout.split("\0").filter((entry) => entry.length > 0);
}

/**
 * True when `dir` is the root of a checked-out repository of its own. A plain
 * directory — including a deinitialized submodule, whose gitlink remains as an
 * empty directory — makes git walk up and answer for an ancestor repository,
 * in which case listing inside it would rediscover the parent (and the
 * gitlink entry "./" would recurse into the same directory forever).
 */
async function isCheckedOutRepository(dir: string): Promise<boolean> {
  let top: string;
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { maxBuffer: LS_FILES_MAX_BUFFER });
    top = stdout.trim();
  } catch {
    return false;
  }
  if (!top) return false;
  try {
    // rev-parse may print a different spelling of the same directory (e.g.
    // /tmp vs /private/tmp), so compare physical identities.
    return (await fs.realpath(top)) === (await fs.realpath(dir));
  } catch {
    return top === dir;
  }
}

/**
 * List candidate files under a root. Prefers git (tracked + untracked but not
 * gitignored, so build output and node_modules stay out); falls back to a
 * bounded recursive walk for non-git roots. Checked-out submodules appear as
 * gitlink directories in the parent listing — expand them by listing inside,
 * which also keeps the parent's ignore rules and index from governing the
 * nested repository. Symlinks are never followed (a tracked symlink to a
 * directory is not a gitlink; following it can loop or leave the roots).
 */
async function listRoot(root: string): Promise<Listing> {
  let entries: string[];
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { maxBuffer: LS_FILES_MAX_BUFFER }
    );
    entries = splitNulList(stdout);
  } catch {
    return await walkRoot(root);
  }

  const listing: Listing = { files: [], excluded: [] };
  try {
    // `--directory` collapses a wholly ignored directory into one entry, so
    // this stays cheap even next to a populated node_modules.
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
      { maxBuffer: LS_FILES_MAX_BUFFER }
    );
    for (const rel of splitNulList(stdout)) listing.excluded.push(path.resolve(root, rel));
  } catch {
    // Advisory: without it a newly visible ignored file looks like a creation.
  }

  for (const rel of entries) {
    const abs = path.resolve(root, rel);
    let stats: import("node:fs").Stats;
    try {
      // lstat: do not follow symlinks. Gitlinks (mode 160000) show up as a
      // single path; when checked out that path is a real directory.
      stats = await fs.lstat(abs);
    } catch {
      continue; // vanished between ls-files and lstat
    }
    if (stats.isSymbolicLink()) {
      listing.excluded.push(abs);
    } else if (stats.isDirectory()) {
      // Only an actual checked-out nested repository is listed inside. The
      // self-reference guard rejects a gitlink that git reports for its own
      // directory ("./" from a deinitialized submodule) even before the
      // repository check runs.
      if (abs !== root && (await isCheckedOutRepository(abs))) {
        const nested = await listRoot(abs);
        listing.files.push(...nested.files);
        listing.excluded.push(...nested.excluded);
      }
    } else if (stats.isFile()) {
      listing.files.push(abs);
    }
  }
  return listing;
}

async function walkRoot(dir: string): Promise<Listing> {
  const listing: Listing = { files: [], excluded: [] };
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return listing;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      listing.excluded.push(abs);
    } else if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        listing.excluded.push(abs);
        continue;
      }
      const nested = await walkRoot(abs);
      listing.files.push(...nested.files);
      listing.excluded.push(...nested.excluded);
    } else if (entry.isFile()) {
      listing.files.push(abs);
    }
  }
  return listing;
}

/**
 * Read one path into a {@link FileRecord}, or null when it is not a readable
 * regular file. `expectedCanonicalPath` refuses a path whose physical identity
 * moved since it was recorded (any component replaced by a symlink): the file
 * we tracked is gone, and whatever the spelling now points at must not be read
 * into an ACP update or a write-through.
 */
async function readFileRecord(abs: string, expectedCanonicalPath?: string): Promise<FileRecord | null> {
  let stats: import("node:fs").Stats;
  try {
    stats = await fs.lstat(abs);
  } catch {
    return null;
  }
  if (!stats.isFile()) return null;
  let canonicalPath: string;
  try {
    canonicalPath = await fs.realpath(abs);
  } catch {
    return null;
  }
  if (expectedCanonicalPath !== undefined && canonicalPath !== expectedCanonicalPath) return null;

  // Never buffer multi-megabyte blobs into memory. Hash them as a stream so a
  // same-size replacement with a preserved/coarse mtime is still detected.
  if (stats.size > MAX_TEXT_BYTES) {
    try {
      const hash = createHash("sha1");
      for await (const chunk of createReadStream(abs)) hash.update(chunk);
      return {
        path: abs,
        canonicalPath,
        sha1: `oversized:${stats.size}:${hash.digest("hex")}`,
        size: stats.size,
        text: null
      };
    } catch {
      return null;
    }
  }

  let buf: Buffer;
  try {
    buf = await fs.readFile(abs);
  } catch {
    return null;
  }
  // NUL byte *or* invalid UTF-8 => binary. Invalid UTF-8 must not be handed to
  // the client's text write-through (which would rewrite U+FFFD replacements).
  const isBinary = buf.includes(0) || !isValidUtf8(buf);
  return {
    path: abs,
    canonicalPath,
    sha1: createHash("sha1").update(buf).digest("hex"),
    size: buf.length,
    text: isBinary ? null : buf.toString("utf8")
  };
}

/** Canonicalize a path that may no longer exist, without following a symlink
 *  that replaced any missing component. */
async function canonicalizeMissing(abs: string): Promise<string> {
  const suffix: string[] = [];
  let ancestor = path.resolve(abs);
  while (true) {
    try {
      return path.join(await fs.realpath(ancestor), ...suffix.reverse());
    } catch {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return path.resolve(abs);
      suffix.push(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function rootFor(canonicalPath: string, roots: WorkspaceRoot[]): WorkspaceRoot | undefined {
  for (const root of roots) {
    const relative = path.relative(root.canonical, canonicalPath);
    if (relative === "") return root;
    if (path.isAbsolute(relative)) continue;
    if (relative === ".." || relative.startsWith(`..${path.sep}`)) continue;
    return root;
  }
  return undefined;
}

/** Absolute path in the configured spelling of whichever root contains it. */
function displayPathFor(canonicalPath: string, roots: WorkspaceRoot[]): string | undefined {
  const root = rootFor(canonicalPath, roots);
  if (!root) return undefined;
  const relative = path.relative(root.canonical, canonicalPath);
  return relative === "" ? root.display : path.join(root.display, relative);
}

function isUnder(target: string, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    if (target === prefix || target.startsWith(prefix + path.sep)) return true;
  }
  return false;
}

/** How many files collectFiles reads at once; large repos would otherwise
 *  pay a serial stat+read+hash per file twice a turn. */
const READ_CONCURRENCY = 16;

/** List and read every file the given roots currently expose. */
async function collectFiles(roots: WorkspaceRoot[]): Promise<{ files: Map<string, FileRecord>; excluded: string[] }> {
  const files = new Map<string, FileRecord>();
  const excluded: string[] = [];
  for (const root of roots) {
    const listing = await listRoot(root.display);
    excluded.push(...listing.excluded);
    // Read with bounded concurrency, then apply in listing order: root order
    // and the first-spelling-wins dedup below stay deterministic.
    const records: Array<FileRecord | null> = new Array(listing.files.length).fill(null);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < records.length) {
        const index = next++;
        records[index] = await readFileRecord(listing.files[index]);
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, records.length) }, worker));
    for (const record of records) {
      if (!record) continue;
      // A root spelling replaced or retargeted mid-turn (a directory swapped
      // for a symlink) lists files whose physical location is outside every
      // root captured at turn start. Those must never reach an ACP update or a
      // write-through, however the listing reached them.
      if (!rootFor(record.canonicalPath, roots)) continue;
      // Overlapping roots list one physical file under several spellings; keep
      // the first configured one so emitted paths stay stable.
      if (files.has(record.canonicalPath)) continue;
      files.set(record.canonicalPath, record);
    }
  }
  return { files, excluded };
}

/** Snapshot the working tree across one or more configured roots. */
export async function snapshotWorkingTree(rootPaths: string[]): Promise<WorkingTreeSnapshot> {
  const roots = await resolveRoots(rootPaths);
  const { files, excluded } = await collectFiles(roots);
  return { roots, files, excluded };
}

export interface ReportedBlock {
  /** Text the block replaced, or null when it reported a whole file body. */
  oldText: string | null;
  newText: string;
}

export interface ReportedContent {
  path: string;
  /**
   * The diff blocks the update reported for this path. Disk is recorded only
   * when they account for every difference from the content already recorded;
   * otherwise a change reached the file before the tool-call was polled, the
   * current bytes were never reported, and reconciliation must still emit them.
   * Omit to record disk unconditionally, which only a caller that knows the
   * client has the current state may do — a completed local revert.
   */
  blocks?: ReportedBlock[];
  /** True when `blocks` carry the whole file body (a `write_to_file` call). */
  wholeFile?: boolean;
}

/**
 * True when the reported blocks account for every difference between the
 * content already recorded for a path and what is on disk now.
 *
 * A whole-file write reports the entire body, so equality settles it. A
 * targeted replacement is checked by applying each reported replacement to
 * every occurrence of its target: reproducing disk exactly proves nothing
 * unreported reached the file, while any other outcome fails closed, so a later
 * edit to a different part of the file is reported as an unstructured change
 * instead of being absorbed. This never *derives* recorded content — it only
 * decides whether the bytes on disk were reported — so failing costs one extra,
 * accurate synthetic edit rather than a lost or invented one.
 */
function reportedAccountsForDisk(
  recorded: string | null | undefined,
  blocks: ReportedBlock[],
  wholeFile: boolean,
  disk: string
): boolean {
  if (blocks.length === 0) return false;
  if (wholeFile || blocks.some((block) => block.oldText === null)) {
    return blocks.some((block) => block.newText === disk);
  }
  if (recorded == null) return false;
  let expected = recorded;
  for (const { oldText, newText } of blocks) {
    // An empty target matches everywhere and would accept any file.
    if (oldText === null || oldText === "" || !expected.includes(oldText)) return false;
    expected = expected.split(oldText).join(newText);
  }
  return expected === disk;
}

/**
 * Digest of a reported whole-file body, in the same shape
 * {@link readFileRecord} uses for files too large to buffer, so an oversized
 * text file can be attributed to a whole-file write without buffering it.
 */
function oversizedTextDigest(text: string): string {
  const buf = Buffer.from(text, "utf8");
  return `oversized:${buf.length}:${createHash("sha1").update(buf).digest("hex")}`;
}

/**
 * Record the current on-disk content of paths whose change has *already* been
 * reported to the client (a recognized structured edit, or a synthetic one this
 * module produced), so end-of-turn reconciliation only emits what is still
 * unreflected. Call it while disk holds the reported content — before any
 * write-through revert/replay dance, and again after a rejected edit is
 * reverted. Paths outside the configured roots are ignored, which keeps the
 * snapshot to files this workspace is responsible for.
 */
export async function observeEditedPaths(
  snapshot: WorkingTreeSnapshot,
  reported: ReportedContent[]
): Promise<void> {
  for (const { path: filePath, blocks, wholeFile } of reported) {
    const abs = path.resolve(filePath);
    const record = await readFileRecord(abs);
    const canonicalPath = record?.canonicalPath ?? (await canonicalizeMissing(abs));
    if (!rootFor(canonicalPath, snapshot.roots)) continue;
    const existing = snapshot.files.get(canonicalPath);
    if (!record) {
      // Nothing on disk. Only a caller that knows the client has the current
      // state (a reverted creation) may forget the entry; otherwise something
      // else removed the file and that deletion still has to be reported.
      if (blocks === undefined) snapshot.files.delete(canonicalPath);
      continue;
    }
    if (blocks !== undefined) {
      if (record.text === null) {
        // Binary content cannot round-trip through a text diff block, but an
        // oversized *text* file can still be attributed to a whole-file write:
        // hash the reported body and compare it with the streamed disk hash.
        // (A binary file's plain digest never matches the prefixed form.)
        const attributed =
          wholeFile === true && blocks.some((block) => oversizedTextDigest(block.newText) === record.sha1);
        if (!attributed) continue;
      } else if (!reportedAccountsForDisk(existing?.text, blocks, wholeFile === true, record.text)) {
        continue;
      }
    }
    const retained = existing?.path ?? displayPathFor(canonicalPath, snapshot.roots) ?? abs;
    snapshot.files.set(canonicalPath, { ...record, path: retained });
  }
}

/**
 * Diff the working tree against what the client has been told (see
 * {@link observeEditedPaths}). Added/modified text files become `reflected`
 * edits; anything we cannot represent as a text diff becomes `unsupported`.
 */
export async function reconcileWorkingTree(snapshot: WorkingTreeSnapshot): Promise<ReconcileResult> {
  const { files: current } = await collectFiles(snapshot.roots);

  const reflected: ReflectedEdit[] = [];
  const unsupported: UnsupportedChange[] = [];
  const unrepresentable = (record: FileRecord): UnsupportedReason =>
    record.size > MAX_TEXT_BYTES ? "oversized" : "binary";
  const pushChange = (before: FileRecord, after: FileRecord): void => {
    // No representable oldText (or newText): treating a binary/oversized file
    // as a text create would mislead the client and corrupt write-through.
    if (before.text === null) unsupported.push({ path: before.path, reason: unrepresentable(before) });
    else if (after.text === null) unsupported.push({ path: before.path, reason: unrepresentable(after) });
    else reflected.push({ path: before.path, oldText: before.text, newText: after.text });
  };

  for (const [canonicalPath, after] of current) {
    const before = snapshot.files.get(canonicalPath);
    if (before) {
      if (before.sha1 !== after.sha1) pushChange(before, after);
      continue;
    }
    // Absent from the pre-turn snapshot: a genuine creation, unless the
    // pre-turn listing deliberately skipped it (gitignored, symlinked, skip
    // list) and an edit to those rules has now exposed it. Both spellings come
    // from listings over the same root, so this comparison never crosses
    // aliases.
    if (isUnder(after.path, snapshot.excluded)) {
      unsupported.push({ path: after.path, reason: "previously-excluded" });
    } else if (after.text === null) {
      unsupported.push({ path: after.path, reason: unrepresentable(after) });
    } else {
      reflected.push({ path: after.path, oldText: null, newText: after.text });
    }
  }

  for (const [canonicalPath, before] of snapshot.files) {
    if (current.has(canonicalPath)) continue;
    // Missing from the listing is not the same as missing from disk: a new
    // ignore rule hides a file that is still there, and observed structured
    // edits can target paths the listing never covered. Read the recorded
    // path directly, refusing any spelling whose physical identity moved.
    const after = await readFileRecord(before.path, canonicalPath);
    if (!after) {
      unsupported.push({ path: before.path, reason: "deleted" });
    } else if (before.sha1 !== after.sha1) {
      pushChange(before, { ...after, path: before.path });
    }
  }

  return { reflected, unsupported };
}

/** Absolute path -> project-relative for display; unchanged if outside cwd. */
export function toDisplayPath(filePath: string, cwd?: string): string {
  if (!cwd) return filePath;
  const resolvedCwd = path.resolve(cwd);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile === resolvedCwd || resolvedFile.startsWith(resolvedCwd + path.sep)) {
    return path.relative(resolvedCwd, resolvedFile);
  }
  return filePath;
}

/**
 * Build a synthetic completed-edit `tool_call` update for a reconciled change.
 * Shaped so {@link diffBlocks} (edit/revert.ts) reads it back and the client
 * fs write-through routes it exactly like a recognized edit. `turnToken`, when
 * provided, keeps the tool-call ID unique across turns in the same session.
 */
export function buildReconcileEditUpdate(
  edit: ReflectedEdit,
  index: number,
  cwd?: string,
  turnToken?: string
): SessionUpdate {
  const shown = toDisplayPath(edit.path, cwd);
  const suffix = turnToken !== undefined ? `${turnToken}-${index}` : `${index}`;
  return {
    sessionUpdate: "tool_call",
    toolCallId: `agy-fs-reconcile-${suffix}`,
    name: edit.oldText === null ? "write_to_file" : "edit",
    title: `Edit ${shown}`,
    kind: "edit",
    status: "completed",
    content: [{ type: "diff", path: edit.path, oldText: edit.oldText, newText: edit.newText }]
  } as unknown as SessionUpdate;
}
