import { StringDecoder } from "node:string_decoder";
import { Transform } from "node:stream";

export const KERNEL_EVENT_ENV = "PASEO_AGY_ACP_KERNEL_EVENTS";
export const KERNEL_EVENT_DIRECTORY_ENV = "PASEO_AGY_ACP_KERNEL_EVENT_DIR";
export const KERNEL_EVENT_PREFIX = "PASEO_ACP_KERNEL_EVENT ";

const MAX_EVENT_LINE_BYTES = 8 * 1024;
const SESSION_LIMIT = 256;
const ERROR_CLASS_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_RETRY_DELAY_MS = 86_400_000;

/** Kernel-reported progress signal. Never treated as a terminal turn outcome. */
export interface KernelBackendHttpError {
  readonly v: 1;
  readonly event: "backend_http_error";
  readonly session: string;
  readonly httpStatus: number;
  readonly emittedAt?: number;
  readonly stepIndex?: number;
}

/** One official harness retry decision. The delay is optional when unparsed. */
export interface KernelModelRetryScheduled {
  readonly v: 1;
  readonly event: "model_retry_scheduled";
  readonly session: string;
  readonly delayMs?: number;
  readonly emittedAt: number;
}

export type KernelEvent = KernelBackendHttpError | KernelModelRetryScheduled;

/**
 * Parses one namespaced stderr line emitted by the pinned compatibility module.
 *
 * Only the exact allowlisted fields are returned. Unknown fields, malformed
 * values, and lines from any other source are ignored so assistant/tool text
 * can never be promoted into a kernel event.
 */
export function parseKernelEventLine(line: string): KernelEvent | undefined {
  const normalized = line.replace(/\r?\n$/, "");
  if (!normalized.startsWith(KERNEL_EVENT_PREFIX)) return undefined;
  const payload = normalized.slice(KERNEL_EVENT_PREFIX.length);
  if (payload.length === 0 || Buffer.byteLength(payload, "utf8") > MAX_EVENT_LINE_BYTES) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return undefined;
  const session = safeSession(record.session);
  if (session === undefined) return undefined;
  const emittedAt = record.emittedAt;
  if (emittedAt !== undefined && (!Number.isSafeInteger(emittedAt) || (emittedAt as number) < 0)) return undefined;
  if (record.event === "model_retry_scheduled") {
    if (emittedAt === undefined) return undefined;
    const delayMs = record.delayMs;
    if (
      delayMs !== undefined &&
      (!Number.isSafeInteger(delayMs) || (delayMs as number) <= 0 || (delayMs as number) > MAX_RETRY_DELAY_MS)
    ) {
      return undefined;
    }
    return Object.freeze({
      v: 1,
      event: "model_retry_scheduled",
      session,
      emittedAt: emittedAt as number,
      ...(delayMs === undefined ? {} : { delayMs: delayMs as number })
    });
  }
  if (record.event !== "backend_http_error") return undefined;
  const httpStatus = record.httpStatus;
  if (
    !Number.isSafeInteger(httpStatus) ||
    ((httpStatus as number) !== 0 && ((httpStatus as number) < 400 || (httpStatus as number) > 599))
  ) {
    return undefined;
  }
  const stepIndex = record.stepIndex;
  if (stepIndex !== undefined && (!Number.isSafeInteger(stepIndex) || (stepIndex as number) < 0)) return undefined;
  return Object.freeze({
    v: 1,
    event: "backend_http_error",
    session,
    httpStatus: httpStatus as number,
    ...(emittedAt === undefined ? {} : { emittedAt: emittedAt as number }),
    ...(stepIndex === undefined ? {} : { stepIndex: stepIndex as number })
  });
}

/**
 * Forwards ordinary kernel stderr unchanged while extracting only namespaced
 * kernel event lines. Event delivery is a progress channel; terminal state is
 * read from the separately fenced state file.
 */
export function createKernelEventFilter(onEvent: (event: KernelEvent) => void): Transform {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let overflowing = false;
  const deliver = (line: string): boolean => {
    const event = parseKernelEventLine(line);
    if (event === undefined) return false;
    try {
      onEvent(event);
    } catch {
      // A consumer failure must never break kernel stderr forwarding.
    }
    return true;
  };
  return new Transform({
    transform(chunk: Buffer | string, _encoding, callback) {
      pending += typeof chunk === "string" ? chunk : decoder.write(chunk);
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        if (overflowing) {
          overflowing = false;
          this.push(line);
        } else if (!deliver(line)) {
          this.push(line);
        }
      }
      if (!overflowing && pending.length > MAX_EVENT_LINE_BYTES) {
        // An oversized candidate line cannot be a valid event; release it as
        // ordinary stderr instead of buffering without bound.
        this.push(pending);
        pending = "";
        overflowing = true;
      }
      callback();
    },
    flush(callback) {
      const tail = decoder.end();
      if (tail) pending += tail;
      if (pending.length > 0 && !overflowing) {
        if (!deliver(pending)) this.push(pending);
      } else if (pending.length > 0) {
        this.push(pending);
      }
      pending = "";
      callback();
    }
  });
}

function safeSession(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > SESSION_LIMIT) return undefined;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return value;
}

export function safeErrorClass(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && ERROR_CLASS_PATTERN.test(value)
    ? value
    : undefined;
}
