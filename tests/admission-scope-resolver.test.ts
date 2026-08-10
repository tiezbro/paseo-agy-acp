import { describe, expect, it } from "vitest";
import {
  AdmissionSessionScopeResolutionError,
  AdmissionSessionScopeResolver,
  type AdmissionSessionScopeFailureCode
} from "../src/acp/session/admission-scope-resolver.js";
import type { SessionState } from "../src/acp/session/types.js";

const SESSION_ID = "7b302919-c1e5-4d14-a8f2-b48ddc2c7c24";
const OTHER_SESSION_ID = "52b59c05-9120-4102-852d-05ffc9789118";
const RAW_PROMPT = "prompt must never leave the SessionState";
const RAW_CREDENTIAL = "credential must never leave the SessionState";

interface FakeAgy {
  readonly calls: string[];
}

class CountingSessionMap extends Map<string, SessionState> {
  lookups = 0;

  override get(key: string): SessionState | undefined {
    this.lookups += 1;
    return super.get(key);
  }
}

function fakeAgy(): FakeAgy {
  return { calls: [] };
}

function sessionState(overrides: {
  sessionId?: unknown;
  closed?: unknown;
  agy?: unknown;
} = {}): SessionState {
  const hasAgy = Object.prototype.hasOwnProperty.call(overrides, "agy");
  return {
    sessionId: overrides.sessionId ?? SESSION_ID,
    closed: overrides.closed,
    agy: (hasAgy ? overrides.agy : fakeAgy()) as SessionState["agy"],
    // These fields are intentionally present in the source object and must
    // never become properties of the returned admission scope.
    promptQueue: [{ rawPrompt: RAW_PROMPT }],
    credential: RAW_CREDENTIAL
  } as unknown as SessionState;
}

function expectFailure(
  resolver: AdmissionSessionScopeResolver,
  requestSessionId: unknown,
  code: AdmissionSessionScopeFailureCode
): void {
  let thrown: unknown;
  try {
    resolver.resolve(requestSessionId as string);
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(AdmissionSessionScopeResolutionError);
  const failure = thrown as AdmissionSessionScopeResolutionError;
  expect(failure.code).toBe(code);
  expect(failure.message).not.toContain(RAW_PROMPT);
  expect(failure.message).not.toContain(RAW_CREDENTIAL);
}

describe("AdmissionSessionScopeResolver", () => {
  it("returns a frozen, prompt-free facade pinned to the resolved agy reference", () => {
    const agy = fakeAgy();
    const session = sessionState({ agy });
    const sessions = new CountingSessionMap([[SESSION_ID, session]]);
    const resolver = new AdmissionSessionScopeResolver(sessions);

    const scope = resolver.resolve(SESSION_ID);

    expect(sessions.lookups).toBe(1);
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.keys(scope)).toEqual(["sessionId"]);
    expect((scope as unknown as Record<string, unknown>).agy).toBeUndefined();
    expect((scope as unknown as Record<string, unknown>).promptQueue).toBeUndefined();
    expect((scope as unknown as Record<string, unknown>).credential).toBeUndefined();
    expect(JSON.stringify(scope)).not.toContain(RAW_PROMPT);
    expect(JSON.stringify(scope)).not.toContain(RAW_CREDENTIAL);
    expect(scope.withAgy((current) => current)).toBe(agy);

    sessions.delete(SESSION_ID);
    (session as { agy: unknown }).agy = fakeAgy();
    expect(scope.withAgy((current) => current)).toBe(agy);
    expect(sessions.lookups).toBe(1);
    expect(agy.calls).toEqual([]);
  });

  it("uses an injected lookup exactly once for each resolve and never again through the facade", () => {
    const agy = fakeAgy();
    const session = sessionState({ agy });
    let lookupCalls = 0;
    const resolver = new AdmissionSessionScopeResolver((requestedSessionId) => {
      lookupCalls += 1;
      expect(requestedSessionId).toBe(SESSION_ID);
      return session;
    });

    const first = resolver.resolve(SESSION_ID);
    expect(lookupCalls).toBe(1);
    expect(first.withAgy((current) => current)).toBe(agy);
    expect(lookupCalls).toBe(1);

    resolver.resolve(SESSION_ID);
    expect(lookupCalls).toBe(2);
  });

  it("rejects unknown, key/session mismatch, closed, malformed, and missing-agy sessions without side effects", () => {
    const agy = fakeAgy();
    const cases: Array<{
      code: AdmissionSessionScopeFailureCode;
      state: SessionState | undefined;
    }> = [
      { code: "unknown_session", state: undefined },
      { code: "session_id_mismatch", state: sessionState({ sessionId: OTHER_SESSION_ID, agy }) },
      { code: "session_closed", state: sessionState({ closed: true, agy }) },
      { code: "invalid_session_state", state: sessionState({ closed: "false", agy }) },
      { code: "missing_agy", state: sessionState({ agy: undefined }) },
      { code: "missing_agy", state: sessionState({ agy: () => undefined }) }
    ];

    for (const current of cases) {
      const sessions = new CountingSessionMap();
      if (current.state !== undefined) sessions.set(SESSION_ID, current.state);
      const resolver = new AdmissionSessionScopeResolver(sessions);

      expectFailure(resolver, SESSION_ID, current.code);
      expect(sessions.lookups).toBe(1);
      expect(sessions.size).toBe(current.state === undefined ? 0 : 1);
      expect(agy.calls).toEqual([]);
    }
  });

  it("rejects malicious and control-character request IDs before lookup", () => {
    let lookupCalls = 0;
    const resolver = new AdmissionSessionScopeResolver(() => {
      lookupCalls += 1;
      return sessionState();
    });

    for (const requestSessionId of [
      "",
      "session\u0000id",
      "session\nnext",
      "../session",
      "session id",
      "session/id",
      "session\\id",
      "session\u007fid",
      null
    ]) {
      expectFailure(resolver, requestSessionId, "invalid_session_id");
    }

    expect(lookupCalls).toBe(0);
  });

  it("converts lookup throws into a typed, detail-free failure without touching agy", () => {
    const agy = fakeAgy();
    const resolver = new AdmissionSessionScopeResolver(() => {
      throw new Error(`${RAW_PROMPT}:${RAW_CREDENTIAL}`);
    });

    expectFailure(resolver, SESSION_ID, "lookup_failed");
    expect(agy.calls).toEqual([]);
  });
});
