import { describe, expect, it } from "vitest";
import {
  createProviderObserver,
  type ProviderObserverSources
} from "../src/admission/provider-observer.js";
import { normalizeTerminalObservation } from "../src/admission/terminal-evidence.js";

const CONVERSATION_ID = "conversation-1";
const OBSERVED_AT = 1_725_000_000_000;

type TerminalOverrides = Partial<{
  source: "stream_json" | "sqlite_reconciliation";
  conversationId: string;
  observedAt: number;
  status: "SUCCESS" | "ERROR" | "CANCELED" | "INTERRUPTED";
  httpStatus: number;
  code: string;
  reason: string;
}>;

function activity(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    source: "stream_json",
    conversationId: CONVERSATION_ID,
    observedAt: OBSERVED_AT,
    status: "ACTIVE",
    ...overrides
  };
}

function terminal(overrides: TerminalOverrides = {}): Record<string, unknown> {
  return {
    source: "stream_json",
    conversationId: CONVERSATION_ID,
    observedAt: OBSERVED_AT,
    status: "SUCCESS",
    ...overrides
  };
}

function sources(overrides: Partial<ProviderObserverSources> = {}): ProviderObserverSources {
  return {
    streamJson: {
      readActivity: () => activity(),
      readTerminal: () => terminal()
    },
    sqliteReconciliation: {
      readTerminal: () => terminal({ source: "sqlite_reconciliation" })
    },
    ...overrides
  };
}

describe("admission provider observer", () => {
  it("requires an exact conversation binding before structured online activity is observed", async () => {
    const seenConversationIds: string[] = [];
    const observer = createProviderObserver(
      sources({
        streamJson: {
          readActivity: (conversationId) => {
            seenConversationIds.push(conversationId);
            return activity({ conversationId });
          },
          readTerminal: () => terminal()
        }
      })
    ).bind(CONVERSATION_ID);

    await expect(observer.observeActivity()).resolves.toEqual({ status: "observed" });
    expect(seenConversationIds).toEqual([CONVERSATION_ID]);

    const mismatched = createProviderObserver(
      sources({
        streamJson: {
          readActivity: () => activity({ conversationId: "other-conversation" }),
          readTerminal: () => terminal()
        }
      })
    ).bind(CONVERSATION_ID);

    await expect(mismatched.observeActivity()).resolves.toEqual({ status: "unobserved" });

    const rawHeader = createProviderObserver(
      sources({
        streamJson: {
          readActivity: () => activity({ header: "Authorization: Bearer private-token" }),
          readTerminal: () => terminal()
        }
      })
    ).bind(CONVERSATION_ID);

    await expect(rawHeader.observeActivity()).resolves.toEqual({ status: "unobserved" });
  });

  it("emits only whitelisted paired success terminal observations", async () => {
    const result = await createProviderObserver(sources()).bind(CONVERSATION_ID).observeTerminal();

    expect(result).toEqual({
      status: "observed",
      observations: {
        streamJson: terminal(),
        sqliteReconciliation: terminal({ source: "sqlite_reconciliation" })
      }
    });
    if (result.status !== "observed") throw new Error("expected terminal evidence");

    for (const observation of Object.values(result.observations)) {
      expect(Object.keys(observation).sort()).toEqual(["conversationId", "observedAt", "source", "status"]);
    }
  });

  it("reconciles cancelled terminals without turning them into success", async () => {
    for (const status of ["CANCELED", "INTERRUPTED"] as const) {
      const result = await createProviderObserver(
        sources({
          streamJson: { readActivity: () => activity(), readTerminal: () => terminal({ status }) },
          sqliteReconciliation: {
            readTerminal: () => terminal({ source: "sqlite_reconciliation", status })
          }
        })
      )
        .bind(CONVERSATION_ID)
        .observeTerminal();

      expect(result).toEqual({
        status: "observed",
        observations: {
          streamJson: terminal({ status }),
          sqliteReconciliation: terminal({ source: "sqlite_reconciliation", status })
        }
      });
    }
  });

  it("retains the safe 503 capacity signal and nothing else", async () => {
    for (const code of ["UNAVAILABLE", "MODEL_CAPACITY_EXHAUSTED"]) {
      const capacity = terminal({ status: "ERROR", httpStatus: 503, code });
      const result = await createProviderObserver(
        sources({
          streamJson: { readActivity: () => activity(), readTerminal: () => capacity },
          sqliteReconciliation: {
            readTerminal: () => ({ ...capacity, source: "sqlite_reconciliation" })
          }
        })
      )
        .bind(CONVERSATION_ID)
        .observeTerminal();

      if (result.status !== "observed") throw new Error("expected capacity terminal evidence");
      expect(normalizeTerminalObservation(result.observations.streamJson)).toMatchObject({
        outcome: "failed",
        failure: { category: "provider_capacity", httpStatus: 503, code }
      });
      expect(Object.keys(result.observations.streamJson).sort()).toEqual([
        "code",
        "conversationId",
        "httpStatus",
        "observedAt",
        "source",
        "status"
      ]);
    }
  });

  it("retains the safe 429 quota signal and nothing else", async () => {
    const quota = terminal({ status: "ERROR", httpStatus: 429, code: "QUOTA_EXHAUSTED" });
    const result = await createProviderObserver(
      sources({
        streamJson: { readActivity: () => activity(), readTerminal: () => quota },
        sqliteReconciliation: {
          readTerminal: () => ({ ...quota, source: "sqlite_reconciliation" })
        }
      })
    )
      .bind(CONVERSATION_ID)
      .observeTerminal();

    if (result.status !== "observed") throw new Error("expected quota terminal evidence");
    expect(normalizeTerminalObservation(result.observations.sqliteReconciliation)).toMatchObject({
      outcome: "failed",
      failure: { category: "quota", httpStatus: 429, code: "QUOTA_EXHAUSTED" }
    });
  });

  it("preserves safe auth, permission, timeout, and transport status evidence", async () => {
    for (const httpStatus of [401, 403, 408, 502]) {
      const error = terminal({ status: "ERROR", httpStatus });
      const result = await createProviderObserver(
        sources({
          streamJson: { readActivity: () => activity(), readTerminal: () => error },
          sqliteReconciliation: {
            readTerminal: () => ({ ...error, source: "sqlite_reconciliation" })
          }
        })
      )
        .bind(CONVERSATION_ID)
        .observeTerminal();

      expect(result).toEqual({
        status: "observed",
        observations: {
          streamJson: error,
          sqliteReconciliation: { ...error, source: "sqlite_reconciliation" }
        }
      });
    }
  });

  it("fails closed without exposing either source when conversation, status, or error semantics differ", async () => {
    const privateConversationId = "private-conversation-id";
    const privateReasoning = "private reasoning must never leave the source";
    const cases: Array<[unknown, unknown]> = [
      [terminal({ conversationId: privateConversationId }), terminal({ source: "sqlite_reconciliation" })],
      [terminal(), terminal({ source: "sqlite_reconciliation", status: "CANCELED" })],
      [
        terminal({ status: "ERROR", httpStatus: 503, code: "UNAVAILABLE" }),
        terminal({ source: "sqlite_reconciliation", status: "ERROR", httpStatus: 503, code: "MODEL_CAPACITY_EXHAUSTED" })
      ],
      [
        {
          ...terminal(),
          rawStdout: privateReasoning,
          reasoning: privateReasoning,
          prompt: privateReasoning,
          header: "Authorization: Bearer private-token"
        },
        terminal({ source: "sqlite_reconciliation" })
      ]
    ];

    for (const [streamJson, sqliteReconciliation] of cases) {
      const result = await createProviderObserver(
        sources({
          streamJson: { readActivity: () => activity(), readTerminal: () => streamJson },
          sqliteReconciliation: { readTerminal: () => sqliteReconciliation }
        })
      )
        .bind(CONVERSATION_ID)
        .observeTerminal();

      expect(result).toEqual({ status: "unobserved" });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(privateConversationId);
      expect(serialized).not.toContain(privateReasoning);
    }
  });

  it("fails closed for a missing source or a source exception without surfacing raw error content", async () => {
    const missingSource = await createProviderObserver(
      sources({ sqliteReconciliation: {} as ProviderObserverSources["sqliteReconciliation"] })
    )
      .bind(CONVERSATION_ID)
      .observeTerminal();
    expect(missingSource).toEqual({ status: "unobserved" });

    const rawSourceError = "Authorization: Bearer secret-token";
    const throwing = createProviderObserver(
      sources({
        streamJson: {
          readActivity: () => {
            throw new Error(rawSourceError);
          },
          readTerminal: () => {
            throw new Error(rawSourceError);
          }
        }
      })
    ).bind(CONVERSATION_ID);

    await expect(throwing.observeActivity()).resolves.toEqual({ status: "unobserved" });
    await expect(throwing.observeTerminal()).resolves.toEqual({ status: "unobserved" });
    expect(JSON.stringify(await throwing.observeTerminal())).not.toContain(rawSourceError);
  });

  it("issues a reconciled terminal at most once", async () => {
    let streamReads = 0;
    let sqliteReads = 0;
    const observer = createProviderObserver(
      sources({
        streamJson: {
          readActivity: () => activity(),
          readTerminal: () => {
            streamReads += 1;
            return terminal();
          }
        },
        sqliteReconciliation: {
          readTerminal: () => {
            sqliteReads += 1;
            return terminal({ source: "sqlite_reconciliation" });
          }
        }
      })
    ).bind(CONVERSATION_ID);

    await expect(observer.observeTerminal()).resolves.toMatchObject({ status: "observed" });
    await expect(observer.observeTerminal()).resolves.toEqual({ status: "unobserved" });
    expect([streamReads, sqliteReads]).toEqual([1, 1]);
  });
});
