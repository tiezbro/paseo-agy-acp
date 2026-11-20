import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { kernelTerminalStatePath } from "../ACP Connector/official-kernel/kernel-terminal-state.js";
import { createNdjsonParser, encodeNdjson } from "../ACP Connector/official-kernel/ndjson.js";
import { OfficialKernelProxy } from "../ACP Connector/official-kernel/proxy.js";
import type { JsonRpcMessage } from "../ACP Connector/official-kernel/json-rpc.js";

interface Harness {
  readonly proxy: OfficialKernelProxy;
  readonly running: Promise<void>;
  readonly forwarded: JsonRpcMessage[];
  readonly received: JsonRpcMessage[];
  readonly send: (message: JsonRpcMessage) => void;
  readonly reply: (message: JsonRpcMessage) => void;
  readonly observeRetry: (sessionId?: string, delayMs?: number) => void;
  readonly close: () => void;
  readonly directory: string;
}

function harness(): Harness {
  const directory = mkdtempSync(path.join(os.tmpdir(), "paseo-kernel-events-"));
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: process.pid
  });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const forwarded: JsonRpcMessage[] = [];
  const received: JsonRpcMessage[] = [];
  child.stdin.on("data", createNdjsonParser(message => forwarded.push(message)));
  stdout.on("data", createNdjsonParser(message => received.push(message)));
  const proxy = new OfficialKernelProxy({
    child: child as unknown as ChildProcessWithoutNullStreams,
    stdin,
    stdout,
    version: "test",
    env: { HOME: directory },
    kernelEventDirectory: directory
  });
  return {
    proxy,
    running: proxy.start(),
    forwarded,
    received,
    send: message => stdin.write(encodeNdjson(message)),
    reply: message => child.stdout.write(encodeNdjson(message)),
    observeRetry(sessionId = "session-a", delayMs = 4000) {
      proxy.observeKernelEvent({
        v: 1,
        event: "model_retry_scheduled",
        session: sessionId,
        delayMs,
        emittedAt: Date.now()
      });
    },
    close: () => child.emit("close", 0),
    directory
  };
}

function kernelNotices(current: Harness): JsonRpcMessage[] {
  return current.received.filter(message => {
    if (!("method" in message) || message.method !== "session/update" || typeof message.params !== "object" || message.params === null) {
      return false;
    }
    const update = (message.params as { update?: { _meta?: Record<string, unknown> } }).update;
    const meta = update?._meta;
    return meta?.["paseo.dev/messageKind"] === "system";
  });
}

async function closeHarness(current: Harness): Promise<void> {
  current.close();
  await current.running;
  rmSync(current.directory, { recursive: true, force: true });
}

describe("official kernel progress notices", () => {
  it("wires each retry plan as its own system chunk without raw error data", async () => {
    const current = harness();
    try {
      current.send({ id: 1, method: "session/prompt", params: { sessionId: "session-a", prompt: "hello" } });
      await vi.waitFor(() => expect(current.forwarded.some(message => "method" in message && message.method === "session/prompt")).toBe(true));

      current.observeRetry();
      current.observeRetry("session-a", undefined);

      await vi.waitFor(() => expect(current.received.filter(message => "method" in message && message.method === "session/update")).toHaveLength(2));
      const [first, second] = current.received.filter(message => "method" in message);
      expect(first).toMatchObject({
        method: "session/update",
        params: {
          sessionId: "session-a",
          update: {
            sessionUpdate: "agent_message_chunk",
            _meta: {
              "paseo.dev/messageKind": "system",
              "paseo.dev/kernelEvent": { v: 1, event: "model_retry_scheduled", delayMs: 4000 }
            }
          }
        }
      });
      expect(second).toMatchObject({
        params: {
          update: {
            _meta: { "paseo.dev/kernelEvent": { v: 1, event: "model_retry_scheduled" } }
          }
        }
      });
      const messageIds = [first, second].map(message => {
        const params = (message as { params: { update: { messageId: string } } }).params;
        return params.update.messageId;
      });
      expect(new Set(messageIds).size).toBe(2);
      expect(JSON.stringify(current.received)).not.toContain("Bad Gateway");
      expect(JSON.stringify(current.received)).not.toContain("gemini-4-argon-low");
    } finally {
      await closeHarness(current);
    }
  });

  it("does not display HTTP 0 for an unknown backend status", async () => {
    const current = harness();
    try {
      current.send({ id: 1, method: "session/prompt", params: { sessionId: "session-a", prompt: "hello" } });
      await vi.waitFor(() => expect(current.forwarded.some(message => "method" in message && message.method === "session/prompt")).toBe(true));
      current.proxy.observeKernelEvent({
        v: 1,
        event: "backend_http_error",
        session: "session-a",
        httpStatus: 0,
        emittedAt: Date.now()
      });
      await vi.waitFor(() => expect(current.received.filter(message => "method" in message)).toHaveLength(1));
      const notice = current.received.find(message => "method" in message) as {
        params: { update: { content: { text: string }; _meta: { "paseo.dev/kernelEvent": unknown } } };
      };
      expect(notice.params.update.content.text).not.toContain("HTTP 0");
      expect(notice.params.update._meta["paseo.dev/kernelEvent"]).toEqual({
        v: 1,
        event: "backend_http_error",
        httpStatus: 0
      });
    } finally {
      await closeHarness(current);
    }
  });

  it("drops retry notices once the turn is cancelled", async () => {
    const current = harness();
    try {
      current.send({ id: 1, method: "session/prompt", params: { sessionId: "session-a", prompt: "hello" } });
      await vi.waitFor(() => expect(current.forwarded.some(message => "method" in message && message.method === "session/prompt")).toBe(true));
      current.observeRetry();
      await vi.waitFor(() => expect(current.received.filter(message => "method" in message)).toHaveLength(1));
      current.send({ method: "session/cancel", params: { sessionId: "session-a" } });
      await vi.waitFor(() => expect(current.forwarded.some(message => "method" in message && message.method === "session/cancel")).toBe(true));
      current.observeRetry();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(current.received.filter(message => "method" in message)).toHaveLength(1);
      current.reply({ id: 1, result: { stopReason: "cancelled" } });
      await vi.waitFor(() => expect(current.received.some(message => "id" in message && message.id === 1)).toBe(true));
    } finally {
      await closeHarness(current);
    }
  });

  it("never shows a previous turn's delayed retry decision in the next active turn", async () => {
    const current = harness();
    try {
      current.send({ id: 1, method: "session/prompt", params: { sessionId: "session-a", prompt: "one" } });
      await vi.waitFor(() => expect(current.forwarded.filter(message => "method" in message && message.method === "session/prompt")).toHaveLength(1));
      const oldDecision = Date.now();
      current.proxy.observeKernelEvent({
        v: 1,
        event: "model_retry_scheduled",
        session: "session-a",
        delayMs: 4000,
        emittedAt: oldDecision
      });
      await vi.waitFor(() => expect(kernelNotices(current)).toHaveLength(1));

      current.reply({
        method: "session/update",
        params: {
          sessionId: "session-a",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } }
        }
      });
      current.reply({ id: 1, result: { stopReason: "end_turn" } });
      await vi.waitFor(() => expect(current.received.some(message => "id" in message && message.id === 1)).toBe(true));

      current.send({ id: 2, method: "session/prompt", params: { sessionId: "session-a", prompt: "two" } });
      await vi.waitFor(() => expect(current.forwarded.filter(message => "method" in message && message.method === "session/prompt")).toHaveLength(2));
      current.proxy.observeKernelEvent({
        v: 1,
        event: "model_retry_scheduled",
        session: "session-a",
        delayMs: 4000,
        emittedAt: oldDecision
      });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(kernelNotices(current)).toHaveLength(1);

      current.proxy.observeKernelEvent({
        v: 1,
        event: "model_retry_scheduled",
        session: "session-a",
        delayMs: 4000,
        emittedAt: Date.now() + 1000
      });
      await vi.waitFor(() => expect(kernelNotices(current)).toHaveLength(2));
    } finally {
      await closeHarness(current);
    }
  });

  it("turns a fenced official terminal log into a JSON-RPC failure and cleans the fence", async () => {
    const current = harness();
    const sessionId = "session-terminal";
    try {
      current.send({ id: 1, method: "session/prompt", params: { sessionId, prompt: "hello" } });
      await vi.waitFor(() => expect(current.forwarded.some(message => "method" in message && message.method === "session/prompt")).toBe(true));
      const statePath = kernelTerminalStatePath(current.directory, sessionId);
      writeFileSync(statePath, JSON.stringify({
        v: 1,
        event: "turn_failed",
        session: sessionId,
        errorClass: "AntigravityExecutionError",
        sequence: 1,
        writtenAt: Date.now()
      }));
      current.reply({
        method: "session/update",
        params: {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial output" } }
        }
      });
      current.reply({ id: 1, result: { stopReason: "end_turn" } });

      await vi.waitFor(() => expect(current.received.some(message => "id" in message && message.id === 1)).toBe(true));
      const response = current.received.find(message => "id" in message && message.id === 1);
      expect(response).toMatchObject({
        id: 1,
        error: {
          code: -32000,
          data: {
            "paseo.dev/kernelEvent": {
              v: 1,
              event: "turn_failed",
              errorClass: "AntigravityExecutionError"
            }
          }
        }
      });
      expect(existsSync(statePath)).toBe(false);
    } finally {
      await closeHarness(current);
    }
  });
});
