import type {
  AgyStreamJsonIdentityChannel,
  AgyStreamJsonIdentityCompletion
} from "../stream-json-identity.js";
import {
  createSqliteProviderObserver,
  type BoundSqliteProviderObserver,
  type SqliteProviderSnapshotReader
} from "./provider-observer.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ExactConversationBindingErrorCode =
  | "invalid_input"
  | "identity_unavailable"
  | "conversation_mismatch"
  | "sqlite_unavailable"
  | "stream_protocol_error"
  | "cancelled";

export class ExactConversationBindingError extends Error {
  readonly code: ExactConversationBindingErrorCode;

  constructor(code: ExactConversationBindingErrorCode) {
    super(`exact conversation binding error: ${code}`);
    this.name = "ExactConversationBindingError";
    this.code = code;
  }
}

export interface ExactConversationBinding {
  readonly conversationId: string;
  readonly cursor: number;
  readonly observer: BoundSqliteProviderObserver;
  /** Must remain observed for the entire turn; a protocol error is fail-closed. */
  readonly streamCompletion: Promise<AgyStreamJsonIdentityCompletion>;
}

export interface ExactConversationBindInput {
  readonly identityChannel: AgyStreamJsonIdentityChannel;
  readonly expectedConversationId: string | null;
  readonly minimumCursor: number;
  readonly signal?: AbortSignal;
}

export interface ExactConversationBinderOptions {
  readonly reader: SqliteProviderSnapshotReader;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Joins the official stream init identity to one exact SQLite database.
 * stream-json supplies identity only; the returned observer remains the v2.0
 * activity and terminal authority.
 */
export class ExactConversationBinder {
  readonly #reader: SqliteProviderSnapshotReader;
  readonly #now: () => number;
  readonly #timeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: ExactConversationBinderOptions) {
    if (!isPlainRecord(options) || !isReader(options.reader)) {
      throw new ExactConversationBindingError("invalid_input");
    }
    this.#reader = options.reader;
    const now = options.now ?? Date.now;
    const wait = options.wait ?? abortableDelay;
    if (typeof now !== "function" || typeof wait !== "function") {
      throw new ExactConversationBindingError("invalid_input");
    }
    this.#now = now;
    this.#timeoutMs = readPositiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.#pollIntervalMs = readPositiveInteger(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    this.#wait = wait;
  }

  async bind(input: ExactConversationBindInput): Promise<ExactConversationBinding> {
    const channel = readIdentityChannel(input.identityChannel);
    const expectedConversationId = readExpectedConversationId(input.expectedConversationId);
    const minimumCursor = readCursor(input.minimumCursor);
    throwIfAborted(input.signal);

    let conversationId: string;
    try {
      const identity = await raceAbort(channel.identity, input.signal);
      conversationId = readConversationId(identity.conversationId);
    } catch (error) {
      if (isAbort(error)) throw new ExactConversationBindingError("cancelled");
      throw new ExactConversationBindingError("identity_unavailable");
    }

    if (expectedConversationId !== null && conversationId !== expectedConversationId) {
      throw new ExactConversationBindingError("conversation_mismatch");
    }

    const startedAt = readTimestamp(this.#now());
    const deadline = startedAt + this.#timeoutMs;
    if (!Number.isSafeInteger(deadline)) throw new ExactConversationBindingError("invalid_input");

    while (true) {
      throwIfAborted(input.signal);
      const completion = await completedWithoutWaiting(channel.completion);
      if (completion !== null && !isTrustedCompletion(completion, conversationId)) {
        throw new ExactConversationBindingError("stream_protocol_error");
      }

      const cursor = await this.readExactCursor(conversationId);
      if (cursor !== null && cursor >= minimumCursor) {
        const sqliteObserver = createSqliteProviderObserver({ reader: this.#reader, now: this.#now })
          .bind(conversationId);
        return Object.freeze({
          conversationId,
          cursor,
          observer: new CompletionGatedObserver(sqliteObserver, channel.completion, conversationId),
          streamCompletion: channel.completion
        });
      }

      const now = readTimestamp(this.#now());
      if (now >= deadline) throw new ExactConversationBindingError("sqlite_unavailable");
      try {
        await this.#wait(Math.min(this.#pollIntervalMs, deadline - now), input.signal);
      } catch (error) {
        if (isAbort(error) || input.signal?.aborted === true) {
          throw new ExactConversationBindingError("cancelled");
        }
        throw new ExactConversationBindingError("sqlite_unavailable");
      }
    }
  }

  private async readExactCursor(conversationId: string): Promise<number | null> {
    try {
      const snapshot = await this.#reader.readSnapshot(conversationId);
      if (!isPlainRecord(snapshot)) return null;
      if (snapshot.conversationId !== conversationId) return null;
      return readOptionalCursor(snapshot.cursor);
    } catch {
      return null;
    }
  }
}

/**
 * Identity remains a guard rather than a provider source. Activity may be
 * observed while the identity stream is still live, but terminal evidence is
 * withheld until it drains with the same exact conversation ID. This prevents
 * a later stream mismatch from being followed by a SQLite terminal emission.
 */
class CompletionGatedObserver implements BoundSqliteProviderObserver {
  readonly #sqliteObserver: BoundSqliteProviderObserver;
  readonly #completion: Promise<AgyStreamJsonIdentityCompletion>;
  readonly #conversationId: string;

  constructor(
    sqliteObserver: BoundSqliteProviderObserver,
    completion: Promise<AgyStreamJsonIdentityCompletion>,
    conversationId: string
  ) {
    this.#sqliteObserver = sqliteObserver;
    this.#completion = completion;
    this.#conversationId = conversationId;
  }

  async observeActivity() {
    const completion = await completedWithoutWaiting(this.#completion);
    if (completion !== null && !isTrustedCompletion(completion, this.#conversationId)) {
      return UNOBSERVED_ACTIVITY;
    }
    return this.#sqliteObserver.observeActivity();
  }

  async observeTerminal() {
    const completion = await completedWithoutWaiting(this.#completion);
    if (completion === null || !isTrustedCompletion(completion, this.#conversationId)) {
      return null;
    }
    return this.#sqliteObserver.observeTerminal();
  }
}

const UNOBSERVED_ACTIVITY = Object.freeze({ status: "unobserved" as const });

export function createExactConversationBinder(options: ExactConversationBinderOptions): ExactConversationBinder {
  return new ExactConversationBinder(options);
}

function readIdentityChannel(value: unknown): AgyStreamJsonIdentityChannel {
  if (
    typeof value !== "object" ||
    value === null ||
    !("identity" in value) ||
    !("completion" in value) ||
    !(value.identity instanceof Promise) ||
    !(value.completion instanceof Promise) ||
    typeof (value as { close?: unknown }).close !== "function"
  ) {
    throw new ExactConversationBindingError("invalid_input");
  }
  return value as AgyStreamJsonIdentityChannel;
}

function isReader(value: unknown): value is SqliteProviderSnapshotReader {
  return typeof value === "object" && value !== null && typeof (value as { readSnapshot?: unknown }).readSnapshot === "function";
}

function readExpectedConversationId(value: unknown): string | null {
  if (value === null) return null;
  return readConversationId(value);
}

function readConversationId(value: unknown): string {
  if (typeof value !== "string" || !CONVERSATION_ID_PATTERN.test(value)) {
    throw new ExactConversationBindingError("invalid_input");
  }
  return value;
}

function readCursor(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < -1) {
    throw new ExactConversationBindingError("invalid_input");
  }
  return value;
}

function readOptionalCursor(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function readPositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new ExactConversationBindingError("invalid_input");
  }
  return value;
}

function readTimestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new ExactConversationBindingError("invalid_input");
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ExactConversationBindingError("cancelled");
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) return Promise.reject(abortReason());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortReason());
    };
    function finish() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) return Promise.reject(abortReason());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortReason());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

async function completedWithoutWaiting(
  completion: Promise<AgyStreamJsonIdentityCompletion>
): Promise<AgyStreamJsonIdentityCompletion | null> {
  const pending = Symbol("pending");
  const value = await Promise.race([completion, Promise.resolve(pending)]);
  return value === pending ? null : value;
}

function isTrustedCompletion(
  completion: AgyStreamJsonIdentityCompletion,
  conversationId: string
): completion is Readonly<{ status: "drained"; conversationId: string }> {
  return completion.status === "drained" && completion.conversationId === conversationId;
}

function abortReason(): Error {
  const error = new Error("cancelled");
  error.name = "AbortError";
  return error;
}

function isAbort(value: unknown): boolean {
  return value instanceof ExactConversationBindingError
    ? value.code === "cancelled"
    : value instanceof Error && value.name === "AbortError";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
