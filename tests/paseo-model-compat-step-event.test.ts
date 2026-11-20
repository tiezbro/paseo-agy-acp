import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { KernelEventTracker } from "../ACP Connector/official-kernel/kernel-event-tracker.js";
import { KERNEL_EVENT_PREFIX, parseKernelEventLine } from "../ACP Connector/official-kernel/kernel-events.js";

const compat = fileURLToPath(new URL("../assets/official-kernel-compat/rc01/paseo_model_compat.py", import.meta.url));
const script = String.raw`
import json, runpy, sys
from types import SimpleNamespace

class LocalConnectionStep(SimpleNamespace):
    pass

sys.modules['google.antigravity.connections.local.event_processor'] = SimpleNamespace(LocalConnectionStep=LocalConnectionStep)
payload = runpy.run_path(sys.argv[1])['_step_event_payload']
attrs = json.loads(sys.argv[2])
for field in ('source', 'type', 'status'):
    if field in attrs:
        attrs[field] = SimpleNamespace(name=attrs[field])
step = (LocalConnectionStep if sys.argv[3] == 'sdk' else SimpleNamespace)(trajectory_id='session-a', **attrs)
print(json.dumps(payload(step)))
`;

function stepPayload(fields: Record<string, unknown>, sdk = false) {
  return JSON.parse(execFileSync("python3", ["-IB", "-c", script, compat, JSON.stringify(fields), sdk ? "sdk" : "raw"], {
    encoding: "utf8"
  }));
}

const done = { type: "ERROR_MESSAGE", status: "DONE" };
const legacy = { source: "SYSTEM", status: "ERROR" };
const event = (httpStatus: number) => ({ v: 1, event: "backend_http_error", session: "session-a", httpStatus, emittedAt: expect.any(Number) });

describe("HTTP notices from official steps", () => {
  it("preserves the SYSTEM/ERROR status and step index", () => {
    expect(stepPayload({ ...legacy, http_code: 502, step_index: 7 })).toEqual({ ...event(502), stepIndex: 7 });
  });

  it("reports five completed 503 error messages once and keeps the turn active", () => {
    const tracker = new KernelEventTracker();
    tracker.beginTurn("session-a", 0);
    for (let index = 1; index <= 5; index++) {
      const payload = stepPayload({ ...done, error_code: 503, step_index: index });
      expect(payload).toEqual({ ...event(503), stepIndex: index });
      const parsed = parseKernelEventLine(KERNEL_EVENT_PREFIX + JSON.stringify(payload));
      if (!parsed) throw new Error("invalid kernel event");
      const notice = tracker.observe(parsed);
      if (index === 1) {
        expect(notice).toEqual({ kind: "backend_http_error", sessionId: "session-a", httpStatus: 503, emittedAt: parsed.emittedAt });
      } else {
        expect(notice).toBeUndefined();
      }
    }
    expect(tracker.hasActiveTurn("session-a")).toBe(true);
  });

  it("accepts either valid structured code, including the endpoints", () => {
    expect(stepPayload({ ...done, http_code: 400 })).toEqual(event(400));
    expect(stepPayload({ ...done, error_code: 0, http_code: 599 })).toEqual(event(599));
  });

  it("reads the SDK's decoded error-only step", () => {
    expect(stepPayload({ type: "UNKNOWN", status: "DONE", http_code: 503 }, true)).toEqual(event(503));
    expect(stepPayload({ type: "UNKNOWN", status: "DONE", http_code: 503 })).toBeNull();
  });

  it("ignores missing, non-integer and out-of-range codes even when the error text says 503", () => {
    for (const value of [undefined, 0, 399, 600, 503.5, "503", true]) {
      expect(stepPayload({ ...done, error_code: value, error: "HTTP 503" })).toBeNull();
      expect(stepPayload({ ...legacy, http_code: value })).toBeNull();
    }
    expect(stepPayload({ ...legacy, error_code: 503 })).toBeNull();
  });

  it("ignores child trajectories and unfinished error messages", () => {
    expect(stepPayload({ ...done, error_code: 503, parent_trajectory_id: "parent" })).toBeNull();
    expect(stepPayload({ ...legacy, http_code: 502, parent_trajectory_id: "parent" })).toBeNull();
    expect(stepPayload({ ...done, status: "ACTIVE", error_code: 503 })).toBeNull();
  });

  it("ignores completed model text, even with a code", () => {
    expect(stepPayload({ type: "TEXT_RESPONSE", status: "DONE", source: "MODEL", content: "HTTP 503", http_code: 503 }, true)).toBeNull();
  });
});
