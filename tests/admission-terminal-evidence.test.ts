import { describe, expect, it } from "vitest";
import {
  confirmTerminalEvidence,
  normalizeTerminalObservation,
  reconcileTerminalEvidence,
  TerminalEvidenceError
} from "../src/admission/terminal-evidence.js";

type ObservationOverrides = Partial<{
  source: "stream_json" | "sqlite_reconciliation";
  conversationId: string;
  observedAt: number;
  status: "SUCCESS" | "ERROR" | "CANCELED" | "INTERRUPTED";
  httpStatus: number;
  code: string;
  reason: string;
}>;

function observation(overrides: ObservationOverrides = {}): Record<string, unknown> {
  return {
    source: "stream_json",
    conversationId: "conversation-1",
    observedAt: 1_725_000_000_000,
    status: "SUCCESS",
    ...overrides
  };
}

describe("official agy terminal evidence", () => {
  it("confirms a strict SQLite-primary terminal without stream-json evidence", () => {
    expect(
      confirmTerminalEvidence({
        mode: "sqlite_primary",
        sqliteReconciliation: observation({
          source: "sqlite_reconciliation",
          status: "ERROR",
          httpStatus: 503,
          code: "UNAVAILABLE"
        })
      })
    ).toEqual({
      outcome: "confirmed",
      mode: "sqlite_primary",
      conversationId: "conversation-1",
      status: "ERROR",
      streamJson: null,
      sqliteReconciliation: {
        source: "sqlite_reconciliation",
        conversationId: "conversation-1",
        observedAt: 1_725_000_000_000,
        status: "ERROR",
        outcome: "failed",
        failure: {
          category: "provider_capacity",
          httpStatus: 503,
          code: "UNAVAILABLE",
          reason: undefined
        }
      }
    });
  });

  it("fails closed without retaining raw data when a mode envelope or its sources are malformed", () => {
    const rawTerminalText = "private provider stdout";
    const cases: unknown[] = [
      {
        mode: "sqlite_primary",
        sqliteReconciliation: observation({ source: "stream_json" })
      },
      {
        mode: "sqlite_primary",
        sqliteReconciliation: { ...observation({ source: "sqlite_reconciliation" }), rawStdout: rawTerminalText }
      },
      {
        mode: "sqlite_primary",
        sqliteReconciliation: observation({ source: "sqlite_reconciliation", status: "FINISHED" as never })
      },
      {
        mode: "sqlite_primary",
        sqliteReconciliation: observation({ source: "sqlite_reconciliation" }),
        headers: rawTerminalText
      },
      {
        mode: "dual_source",
        streamJson: observation(),
        sqliteReconciliation: observation({ source: "sqlite_reconciliation", conversationId: "different-conversation" })
      }
    ];

    for (const input of cases) {
      const result = confirmTerminalEvidence(input);
      expect(result).toEqual({ outcome: "recovery_required" });
      expect(JSON.stringify(result)).not.toContain(rawTerminalText);
    }
  });

  it("normalizes only official successful and cancelled terminal states", () => {
    expect(normalizeTerminalObservation(observation())).toEqual({
      source: "stream_json",
      conversationId: "conversation-1",
      observedAt: 1_725_000_000_000,
      status: "SUCCESS",
      outcome: "completed"
    });

    for (const status of ["CANCELED", "INTERRUPTED"] as const) {
      expect(normalizeTerminalObservation(observation({ status }))).toEqual({
        source: "stream_json",
        conversationId: "conversation-1",
        observedAt: 1_725_000_000_000,
        status,
        outcome: "cancelled"
      });
    }

    expect(() => normalizeTerminalObservation(observation({ httpStatus: 503, code: "UNAVAILABLE" }))).toThrow(
      TerminalEvidenceError
    );
  });

  it("classifies an official ERROR through the sanitized provider failure classifier", () => {
    expect(
      normalizeTerminalObservation(
        observation({
          source: "sqlite_reconciliation",
          status: "ERROR",
          httpStatus: 429,
          code: "QUOTA_EXHAUSTED",
          reason: "QUOTA_EXHAUSTED"
        })
      )
    ).toEqual({
      source: "sqlite_reconciliation",
      conversationId: "conversation-1",
      observedAt: 1_725_000_000_000,
      status: "ERROR",
      outcome: "failed",
      failure: {
        category: "quota",
        httpStatus: 429,
        code: "QUOTA_EXHAUSTED",
        reason: "QUOTA_EXHAUSTED"
      }
    });
  });

  it("rejects malformed identifiers, timestamps, sources, and terminal statuses", () => {
    const missingStatus = observation();
    delete missingStatus.status;
    const missingSource = observation();
    delete missingSource.source;

    for (const input of [
      missingStatus,
      missingSource,
      observation({ status: "FINISHED" as never }),
      observation({ source: "other" as never }),
      observation({ conversationId: "" }),
      observation({ conversationId: "   " }),
      observation({ conversationId: "conversation\u0000hidden" }),
      observation({ observedAt: 1.5 }),
      observation({ observedAt: -1 }),
      observation({ observedAt: Number.MAX_SAFE_INTEGER + 1 })
    ]) {
      expect(() => normalizeTerminalObservation(input)).toThrow(TerminalEvidenceError);
    }
  });

  it("rejects raw or unrecognized provider fields and every non-contract field without echoing content", () => {
    const rawPrompt = "plan secret launch and include customer data";
    const rawStack = "Error: secret\n    at internal.ts:1:1";
    const forbidden = [
      { text: rawPrompt },
      { rawText: rawPrompt },
      { prompt: rawPrompt },
      { reasoning: rawPrompt },
      { stack: rawStack },
      { unexpected: "field" },
      { code: rawPrompt },
      { reason: rawPrompt },
      { httpStatus: 600 }
    ];

    for (const extra of forbidden) {
      let error: unknown;
      try {
        normalizeTerminalObservation({ ...observation({ status: "ERROR" }), ...extra });
      } catch (caught) {
        error = caught;
      }

      expect(error).toBeInstanceOf(TerminalEvidenceError);
      expect(String(error)).not.toContain(rawPrompt);
      expect(String(error)).not.toContain(rawStack);
    }
  });

  it("reconciles only matching stream-json and SQLite terminal observations", () => {
    const result = reconcileTerminalEvidence(
      observation({ status: "ERROR", httpStatus: 503, code: "UNAVAILABLE" }),
      observation({
        source: "sqlite_reconciliation",
        status: "ERROR",
        httpStatus: 503,
        code: "UNAVAILABLE"
      })
    );

    expect(result).toEqual({
      outcome: "reconciled",
      conversationId: "conversation-1",
      status: "ERROR",
      streamJson: {
        source: "stream_json",
        conversationId: "conversation-1",
        observedAt: 1_725_000_000_000,
        status: "ERROR",
        outcome: "failed",
        failure: {
          category: "provider_capacity",
          httpStatus: 503,
          code: "UNAVAILABLE",
          reason: undefined
        }
      },
      sqliteReconciliation: {
        source: "sqlite_reconciliation",
        conversationId: "conversation-1",
        observedAt: 1_725_000_000_000,
        status: "ERROR",
        outcome: "failed",
        failure: {
          category: "provider_capacity",
          httpStatus: 503,
          code: "UNAVAILABLE",
          reason: undefined
        }
      }
    });
  });

  it("returns a data-free recovery result when sources, conversations, statuses, or input shape disagree", () => {
    const privateStreamConversation = "stream-private-conversation";
    const privateSqliteConversation = "sqlite-private-conversation";
    const cases: Array<[unknown, unknown]> = [
      [observation({ conversationId: privateStreamConversation }), observation({ source: "sqlite_reconciliation", conversationId: privateSqliteConversation })],
      [observation({ status: "SUCCESS" }), observation({ source: "sqlite_reconciliation", status: "CANCELED" })],
      [
        observation({ status: "ERROR", httpStatus: 503, code: "UNAVAILABLE" }),
        observation({ source: "sqlite_reconciliation", status: "ERROR", httpStatus: 429, code: "QUOTA_EXHAUSTED" })
      ],
      [observation({ source: "sqlite_reconciliation" }), observation({ source: "sqlite_reconciliation" })],
      [observation({ rawText: "private raw event" } as never), observation({ source: "sqlite_reconciliation" })]
    ];

    for (const [streamJson, sqliteReconciliation] of cases) {
      const result = reconcileTerminalEvidence(streamJson, sqliteReconciliation);
      expect(result).toEqual({ outcome: "recovery_required" });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(privateStreamConversation);
      expect(serialized).not.toContain(privateSqliteConversation);
      expect(serialized).not.toContain("private raw event");
    }
  });
});
