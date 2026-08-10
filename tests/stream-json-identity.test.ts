import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  AgyStreamJsonIdentityError,
  observeAgyStreamJsonIdentity
} from "../src/agy/stream-json-identity.js";

const CONVERSATION_ID = "c3b66b04-872b-4fbe-a3a4-058a026ef20a";
const OTHER_CONVERSATION_ID = "055a398f-db14-4c5f-abbb-1bf03f8120a7";

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function init(conversationId = CONVERSATION_ID): Record<string, unknown> {
  return {
    event: "init",
    conversation_id: conversationId,
    init: {
      cwd: "/workspace/project",
      tools: ["run_command"],
      permission_mode: "always-proceed"
    }
  };
}

describe("agy stream-json identity channel", () => {
  it("binds the first split init event and drains later provider payloads without returning them", async () => {
    const stream = new PassThrough();
    const channel = observeAgyStreamJsonIdentity(stream);
    const privateText = "raw response and Authorization header must not escape";
    const encoded = line(init());

    stream.write(encoded.slice(0, 17));
    stream.write(encoded.slice(17));
    await expect(channel.identity).resolves.toEqual({ conversationId: CONVERSATION_ID });

    stream.write(line({
      event: "step_update",
      step_update: {
        conversation_id: CONVERSATION_ID,
        step_index: 3,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: privateText
      }
    }));
    stream.end(line({
      event: "result",
      result: {
        conversation_id: CONVERSATION_ID,
        status: "SUCCESS",
        response: privateText
      }
    }));

    const completion = await channel.completion;
    expect(completion).toEqual({ status: "drained", conversationId: CONVERSATION_ID });
    expect(JSON.stringify(completion)).not.toContain(privateText);
  });

  it("rejects a stream whose first event is not init", async () => {
    const stream = new PassThrough();
    const channel = observeAgyStreamJsonIdentity(stream);
    stream.end(line({
      event: "step_update",
      step_update: { conversation_id: CONVERSATION_ID }
    }));

    await expect(channel.identity).rejects.toMatchObject({
      name: "AgyStreamJsonIdentityError",
      code: "unexpected_first_event"
    });
    await expect(channel.completion).resolves.toEqual({
      status: "protocol_error",
      code: "unexpected_first_event"
    });
  });

  it("reports a later conversation mismatch without exposing the provider event", async () => {
    const stream = new PassThrough();
    const channel = observeAgyStreamJsonIdentity(stream);
    stream.write(line(init()));
    await expect(channel.identity).resolves.toEqual({ conversationId: CONVERSATION_ID });

    stream.end(line({
      event: "result",
      result: {
        conversation_id: OTHER_CONVERSATION_ID,
        status: "ERROR",
        error: "Bearer private-provider-error"
      }
    }));

    const completion = await channel.completion;
    expect(completion).toEqual({ status: "protocol_error", code: "conversation_mismatch" });
    expect(JSON.stringify(completion)).not.toContain("private-provider-error");
  });

  it("fails closed for malformed, oversized, or missing init data", async () => {
    const malformed = new PassThrough();
    const malformedChannel = observeAgyStreamJsonIdentity(malformed);
    malformed.end("not-json\n");
    await expect(malformedChannel.identity).rejects.toMatchObject({ code: "malformed_event" });

    const oversized = new PassThrough();
    const oversizedChannel = observeAgyStreamJsonIdentity(oversized, { maxLineBytes: 64 });
    oversized.end("x".repeat(65));
    await expect(oversizedChannel.identity).rejects.toMatchObject({ code: "line_too_large" });

    const empty = new PassThrough();
    const emptyChannel = observeAgyStreamJsonIdentity(empty);
    empty.end();
    await expect(emptyChannel.identity).rejects.toMatchObject({ code: "stream_ended_before_init" });
  });

  it("detaches explicitly and rejects identity when closed before init", async () => {
    const stream = new PassThrough();
    const channel = observeAgyStreamJsonIdentity(stream);
    channel.close();

    await expect(channel.identity).rejects.toMatchObject({ code: "closed_before_init" });
    await expect(channel.completion).resolves.toEqual({ status: "closed" });
    stream.end(line(init()));
  });

  it("validates source and bounded line options synchronously", () => {
    expect(() => observeAgyStreamJsonIdentity(null)).toThrow(AgyStreamJsonIdentityError);
    expect(() => observeAgyStreamJsonIdentity(new PassThrough(), { maxLineBytes: 63 })).toThrow(
      AgyStreamJsonIdentityError
    );
  });
});
