// Read-only access to agy's per-conversation SQLite databases.
//
// A `ConversationDb` keeps one DB handle + prepared statement open so the
// streaming poll loop can read repeatedly without re-opening the file each
// tick. One-shot `readRows` is provided for replay, where a single read is all
// that's needed.

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";
import { decodeErrorDetails, decodePermissions, decodeTaskDetails } from "./columns.js";
import { decodeStepPayload } from "./step-payload.js";
import type { StepRow } from "./types.js";

const SELECT_ROWS =
  "SELECT idx, step_type, status, step_payload, error_details, permissions, task_details " +
  "FROM steps WHERE idx > ? ORDER BY idx";

interface RawRow {
  idx: number;
  step_type: number;
  status: number;
  step_payload: unknown;
  error_details: unknown;
  permissions: unknown;
  task_details: unknown;
}

function toUint8(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Buffer.isBuffer(v)) return new Uint8Array(v);
  return new Uint8Array(0);
}

/** Decode an optional blob column, returning null when absent/empty. */
function decodeColumn<T>(v: unknown, decode: (b: Uint8Array) => T): T | null {
  const bytes = toUint8(v);
  return bytes.length === 0 ? null : decode(bytes);
}

function rowToStep(r: RawRow): StepRow {
  return {
    idx: r.idx,
    stepType: r.step_type,
    status: r.status ?? 0,
    stepPayload: decodeStepPayload(toUint8(r.step_payload)),
    error: decodeColumn(r.error_details, decodeErrorDetails),
    permission: decodeColumn(r.permissions, decodePermissions),
    task: decodeColumn(r.task_details, decodeTaskDetails)
  };
}

export function conversationDbPath(dir: string, id: string): string {
  return path.join(dir, `${id}.db`);
}

/** A live identity for a conversation DB file, used to validate caches. */
export interface DbStat {
  mtimeMs: number;
  size: number;
  walMtimeMs?: number;
  walSize?: number;
  journalMtimeMs?: number;
  journalSize?: number;
  changeCounter: number;
  /**
   * Committed WAL state from the wal-index (`-shm`) header: the committed frame
   * count (mxFrame) and the cumulative checksum chain through that frame. In
   * WAL mode the main-file change counter only advances on checkpoint, and WAL
   * file metadata/content cannot prove the committed state is unchanged: commit
   * frames reach the file before mxFrame is published, RESTART checkpoints
   * leave the file allocated, and rolled-back spill frames are reused without
   * bumping header salts. The wal-index is the same publication point SQLite
   * readers consult, so keying on it ties the fingerprint to exactly the
   * snapshot a replay build reads. A torn shm read only causes a spurious
   * rebuild (safe direction), never a stale hit.
   */
  walMxFrame?: number;
  walFrameCksum0?: number;
  walFrameCksum1?: number;
}

/** Known wal-index format version (WalIndexHdr.iVersion). */
const WAL_INDEX_VERSION = 3007000;

/** Read committed WAL state from the wal-index (`-shm`) header, or null when
 *  absent/short/unparseable. Fixed 48-byte read; never reads the WAL itself. */
function readWalIndexState(shmPath: string): {
  mxFrame: number;
  frameCksum0: number;
  frameCksum1: number;
} | null {
  try {
    const fd = fs.openSync(shmPath, "r");
    try {
      const buf = Buffer.alloc(48);
      if (fs.readSync(fd, buf, 0, 48, 0) !== 48) return null;
      // The wal-index uses the writer's native byte order; detect it via the
      // known iVersion constant at offset 0.
      const little = buf.readUInt32LE(0) === WAL_INDEX_VERSION;
      if (!little && buf.readUInt32BE(0) !== WAL_INDEX_VERSION) return null;
      const u32 = (off: number): number => (little ? buf.readUInt32LE(off) : buf.readUInt32BE(off));
      return { mxFrame: u32(16), frameCksum0: u32(24), frameCksum1: u32(28) };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Stat a conversation DB, or null if it doesn't exist. */
export function statConversation(dir: string, id: string): DbStat | null {
  const dbPath = conversationDbPath(dir, id);
  try {
    const s = fs.statSync(dbPath);

    let walMtimeMs: number | undefined;
    let walSize: number | undefined;
    let walMxFrame: number | undefined;
    let walFrameCksum0: number | undefined;
    let walFrameCksum1: number | undefined;
    try {
      const ws = fs.statSync(`${dbPath}-wal`);
      walMtimeMs = ws.mtimeMs;
      walSize = ws.size;
      const walIndex = readWalIndexState(`${dbPath}-shm`);
      if (walIndex) {
        walMxFrame = walIndex.mxFrame;
        walFrameCksum0 = walIndex.frameCksum0;
        walFrameCksum1 = walIndex.frameCksum1;
      }
    } catch {
      // no wal file
    }

    let journalMtimeMs: number | undefined;
    let journalSize: number | undefined;
    try {
      const js = fs.statSync(`${dbPath}-journal`);
      journalMtimeMs = js.mtimeMs;
      journalSize = js.size;
    } catch {
      // no journal file
    }

    let changeCounter = 0;
    try {
      const fd = fs.openSync(dbPath, "r");
      try {
        const buf = Buffer.alloc(4);
        if (fs.readSync(fd, buf, 0, 4, 24) === 4) {
          changeCounter = buf.readUInt32BE(0);
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // ignore read errors
    }

    return {
      mtimeMs: s.mtimeMs,
      size: s.size,
      walMtimeMs,
      walSize,
      walMxFrame,
      walFrameCksum0,
      walFrameCksum1,
      journalMtimeMs,
      journalSize,
      changeCounter
    };
  } catch {
    return null;
  }
}

/** An open, reusable read handle on one conversation's steps table. */
export class ConversationDb {
  private constructor(
    private readonly db: Database.Database,
    private readonly stmt: Database.Statement,
    private readonly dataVersionStmt: Database.Statement
  ) {}

  /** Open a conversation DB, or null if missing/unreadable or lacking a steps table. */
  static open(dir: string, id: string): ConversationDb | null {
    const dbPath = conversationDbPath(dir, id);
    if (!fs.existsSync(dbPath)) return null;

    try {
      const db = new Database(dbPath, { readonly: true, fileMustExist: true });
      const hasSteps = db
        .prepare(
          "SELECT COUNT(*) > 0 AS present FROM sqlite_master WHERE type='table' AND name='steps'"
        )
        .get() as { present: number } | undefined;
      if (!hasSteps?.present) {
        db.close();
        console.error(`[agy-acp] WARN: steps table not found in ${id}.db — schema changed?`);
        return null;
      }
      return new ConversationDb(
        db,
        db.prepare(SELECT_ROWS),
        db.prepare("PRAGMA data_version")
      );
    } catch {
      return null;
    }
  }

  /** Read decoded step rows with idx > afterStepIdx, in order.
   *
   * A row whose blob fails to decode (e.g. a torn read of a row agy is still
   * writing to) is logged and dropped rather than thrown — one bad row must
   * not take down the whole poll loop. Since it's dropped, not consumed, its
   * idx isn't advanced past, so it's naturally retried on the next read once
   * the write settles. */
  readAfter(afterStepIdx: number): StepRow[] & { hasDecodeError: boolean } {
    const rows = this.stmt.all(afterStepIdx) as RawRow[];
    const out: StepRow[] & { hasDecodeError?: boolean } = [];
    let hasDecodeError = false;
    for (const r of rows) {
      try {
        out.push(rowToStep(r));
      } catch (error) {
        hasDecodeError = true;
        console.error(
          `[agy-acp] WARN: failed to decode step ${r.idx}, skipping: ${(error as Error).message}`
        );
      }
    }
    out.hasDecodeError = hasDecodeError;
    return out as StepRow[] & { hasDecodeError: boolean };
  }

  /** SQLite generation counter, incremented when another connection commits. */
  dataVersion(): number {
    const row = this.dataVersionStmt.get() as { data_version?: number } | undefined;
    return row?.data_version ?? 0;
  }

  close(): void {
    this.db.close();
  }
}

/** One-shot read of decoded step rows with idx > afterStepIdx. Returns null if
 *  the DB is missing/unreadable. */
export function readRows(dir: string, id: string, afterStepIdx: number): StepRow[] | null {
  const conn = ConversationDb.open(dir, id);
  if (!conn) return null;
  try {
    return conn.readAfter(afterStepIdx);
  } finally {
    conn.close();
  }
}
