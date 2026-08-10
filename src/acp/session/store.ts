// ACP Session Setup / List: persist bindings for session/load, session/resume,
// and session/list across server restarts.
// Docs: https://agentclientprotocol.com/protocol/v1/session-setup
//
// Writes are serialized through an in-process promise chain (so concurrent
// persists can't clobber each other) and committed atomically via temp-file +
// rename.
//
// Stored under its own directory (not the sibling `antigravity-acp` project's
// `~/.agy-acp`) so the two tools can't collide if both happen to be installed.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Where session bindings live. Exposed as a
 *  function (rather than a module-level constant) so callers — including
 *  tests — can control it, instead of it being fixed at module-load time. */
export function defaultStateDir(): string {
  return path.join(os.homedir(), ".agy-acp-state");
}

/** Persisted ACP session binding (fields aligned with session config + setup). */
export interface StoredSession {
  cwd: string;
  /** ACP `additionalDirectories` (does not include `cwd`). */
  additionalDirectories: string[];
  conversationId: string | null;
  lastStepIdx: number;
  /** Matches ACP config option `model` (base slug for agy --model). */
  model: string;
  /** Matches ACP config option `reasoningEffort` (maps to agy --effort). */
  reasoningEffort: string;
  /** Matches ACP config option `mode`. Absent on older store files. */
  mode?: string;
  /** Stable v2 user-message IDs keyed by their persisted agy step index. */
  v2UserMessageIdsByStep: Record<string, string>;
  updatedAt: string;
}

/**
 * Persistence contract shared by the legacy JSON store and the SQLite runtime
 * store. AcpAgent uses this contract so the established session API remains
 * independent of the selected persistence backend.
 */
export interface SessionStoreBackend {
  restore(sessionId: string): Promise<StoredSession | null>;
  list(filter?: { cwd?: string | null }): Promise<Array<{ sessionId: string } & StoredSession>>;
  persist(sessionId: string, session: StoredSession): Promise<void>;
  delete(sessionId: string): Promise<boolean>;
}

interface DiskStore {
  sessions: Record<string, StoredSession>;
}

export class SessionStore implements SessionStoreBackend {
  #writeChain: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(private readonly dir: string) {
    this.file = path.join(dir, "sessions.json");
  }

  /** Restore a persisted session binding, or null if none exists. */
  async restore(sessionId: string): Promise<StoredSession | null> {
    const store = await this.load();
    return store.sessions[sessionId] ?? null;
  }

  /**
   * List persisted session bindings, newest first.
   * Optional `cwd` filters to sessions whose stored working directory matches.
   */
  async list(filter?: { cwd?: string | null }): Promise<Array<{ sessionId: string } & StoredSession>> {
    const store = await this.load();
    const cwd = filter?.cwd ?? null;
    return Object.entries(store.sessions)
      .filter(([, session]) => cwd == null || session.cwd === cwd)
      .map(([sessionId, session]) => ({ sessionId, ...session }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /** Persist a session binding. Resolves once written (writes are serialized). */
  persist(sessionId: string, session: StoredSession): Promise<void> {
    this.#writeChain = this.#writeChain.then(() => this.writeOne(sessionId, session)).catch((error) => {
      console.error(`[agy-acp] WARN: failed to persist session: ${(error as Error).message}`);
    });
    return this.#writeChain;
  }

  /** Delete a persisted session binding. Resolves once written (writes are serialized). Returns true if deleted. */
  delete(sessionId: string): Promise<boolean> {
    let deleted = false;
    this.#writeChain = this.#writeChain
      .then(async () => {
        deleted = await this.deleteOne(sessionId);
      })
      .catch((error) => {
        console.error(`[agy-acp] WARN: failed to delete session: ${(error as Error).message}`);
      });
    return this.#writeChain.then(() => deleted);
  }

  private async load(): Promise<DiskStore> {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.file, "utf-8")) as {
        sessions?: Record<string, LegacyStoredSession>;
      };
      const sessions: Record<string, StoredSession> = {};
      for (const [id, raw] of Object.entries(parsed.sessions ?? {})) {
        sessions[id] = normalizeStoredSession(raw);
      }
      return { sessions };
    } catch {
      return { sessions: {} };
    }
  }

  private async writeOne(sessionId: string, session: StoredSession): Promise<void> {
    const store = await this.load();
    store.sessions[sessionId] = session;
    await fs.promises.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(store, null, 2));
    await fs.promises.rename(tmp, this.file);
  }

  private async deleteOne(sessionId: string): Promise<boolean> {
    const store = await this.load();
    if (!(sessionId in store.sessions)) {
      return false;
    }
    delete store.sessions[sessionId];
    await fs.promises.mkdir(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(store, null, 2));
    await fs.promises.rename(tmp, this.file);
    return true;
  }
}

/** Legacy disk keys from older agy-acp builds. */
type LegacyStoredSession = Partial<StoredSession> & {
  modelId?: string;
  /** Pre-ACP rename of `reasoningEffort`. */
  reasoningEffect?: string;
  /** Pre-ACP rename: used to store `[cwd, ...additionalDirectories]`. */
  workspaces?: string[];
};

/** Map legacy disk keys to current ACP-aligned field names. */
function normalizeStoredSession(raw: LegacyStoredSession): StoredSession {
  const cwd = raw.cwd ?? "";
  const additionalDirectories =
    raw.additionalDirectories ??
    (Array.isArray(raw.workspaces) ? raw.workspaces.filter((w) => w !== cwd) : []);

  return {
    cwd,
    additionalDirectories,
    conversationId: raw.conversationId ?? null,
    lastStepIdx: raw.lastStepIdx ?? -1,
    model: raw.model ?? raw.modelId ?? "",
    reasoningEffort: raw.reasoningEffort ?? raw.reasoningEffect ?? "",
    mode: raw.mode,
    v2UserMessageIdsByStep: normalizeMessageIdMap(raw.v2UserMessageIdsByStep),
    updatedAt: raw.updatedAt ?? new Date(0).toISOString()
  };
}

function normalizeMessageIdMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([stepIdx, messageId]) => /^\d+$/.test(stepIdx) && typeof messageId === "string" && messageId.length > 0
    )
  ) as Record<string, string>;
}
