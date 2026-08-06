// Full conversation-history replay for session/load, with a validated cache.
//
// Replays are cached per conversation and validated by a file fingerprint
// (main-file mtime/size/change counter, journal stats, and committed wal-index
// state). On an exact cache hit the result is returned without touching
// SQLite. Any fingerprint change triggers a full rebuild so replay message
// grouping and mutable step snapshots do not depend on prior cache state.

import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { ConversationDb, type DbStat, statConversation } from "./database.js";
import { Lru } from "./lru.js";
import { isReadableFile } from "./tool-call-updates.js";
import { Translator } from "./translator.js";

export interface ReplayOptions {
  skipNarration: boolean;
  cwd?: string;
}

export interface ReplayResult {
  updates: SessionUpdate[];
  /** Highest step idx covered (advances even for steps that emit nothing). */
  maxIdx: number;
}

interface CacheEntry extends ReplayResult {
  stat: DbStat;
  skipNarration: boolean;
  cwd: string | undefined;
  locationReadability: Map<string, boolean>;
}

interface BuiltReplay extends ReplayResult {
  locationReadability: Map<string, boolean>;
}

/** Translate an entire conversation from scratch. Returns null if unreadable. */
function buildReplay(dir: string, id: string, opts: ReplayOptions): BuiltReplay | null {
  const conn = ConversationDb.open(dir, id);
  if (!conn) return null;
  try {
    const translator = new Translator({ mode: "replay", ...opts });
    const updates = translator.translate(conn.readAfter(-1));
    return {
      updates,
      maxIdx: translator.lastStepIdx,
      locationReadability: translator.locationReadability
    };
  } finally {
    conn.close();
  }
}

/** True when two DB fingerprints are identical across every tracked field. */
export function isDbStatUnchanged(a: DbStat, b: DbStat): boolean {
  return (
    a.mtimeMs === b.mtimeMs &&
    a.size === b.size &&
    a.walMtimeMs === b.walMtimeMs &&
    a.walSize === b.walSize &&
    a.walMxFrame === b.walMxFrame &&
    a.walFrameCksum0 === b.walFrameCksum0 &&
    a.walFrameCksum1 === b.walFrameCksum1 &&
    a.journalMtimeMs === b.journalMtimeMs &&
    a.journalSize === b.journalSize &&
    a.changeCounter === b.changeCounter
  );
}

/**
 * Replays conversations into ACP updates, caching results so repeat loads of an
 * unchanged conversation are cheap.
 */
export class ReplayCache {
  private readonly cache: Lru<string, CacheEntry>;

  constructor(capacity: number) {
    this.cache = new Lru(capacity);
  }

  /** Replay a conversation, using/refreshing the cache. Null if unreadable. */
  get(dir: string, id: string, opts: ReplayOptions): ReplayResult | null {
    const stat = statConversation(dir, id);
    if (!stat) return null;

    const entry = this.cache.get(id);
    const sameOptions = entry?.skipNarration === opts.skipNarration && entry?.cwd === opts.cwd;

    if (entry && sameOptions) {
      // Fast path: file identical to what we cached.
      const locationStateUnchanged = [...entry.locationReadability].every(
        ([filePath, wasReadable]) => isReadableFile(filePath) === wasReadable
      );
      if (isDbStatUnchanged(entry.stat, stat) && locationStateUnchanged) {
        return { updates: entry.updates, maxIdx: entry.maxIdx };
      }
    }

    // Full (re)build.
    const built = buildReplay(dir, id, opts);
    if (!built) return null;
    this.cache.set(id, { ...built, stat, skipNarration: opts.skipNarration, cwd: opts.cwd });
    return { updates: built.updates, maxIdx: built.maxIdx };
  }

  /** Manually invalidate cache for a specific conversation ID. */
  invalidate(id: string): void {
    this.cache.delete(id);
  }

  /** Clear all cached conversations. */
  clear(): void {
    this.cache.clear();
  }
}
