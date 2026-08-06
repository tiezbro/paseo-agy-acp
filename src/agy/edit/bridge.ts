// Route completed edits through the client's ACP fs/read_text_file +
// fs/write_text_file capability (see acp/fs/read-text-file.ts and
// acp/fs/write-text-file.ts for the raw RPC calls) so the editor's native
// review UI owns the change, instead of agy-acp's own permission-bridge modal.
// Docs: https://agentclientprotocol.com/protocol/v1/file-system
//
// Used when there is no live agy gate (or after one), so Zed's review panel
// (e.g. Zed's Review Changes panel, populated via its own buffer/action-log
// tracking) owns the change instead of agy-acp's local permission-bridge
// modal. See acp_thread.rs::write_text_file: Zed diffs the write's content
// against the buffer snapshot it has cached (from a prior read_text_file, or
// the buffer's live state) — so the file must still read as the pre-edit
// text at the moment we call in, which is why we revert it locally first.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { diffBlocks, hasUniqueOccurrence } from "./revert.js";

export interface ClientFileSystem {
  readTextFile(path: string): Promise<void>;
  writeTextFile(path: string, content: string): Promise<void>;
}

/**
 * Returns true if the edit was handed off to the client (disk ends up back
 * at newText, written by the client itself). Returns false — leaving disk
 * untouched at newText — if there was nothing to route or the client
 * rejected the write-through, so the caller can fall back to the local
 * permission-bridge review.
 */
interface FileToRoute {
  path: string;
  fullOldText: string;
  fullNewText: string;
}

function preflightRouteEdit(toolCall: SessionUpdate): FileToRoute[] | null {
  const blocks = diffBlocks(toolCall);
  if (blocks.length === 0) return null;

  const pathsInOrder: string[] = [];
  const blocksByPath = new Map<string, import("./revert.js").DiffBlock[]>();

  for (const block of blocks) {
    let list = blocksByPath.get(block.path);
    if (!list) {
      list = [];
      blocksByPath.set(block.path, list);
      pathsInOrder.push(block.path);
    }
    list.push(block);
  }

  const filesToRoute: FileToRoute[] = [];

  for (const path of pathsInOrder) {
    if (!existsSync(path)) return null;

    const fullNewText = readFileSync(path, "utf8");
    let current = fullNewText;
    const fileBlocks = blocksByPath.get(path)!;

    for (const { oldText, newText } of fileBlocks) {
      if (current === newText) {
        current = oldText ?? "";
      } else if (hasUniqueOccurrence(current, newText)) {
        current = current.replace(newText, oldText ?? "");
      } else {
        return null; // diverged, missing, or ambiguous match
      }
    }

    filesToRoute.push({
      path,
      fullOldText: current,
      fullNewText
    });
  }

  return filesToRoute;
}

/**
 * Returns true if the edit was handed off to the client (disk ends up back
 * at newText, written by the client itself). Returns false — leaving disk
 * untouched at newText — if there was nothing to route or the client
 * rejected the write-through, so the caller can fall back to the local
 * permission-bridge review.
 */
export async function routeEditThroughClient(toolCall: SessionUpdate, bridge: ClientFileSystem): Promise<boolean> {
  const filesToRoute = preflightRouteEdit(toolCall);
  if (!filesToRoute || filesToRoute.length === 0) return false;

  const reverted: { path: string; fullNewText: string }[] = [];
  try {
    for (const { path, fullOldText, fullNewText } of filesToRoute) {
      writeFileSync(path, fullOldText, "utf8");
      reverted.push({ path, fullNewText });

      await bridge.readTextFile(path);
      await bridge.writeTextFile(path, fullNewText);
    }
    return true;
  } catch {
    // Restore whatever we reverted before the failure, so disk still matches
    // the content already reported via session/update.
    for (const { path, fullNewText } of reverted) {
      try { writeFileSync(path, fullNewText, "utf8"); } catch { /* best effort */ }
    }
    return false;
  }
}

/**
 * Prime the client's buffer snapshot for a live-gated edit *before* agy
 * applies it, while disk still genuinely holds the pre-edit text. Used so
 * the later write-through (see {@link writeEditThroughClient}) doesn't need
 * to revert-then-replay disk itself — which races against the client's own
 * file watcher if the buffer is already open there. Best effort: failures
 * are swallowed, since a missed prime just means the later write-through
 * won't produce a clean diff and the caller falls back silently.
 */
export async function primeEditReadThroughClient(toolCall: SessionUpdate, bridge: ClientFileSystem): Promise<void> {
  const paths = new Set(diffBlocks(toolCall).map((block) => block.path));
  for (const path of paths) {
    try {
      await bridge.readTextFile(path);
    } catch {
      // best effort
    }
  }
}

/**
 * Write an edit through the client after agy has already applied it *and*
 * the pre-edit state was primed via {@link primeEditReadThroughClient} —
 * no local revert needed, since disk was never touched by us in between.
 */
export async function writeEditThroughClient(toolCall: SessionUpdate, bridge: ClientFileSystem): Promise<boolean> {
  const paths = Array.from(new Set(diffBlocks(toolCall).map((block) => block.path)));
  if (paths.length === 0) return false;
  for (const path of paths) {
    if (!existsSync(path)) return false;
  }
  try {
    for (const path of paths) {
      await bridge.writeTextFile(path, readFileSync(path, "utf8"));
    }
    return true;
  } catch {
    return false;
  }
}
