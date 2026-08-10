import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  createExactConversationBinder,
  ExactConversationBindingError
} from "../src/agy/db/exact-conversation-binder.js";
import type { SqliteProviderSnapshotReader } from "../src/agy/db/provider-observer.js";
import { observeAgyStreamJsonIdentity } from "../src/agy/stream-json-identity.js";

const CONVERSATION_ID = "c3b66b04-872b-4fbe-a3a4-058a026ef20a";
const OTHER_CONVERSATION_ID = "055a398f-db14-4c5f-abbb-1bf03f8120a7";

function streamChannel(conversationId = CONVERSATION_ID) {
  const stream = new PassThrough();
  const channel = observeAgyStreamJsonIdentity(stream);
  stream.write(`${JSON.stringify({
    event: "init",
    conversation_id: conversationId,
    init: { cwd: "/workspace/project", tools: [] }
  })}\n`);
  return { stream, channel };
}

function snapshot(conversationId = CONVERSATION_ID, cursor = 2) {
  return {
    conversationId,
    cursor,
    latest: { cursor, kind: "activity" as const, status: "ACTIVE" as const },
    backgroundTasks: "settled" as const
  };
}

describe("ExactConversationBinder", () => {
  it("uses the official init identity and reads only that exact SQLite conversation", async () => {
    const seen: string[] = [];
    const reader: SqliteProviderSnapshotReader = {
      readSnapshot(conversationId) {
        seen.push(conversationId);
        return snapshot(conversationId, 7);
      }
    };
    const { stream, channel } = streamChannel();
    const binder = createExactConversationBinder({ reader, now: () => 1_000 });

    const binding = await binder.bind({
      identityChannel: channel,
      expectedConversationId: null,
      minimumCursor: 0
    });

    expect(binding).toMatchObject({ conversationId: CONVERSATION_ID, cursor: 7 });
    expect(seen).toEqual([CONVERSATION_ID]);
    stream.end(`${JSON.stringify({
      event: "result",
      result: { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "private" }
    })}\n`);
    await expect(binding.streamCompletion).resolves.toEqual({
      status: "drained",
      conversationId: CONVERSATION_ID
    });
  });

  it("requires a resumed stream identity to match the persisted conversation", async () => {
    const reader: SqliteProviderSnapshotReader = { readSnapshot: () => snapshot() };
    const { channel } = streamChannel(OTHER_CONVERSATION_ID);
    const binder = createExactConversationBinder({ reader, now: () => 1_000 });

    await expect(binder.bind({
      identityChannel: channel,
      expectedConversationId: CONVERSATION_ID,
      minimumCursor: 0
    })).rejects.toMatchObject({ code: "conversation_mismatch" });
  });

  it("polls only the bound database until its cursor reaches the required baseline", async () => {
    let clock = 1_000;
    let reads = 0;
    const reader: SqliteProviderSnapshotReader = {
      readSnapshot(conversationId) {
        reads += 1;
        if (reads === 1) return null;
        if (reads === 2) return snapshot(conversationId, 3);
        return snapshot(conversationId, 4);
      }
    };
    const wait = vi.fn(async (milliseconds: number) => {
      clock += milliseconds;
    });
    const { channel } = streamChannel();
    const binder = createExactConversationBinder({
      reader,
      now: () => clock,
      timeoutMs: 100,
      pollIntervalMs: 10,
      wait
    });

    await expect(binder.bind({
      identityChannel: channel,
      expectedConversationId: null,
      minimumCursor: 4
    })).resolves.toMatchObject({ conversationId: CONVERSATION_ID, cursor: 4 });
    expect(reads).toBe(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("fails closed on timeout, cancellation, or malformed SQLite evidence", async () => {
    let clock = 1_000;
    const reader: SqliteProviderSnapshotReader = {
      readSnapshot: () => ({ ...snapshot(), conversationId: OTHER_CONVERSATION_ID })
    };
    const { channel } = streamChannel();
    const binder = createExactConversationBinder({
      reader,
      now: () => clock,
      timeoutMs: 10,
      pollIntervalMs: 10,
      wait: async (milliseconds) => { clock += milliseconds; }
    });

    await expect(binder.bind({
      identityChannel: channel,
      expectedConversationId: null,
      minimumCursor: 0
    })).rejects.toMatchObject({ code: "sqlite_unavailable" });

    const cancelled = new AbortController();
    cancelled.abort();
    await expect(binder.bind({
      identityChannel: channel,
      expectedConversationId: null,
      minimumCursor: 0,
      signal: cancelled.signal
    })).rejects.toMatchObject({ code: "cancelled" });
  });

  it("fails closed when the identity stream terminates before init or later violates its conversation", async () => {
    const reader: SqliteProviderSnapshotReader = { readSnapshot: () => null };
    const missingStream = new PassThrough();
    const missing = observeAgyStreamJsonIdentity(missingStream);
    missingStream.end();
    const binder = createExactConversationBinder({ reader, now: () => 1_000 });
    await expect(binder.bind({
      identityChannel: missing,
      expectedConversationId: null,
      minimumCursor: 0
    })).rejects.toMatchObject({ code: "identity_unavailable" });

    const mismatch = streamChannel();
    mismatch.stream.end(`${JSON.stringify({
      event: "result",
      result: { conversation_id: OTHER_CONVERSATION_ID, status: "SUCCESS" }
    })}\n`);
    const mismatchBinder = createExactConversationBinder({
      reader,
      now: () => 1_000,
      wait: async () => {}
    });
    await expect(mismatchBinder.bind({
      identityChannel: mismatch.channel,
      expectedConversationId: null,
      minimumCursor: 0
    })).rejects.toMatchObject({ code: "stream_protocol_error" });
  });

  it("withholds SQLite terminal evidence until the matching identity stream drains", async () => {
    const reader: SqliteProviderSnapshotReader = {
      readSnapshot(conversationId) {
        return {
          conversationId,
          cursor: 7,
          latest: { cursor: 7, kind: "terminal" as const, status: "SUCCESS" as const },
          backgroundTasks: "settled" as const
        };
      }
    };
    const { stream, channel } = streamChannel();
    const binding = await createExactConversationBinder({ reader, now: () => 1_000 }).bind({
      identityChannel: channel,
      expectedConversationId: null,
      minimumCursor: 0
    });

    await expect(binding.observer.observeTerminal()).resolves.toBeNull();
    stream.end(`${JSON.stringify({
      event: "result",
      result: { conversation_id: CONVERSATION_ID, status: "SUCCESS", response: "private" }
    })}\n`);
    await expect(binding.streamCompletion).resolves.toEqual({
      status: "drained",
      conversationId: CONVERSATION_ID
    });
    await expect(binding.observer.observeTerminal()).resolves.toEqual({
      source: "sqlite_reconciliation",
      conversationId: CONVERSATION_ID,
      observedAt: 1_000,
      status: "SUCCESS"
    });
  });

  it("validates construction and request values without touching SQLite", async () => {
    expect(() => createExactConversationBinder({ reader: null as never })).toThrow(
      ExactConversationBindingError
    );
    const readSnapshot = vi.fn(() => snapshot());
    const binder = createExactConversationBinder({ reader: { readSnapshot } });
    const { channel } = streamChannel();

    await expect(binder.bind({
      identityChannel: channel,
      expectedConversationId: "not-an-id",
      minimumCursor: 0
    })).rejects.toMatchObject({ code: "invalid_input" });
    expect(readSnapshot).not.toHaveBeenCalled();
  });
});
