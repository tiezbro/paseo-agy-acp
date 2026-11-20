import { describe, expect, it } from "vitest";
import {
  KERNEL_EVENT_PREFIX,
  parseKernelEventLine
} from "../ACP Connector/official-kernel/kernel-events.js";

function eventLine(payload: unknown): string {
  return `${KERNEL_EVENT_PREFIX}${JSON.stringify(payload)}\n`;
}

describe("kernel event line parsing", () => {
  it("parses a retry plan with an optional millisecond delay", () => {
    expect(parseKernelEventLine(eventLine({
      v: 1,
      event: "model_retry_scheduled",
      session: "session-a",
      delayMs: 4000,
      emittedAt: 1000
    }))).toEqual({
      v: 1,
      event: "model_retry_scheduled",
      session: "session-a",
      delayMs: 4000,
      emittedAt: 1000
    });
    expect(parseKernelEventLine(eventLine({
      v: 1,
      event: "model_retry_scheduled",
      session: "session-a",
      emittedAt: 1000
    }))).toEqual({
      v: 1,
      event: "model_retry_scheduled",
      session: "session-a",
      emittedAt: 1000
    });
  });

  it("rejects retry delays that are zero, unsafe or beyond one day", () => {
    for (const delayMs of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, 86_400_001]) {
      expect(parseKernelEventLine(eventLine({
        v: 1,
        event: "model_retry_scheduled",
        session: "session-a",
        delayMs,
        emittedAt: 1000
      }))).toBeUndefined();
    }
  });

  it("requires emittedAt for retry plans so an old turn cannot reuse the notice", () => {
    expect(parseKernelEventLine(eventLine({
      v: 1,
      event: "model_retry_scheduled",
      session: "session-a",
      delayMs: 4000
    }))).toBeUndefined();
  });

  it("keeps only allowlisted retry fields even when raw error text is present", () => {
    const parsed = parseKernelEventLine(eventLine({
      v: 1,
      event: "model_retry_scheduled",
      session: "session-a",
      delayMs: 4000,
      emittedAt: 1000,
      error: "Error 502, Message: Bad Gateway token={{SECRET}} https://internal.example",
      model: "gemini-4-argon-low",
      retryOrdinal: 3
    }));
    expect(parsed).toEqual({
      v: 1,
      event: "model_retry_scheduled",
      session: "session-a",
      delayMs: 4000,
      emittedAt: 1000
    });
  });

  it("accepts only unknown (0) or client-error/server-error backend statuses", () => {
    const backend = (httpStatus: number) => parseKernelEventLine(eventLine({
      v: 1,
      event: "backend_http_error",
      session: "session-a",
      httpStatus,
      emittedAt: 1000,
      stepIndex: 4
    }));
    expect(backend(0)).toMatchObject({ httpStatus: 0, stepIndex: 4 });
    expect(backend(400)).toMatchObject({ httpStatus: 400 });
    expect(backend(502)).toMatchObject({ httpStatus: 502 });
    expect(backend(599)).toMatchObject({ httpStatus: 599 });
    expect(backend(200)).toBeUndefined();
    expect(backend(302)).toBeUndefined();
    expect(backend(600)).toBeUndefined();
  });

  it("ignores unknown events, forged prefixes and oversized lines", () => {
    expect(parseKernelEventLine(eventLine({
      v: 1,
      event: "turn_started",
      session: "session-a"
    }))).toBeUndefined();
    expect(parseKernelEventLine("assistant text PASEO_ACP_KERNEL_EVENT {}\n")).toBeUndefined();
    expect(parseKernelEventLine(`${KERNEL_EVENT_PREFIX}${"x".repeat(9000)}\n`)).toBeUndefined();
  });
});
