import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSqliteProviderObserver,
  createSqliteProviderObserverForDirectory,
  type SqliteProviderSnapshotReader
} from "../src/agy/db/provider-observer.js";
import { normalizeTerminalObservation } from "../src/admission/terminal-evidence.js";
import { createConversationDb, insertStep } from "./fixtures/conversation-db.js";
import { encodeModelProviderError, encodeStepPayload } from "./fixtures/step-encoder.js";

const CONVERSATION_ID = "conversation-exact";
const OBSERVED_AT = 1_725_000_000_000;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function activeSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversationId: CONVERSATION_ID,
    cursor: 7,
    latest: {
      cursor: 7,
      kind: "activity",
      status: "ACTIVE"
    },
    backgroundTasks: "settled",
    ...overrides
  };
}

function terminalSnapshot(
  status: "SUCCESS" | "ERROR" | "CANCELED" | "INTERRUPTED",
  rowOverrides: Record<string, unknown> = {},
  snapshotOverrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    conversationId: CONVERSATION_ID,
    cursor: 9,
    latest: {
      cursor: 9,
      kind: "terminal",
      status,
      ...rowOverrides
    },
    backgroundTasks: "settled",
    ...snapshotOverrides
  };
}

function reader(snapshot: unknown, seen?: string[]): SqliteProviderSnapshotReader {
  return {
    readSnapshot(conversationId) {
      seen?.push(conversationId);
      return snapshot as never;
    }
  };
}

function observerFor(snapshot: unknown, seen?: string[]) {
  return createSqliteProviderObserver({
    reader: reader(snapshot, seen),
    now: () => OBSERVED_AT
  });
}

describe("SQLite provider observer", () => {
  it("requires an exact conversation binding and passes only that ID to its reader", async () => {
    const seen: string[] = [];
    const observer = createSqliteProviderObserver({
      reader: {
        readSnapshot(conversationId) {
          seen.push(conversationId);
          return activeSnapshot({ conversationId }) as never;
        }
      },
      now: () => OBSERVED_AT
    });

    await expect(observer.bind(CONVERSATION_ID).observeActivity()).resolves.toEqual({
      status: "observed",
      activity: {
        source: "sqlite_reconciliation",
        conversationId: CONVERSATION_ID,
        cursor: 7,
        observedAt: OBSERVED_AT,
        status: "ACTIVE"
      }
    });
    expect(seen).toEqual([CONVERSATION_ID]);
    expect(() => observer.bind("")).toThrow(/conversation ID/i);
    expect(() => observer.bind("../other-conversation")).toThrow(/conversation ID/i);
  });

  it("observes activity only from an exact structured SQLite row and cursor", async () => {
    const cases: unknown[] = [
      null,
      activeSnapshot({ conversationId: "other-conversation" }),
      activeSnapshot({ cursor: 8 }),
      activeSnapshot({ backgroundTasks: "unknown" }),
      activeSnapshot({ header: "Authorization: Bearer private-token" }),
      activeSnapshot({
        latest: { cursor: 7, kind: "activity", status: "ACTIVE", rawPrompt: "private prompt" }
      })
    ];

    for (const snapshot of cases) {
      await expect(observerFor(snapshot).bind(CONVERSATION_ID).observeActivity()).resolves.toEqual({
        status: "unobserved"
      });
    }
  });

  it("emits only a whitelist-shaped SQLite-primary terminal for every official status", async () => {
    for (const status of ["SUCCESS", "CANCELED", "INTERRUPTED"] as const) {
      const terminal = await observerFor(terminalSnapshot(status)).bind(CONVERSATION_ID).observeTerminal();

      expect(terminal).toEqual({
        source: "sqlite_reconciliation",
        conversationId: CONVERSATION_ID,
        observedAt: OBSERVED_AT,
        status
      });
      expect(Object.keys(terminal ?? {}).sort()).toEqual([
        "conversationId",
        "observedAt",
        "source",
        "status"
      ]);
    }
  });

  it("preserves structured capacity and quota semantics without retaining raw provider text", async () => {
    const cases = [
      { httpStatus: 503, code: "UNAVAILABLE", category: "provider_capacity" },
      { httpStatus: 503, code: "MODEL_CAPACITY_EXHAUSTED", category: "provider_capacity" },
      { httpStatus: 429, code: "QUOTA_EXHAUSTED", category: "quota" }
    ] as const;

    for (const { httpStatus, code, category } of cases) {
      const terminal = await observerFor(terminalSnapshot("ERROR", { httpStatus, code }))
        .bind(CONVERSATION_ID)
        .observeTerminal();

      expect(terminal).toEqual({
        source: "sqlite_reconciliation",
        conversationId: CONVERSATION_ID,
        observedAt: OBSERVED_AT,
        status: "ERROR",
        httpStatus,
        code
      });
      expect(normalizeTerminalObservation(terminal)).toMatchObject({
        outcome: "failed",
        failure: { category, httpStatus, code }
      });
    }
  });

  it("retains only safe auth, permission, timeout, and transport status evidence", async () => {
    for (const httpStatus of [401, 403, 408, 502]) {
      const terminal = await observerFor(terminalSnapshot("ERROR", { httpStatus }))
        .bind(CONVERSATION_ID)
        .observeTerminal();

      expect(terminal).toEqual({
        source: "sqlite_reconciliation",
        conversationId: CONVERSATION_ID,
        observedAt: OBSERVED_AT,
        status: "ERROR",
        httpStatus
      });
      expect(Object.keys(terminal ?? {}).sort()).toEqual([
        "conversationId",
        "httpStatus",
        "observedAt",
        "source",
        "status"
      ]);
    }
  });

  it("fails closed for unreadable, mismatched, non-terminal, background, or raw-bearing terminal input", async () => {
    const privateText = "raw prompt and Authorization header must not escape";
    const cases: SqliteProviderSnapshotReader[] = [
      { readSnapshot: () => null },
      { readSnapshot: () => { throw new Error(privateText); } },
      reader(terminalSnapshot("SUCCESS", {}, { conversationId: "other-conversation" })),
      reader(terminalSnapshot("SUCCESS", { rawStdout: privateText })),
      reader(terminalSnapshot("SUCCESS", { reasoning: privateText })),
      reader(terminalSnapshot("SUCCESS", { header: privateText })),
      reader(terminalSnapshot("SUCCESS", { prompt: privateText })),
      reader(terminalSnapshot("SUCCESS", { httpStatus: 503 })),
      reader(terminalSnapshot("ERROR", { code: "UNAVAILABLE" })),
      reader(terminalSnapshot("ERROR", { httpStatus: 503, code: "QUOTA_EXHAUSTED" })),
      reader(terminalSnapshot("SUCCESS", { cursor: 8 })),
      reader(terminalSnapshot("SUCCESS", { unexpected: privateText })),
      reader(terminalSnapshot("SUCCESS", {}, { backgroundTasks: "active" }))
    ];

    for (const source of cases) {
      const result = await createSqliteProviderObserver({ reader: source, now: () => OBSERVED_AT })
        .bind(CONVERSATION_ID)
        .observeTerminal();
      expect(result).toBeNull();
      expect(JSON.stringify(result)).not.toContain(privateText);
    }
  });

  it("issues an observed terminal at most once, including concurrent reads", async () => {
    let reads = 0;
    const observer = createSqliteProviderObserver({
      reader: {
        async readSnapshot() {
          reads += 1;
          await Promise.resolve();
          return terminalSnapshot("SUCCESS") as never;
        }
      },
      now: () => OBSERVED_AT
    }).bind(CONVERSATION_ID);

    const [first, concurrent] = await Promise.all([observer.observeTerminal(), observer.observeTerminal()]);
    expect([first, concurrent]).toContainEqual({
      source: "sqlite_reconciliation",
      conversationId: CONVERSATION_ID,
      observedAt: OBSERVED_AT,
      status: "SUCCESS"
    });
    expect([first, concurrent].filter((value) => value !== null)).toHaveLength(1);
    await expect(observer.observeTerminal()).resolves.toBeNull();
    expect(reads).toBe(1);
  });

  it("uses the bound SQLite database only and does not select a unique other database", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-sqlite-provider-observer-"));
    temporaryDirectories.push(directory);
    const other = createConversationDb(directory, "other-conversation");
    insertStep(other, {
      idx: 1,
      stepType: 15,
      status: 1,
      stepPayload: encodeStepPayload({ agentText: "still working" })
    });
    other.close();

    const observer = createSqliteProviderObserverForDirectory(directory, { now: () => OBSERVED_AT });
    await expect(observer.bind(CONVERSATION_ID).observeActivity()).resolves.toEqual({ status: "unobserved" });
    await expect(observer.bind(CONVERSATION_ID).observeTerminal()).resolves.toBeNull();
  });

  it("projects a strict structured SQLite provider error without exposing its prompt-like fields", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-sqlite-provider-observer-"));
    temporaryDirectories.push(directory);
    const db = createConversationDb(directory, CONVERSATION_ID);
    const responseJson = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        details: [{ reason: "QUOTA_EXHAUSTED" }]
      }
    });
    insertStep(db, {
      idx: 1,
      stepType: 17,
      status: 7,
      stepPayload: encodeStepPayload({
        modelProviderError: encodeModelProviderError({
          summary: "raw provider summary",
          diagnostic: "Authorization: Bearer private-token",
          responseJson,
          userMessage: "raw prompt-like provider text"
        })
      })
    });
    insertStep(db, {
      idx: 2,
      stepType: 101,
      status: 3,
      stepPayload: encodeStepPayload({})
    });
    db.close();

    const terminal = await createSqliteProviderObserverForDirectory(directory, { now: () => OBSERVED_AT })
      .bind(CONVERSATION_ID)
      .observeTerminal();

    expect(terminal).toEqual({
      source: "sqlite_reconciliation",
      conversationId: CONVERSATION_ID,
      observedAt: OBSERVED_AT,
      status: "ERROR",
      httpStatus: 429,
      reason: "QUOTA_EXHAUSTED"
    });
    const serialized = JSON.stringify(terminal);
    expect(serialized).not.toContain("raw provider summary");
    expect(serialized).not.toContain("private-token");
    expect(serialized).not.toContain("raw prompt-like provider text");
  });
});
