// Discover agy conversation databases by scanning the conversations directory.
// Used to bind a session to the new DB that agy creates when a fresh prompt runs.

import * as fs from "node:fs";

/** Snapshot the set of conversation ids (`*.db` stems) currently on disk. */
export function conversationSnapshot(dir: string): Set<string> {
  const out = new Set<string>();
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of entries) {
    if (f.endsWith(".db")) out.add(f.slice(0, -3));
  }
  return out;
}

/**
 * Find the single new conversation id created since `before`. Returns null if
 * none — or if several appeared, since we can't safely pick which one belongs
 * to this prompt.
 */
export function newConversationId(
  dir: string,
  before: Set<string>
): string | null {
  const created = [...conversationSnapshot(dir)].filter(
    (id) => !before.has(id)
  );
  if (created.length === 0) return null;
  if (created.length > 1) {
    console.error(
      "[agy-acp] WARN: multiple new agy conversation files appeared; refusing to bind"
    );
    return null;
  }
  return created[0] ?? null;
}
