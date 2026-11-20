import { describe, expect, it } from "vitest";
import { KernelEventTracker } from "../ACP Connector/official-kernel/kernel-event-tracker.js";
import type { KernelEvent } from "../ACP Connector/official-kernel/kernel-events.js";

const retry = (session: string, emittedAt: number, delayMs?: number): KernelEvent => ({
  v: 1,
  event: "model_retry_scheduled",
  session,
  emittedAt,
  ...(delayMs === undefined ? {} : { delayMs })
});

const backend = (session: string, emittedAt: number, httpStatus: number, stepIndex?: number): KernelEvent => ({
  v: 1,
  event: "backend_http_error",
  session,
  emittedAt,
  httpStatus,
  ...(stepIndex === undefined ? {} : { stepIndex })
});

describe("kernel event tracker", () => {
  it("emits one retry notice per real plan and preserves the parsed delay", () => {
    const tracker = new KernelEventTracker();
    tracker.beginTurn("session-a", 1000);
    expect(tracker.observe(retry("session-a", 1001, 4000))).toMatchObject({
      kind: "model_retry_scheduled",
      sessionId: "session-a",
      delayMs: 4000
    });
    expect(tracker.observe(retry("session-a", 1002, 5_923))).toMatchObject({
      kind: "model_retry_scheduled",
      delayMs: 5_923
    });
    expect(tracker.observe(retry("session-a", 1003))).toMatchObject({
      kind: "model_retry_scheduled",
      sessionId: "session-a"
    });
  });

  it("drops signals from another session, an ended turn or an older turn", () => {
    const tracker = new KernelEventTracker();
    tracker.beginTurn("session-a", 1000);
    expect(tracker.observe(retry("session-b", 1001, 4000))).toBeUndefined();
    expect(tracker.observe(retry("session-a", 999, 4000))).toBeUndefined();
    tracker.endTurn("session-a");
    expect(tracker.observe(retry("session-a", 1002, 4000))).toBeUndefined();

    tracker.beginTurn("session-a", 2000);
    expect(tracker.observe(retry("session-a", 1999, 4000))).toBeUndefined();
    expect(tracker.observe(retry("session-a", 2000, 4000))).toBeUndefined();
    expect(tracker.observe(retry("session-a", 2001, 4000))).toBeDefined();
  });

  it("deduplicates repeated backend notices but keeps distinct statuses", () => {
    const tracker = new KernelEventTracker();
    tracker.beginTurn("session-a", 1000);
    expect(tracker.observe(backend("session-a", 1001, 502, 1))).toMatchObject({
      kind: "backend_http_error",
      httpStatus: 502
    });
    expect(tracker.observe(backend("session-a", 1002, 502, 2))).toBeUndefined();
    expect(tracker.observe(backend("session-a", 1003, 503, 3))).toMatchObject({
      kind: "backend_http_error",
      httpStatus: 503
    });
    expect(tracker.observe(backend("session-a", 1004, 0))).toMatchObject({
      kind: "backend_http_error",
      httpStatus: 0
    });
  });

  it("rejects a stale step index after a new turn starts", () => {
    const tracker = new KernelEventTracker();
    tracker.beginTurn("session-a", 1000);
    expect(tracker.observe(backend("session-a", 1001, 502, 10))).toBeDefined();
    tracker.endTurn("session-a");

    tracker.beginTurn("session-a", 2000);
    expect(tracker.observe(backend("session-a", 2001, 502, 10))).toBeUndefined();
    expect(tracker.observe(backend("session-a", 2001, 502, 11))).toBeDefined();
  });

  it("stops noticing immediately on cancellation and can start a clean turn", () => {
    const tracker = new KernelEventTracker();
    tracker.beginTurn("session-a", 1000);
    expect(tracker.observe(retry("session-a", 1001, 4000))).toBeDefined();
    tracker.cancelTurn("session-a");
    expect(tracker.hasActiveTurn("session-a")).toBe(false);
    expect(tracker.observe(retry("session-a", 1002, 4000))).toBeUndefined();

    tracker.beginTurn("session-a", 3000);
    expect(tracker.observe(retry("session-a", 3001, 4000))).toBeDefined();
  });

  it("keeps the latest backend status for the terminal JSON-RPC data", () => {
    const tracker = new KernelEventTracker();
    tracker.beginTurn("session-a", 1000);
    tracker.observe(backend("session-a", 1001, 502, 1));
    expect(tracker.endTurn("session-a")).toEqual({ lastHttpStatus: 502 });
    expect(tracker.endTurn("session-a")).toBeUndefined();
  });
});
