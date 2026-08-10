import type { AgyCliSession } from "../../agy/cli.js";
import type { SessionState } from "./types.js";

const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

export type AdmissionSessionScopeFailureCode =
  | "invalid_session_id"
  | "lookup_unavailable"
  | "lookup_failed"
  | "unknown_session"
  | "session_id_mismatch"
  | "session_closed"
  | "invalid_session_state"
  | "missing_agy";

/** Typed, detail-free rejection for an admission request that has no exact live session scope. */
export class AdmissionSessionScopeResolutionError extends Error {
  readonly code: AdmissionSessionScopeFailureCode;

  constructor(code: AdmissionSessionScopeFailureCode) {
    super(`admission session scope rejected: ${code}`);
    this.name = "AdmissionSessionScopeResolutionError";
    this.code = code;
  }
}

export type AdmissionSessionScopeLookup = (sessionId: string) => SessionState | undefined;

export type AdmissionSessionScopeSource = ReadonlyMap<string, SessionState> | AdmissionSessionScopeLookup;

/**
 * A request-local facade over the exact agy reference resolved once from the
 * active-session source. It intentionally exposes neither SessionState nor
 * any queue, prompt, credential, or source lookup capability.
 */
export interface AdmissionSessionScope {
  readonly sessionId: string;
  withAgy<TResult>(operation: (agy: AgyCliSession) => TResult): TResult;
}

/**
 * Resolves one live ACP session into a frozen request-local scope. It owns no
 * provider, lifecycle, prompt, or spawn behavior; callers compose those after
 * resolution through `withAgy` without another map lookup.
 */
export class AdmissionSessionScopeResolver {
  readonly #lookup: AdmissionSessionScopeLookup | undefined;

  constructor(source: AdmissionSessionScopeSource) {
    this.#lookup = lookupFor(source);
  }

  resolve(requestSessionId: string): AdmissionSessionScope {
    const sessionId = requiredSessionId(requestSessionId);
    const lookup = this.#lookup;
    if (lookup === undefined) throw failure("lookup_unavailable");

    let session: SessionState | undefined;
    try {
      // This is deliberately the sole source access for one resolve call.
      session = lookup(sessionId);
    } catch {
      throw failure("lookup_failed");
    }

    const agy = exactLiveAgy(session, sessionId);
    return new ExactAdmissionSessionScope(sessionId, agy);
  }
}

class ExactAdmissionSessionScope implements AdmissionSessionScope {
  readonly sessionId: string;
  readonly #agy: AgyCliSession;

  constructor(sessionId: string, agy: AgyCliSession) {
    this.sessionId = sessionId;
    this.#agy = agy;
    Object.freeze(this);
  }

  withAgy<TResult>(operation: (agy: AgyCliSession) => TResult): TResult {
    if (typeof operation !== "function") throw new TypeError("admission scope operation must be a function");
    return operation(this.#agy);
  }
}

function lookupFor(source: unknown): AdmissionSessionScopeLookup | undefined {
  if (typeof source === "function") return source as AdmissionSessionScopeLookup;
  if (typeof source !== "object" || source === null) return undefined;

  try {
    const get = (source as { get?: unknown }).get;
    return typeof get === "function"
      ? (sessionId) => get.call(source, sessionId) as SessionState | undefined
      : undefined;
  } catch {
    return undefined;
  }
}

function exactLiveAgy(session: unknown, expectedSessionId: string): AgyCliSession {
  if (!isRecord(session)) throw failure("unknown_session");

  let sessionId: unknown;
  let closed: unknown;
  let agy: unknown;
  try {
    sessionId = session.sessionId;
    closed = session.closed;
    agy = session.agy;
  } catch {
    throw failure("invalid_session_state");
  }

  if (sessionId !== expectedSessionId) throw failure("session_id_mismatch");
  if (closed === true) throw failure("session_closed");
  if (closed !== undefined && closed !== false) throw failure("invalid_session_state");
  if (!isAgyReference(agy)) throw failure("missing_agy");
  return agy as AgyCliSession;
}

function requiredSessionId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_SESSION_ID.test(value)) {
    throw failure("invalid_session_id");
  }
  return value;
}

function isAgyReference(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(code: AdmissionSessionScopeFailureCode): AdmissionSessionScopeResolutionError {
  return new AdmissionSessionScopeResolutionError(code);
}
