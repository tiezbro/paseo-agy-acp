/**
 * Identity-only reader for the official agy stream-json protocol.
 *
 * v2.0 uses the init event solely to bind an exact conversation database.
 * Provider activity and terminal state remain SQLite-primary; response text,
 * tool payloads, usage, and errors are never returned or retained here.
 */

const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type AgyStreamJsonIdentityErrorCode =
  | "invalid_stream"
  | "invalid_limit"
  | "unexpected_first_event"
  | "malformed_event"
  | "line_too_large"
  | "conversation_mismatch"
  | "stream_error"
  | "stream_ended_before_init"
  | "closed_before_init";

export class AgyStreamJsonIdentityError extends Error {
  readonly code: AgyStreamJsonIdentityErrorCode;

  constructor(code: AgyStreamJsonIdentityErrorCode) {
    super(`agy stream-json identity error: ${code}`);
    this.name = "AgyStreamJsonIdentityError";
    this.code = code;
  }
}

export interface AgyStreamJsonIdentity {
  readonly conversationId: string;
}

export type AgyStreamJsonIdentityCompletion =
  | Readonly<{ status: "drained"; conversationId: string }>
  | Readonly<{ status: "protocol_error"; code: AgyStreamJsonIdentityErrorCode }>
  | Readonly<{ status: "closed" }>;

export interface AgyStreamJsonIdentityChannel {
  readonly identity: Promise<AgyStreamJsonIdentity>;
  readonly completion: Promise<AgyStreamJsonIdentityCompletion>;
  close(): void;
}

export interface AgyStreamJsonIdentityOptions {
  readonly maxLineBytes?: number;
}

interface ReadableEventSource {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: () => void): unknown;
  off(event: "data", listener: (chunk: unknown) => void): unknown;
  off(event: "end" | "close", listener: () => void): unknown;
  off(event: "error", listener: () => void): unknown;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

/**
 * Attach before the prompt write so the first official init event cannot be
 * missed. The channel keeps draining stdout after identity resolution and
 * reports any later conversation mismatch through completion.
 */
export function observeAgyStreamJsonIdentity(
  source: unknown,
  options: AgyStreamJsonIdentityOptions = {}
): AgyStreamJsonIdentityChannel {
  const stream = requireStream(source);
  const maxLineBytes = requireLineLimit(options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES);
  const identity = deferred<AgyStreamJsonIdentity>();
  const completion = deferred<AgyStreamJsonIdentityCompletion>();
  let buffered = Buffer.alloc(0);
  let conversationId: string | null = null;
  let identitySettled = false;
  let finished = false;

  const detach = () => {
    stream.off("data", onData);
    stream.off("end", onEnd);
    stream.off("close", onEnd);
    stream.off("error", onError);
  };

  const settleIdentityError = (code: AgyStreamJsonIdentityErrorCode) => {
    if (identitySettled) return;
    identitySettled = true;
    identity.reject(new AgyStreamJsonIdentityError(code));
  };

  const fail = (code: AgyStreamJsonIdentityErrorCode) => {
    if (finished) return;
    finished = true;
    settleIdentityError(code);
    buffered.fill(0);
    buffered = Buffer.alloc(0);
    detach();
    completion.resolve(Object.freeze({ status: "protocol_error" as const, code }));
  };

  const acceptLine = (line: Buffer) => {
    if (line.length === 0) return;
    if (line.length > maxLineBytes) {
      fail("line_too_large");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString("utf8"));
    } catch {
      fail("malformed_event");
      return;
    } finally {
      line.fill(0);
    }

    const event = readEvent(parsed);
    if (event === null) {
      fail("malformed_event");
      return;
    }

    if (conversationId === null) {
      if (event.type !== "init") {
        fail("unexpected_first_event");
        return;
      }
      conversationId = event.conversationId;
      identitySettled = true;
      identity.resolve(Object.freeze({ conversationId }));
      return;
    }

    if (event.type === "init" || event.conversationId !== conversationId) {
      fail("conversation_mismatch");
    }
  };

  const onData = (chunk: unknown) => {
    if (finished) return;
    const bytes = toBuffer(chunk);
    if (bytes === null) {
      fail("malformed_event");
      return;
    }
    buffered = Buffer.concat([buffered, bytes]);
    bytes.fill(0);

    if (buffered.length > maxLineBytes && buffered.indexOf(0x0a) < 0) {
      fail("line_too_large");
      return;
    }

    let newline = buffered.indexOf(0x0a);
    while (newline >= 0 && !finished) {
      const line = Buffer.from(buffered.subarray(0, stripCarriageReturn(buffered, newline)));
      const remainder = Buffer.from(buffered.subarray(newline + 1));
      buffered.fill(0);
      buffered = remainder;
      acceptLine(line);
      newline = buffered.indexOf(0x0a);
    }
  };

  const onEnd = () => {
    if (finished) return;
    if (buffered.length > 0) {
      const line = Buffer.from(buffered.subarray(0, stripTrailingCarriageReturn(buffered)));
      buffered.fill(0);
      buffered = Buffer.alloc(0);
      acceptLine(line);
    }
    if (finished) return;
    finished = true;
    detach();
    if (conversationId === null) {
      settleIdentityError("stream_ended_before_init");
      completion.resolve(Object.freeze({
        status: "protocol_error" as const,
        code: "stream_ended_before_init" as const
      }));
      return;
    }
    completion.resolve(Object.freeze({ status: "drained" as const, conversationId }));
  };

  const onError = () => fail("stream_error");

  stream.on("data", onData);
  stream.on("end", onEnd);
  stream.on("close", onEnd);
  stream.on("error", onError);

  return Object.freeze({
    identity: identity.promise,
    completion: completion.promise,
    close() {
      if (finished) return;
      finished = true;
      buffered.fill(0);
      buffered = Buffer.alloc(0);
      detach();
      settleIdentityError("closed_before_init");
      completion.resolve(Object.freeze({ status: "closed" as const }));
    }
  });
}

type ParsedEvent =
  | Readonly<{ type: "init"; conversationId: string }>
  | Readonly<{ type: "step_update" | "result"; conversationId: string }>;

function readEvent(value: unknown): ParsedEvent | null {
  if (!isPlainRecord(value) || typeof value.event !== "string") return null;
  if (value.event === "init") {
    const conversationId = readConversationId(value.conversation_id);
    return conversationId === null ? null : Object.freeze({ type: "init" as const, conversationId });
  }
  if (value.event === "step_update") {
    const payload = value.step_update;
    if (!isPlainRecord(payload)) return null;
    const conversationId = readConversationId(payload.conversation_id);
    return conversationId === null
      ? null
      : Object.freeze({ type: "step_update" as const, conversationId });
  }
  if (value.event === "result") {
    const payload = value.result;
    if (!isPlainRecord(payload)) return null;
    const conversationId = readConversationId(payload.conversation_id);
    return conversationId === null
      ? null
      : Object.freeze({ type: "result" as const, conversationId });
  }
  return null;
}

function readConversationId(value: unknown): string | null {
  return typeof value === "string" && CONVERSATION_ID_PATTERN.test(value) ? value : null;
}

function requireStream(value: unknown): ReadableEventSource {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { on?: unknown }).on !== "function" ||
    typeof (value as { off?: unknown }).off !== "function"
  ) {
    throw new AgyStreamJsonIdentityError("invalid_stream");
  }
  return value as unknown as ReadableEventSource;
}

function requireLineLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 64) {
    throw new AgyStreamJsonIdentityError("invalid_limit");
  }
  return value;
}

function toBuffer(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return Buffer.from(value);
  return null;
}

function stripCarriageReturn(value: Buffer, newline: number): number {
  return newline > 0 && value[newline - 1] === 0x0d ? newline - 1 : newline;
}

function stripTrailingCarriageReturn(value: Buffer): number {
  return value.length > 0 && value[value.length - 1] === 0x0d ? value.length - 1 : value.length;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
