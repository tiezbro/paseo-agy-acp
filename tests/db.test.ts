import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConversationDb, type DbStat, statConversation } from "../ACP Connector/agy/db/database.js";
import { ReplayCache, isDbStatUnchanged } from "../ACP Connector/agy/db/replay.js";
import { conversationSnapshot, newConversationId } from "../ACP Connector/agy/db/scan.js";
import { StreamPoller } from "../ACP Connector/agy/db/streaming.js";
import { Translator } from "../ACP Connector/agy/db/translator.js";
import { sessionUpdateFromStep } from "../ACP Connector/agy/db/updates.js";
import { createConversationDb, insertStep, updateStep, updateStepPayload } from "./fixtures/conversation-db.js";
import {
  encodeAgentText,
  encodeCommandResult,
  encodeGrepSearchResult,
  encodeModelProviderError,
  encodePermissions,
  encodeSearchHit,
  encodeStepPayload,
  encodeTaskDetails,
  encodeToolCall,
  encodeToolRun,
  encodeUrlContentResult,
  encodeViewFileResult,
  encodeWebSearchResult
} from "./fixtures/step-encoder.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("ConversationDb", () => {
  it("decodes agent text and tool-run rows from a real sqlite file", () => {
    const db = createConversationDb(dir, "conv-1");
    insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "Hello" }) });
    insertStep(db, {
      idx: 2,
      stepType: 21,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({ callId: "c1", namePrimary: "run_command", rawInputJson: '{"CommandLine":"echo hi"}' })
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-1");
    expect(conn).not.toBeNull();
    const rows = conn!.readAfter(0);
    conn!.close();

    expect(rows).toHaveLength(2);
    expect(rows[0].stepPayload.agentText?.text).toBe("Hello");
    expect(rows[1].stepPayload.toolRun?.call?.namePrimary).toBe("run_command");
    expect(rows[1].stepPayload.toolRun?.call?.rawInputJson).toBe('{"CommandLine":"echo hi"}');
  });

  it("decodes agent text thinking/reasoning (tag 3) from step type 15 payload", () => {
    const db = createConversationDb(dir, "conv-thought-step15");
    insertStep(db, {
      idx: 1,
      stepType: 15,
      stepPayload: encodeStepPayload({
        agentText: { text: "Result: 309524", thought: "Calculating 347 * 892..." }
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-thought-step15");
    expect(conn).not.toBeNull();
    const rows = conn!.readAfter(0);
    conn!.close();

    expect(rows).toHaveLength(1);
    expect(rows[0].stepPayload.agentText?.text).toBe("Result: 309524");
    expect(rows[0].stepPayload.agentText?.thought).toBe("Calculating 347 * 892...");
  });

  it("decodes the model-provider error wrapper from field 24", () => {
    const db = createConversationDb(dir, "conv-provider-error");
    insertStep(db, {
      idx: 1,
      stepType: 17,
      stepPayload: encodeStepPayload({
        modelProviderError: encodeModelProviderError({
          summary: "RESOURCE_EXHAUSTED (code 429): quota reached",
          diagnostic: "HTTP 429 Too Many Requests",
          responseJson: '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}',
          userMessage: "RESOURCE_EXHAUSTED (code 429): quota reached"
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-provider-error")!;
    const rows = conn.readAfter(-1);
    conn.close();

    expect(rows[0].stepPayload.modelProviderError).toEqual({
      summary: "RESOURCE_EXHAUSTED (code 429): quota reached",
      diagnostic: "HTTP 429 Too Many Requests",
      responseJson: '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}',
      userMessage: "RESOURCE_EXHAUSTED (code 429): quota reached"
    });
  });

  it("returns null for a missing conversation", () => {
    expect(ConversationDb.open(dir, "does-not-exist")).toBeNull();
  });

  it("skips a row whose payload fails to decode instead of throwing, and retries it once fixed", () => {
    const db = createConversationDb(dir, "conv-corrupt");
    insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "Hello" }) });
    const goodPayload = encodeStepPayload({
      toolRun: encodeToolRun({ call: encodeToolCall({ namePrimary: "run_command", rawInputJson: "{}" }) })
    });
    // Simulate a torn read of a row agy is still writing to: a submessage
    // truncated mid-field, which throws "premature EOF" while decoding.
    insertStep(db, { idx: 2, stepType: 21, stepPayload: goodPayload.slice(0, goodPayload.length - 2) });

    const conn = ConversationDb.open(dir, "conv-corrupt")!;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const rows = conn.readAfter(0);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("failed to decode step 2"));
    errorSpy.mockRestore();

    expect(rows).toHaveLength(1);
    expect(rows[0].idx).toBe(1);

    updateStepPayload(db, 2, goodPayload);
    const retried = conn.readAfter(1);
    expect(retried).toHaveLength(1);
    expect(retried[0].stepPayload.toolRun?.call?.namePrimary).toBe("run_command");

    conn.close();
    db.close();
  });
});

describe("Translator", () => {
  it("emits only the final persisted quota exhaustion as an agent message", () => {
    const db = createConversationDb(dir, "conv-quota-exhausted");
    const summaries = [
      "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 3h35m25s.",
      "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 3h35m24s.",
      "RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 3h35m22s."
    ];
    const responseJson = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        details: [{ reason: "QUOTA_EXHAUSTED" }]
      }
    });
    summaries.forEach((summary, index) => {
      insertStep(db, {
        idx: 27 + index * 2,
        stepType: 17,
        status: 3,
        stepPayload: encodeStepPayload({
          modelProviderError: encodeModelProviderError({
            summary,
            diagnostic: "HTTP 429 Too Many Requests",
            responseJson,
            userMessage:
              index === summaries.length - 1
                ? summary
                : "The model API is currently overloaded and may experience intermittent errors."
          })
        })
      });
    });
    db.close();

    const expected = [{
      sessionUpdate: "agent_message_chunk",
      messageId: "provider-error-31",
      content: { type: "text", text: summaries[2] },
      _meta: { stepIdx: 31 }
    }];

    const replayConn = ConversationDb.open(dir, "conv-quota-exhausted")!;
    const replay = new Translator({ mode: "replay", skipNarration: false });
    expect(replay.translate(replayConn.readAfter(-1))).toEqual(expected);
    replayConn.close();

    const streamConn = ConversationDb.open(dir, "conv-quota-exhausted")!;
    const stream = new Translator({ mode: "stream", skipNarration: false });
    expect(stream.translate(streamConn.readAfter(-1))).toEqual(expected);
    expect(stream.translate(streamConn.readAfter(-1))).toEqual([]);
    streamConn.close();
  });

  it("does not infer quota exhaustion without the observed structured response and final message", () => {
    const summary = "RESOURCE_EXHAUSTED (code 429): quota reached";
    const db = createConversationDb(dir, "conv-unverified-quota");
    insertStep(db, {
      idx: 1,
      stepType: 17,
      stepPayload: encodeStepPayload({
        modelProviderError: encodeModelProviderError({
          summary,
          responseJson: '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}',
          userMessage: summary
        })
      })
    });
    insertStep(db, {
      idx: 2,
      stepType: 17,
      stepPayload: encodeStepPayload({
        modelProviderError: encodeModelProviderError({
          summary,
          responseJson: JSON.stringify({
            error: {
              code: 429,
              status: "RESOURCE_EXHAUSTED",
              details: [{ reason: "QUOTA_EXHAUSTED" }]
            }
          }),
          userMessage: "The model API is currently overloaded and may experience intermittent errors."
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-unverified-quota")!;
    const updates = new Translator({ mode: "replay", skipNarration: false }).translate(
      conn.readAfter(-1)
    );
    conn.close();

    expect(updates).toEqual([]);
  });

  it("waits for a provider-error row to become terminal before emitting its full message", () => {
    const initial = "RESOURCE_EXHAUSTED (code 429): quota reached. Resets in 4h.";
    const final = "RESOURCE_EXHAUSTED (code 429): quota reached. Resets in 3h59m58s.";
    const responseJson = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        details: [{ reason: "QUOTA_EXHAUSTED" }]
      }
    });
    const db = createConversationDb(dir, "conv-growing-provider-error");
    insertStep(db, {
      idx: 1,
      stepType: 17,
      status: 1,
      stepPayload: encodeStepPayload({
        modelProviderError: encodeModelProviderError({
          summary: initial,
          responseJson,
          userMessage: initial
        })
      })
    });

    const conn = ConversationDb.open(dir, "conv-growing-provider-error")!;
    const translator = new Translator({ mode: "stream", skipNarration: false });
    expect(translator.translate(conn.readAfter(-1))).toEqual([]);

    updateStep(db, 1, {
      status: 3,
      stepPayload: encodeStepPayload({
        modelProviderError: encodeModelProviderError({
          summary: final,
          responseJson,
          userMessage: final
        })
      })
    });
    expect(translator.translate(conn.readAfter(-1))).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "provider-error-1",
        content: { type: "text", text: final },
        _meta: { stepIdx: 1 }
      }
    ]);
    expect(translator.translate(conn.readAfter(-1))).toEqual([]);

    conn.close();
    db.close();
  });

  it("streams only the newly-appended slice of a growing agent-text row", () => {
    const db = createConversationDb(dir, "conv-2");
    insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "Hello" }) });

    const translator = new Translator({ mode: "stream", skipNarration: false });
    const conn = ConversationDb.open(dir, "conv-2")!;

    const first = translator.translate(conn.readAfter(0));
    expect(first).toEqual([
      { sessionUpdate: "agent_message_chunk", messageId: "1", content: { type: "text", text: "Hello" } }
    ]);

    updateStepPayload(db, 1, encodeStepPayload({ agentText: "Hello world" }));
    const second = translator.translate(conn.readAfter(0));
    expect(second).toEqual([
      { sessionUpdate: "agent_message_chunk", messageId: "1", content: { type: "text", text: " world" } }
    ]);

    conn.close();
    db.close();
  });

  it("uses one message id for consecutive agent-text rows in streaming and replay", () => {
    const db = createConversationDb(dir, "conv-stream-message-group");
    insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "Hello" }) });
    insertStep(db, { idx: 2, stepType: 15, stepPayload: encodeStepPayload({ agentText: "world" }) });
    db.close();

    const streamConn = ConversationDb.open(dir, "conv-stream-message-group")!;
    const streamUpdates = new Translator({ mode: "stream", skipNarration: false }).translate(
      streamConn.readAfter(-1)
    );
    streamConn.close();
    expect(streamUpdates).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "Hello" }
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "\nworld" }
      }
    ]);

    const replayConn = ConversationDb.open(dir, "conv-stream-message-group")!;
    const replayUpdates = new Translator({ mode: "replay", skipNarration: false }).translate(
      replayConn.readAfter(-1)
    );
    replayConn.close();
    expect(replayUpdates).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "Hello\nworld" },
        _meta: { stepIdx: 1, endStepIdx: 2 }
      }
    ]);
  });

  it("starts a streaming message group at the first row containing answer text", () => {
    const db = createConversationDb(dir, "conv-stream-thought-first");
    insertStep(db, {
      idx: 1,
      stepType: 15,
      stepPayload: encodeStepPayload({ agentText: { thought: "Thinking" } })
    });
    insertStep(db, {
      idx: 2,
      stepType: 15,
      stepPayload: encodeStepPayload({ agentText: "Answer" })
    });
    db.close();

    const streamConn = ConversationDb.open(dir, "conv-stream-thought-first")!;
    const streamUpdates = new Translator({ mode: "stream", skipNarration: false }).translate(
      streamConn.readAfter(-1)
    );
    streamConn.close();
    expect(streamUpdates).toContainEqual({
      sessionUpdate: "agent_message_chunk",
      messageId: "2",
      content: { type: "text", text: "Answer" }
    });

    const replayConn = ConversationDb.open(dir, "conv-stream-thought-first")!;
    const replayUpdates = new Translator({ mode: "replay", skipNarration: false }).translate(
      replayConn.readAfter(-1)
    );
    replayConn.close();
    expect(replayUpdates).toContainEqual({
      sessionUpdate: "agent_message_chunk",
      messageId: "2",
      content: { type: "text", text: "Answer" },
      _meta: { stepIdx: 2 }
    });
  });

  it("dedupes unchanged tool-call steps across repeated polls in stream mode", () => {
    const db = createConversationDb(dir, "conv-3");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({ call: encodeToolCall({ namePrimary: "run_command", rawInputJson: "{}" }) })
      })
    });

    const translator = new Translator({ mode: "stream", skipNarration: false });
    const conn = ConversationDb.open(dir, "conv-3")!;

    expect(translator.translate(conn.readAfter(0))).toHaveLength(1);
    expect(translator.translate(conn.readAfter(0))).toHaveLength(0); // already emitted

    conn.close();
    db.close();
  });

  it("re-emits a progressive tool update when its decoded name changes", () => {
    const db = createConversationDb(dir, "conv-progressive-tool-name");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 2,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "late-name",
            rawInputJson: '{"CommandLine":"echo hi"}'
          })
        })
      })
    });

    const translator = new Translator({ mode: "stream", skipNarration: false });
    const conn = ConversationDb.open(dir, "conv-progressive-tool-name")!;

    expect(translator.translate(conn.readAfter(0))).toMatchObject([
      {
        sessionUpdate: "tool_call",
        toolCallId: "late-name",
        name: "run_command"
      }
    ]);

    updateStepPayload(
      db,
      1,
      encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "late-name",
            nameSecondary: "resolved_command_tool",
            rawInputJson: '{"CommandLine":"echo hi"}'
          })
        })
      })
    );

    expect(translator.translate(conn.readAfter(0))).toMatchObject([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "late-name",
        name: "resolved_command_tool"
      }
    ]);
    expect(translator.translate(conn.readAfter(0))).toEqual([]);

    conn.close();
    db.close();
  });

  it("emits tool_call then tool_call_update when status progresses on the same idx", () => {
    const db = createConversationDb(dir, "conv-tool-progress");
    const call = encodeToolCall({
      callId: "cmd-1",
      namePrimary: "run_command",
      rawInputJson: '{"CommandLine":"echo hi"}'
    });
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 2, // in_progress
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({ call })
      })
    });

    const translator = new Translator({ mode: "stream", skipNarration: false });
    const conn = ConversationDb.open(dir, "conv-tool-progress")!;

    const first = translator.translate(conn.readAfter(0));
    expect(first).toMatchObject([
      {
        sessionUpdate: "tool_call",
        toolCallId: "cmd-1",
        kind: "execute",
        status: "in_progress",
        title: "echo hi"
      }
    ]);

    updateStep(db, 1, {
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({ call }),
        commandResult: encodeCommandResult({
          cwd: "/repo",
          exitCode: 0,
          output: "hi\n",
          command: "echo hi"
        })
      })
    });

    const second = translator.translate(conn.readAfter(0));
    expect(second).toMatchObject([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "cmd-1",
        kind: "execute",
        status: "completed",
        title: "echo hi"
      }
    ]);
    const content = (second[0] as { content?: Array<{ content?: { text?: string } }> }).content ?? [];
    const texts = content.map((c) => c.content?.text ?? "").join("\n");
    expect(texts).toContain("hi");

    // Unchanged snapshot: no third emission.
    expect(translator.translate(conn.readAfter(0))).toHaveLength(0);

    conn.close();
    db.close();
  });

  it("prioritizes CommandLine firstLine over toolSummary in executeUpdate title (issue #69)", () => {
    const db = createConversationDb(dir, "conv-title-priority");
    const call = encodeToolCall({
      callId: "cmd-title-1",
      namePrimary: "run_command",
      rawInputJson: JSON.stringify({
        CommandLine: "gh issue view 69",
        toolSummary: "View issue 69",
        toolAction: "Checking GitHub issue"
      })
    });
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 2, // in_progress
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({ call })
      })
    });

    const translator = new Translator({ mode: "stream", skipNarration: false });
    const conn = ConversationDb.open(dir, "conv-title-priority")!;

    const updates = translator.translate(conn.readAfter(0));
    expect(updates).toMatchObject([
      {
        sessionUpdate: "tool_call",
        toolCallId: "cmd-title-1",
        kind: "execute",
        status: "in_progress",
        title: "gh issue view 69"
      }
    ]);

    conn.close();
    db.close();
  });

  it("streams stdout output while step status is in_progress (status 2) (issue #69)", () => {
    const db = createConversationDb(dir, "conv-streaming-output");
    const call = encodeToolCall({
      callId: "cmd-stream-out",
      namePrimary: "run_command",
      rawInputJson: JSON.stringify({ CommandLine: "long_running_task" })
    });
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 2, // in_progress
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({ call })
      })
    });

    const translator = new Translator({ mode: "stream", skipNarration: false });
    const conn = ConversationDb.open(dir, "conv-streaming-output")!;

    const first = translator.translate(conn.readAfter(0));
    expect(first).toMatchObject([
      {
        sessionUpdate: "tool_call",
        toolCallId: "cmd-stream-out",
        status: "in_progress",
        title: "long_running_task"
      }
    ]);

    // Live stdout arrives in commandResult while status is still in_progress (2)
    updateStep(db, 1, {
      status: 2,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({ call }),
        commandResult: encodeCommandResult({
          cwd: "/repo",
          output: "step 1 completed\n",
          command: "long_running_task"
        })
      })
    });

    const second = translator.translate(conn.readAfter(0));
    expect(second).toMatchObject([
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "cmd-stream-out",
        status: "in_progress"
      }
    ]);
    const content = (second[0] as { content?: Array<{ content?: { text?: string } }> }).content ?? [];
    const texts = content.map((c) => c.content?.text ?? "").join("\n");
    expect(texts).toContain("step 1 completed");

    conn.close();
    db.close();
  });

  it("maps active step status 1 to in_progress tool status", () => {
    const db = createConversationDb(dir, "conv-status-1");
    const call = encodeToolCall({ callId: "active-1", namePrimary: "run_command", rawInputJson: '{"CommandLine":"echo active"}' });
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 1, // active
      stepPayload: encodeStepPayload({ toolRun: encodeToolRun({ call }) })
    });
    const translator = new Translator({ mode: "stream", skipNarration: false });
    const conn = ConversationDb.open(dir, "conv-status-1")!;
    const res = translator.translate(conn.readAfter(0));
    expect(res).toMatchObject([
      {
        sessionUpdate: "tool_call",
        toolCallId: "active-1",
        status: "in_progress"
      }
    ]);
    conn.close();
    db.close();
  });

  it("maps permission-pending status 9 and dedupes its transition", () => {
    const db = createConversationDb(dir, "conv-pending");
    const payload = encodeStepPayload({ toolRun: encodeToolRun({ call: encodeToolCall({ callId: "p1", namePrimary: "run_command", rawInputJson: "{}" }) }) });
    insertStep(db, { idx: 1, stepType: 21, status: 9, stepPayload: payload });
    const translator = new Translator({ mode: "stream", skipNarration: false });
    const conn = ConversationDb.open(dir, "conv-pending")!;
    expect(translator.translate(conn.readAfter(0))).toMatchObject([{ sessionUpdate: "tool_call", status: "pending" }]);
    expect(translator.translate(conn.readAfter(0))).toEqual([]);
    updateStep(db, 1, { status: 3, stepPayload: payload });
    expect(translator.translate(conn.readAfter(0))).toMatchObject([{ sessionUpdate: "tool_call_update", status: "completed" }]);
    conn.close(); db.close();
  });


  it("emits agent_thought_chunk for title-attached Think narration", () => {
    const db = createConversationDb(dir, "conv-thought");
    insertStep(db, {
      idx: 1,
      stepType: 23,
      stepPayload: encodeStepPayload({
        titleUpdate: "My session\n\nI will inspect the repo structure first."
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-thought")!;
    const translator = new Translator({ mode: "stream", skipNarration: false });
    const updates = translator.translate(conn.readAfter(0));
    conn.close();

    expect(updates).toEqual([
      { sessionUpdate: "session_info_update", title: "My session", _meta: { stepIdx: 1 } },
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "title-thought-1",
        content: { type: "text", text: "I will inspect the repo structure first." },
        _meta: { stepIdx: 1 }
      }
    ]);

    // Second poll: no duplicate thought/title.
    const conn2 = ConversationDb.open(dir, "conv-thought")!;
    expect(translator.translate(conn2.readAfter(0))).toHaveLength(0);
    conn2.close();
  });

  it("emits agent_thought_chunk for step type 15 carrying thought payload in streaming and replay modes", () => {
    const db = createConversationDb(dir, "conv-agent-thought-stream");
    insertStep(db, {
      idx: 1,
      stepType: 15,
      stepPayload: encodeStepPayload({
        agentText: { text: "Final output", thought: "Thinking deeply..." }
      })
    });
    db.close();

    // Stream mode
    const connStream = ConversationDb.open(dir, "conv-agent-thought-stream")!;
    const streamTranslator = new Translator({ mode: "stream", skipNarration: false });
    const streamUpdates = streamTranslator.translate(connStream.readAfter(0));
    connStream.close();

    expect(streamUpdates).toEqual([
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "agent-thought-1",
        content: { type: "text", text: "Thinking deeply..." },
        _meta: { stepIdx: 1 }
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "Final output" }
      }
    ]);

    // Replay mode
    const connReplay = ConversationDb.open(dir, "conv-agent-thought-stream")!;
    const replayTranslator = new Translator({ mode: "replay", skipNarration: false });
    const replayUpdates = replayTranslator.translate(connReplay.readAfter(-1));
    connReplay.close();

    expect(replayUpdates).toEqual([
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "agent-thought-1",
        content: { type: "text", text: "Thinking deeply..." },
        _meta: { stepIdx: 1 }
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "Final output" },
        _meta: { stepIdx: 1 }
      }
    ]);
  });


  it("surfaces commandResult output on execute tool calls", () => {
    const db = createConversationDb(dir, "conv-exec-out");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "c-out",
            namePrimary: "run_command",
            rawInputJson: '{"CommandLine":"ls","Cwd":"/repo"}'
          })
        }),
        commandResult: encodeCommandResult({
          cwd: "/repo",
          exitCode: 0,
          output: "README.md\n",
          command: "ls"
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-exec-out")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as {
      sessionUpdate: string;
      kind: string;
      rawOutput?: { exitCode?: number; output?: string };
      content?: Array<{ content?: { text?: string } }>;
    };
    expect(update.sessionUpdate).toBe("tool_call");
    expect(update.kind).toBe("execute");
    expect(update.rawOutput).toMatchObject({ exitCode: 0 });
    const body = (update.content ?? []).map((c) => c.content?.text ?? "").join("\n");
    expect(body).toContain("ls");
    expect(body).toContain("README.md");
  });

  it("does not emit directory Cwd in locations for run_command steps (regression for issue #16)", () => {
    const db = createConversationDb(dir, "conv-exec-no-dir-location");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "c-dir",
            namePrimary: "run_command",
            rawInputJson: JSON.stringify({ CommandLine: "ls", Cwd: dir })
          })
        }),
        commandResult: encodeCommandResult({
          cwd: dir,
          exitCode: 0,
          output: "ok\n",
          command: "ls"
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-exec-no-dir-location")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as { locations?: unknown[] };
    expect(update.locations).toBeUndefined();
  });

  it("does not emit directory path in locations for list_dir steps", () => {
    const db = createConversationDb(dir, "conv-list-dir-no-location");
    insertStep(db, {
      idx: 1,
      stepType: 9,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "l-dir",
            namePrimary: "list_dir",
            rawInputJson: JSON.stringify({ DirectoryPath: dir })
          })
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-list-dir-no-location")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as { locations?: unknown[] };
    expect(update.locations).toBeUndefined();
  });

  it("does not emit directory SearchPath in locations for grep_search steps", () => {
    const db = createConversationDb(dir, "conv-grep-dir-no-location");
    insertStep(db, {
      idx: 1,
      stepType: 7,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "g-dir",
            namePrimary: "grep_search",
            rawInputJson: JSON.stringify({ Query: "foo", SearchPath: dir })
          })
        }),
        grepSearch: encodeGrepSearchResult({
          query: "foo",
          cwdUri: `file://${dir}`
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-grep-dir-no-location")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as { locations?: unknown[] };
    expect(update.locations).toBeUndefined();
  });

  it("does not emit non-existent or deleted SearchPath in locations for grep_search steps", () => {
    const deletedDir = path.join(dir, "non-existent-folder");
    const db = createConversationDb(dir, "conv-grep-deleted-dir");
    insertStep(db, {
      idx: 1,
      stepType: 7,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "g-deleted",
            namePrimary: "grep_search",
            rawInputJson: JSON.stringify({ Query: "foo", SearchPath: deletedDir })
          })
        }),
        grepSearch: encodeGrepSearchResult({
          query: "foo",
          cwdUri: `file://${deletedDir}`
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-grep-deleted-dir")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as { locations?: unknown[] };
    expect(update.locations).toBeUndefined();
  });

  it("emits SearchPath in locations for grep_search steps when SearchPath is a file", () => {
    const file = path.join(dir, "test.txt");
    fs.writeFileSync(file, "hello world");
    const db = createConversationDb(dir, "conv-grep-file");
    insertStep(db, {
      idx: 1,
      stepType: 7,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "g-file",
            namePrimary: "grep_search",
            rawInputJson: JSON.stringify({ Query: "hello", SearchPath: file })
          })
        }),
        grepSearch: encodeGrepSearchResult({
          query: "hello",
          cwdUri: `file://${file}`
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-grep-file")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as { locations?: Array<{ path: string }> };
    expect(update.locations).toEqual([{ path: file }]);
  });

  it("resolves relative SearchPath against session cwd for grep_search steps", () => {
    const relFile = "subfolder/rel-file.txt";
    const absFolder = path.join(dir, "subfolder");
    fs.mkdirSync(absFolder, { recursive: true });
    const absFile = path.join(dir, relFile);
    fs.writeFileSync(absFile, "relative content");

    const db = createConversationDb(dir, "conv-grep-rel");
    insertStep(db, {
      idx: 1,
      stepType: 7,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "g-rel",
            namePrimary: "grep_search",
            rawInputJson: JSON.stringify({ Query: "relative", SearchPath: relFile })
          })
        }),
        grepSearch: encodeGrepSearchResult({
          query: "relative"
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-grep-rel")!;
    const translator = new Translator({ mode: "replay", skipNarration: false, cwd: dir });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as { locations?: Array<{ path: string }> };
    expect(update.locations).toEqual([{ path: absFile }]);
  });

  it("does not emit location for replayed view_file step when file does not exist on disk", () => {
    const missingFile = path.join(dir, "non-existent-view.txt");
    const db = createConversationDb(dir, "conv-view-missing");
    insertStep(db, {
      idx: 1,
      stepType: 8,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "view-missing",
            namePrimary: "view_file",
            rawInputJson: JSON.stringify({ AbsolutePath: missingFile })
          })
        }),
        viewFile: encodeViewFileResult({
          fileUri: `file://${missingFile}`,
          content: "cached historical content\n"
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-view-missing")!;
    const translator = new Translator({ mode: "replay", skipNarration: false, cwd: dir });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as { locations?: unknown[] };
    expect(update.locations).toBeUndefined();
  });

  it("does not emit locations for replayed edits when the target does not exist on disk", () => {
    const missingFile = path.join(dir, "non-existent-edit.txt");
    const db = createConversationDb(dir, "conv-edit-missing");
    insertStep(db, {
      idx: 1,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "write-missing",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({ TargetFile: missingFile, CodeContent: "new content\n" })
          })
        })
      })
    });
    insertStep(db, {
      idx: 2,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "replace-missing",
            namePrimary: "replace_file_content",
            rawInputJson: JSON.stringify({
              TargetFile: missingFile,
              TargetContent: "old content",
              ReplacementContent: "new content",
              StartLine: 3
            })
          })
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-edit-missing")!;
    const translator = new Translator({ mode: "replay", skipNarration: false, cwd: dir });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(2);
    for (const update of updates as Array<{ locations?: unknown[] }>) {
      expect(update.locations).toBeUndefined();
    }
  });

  it("decodes Windows file URIs with drive letters in view_file fallback", () => {
    const winFile = path.join(dir, "win.txt");
    fs.writeFileSync(winFile, "content");
    const fileUri = `file:///${winFile.replace(/\\/g, "/")}`;
    const db = createConversationDb(dir, "conv-win-uri");
    insertStep(db, {
      idx: 1,
      stepType: 8,
      status: 3,
      stepPayload: encodeStepPayload({
        viewFile: encodeViewFileResult({
          fileUri,
          startLine: 1,
          content: "content"
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-win-uri")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as { locations?: Array<{ path: string }> };
    expect(update.locations).toEqual([{ path: winFile, line: 1 }]);
  });

  it("handles malformed percent-encoded file URIs without throwing URIError", () => {
    const db = createConversationDb(dir, "conv-malformed-uri");
    insertStep(db, {
      idx: 1,
      stepType: 8,
      status: 3,
      stepPayload: encodeStepPayload({
        viewFile: encodeViewFileResult({
          fileUri: "file:///tmp/foo%bar",
          content: "malformed URI test content\n"
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-malformed-uri")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    expect(() => translator.translate(conn.readAfter(-1))).not.toThrow();
    conn.close();
  });

  it("does not reinterpret an encoded path separator in a malformed file URI", () => {
    const nestedDir = path.join(dir, "encoded");
    const nestedFile = path.join(nestedDir, "path.txt");
    fs.mkdirSync(nestedDir);
    fs.writeFileSync(nestedFile, "content");
    const malformedUri = `file://${path.join(dir, "encoded%2Fpath.txt")}`;
    const db = createConversationDb(dir, "conv-encoded-separator-uri");
    insertStep(db, {
      idx: 1,
      stepType: 8,
      status: 3,
      stepPayload: encodeStepPayload({
        viewFile: encodeViewFileResult({
          fileUri: malformedUri,
          content: "content"
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-encoded-separator-uri")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    expect((updates[0] as { locations?: unknown[] }).locations).toBeUndefined();
  });

  it("uses resolved session path for view_file cache keys on full-file writes with relative paths", () => {
    const db = createConversationDb(dir, "conv-write-diff-rel");
    insertStep(db, {
      idx: 1,
      stepType: 8,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "read-rel",
            namePrimary: "view_file",
            rawInputJson: '{"AbsolutePath":"a.ts"}'
          })
        }),
        viewFile: encodeViewFileResult({
          fileUri: "a.ts",
          content: "export const x = 1;\n"
        })
      })
    });
    insertStep(db, {
      idx: 2,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "write-rel",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({
              TargetFile: "a.ts",
              CodeContent: "export const x = 2;\n"
            })
          })
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-write-diff-rel")!;
    const translator = new Translator({ mode: "replay", skipNarration: false, cwd: dir });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    const write = updates.find(
      (u) => (u as { toolCallId?: string }).toolCallId === "write-rel"
    ) as {
      content?: Array<{ type?: string; path?: string; oldText?: string | null; newText?: string }>;
    };
    expect(write).toBeTruthy();
    const diff = (write.content ?? []).find((c) => c.type === "diff");
    expect(diff).toMatchObject({
      type: "diff",
      oldText: "export const x = 1;\n",
      newText: "export const x = 2;\n"
    });
  });

  it("does not attach exitCode in rawOutput for pending run_command steps", () => {
    const db = createConversationDb(dir, "conv-exec-pending");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 9,
      stepPayload: encodeStepPayload({
        commandResult: encodeCommandResult({
          command: "gh issue view",
          cwd: "/path/to/cwd",
          exitCode: 0
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-exec-pending")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as {
      sessionUpdate: string;
      kind: string;
      status: string;
      rawOutput?: { exitCode?: number };
    };
    expect(update.sessionUpdate).toBe("tool_call");
    expect(update.kind).toBe("execute");
    expect(update.status).toBe("pending");
    expect(update.rawOutput).toBeUndefined();
  });

  it("surfaces web search query metadata from field 42", () => {
    const db = createConversationDb(dir, "conv-web-search");
    insertStep(db, {
      idx: 1,
      stepType: 33,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "ws-1",
            namePrimary: "search_web",
            rawInputJson: '{"query":"agy acp adapter"}'
          })
        }),
        webSearch: encodeWebSearchResult({
          query: "agy acp adapter",
          refinedQueryOrUrl: "https://www.google.com/search?q=agy+acp+adapter"
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-web-search")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as {
      kind: string;
      title: string;
      content?: Array<{ content?: { text?: string } }>;
    };
    expect(update.kind).toBe("search");
    expect(update.title).toContain("agy acp adapter");
    const body = (update.content ?? []).map((c) => c.content?.text ?? "").join("\n");
    expect(body).toContain("Query: agy acp adapter");
    expect(body).toContain("https://www.google.com/search");
  });

  it("decodes grep_search hits whose field 2 is a varint line number (regression for issue #12)", () => {
    const db = createConversationDb(dir, "conv-grep");
    insertStep(db, {
      idx: 1,
      stepType: 7,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "g-1",
            namePrimary: "grep_search",
            rawInputJson: '{"Query":"Unreleased","SearchPath":"/repo"}'
          })
        }),
        grepSearch: encodeGrepSearchResult({
          query: "Unreleased",
          cwdUri: "file:///repo",
          hits: [
            encodeSearchHit({ field1: "CHANGELOG.md", field2: 9, field3: "## [Unreleased]", field4: "/repo/CHANGELOG.md" }),
            encodeSearchHit({ field1: "CHANGELOG.md", field2: 42, field3: "## [Unreleased] - 2026-01-01", field4: "/repo/CHANGELOG.md" })
          ]
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-grep")!;
    const rows = conn.readAfter(-1);
    conn.close();

    // The whole point of the regression: this must not throw "premature EOF"
    // / "cant skip wire type 6/7", and the hits must carry line numbers.
    expect(rows).toHaveLength(1);
    const hits = rows[0].stepPayload.grepSearch?.hits ?? [];
    expect(hits).toHaveLength(2);
    expect(hits[0].field1).toBe("CHANGELOG.md");
    expect(hits[0].field2).toBe(9);
    expect(hits[0].field3).toBe("## [Unreleased]");
    expect(hits[0].field4).toBe("/repo/CHANGELOG.md");
    expect(hits[1].field2).toBe(42);

    const translator = new Translator({ mode: "replay", skipNarration: false });
    const conn2 = ConversationDb.open(dir, "conv-grep")!;
    const updates = translator.translate(conn2.readAfter(-1));
    conn2.close();
    expect(updates).toHaveLength(1);
    const update = updates[0] as { kind: string; content?: Array<{ content?: { text?: string } }> };
    expect(update.kind).toBe("search");
    const body = (update.content ?? []).map((c) => c.content?.text ?? "").join("\n");
    expect(body).toContain("CHANGELOG.md | 9 | ## [Unreleased]");
    expect(body).toContain("CHANGELOG.md | 42 | ## [Unreleased] - 2026-01-01");
  });

  it("surfaces fetched URL body from field 40", () => {
    const db = createConversationDb(dir, "conv-fetch");
    insertStep(db, {
      idx: 1,
      stepType: 31,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "fetch-1",
            namePrimary: "read_url_content",
            rawInputJson: '{"Url":"https://example.com/doc"}'
          })
        }),
        urlContent: encodeUrlContentResult({
          url: "https://example.com/doc",
          title: "Example Doc",
          description: "Fetched live",
          body: "# Hello\n\nBody from the page."
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-fetch")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as {
      kind: string;
      title: string;
      rawOutput?: { title?: string; truncated?: boolean };
      content?: Array<{ content?: { text?: string } }>;
    };
    expect(update.kind).toBe("fetch");
    expect(update.title).toBe("Fetch Example Doc");
    expect(update.rawOutput).toMatchObject({ title: "Example Doc" });
    const body = (update.content ?? []).map((c) => c.content?.text ?? "").join("\n");
    expect(body).toContain("https://example.com/doc");
    expect(body).toContain("Body from the page.");
  });

  it("uses prior view_file content as oldText on full-file writes", () => {
    const db = createConversationDb(dir, "conv-write-diff");
    insertStep(db, {
      idx: 1,
      stepType: 8,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "read-1",
            namePrimary: "view_file",
            rawInputJson: '{"AbsolutePath":"/repo/a.ts"}'
          })
        }),
        viewFile: encodeViewFileResult({
          fileUri: "file:///repo/a.ts",
          content: "export const x = 1;\n"
        })
      })
    });
    insertStep(db, {
      idx: 2,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "write-1",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({
              TargetFile: "/repo/a.ts",
              CodeContent: "export const x = 2;\n"
            })
          })
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-write-diff")!;
    const translator = new Translator({ mode: "replay", skipNarration: false, cwd: "/repo" });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    const write = updates.find(
      (u) => (u as { toolCallId?: string }).toolCallId === "write-1"
    ) as {
      content?: Array<{ type?: string; path?: string; oldText?: string | null; newText?: string }>;
    };
    expect(write).toBeTruthy();
    const diff = (write.content ?? []).find((c) => c.type === "diff");
    expect(diff).toMatchObject({
      type: "diff",
      path: "/repo/a.ts",
      oldText: "export const x = 1;\n",
      newText: "export const x = 2;\n"
    });
  });

  it("does not use ranged view_file slices as oldText for full-file writes", () => {
    const db = createConversationDb(dir, "conv-write-ranged");
    insertStep(db, {
      idx: 1,
      stepType: 8,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "read-range",
            namePrimary: "view_file",
            rawInputJson: '{"AbsolutePath":"/repo/a.ts","StartLine":10,"EndLine":20}'
          })
        }),
        viewFile: encodeViewFileResult({
          fileUri: "file:///repo/a.ts",
          startLine: 10,
          endLine: 20,
          content: "partial slice\n"
        })
      })
    });
    insertStep(db, {
      idx: 2,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "write-2",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({
              TargetFile: "/repo/a.ts",
              CodeContent: "full file\n"
            })
          })
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-write-ranged")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    const write = updates.find(
      (u) => (u as { toolCallId?: string }).toolCallId === "write-2"
    ) as {
      content?: Array<{ type?: string; oldText?: string | null; newText?: string }>;
    };
    const diff = (write.content ?? []).find((c) => c.type === "diff");
    expect(diff).toMatchObject({ oldText: null, newText: "full file\n" });
  });

  it("labels permission decisions as granted or denied", () => {
    const db = createConversationDb(dir, "conv-perm");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 7,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "cmd-deny",
            namePrimary: "run_command",
            rawInputJson: '{"CommandLine":"rm -rf /"}'
          })
        })
      }),
      permissions: encodePermissions({ kind: "command", value: "rm -rf /", decision: 0 })
    });
    insertStep(db, {
      idx: 2,
      stepType: 21,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "cmd-ok",
            namePrimary: "run_command",
            rawInputJson: '{"CommandLine":"ls"}'
          })
        })
      }),
      permissions: encodePermissions({ kind: "unsandboxed", value: "ls", decision: 1 })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-perm")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(2);
    const texts = updates.map((u) =>
      ((u as { content?: Array<{ content?: { text?: string } }> }).content ?? [])
        .map((c) => c.content?.text ?? "")
        .join("\n")
    );
    expect(texts[0]).toContain("Permission denied: command (rm -rf /)");
    expect(texts[1]).toContain("Permission granted: unsandboxed (ls)");
  });

  it("presents brain plan writes as structured ACP plan entries", () => {
    const planPath =
      "/Users/me/.gemini/antigravity-cli/brain/abc/.system_generated/steps/1/implementation_plan.md";
    const db = createConversationDb(dir, "conv-plan");
    insertStep(db, {
      idx: 1,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "plan-1",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({
              TargetFile: planPath,
              CodeContent: "# Plan\n\n1. Do the thing\n2. Ship it\n"
            })
          })
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-plan")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    const update = updates[0] as {
      sessionUpdate: string;
      entries?: Array<{ content: string; status: string; priority: string }>;
    };
    expect(update.sessionUpdate).toBe("plan");
    expect(update.entries?.map((e) => e.content)).toEqual(["Do the thing", "Ship it"]);
    expect(update.entries?.every((e) => e.status === "pending")).toBe(true);
  });

  it("dedups unchanged plan snapshots across stream polls", () => {
    const planPath =
      "/Users/me/.gemini/antigravity-cli/brain/abc/.system_generated/steps/1/implementation_plan.md";
    const db = createConversationDb(dir, "conv-plan-dedup");
    insertStep(db, {
      idx: 1,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "plan-1",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({
              TargetFile: planPath,
              CodeContent: "- [ ] One\n- [x] Two\n"
            })
          })
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-plan-dedup")!;
    const translator = new Translator({ mode: "stream", skipNarration: false });
    const first = translator.translate(conn.readAfter(-1));
    const second = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    const entries = (first[0] as { entries: Array<{ content: string; status: string }> }).entries;
    expect(entries).toMatchObject([
      { content: "One", priority: "high", status: "pending" },
      { content: "Two", priority: "high", status: "completed" }
    ]);
    // Entries have content-hash-based IDs
    for (const e of entries) {
      expect((e as Record<string, unknown>).id).toMatch(/^entry_[0-9a-f]+$/);
    }
  });

  it("keeps plan entry ids stable when a duplicate task is inserted before an existing one", () => {
    const planPath =
      "/Users/me/.gemini/antigravity-cli/brain/abc/.system_generated/steps/1/implementation_plan.md";
    const db = createConversationDb(dir, "conv-plan-dup-insert");
    insertStep(db, {
      idx: 1,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "plan-dup-1",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({
              TargetFile: planPath,
              CodeContent: "- [x] Deploy\n"
            })
          })
        })
      })
    });

    const translator = new Translator({ mode: "stream", skipNarration: false });
    const conn = ConversationDb.open(dir, "conv-plan-dup-insert")!;

    const first = translator.translate(conn.readAfter(0));
    expect(first).toHaveLength(1);
    const firstEntries = (first[0] as { entries: Array<{ id?: string; status: string }> }).entries;
    expect(firstEntries).toHaveLength(1);
    const deployId = firstEntries[0].id;
    expect(deployId).toBeDefined();

    // Next poll: an identical pending task is inserted before the completed row.
    insertStep(db, {
      idx: 2,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "plan-dup-2",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({
              TargetFile: planPath,
              CodeContent: "- [ ] Deploy\n- [x] Deploy\n"
            })
          })
        })
      })
    });

    const second = translator.translate(conn.readAfter(1));
    conn.close();
    db.close();

    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ sessionUpdate: "plan" });
    const entries = (second[0] as { entries: Array<{ id?: string; status: string }> }).entries;
    expect(entries).toHaveLength(2);
    // The existing completed row keeps its original id; the inserted pending
    // row gets a fresh, distinct id (not the old row's occurrence hash).
    expect(entries[0].status).toBe("pending");
    expect(entries[0].id).toBeDefined();
    expect(entries[0].id).not.toBe(deployId);
    expect(entries[1].status).toBe("completed");
    expect(entries[1].id).toBe(deployId);
  });

  it("does not replay prior plan states when a later row triggers a reread", () => {
    const planPath =
      "/Users/me/.gemini/antigravity-cli/brain/abc/.system_generated/steps/1/implementation_plan.md";
    const db = createConversationDb(dir, "conv-plan-reread");
    // Two rows update the same plan: v1, then v2.
    insertStep(db, {
      idx: 1,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "plan-reread-1",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({ TargetFile: planPath, CodeContent: "- [ ] One\n" })
          })
        })
      })
    });
    insertStep(db, {
      idx: 2,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "plan-reread-2",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({ TargetFile: planPath, CodeContent: "- [ ] One\n- [ ] Two\n" })
          })
        })
      })
    });

    const translator = new Translator({ mode: "stream", skipNarration: false });
    const conn = ConversationDb.open(dir, "conv-plan-reread")!;

    // First poll emits both successive plan states.
    const first = translator.translate(conn.readAfter(0));
    expect(first.map((u) => u.sessionUpdate)).toEqual(["plan", "plan"]);

    // A later unrelated row makes the poller reread rows 1-2; the historical
    // plan states must not be re-emitted (no rollback to v1, no repeat of v2).
    insertStep(db, { idx: 3, stepType: 15, stepPayload: encodeStepPayload({ agentText: "done" }) });
    const second = translator.translate(conn.readAfter(0));
    expect(second).toEqual([
      { sessionUpdate: "agent_message_chunk", messageId: "3", content: { type: "text", text: "done" } }
    ]);

    conn.close();
    db.close();
  });

  it("derives one plan id for relative and absolute references to the same file", () => {
    const absPlanPath = path.join(dir, ".gemini", "antigravity-cli", "brain", "conv-plan-rel", "plan.md");
    fs.mkdirSync(path.dirname(absPlanPath), { recursive: true });
    fs.writeFileSync(absPlanPath, "- [ ] Keep\n");
    const relPlanPath = path.relative(dir, absPlanPath);

    const db = createConversationDb(dir, "conv-plan-rel");
    // Write the plan via a relative path, then clear it via the absolute path.
    insertStep(db, {
      idx: 1,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "plan-rel-1",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({ TargetFile: relPlanPath, CodeContent: "- [ ] Keep\n" })
          })
        })
      })
    });
    insertStep(db, {
      idx: 2,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "plan-rel-2",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({ TargetFile: absPlanPath, CodeContent: "" })
          })
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-plan-rel")!;
    const translator = new Translator({ mode: "stream", skipNarration: false, cwd: dir });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    // Both updates reference the same canonical plan id, so the removal clears
    // the plan the first update created instead of targeting a divergent id.
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ sessionUpdate: "plan" });
    expect((updates[0] as { _meta?: Record<string, unknown> })._meta?.["agy-acp/planId"]).toBe(
      `file:${absPlanPath}`
    );
    expect(updates[1]).toMatchObject({
      sessionUpdate: "plan_removed",
      planId: `file:${absPlanPath}`
    });
  });

  it("emits plan_removed session update when brain plan file is cleared", () => {
    const planPath = path.join(dir, ".gemini", "antigravity-cli", "brain", "conv-plan-empty", "plan.md");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, "");

    const db = createConversationDb(dir, "conv-plan-empty");
    insertStep(db, {
      idx: 1,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "plan-empty-1",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({
              TargetFile: planPath,
              CodeContent: ""
            })
          })
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-plan-empty")!;
    const translator = new Translator({ mode: "stream", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      sessionUpdate: "plan_removed",
      planId: `file:${planPath}`
    });
  });

  it("does not emit plan_removed for empty plan writes that are not completed", () => {
    const planPath = path.join(dir, ".gemini", "antigravity-cli", "brain", "conv-plan-empty-pending", "plan.md");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, "- [ ] Keep me\n");

    // status 9 = permission pending, 7 = failed, 6 = cancelled
    for (const { status, label, expectedStatus } of [
      { status: 9, label: "pending", expectedStatus: "pending" },
      { status: 7, label: "failed", expectedStatus: "failed" },
      { status: 6, label: "cancelled", expectedStatus: "cancelled" }
    ] as const) {
      const convId = `conv-plan-empty-${label}`;
      const db = createConversationDb(dir, convId);
      insertStep(db, {
        idx: 1,
        stepType: 5,
        status,
        stepPayload: encodeStepPayload({
          toolRun: encodeToolRun({
            call: encodeToolCall({
              callId: `plan-empty-${label}`,
              namePrimary: "write_to_file",
              rawInputJson: JSON.stringify({
                TargetFile: planPath,
                CodeContent: ""
              })
            })
          })
        })
      });
      db.close();

      const conn = ConversationDb.open(dir, convId)!;
      const translator = new Translator({ mode: "stream", skipNarration: false });
      const updates = translator.translate(conn.readAfter(-1));
      conn.close();

      expect(updates, label).toHaveLength(1);
      expect(updates[0], label).toMatchObject({
        sessionUpdate: "tool_call",
        name: "write_to_file",
        kind: "edit",
        status: expectedStatus
      });
      expect((updates[0] as { sessionUpdate: string }).sessionUpdate, label).not.toBe("plan_removed");
    }
  });

  it("emits plan_removed when a completed replace clears the plan file", () => {
    const planPath = path.join(dir, ".gemini", "antigravity-cli", "brain", "conv-plan-replace-clear", "plan.md");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    const prior = "- [ ] Keep me\n- [x] Done\n";
    fs.writeFileSync(planPath, prior);

    const db = createConversationDb(dir, "conv-plan-replace-clear");
    // Seed cache via an earlier full write of the plan.
    insertStep(db, {
      idx: 1,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "plan-seed",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({
              TargetFile: planPath,
              CodeContent: prior
            })
          })
        })
      })
    });
    // Completed replace that deletes the entire plan body.
    insertStep(db, {
      idx: 2,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "plan-replace-clear",
            namePrimary: "replace_file_content",
            rawInputJson: JSON.stringify({
              TargetFile: planPath,
              TargetContent: prior,
              ReplacementContent: ""
            })
          })
        })
      })
    });
    // Mirror agy applying the edit on disk.
    fs.writeFileSync(planPath, "");
    db.close();

    const conn = ConversationDb.open(dir, "conv-plan-replace-clear")!;
    const translator = new Translator({ mode: "stream", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ sessionUpdate: "plan" });
    expect(updates[1]).toMatchObject({
      sessionUpdate: "plan_removed",
      planId: `file:${planPath}`
    });
  });

  it("does not emit plan_removed for incomplete replace that would clear the plan", () => {
    const planPath = path.join(dir, ".gemini", "antigravity-cli", "brain", "conv-plan-replace-pending", "plan.md");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    const prior = "- [ ] Keep me\n";
    fs.writeFileSync(planPath, prior);

    const db = createConversationDb(dir, "conv-plan-replace-pending");
    insertStep(db, {
      idx: 1,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "plan-seed-pending",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({
              TargetFile: planPath,
              CodeContent: prior
            })
          })
        })
      })
    });
    insertStep(db, {
      idx: 2,
      stepType: 5,
      status: 9,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "plan-replace-pending",
            namePrimary: "replace_file_content",
            rawInputJson: JSON.stringify({
              TargetFile: planPath,
              TargetContent: prior,
              ReplacementContent: ""
            })
          })
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-plan-replace-pending")!;
    const translator = new Translator({ mode: "stream", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatchObject({ sessionUpdate: "plan" });
    expect(updates[1]).toMatchObject({
      sessionUpdate: "tool_call",
      name: "replace_file_content",
      status: "pending"
    });
  });

  it("does not cache unsuccessful full plan writes for later replace derivation", () => {
    const planPath = path.join(dir, ".gemini", "antigravity-cli", "brain", "conv-plan-write-cache", "plan.md");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    const real = "- [ ] Real plan\n";
    const rejected = "- [x] Speculative\n";
    const bogusFromRejected = "- [ ] From rejected cache\n";
    fs.writeFileSync(planPath, real);

    const seedPayload = encodeStepPayload({
      toolRun: encodeToolRun({
        call: encodeToolCall({
          callId: "plan-seed-cache",
          namePrimary: "write_to_file",
          rawInputJson: JSON.stringify({ TargetFile: planPath, CodeContent: real })
        })
      })
    });
    const rejectedWritePayload = encodeStepPayload({
      toolRun: encodeToolRun({
        call: encodeToolCall({
          callId: "plan-write-rejected",
          namePrimary: "write_to_file",
          rawInputJson: JSON.stringify({ TargetFile: planPath, CodeContent: rejected })
        })
      })
    });
    // Replace targets the rejected body. If the failed write poisoned the cache, this would
    // succeed and emit a plan derived from the never-applied write. With a clean cache it
    // cannot apply and falls back to the on-disk real plan.
    const replacePayload = encodeStepPayload({
      toolRun: encodeToolRun({
        call: encodeToolCall({
          callId: "plan-replace-after-reject",
          namePrimary: "replace_file_content",
          rawInputJson: JSON.stringify({
            TargetFile: planPath,
            TargetContent: rejected,
            ReplacementContent: bogusFromRejected
          })
        })
      })
    });

    const db = createConversationDb(dir, "conv-plan-write-cache");
    insertStep(db, { idx: 1, stepType: 5, status: 3, stepPayload: seedPayload });
    insertStep(db, { idx: 2, stepType: 5, status: 9, stepPayload: rejectedWritePayload });

    const conn = ConversationDb.open(dir, "conv-plan-write-cache")!;
    const translator = new Translator({ mode: "stream", skipNarration: false });

    const first = translator.translate(conn.readAfter(-1));
    expect(first[0]).toMatchObject({ sessionUpdate: "plan" });
    expect((first[0] as { entries: Array<{ content: string }> }).entries[0].content).toBe("Real plan");
    // Pending write may still publish requested content for UX, but must not cache it.
    expect(first[1]).toMatchObject({ sessionUpdate: "plan" });
    expect((first[1] as { entries: Array<{ content: string }> }).entries[0].content).toBe("Speculative");

    updateStep(db, 2, { status: 7, stepPayload: rejectedWritePayload });
    // Re-translate the failed row only (status transition); plan snapshot stays speculative UX.
    translator.translate(conn.readAfter(1));

    insertStep(db, { idx: 3, stepType: 5, status: 3, stepPayload: replacePayload });
    // File on disk never received the rejected write.
    fs.writeFileSync(planPath, real);
    // Translate only the new replace row so a prior failed write is not re-published.
    const afterReplace = translator.translate(conn.readAfter(2));

    // Poisoned cache would apply TargetContent=rejected and emit "From rejected cache".
    // With a clean cache the replace cannot apply; disk fallback keeps the real plan
    // (and progressive dedupe may emit nothing if the snapshot is unchanged).
    const planUpdates = afterReplace.filter((u) => (u as { sessionUpdate: string }).sessionUpdate === "plan");
    for (const u of planUpdates) {
      const entries = (u as { entries: Array<{ content: string }> }).entries;
      expect(entries.some((e) => e.content === "From rejected cache")).toBe(false);
      expect(entries.map((e) => e.content)).toEqual(["Real plan"]);
    }
    // Even if no plan re-emit (deduped), we must not have published the rejected-derived body.
    expect(planUpdates.some((u) =>
      (u as { entries: Array<{ content: string }> }).entries.some((e) => e.content === "From rejected cache")
    )).toBe(false);

    conn.close();
    db.close();
  });

  it("does not apply speculative plan updates for incomplete nonempty replaces", () => {
    const planPath = path.join(dir, ".gemini", "antigravity-cli", "brain", "conv-plan-replace-speculative", "plan.md");
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    const prior = "- [ ] Keep me\n";
    const next = "- [x] Keep me\n";
    fs.writeFileSync(planPath, prior);

    const replacePayload = encodeStepPayload({
      toolRun: encodeToolRun({
        call: encodeToolCall({
          callId: "plan-replace-speculative",
          namePrimary: "replace_file_content",
          rawInputJson: JSON.stringify({
            TargetFile: planPath,
            TargetContent: prior,
            ReplacementContent: next
          })
        })
      })
    });

    const db = createConversationDb(dir, "conv-plan-replace-speculative");
    insertStep(db, {
      idx: 1,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "plan-seed-speculative",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({
              TargetFile: planPath,
              CodeContent: prior
            })
          })
        })
      })
    });
    // Permission-pending replace that would mark the task completed if applied.
    insertStep(db, {
      idx: 2,
      stepType: 5,
      status: 9,
      stepPayload: replacePayload
    });

    const conn = ConversationDb.open(dir, "conv-plan-replace-speculative")!;
    const translator = new Translator({ mode: "stream", skipNarration: false });

    const pending = translator.translate(conn.readAfter(-1));
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({ sessionUpdate: "plan" });
    expect((pending[0] as { entries: Array<{ content: string; status: string }> }).entries).toMatchObject([
      { content: "Keep me", status: "pending" }
    ]);
    expect(pending[1]).toMatchObject({
      sessionUpdate: "tool_call",
      name: "replace_file_content",
      status: "pending"
    });

    // Denial/failure must not rewrite the plan or poison the content cache.
    updateStep(db, 2, { status: 7, stepPayload: replacePayload });
    const failed = translator.translate(conn.readAfter(-1));
    expect(failed).toMatchObject([
      { sessionUpdate: "tool_call_update", name: "replace_file_content", status: "failed" }
    ]);
    expect(failed.some((u) => (u as { sessionUpdate: string }).sessionUpdate === "plan")).toBe(false);

    // A later successful replace still derives from the original cached plan body.
    updateStep(db, 2, { status: 3, stepPayload: replacePayload });
    fs.writeFileSync(planPath, next);
    const completed = translator.translate(conn.readAfter(-1));
    expect(completed).toMatchObject([
      {
        sessionUpdate: "plan",
        entries: [{ content: "Keep me", status: "completed" }]
      }
    ]);

    conn.close();
    db.close();
  });

  it("buffers consecutive agent-text parts into one message in replay mode", () => {
    const db = createConversationDb(dir, "conv-4");
    insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "Hello" }) });
    insertStep(db, { idx: 2, stepType: 15, stepPayload: encodeStepPayload({ agentText: " world" }) });
    db.close();

    const conn = ConversationDb.open(dir, "conv-4")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "Hello\n world" },
        _meta: { stepIdx: 1, endStepIdx: 2 }
      }
    ]);
  });

  it("stamps _meta.stepIdx on title, thought, and agent text updates", () => {
    const db = createConversationDb(dir, "conv-stamped");
    insertStep(db, { idx: 10, stepType: 23, stepPayload: encodeStepPayload({ titleUpdate: "My Title\n\nTitle narration" }) });
    insertStep(db, { idx: 11, stepType: 15, stepPayload: encodeStepPayload({ agentText: { text: "Done", thought: "Thinking..." } }) });
    db.close();

    const conn = ConversationDb.open(dir, "conv-stamped")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toEqual([
      {
        sessionUpdate: "session_info_update",
        title: "My Title",
        _meta: { stepIdx: 10 }
      },
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "title-thought-10",
        content: { type: "text", text: "Title narration" },
        _meta: { stepIdx: 10 }
      },
      {
        sessionUpdate: "agent_thought_chunk",
        messageId: "agent-thought-11",
        content: { type: "text", text: "Thinking..." },
        _meta: { stepIdx: 11 }
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "11",
        content: { type: "text", text: "Done" },
        _meta: { stepIdx: 11 }
      }
    ]);
  });

  it("suppresses <SYSTEM_MESSAGE> task outputs in stepType 15 during replay and streaming", () => {
    const db = createConversationDb(dir, "conv-sys-msg");
    const sysMsgText = "<SYSTEM_MESSAGE>\n[Message] timestamp=2026-07-28T10:07:08Z content=Task id task-175 finished";
    insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: { text: "Hello" } }) });
    insertStep(db, { idx: 2, stepType: 15, stepPayload: encodeStepPayload({ agentText: { text: sysMsgText } }) });
    insertStep(db, { idx: 3, stepType: 15, stepPayload: encodeStepPayload({ agentText: { text: "World" } }) });
    db.close();

    const connReplay = ConversationDb.open(dir, "conv-sys-msg")!;
    const replayTranslator = new Translator({ mode: "replay", skipNarration: false });
    const replayUpdates = replayTranslator.translate(connReplay.readAfter(-1));
    connReplay.close();

    expect(replayUpdates).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "Hello\nWorld" },
        _meta: { stepIdx: 1, endStepIdx: 3 }
      }
    ]);

    const connStream = ConversationDb.open(dir, "conv-sys-msg")!;
    const streamTranslator = new Translator({ mode: "stream", skipNarration: false });
    const streamUpdates = streamTranslator.translate(connStream.readAfter(-1));
    connStream.close();

    expect(streamUpdates).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "Hello" }
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "\nWorld" }
      }
    ]);
  });

  it("buffers a growing system-message envelope until it can be classified", () => {
    const db = createConversationDb(dir, "conv-growing-sys-msg");
    insertStep(db, {
      idx: 1,
      stepType: 15,
      status: 1,
      stepPayload: encodeStepPayload({ agentText: { text: "<SYSTEM_MESSAGE>\n[Messag" } })
    });

    const conn = ConversationDb.open(dir, "conv-growing-sys-msg")!;
    const translator = new Translator({ mode: "stream", skipNarration: false });
    expect(translator.translate(conn.readAfter(0))).toEqual([]);

    updateStep(
      db,
      1,
      {
        status: 3,
        stepPayload: encodeStepPayload({
          agentText: {
            text: "<SYSTEM_MESSAGE>\n[Message] timestamp=2026-07-28T10:07:08Z content=Task id task-175 finished"
          }
        })
      }
    );
    expect(translator.translate(conn.readAfter(0))).toEqual([]);
    expect(translator.translate(conn.readAfter(0))).toEqual([]);

    conn.close();
    db.close();
  });

  it("buffers all whitespace prefixes accepted by the system-message envelope", () => {
    const db = createConversationDb(dir, "conv-growing-whitespace-sys-msg");
    insertStep(db, {
      idx: 1,
      stepType: 15,
      status: 1,
      stepPayload: encodeStepPayload({ agentText: { text: "<SYSTEM_MESSAGE>\n\n" } })
    });

    const conn = ConversationDb.open(dir, "conv-growing-whitespace-sys-msg")!;
    const translator = new Translator({ mode: "stream", skipNarration: false });
    expect(translator.translate(conn.readAfter(0))).toEqual([]);

    updateStep(
      db,
      1,
      {
        status: 3,
        stepPayload: encodeStepPayload({ agentText: { text: "<SYSTEM_MESSAGE>\n\n[Message] payload" } })
      }
    );
    expect(translator.translate(conn.readAfter(0))).toEqual([]);

    conn.close();
    db.close();
  });

  it("releases a buffered system-message prefix when growing text proves ordinary", () => {
    const db = createConversationDb(dir, "conv-growing-sys-msg-prose");
    insertStep(db, {
      idx: 1,
      stepType: 15,
      status: 1,
      stepPayload: encodeStepPayload({ agentText: { text: "<SYSTEM_MESSAGE>\n[Messag" } })
    });

    const conn = ConversationDb.open(dir, "conv-growing-sys-msg-prose")!;
    const translator = new Translator({ mode: "stream", skipNarration: false });
    expect(translator.translate(conn.readAfter(0))).toEqual([]);

    const prose = "<SYSTEM_MESSAGE>\n[Messagical text is not an internal notification.";
    updateStepPayload(db, 1, encodeStepPayload({ agentText: { text: prose } }));
    expect(translator.translate(conn.readAfter(0))).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: prose }
      }
    ]);

    conn.close();
    db.close();
  });

  it("releases an ambiguous system-message prefix when its row is terminal", () => {
    const db = createConversationDb(dir, "conv-terminal-sys-msg-prefix");
    const text = "<SYSTEM_MESSAGE>\n[Messag";
    insertStep(db, {
      idx: 1,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({ agentText: { text } })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-terminal-sys-msg-prefix")!;
    const updates = new Translator({ mode: "stream", skipNarration: false }).translate(conn.readAfter(0));
    conn.close();

    expect(updates).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text }
      }
    ]);
  });

  it("releases an ambiguous system-message prefix at a later step boundary", () => {
    const db = createConversationDb(dir, "conv-bounded-sys-msg-prefix");
    const text = "<SYSTEM_MESSAGE>\n[Messag";
    insertStep(db, {
      idx: 1,
      stepType: 15,
      status: 1,
      stepPayload: encodeStepPayload({ agentText: { text } })
    });
    insertStep(db, {
      idx: 2,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({ agentText: { text: "done" } })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-bounded-sys-msg-prefix")!;
    const updates = new Translator({ mode: "stream", skipNarration: false }).translate(conn.readAfter(0));
    conn.close();

    expect(updates).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text }
      },
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "\ndone" }
      }
    ]);
  });

  it("preserves assistant messages that mention <SYSTEM_MESSAGE> in prose or at start", () => {
    const db = createConversationDb(dir, "conv-prose-sys-msg");
    const proseText1 = "The error notification contains <SYSTEM_MESSAGE> tag.";
    const proseText2 = "<SYSTEM_MESSAGE> tag is used by agy for internal task notifications.";
    insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: { text: proseText1 } }) });
    insertStep(db, { idx: 2, stepType: 15, stepPayload: encodeStepPayload({ agentText: { text: proseText2 } }) });
    db.close();

    const conn = ConversationDb.open(dir, "conv-prose-sys-msg")!;
    const translator = new Translator({ mode: "replay", skipNarration: false });
    const updates = translator.translate(conn.readAfter(-1));
    conn.close();

    expect(updates).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: `${proseText1}\n${proseText2}` },
        _meta: { stepIdx: 1, endStepIdx: 2 }
      }
    ]);
  });
});

describe("StreamPoller", () => {
  it("skips decoding unchanged databases and still detects in-place payload growth", () => {
    const db = createConversationDb(dir, "conv-poll");
    insertStep(db, {
      idx: 1,
      stepType: 15,
      stepPayload: encodeStepPayload({ agentText: "Hello" })
    });
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-poll",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    expect(poller.poll()).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "Hello" }
      }
    ]);
    const revision = poller.revision;
    const readSpy = vi.spyOn(ConversationDb.prototype, "readAfter");
    expect(poller.poll()).toEqual([]);
    expect(readSpy).not.toHaveBeenCalled();
    expect(poller.revision).toBe(revision);

    updateStepPayload(db, 1, encodeStepPayload({ agentText: "Hello world" }));
    expect(poller.poll()).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: " world" }
      }
    ]);
    expect(readSpy).toHaveBeenCalledOnce();
    expect(poller.revision).toBe(revision + 1);

    readSpy.mockRestore();
    poller.close();
    db.close();
  });

  it("preserves full-write oldText across pending completion and historical rereads", () => {
    const db = createConversationDb(dir, "conv-poll-write-history");
    const firstWrite = encodeStepPayload({
      toolRun: encodeToolRun({
        call: encodeToolCall({
          callId: "write-a",
          namePrimary: "write_to_file",
          rawInputJson: JSON.stringify({ TargetFile: "/repo/a.txt", CodeContent: "A" })
        })
      })
    });
    insertStep(db, { idx: 1, stepType: 5, status: 9, stepPayload: firstWrite });
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-poll-write-history",
      baseStepIdx: -1,
      skipNarration: false,
      cwd: "/repo",
      snapshot: null
    });

    const pending = poller.poll() as Array<{ status?: string; content?: Array<Record<string, unknown>> }>;
    expect(pending[0]).toMatchObject({ status: "pending" });
    expect(pending[0]?.content?.[0]).toMatchObject({ oldText: null, newText: "A" });

    updateStep(db, 1, { status: 3, stepPayload: firstWrite });
    const completed = poller.poll() as Array<{ status?: string; content?: Array<Record<string, unknown>> }>;
    expect(completed[0]).toMatchObject({ status: "completed" });
    expect(completed[0]?.content?.[0]).toMatchObject({ oldText: null, newText: "A" });

    insertStep(db, {
      idx: 2,
      stepType: 5,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "write-b",
            namePrimary: "write_to_file",
            rawInputJson: JSON.stringify({ TargetFile: "/repo/a.txt", CodeContent: "B" })
          })
        })
      })
    });
    const secondWrite = poller.poll() as Array<{
      toolCallId?: string;
      content?: Array<Record<string, unknown>>;
    }>;
    expect(secondWrite).toHaveLength(1);
    expect(secondWrite[0]).toMatchObject({ toolCallId: "write-b" });
    expect(secondWrite[0]?.content?.[0]).toMatchObject({ oldText: "A", newText: "B" });

    // A later unrelated row makes StreamPoller translate rows 1-3 again. The
    // completed writes must derive the same snapshots and remain deduplicated.
    insertStep(db, {
      idx: 3,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({ agentText: "done" })
    });
    expect(poller.poll()).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "3",
        content: { type: "text", text: "done" }
      }
    ]);

    poller.close();
    db.close();
  });

  it("increments revision for auxiliary-column-only mutations", () => {
    const db = createConversationDb(dir, "conv-poll-permission");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "cmd-1",
            namePrimary: "run_command",
            rawInputJson: '{"CommandLine":"ls"}'
          })
        })
      })
    });
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-poll-permission",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    expect(poller.poll()).toHaveLength(1);
    const revision = poller.revision;
    db.prepare("UPDATE steps SET permissions = ? WHERE idx = 1").run(
      Buffer.from(encodePermissions({ kind: "command", value: "ls", decision: 1 }))
    );
    const updated = poller.poll();
    expect(updated).toHaveLength(1);
    expect((updated[0] as { sessionUpdate: string }).sessionUpdate).toBe("tool_call_update");
    expect(poller.revision).toBe(revision + 1);
    expect(poller.poll()).toEqual([]);

    poller.close();
    db.close();
  });

  it("queues a new pending interaction when an identical status-9 gate is re-armed", () => {
    const db = createConversationDb(dir, "conv-identical-gate");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 9,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "cmd-identical",
            namePrimary: "run_command",
            rawInputJson: '{"CommandLine":"echo x && echo x"}'
          })
        })
      })
    });
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-identical-gate",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    expect(poller.poll()).toHaveLength(1);
    expect(poller.takePending()).toHaveLength(1);

    const permission = Buffer.from(encodePermissions({ kind: "command", value: "echo x", decision: 1 }));
    db.prepare("UPDATE steps SET permissions = ? WHERE idx = 1").run(permission);
    expect(poller.poll()).toHaveLength(1);
    expect(poller.takePending()).toHaveLength(1);

    // SQLite does not advance data_version when the exact same bytes are
    // written, so the poll itself has no occurrence to report.
    db.prepare("UPDATE steps SET permissions = ? WHERE idx = 1").run(permission);
    expect(poller.poll()).toEqual([]);
    expect(poller.takePending()).toEqual([]);

    // The TUI redraw supplies the generation in this case. Requeueing remains
    // deduplicated until the queued occurrence is consumed.
    poller.requeuePending("cmd-identical");
    poller.requeuePending("cmd-identical");
    expect(poller.takePending()).toHaveLength(1);

    poller.close();
    db.close();
  });

  it("retries readAfter on next poll if a torn read decode error occurs", () => {
    const db = createConversationDb(dir, "conv-torn-read");
    // Insert step with invalid/corrupt blob payload to simulate premature EOF
    db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)").run(
      1, 21, 9, Buffer.from([0x08, 0xff])
    );
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-torn-read",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    // First poll encounters decode error, so dataVersion is NOT cached
    expect(poller.poll()).toEqual([]);

    // Now update row 1 to hold a valid payload (simulating completed write)
    db.prepare("UPDATE steps SET step_payload = ? WHERE idx = 1").run(
      Buffer.from(encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "cmd-1",
            namePrimary: "run_command",
            rawInputJson: '{"CommandLine":"ls"}'
          })
        })
      }))
    );

    // Second poll retries reading and successfully decodes the step
    const updates = poller.poll();
    expect(updates).toHaveLength(1);
    expect((updates[0] as { sessionUpdate: string }).sessionUpdate).toBe("tool_call");

    poller.close();
    db.close();
  });

  it("bounds retries on a permanently undecodable row after 3 failed attempts on the same dataVersion", () => {
    const db = createConversationDb(dir, "conv-perm-corrupt");
    // Insert step with invalid/corrupt blob payload to simulate permanently corrupted data
    db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)").run(
      1, 21, 9, Buffer.from([0x08, 0xff])
    );
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-perm-corrupt",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    // Poll 1: encounters decode error (attempt 1), returns []
    expect(poller.poll()).toEqual([]);
    // Poll 2: encounters decode error (attempt 2), returns []
    expect(poller.poll()).toEqual([]);
    // Poll 3: encounters decode error (attempt 3), caches dataVersion and returns []
    expect(poller.poll()).toEqual([]);

    // Poll 4: because dataVersion is now cached, poll() immediately returns [] without re-reading/re-logging
    expect(poller.poll()).toEqual([]);

    poller.close();
    db.close();
  });

  it("does not complete from a terminal row when a trailing row failed to decode", () => {
    const db = createConversationDb(dir, "conv-terminal-before-corrupt");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({ callId: "cmd-1", namePrimary: "run_command", rawInputJson: "{}" })
        })
      })
    });
    db.prepare("INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)").run(
      2, 15, 3, Buffer.from([0x0a, 0xff])
    );
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-terminal-before-corrupt",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    // The surviving terminal tool must not hide the undecodable final row,
    // including after retries for this data version have been bounded.
    expect(poller.poll()).toHaveLength(1);
    expect(poller.turnCompleteCandidate).toBe(false);
    expect(poller.poll()).toEqual([]);
    expect(poller.turnCompleteCandidate).toBe(false);
    expect(poller.poll()).toEqual([]);
    expect(poller.turnCompleteCandidate).toBe(false);
    expect(poller.poll()).toEqual([]);
    expect(poller.turnCompleteCandidate).toBe(false);

    db.prepare("UPDATE steps SET step_payload = ? WHERE idx = 2").run(
      Buffer.from(encodeStepPayload({ agentText: "done" }))
    );
    expect(poller.poll()).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "2",
        content: { type: "text", text: "done" }
      }
    ]);
    expect(poller.turnCompleteCandidate).toBe(true);

    poller.close();
    db.close();
  });

  it("does not treat stepType 14 (user prompt, status 3) as a turn completion candidate", () => {
    const db = createConversationDb(dir, "conv-user-prompt-only");
    insertStep(db, {
      idx: 1,
      stepType: 14,
      status: 3,
      stepPayload: encodeStepPayload({ userPrompt: "Hello assistant" })
    });
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-user-prompt-only",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    expect(poller.poll()).toEqual([]);
    expect(poller.turnCompleteCandidate).toBe(false);

    insertStep(db, {
      idx: 2,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({ agentText: "Hello user" })
    });
    expect(poller.poll()).toHaveLength(1);
    expect(poller.turnCompleteCandidate).toBe(true);

    poller.close();
    db.close();
  });

  it("requires a terminal assistant message after the last tool before completing", () => {
    const db = createConversationDb(dir, "conv-final-after-tool");
    const call = encodeToolCall({
      callId: "cmd-final",
      namePrimary: "run_command",
      rawInputJson: '{"CommandLine":"echo done"}'
    });
    insertStep(db, {
      idx: 1,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({ agentText: "I'll inspect the workspace first." })
    });
    insertStep(db, {
      idx: 2,
      stepType: 21,
      status: 2,
      stepPayload: encodeStepPayload({ toolRun: encodeToolRun({ call }) })
    });
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-final-after-tool",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    expect(poller.poll()).toMatchObject([
      { sessionUpdate: "agent_message_chunk", content: { text: "I'll inspect the workspace first." } },
      { sessionUpdate: "tool_call", toolCallId: "cmd-final", status: "in_progress" }
    ]);
    expect(poller.turnCompleteCandidate).toBe(false);

    updateStep(db, 2, {
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({ call }),
        commandResult: encodeCommandResult({ command: "echo done", output: "done\n", exitCode: 0 })
      })
    });
    expect(poller.poll()).toMatchObject([
      { sessionUpdate: "tool_call_update", toolCallId: "cmd-final", status: "completed" }
    ]);
    expect(poller.turnCompleteCandidate).toBe(false);

    // agy's terminal lifecycle row is provider state, not an assistant deliverable.
    insertStep(db, {
      idx: 3,
      stepType: 101,
      status: 3,
      stepPayload: encodeStepPayload({})
    });
    expect(poller.poll()).toEqual([]);
    expect(poller.turnCompleteCandidate).toBe(false);

    insertStep(db, {
      idx: 4,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({ agentText: "The workspace is ready." })
    });
    expect(poller.poll()).toMatchObject([
      { sessionUpdate: "agent_message_chunk", content: { text: "The workspace is ready." } }
    ]);
    expect(poller.turnCompleteCandidate).toBe(true);

    poller.close();
    db.close();
  });

  it.each([
    { status: 3, outcome: "allowed" },
    { status: 7, outcome: "denied" }
  ])("keeps a permission turn open after it is $outcome until a final assistant message exists", ({ status }) => {
    const id = `conv-permission-${status}`;
    const db = createConversationDb(dir, id);
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 9,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: `permission-${status}`,
            namePrimary: "run_command",
            rawInputJson: '{"CommandLine":"git status"}'
          })
        })
      })
    });
    insertStep(db, {
      idx: 2,
      stepType: 101,
      status: 3,
      stepPayload: encodeStepPayload({})
    });
    const poller = new StreamPoller({
      dir,
      conversationId: id,
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    poller.poll();
    expect(poller.takePending()).toHaveLength(1);
    expect(poller.turnCompleteCandidate).toBe(false);

    updateStep(db, 1, { status });
    poller.poll();
    expect(poller.turnCompleteCandidate).toBe(false);

    insertStep(db, {
      idx: 3,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({
        agentText: status === 3 ? "Command completed." : "Command was denied."
      })
    });
    poller.poll();
    expect(poller.turnCompleteCandidate).toBe(true);

    poller.close();
    db.close();
  });

  it("does not complete from lifecycle or internal system rows before visible assistant output", () => {
    const db = createConversationDb(dir, "conv-lifecycle-before-answer");
    insertStep(db, {
      idx: 1,
      stepType: 101,
      status: 3,
      stepPayload: encodeStepPayload({})
    });
    insertStep(db, {
      idx: 2,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({
        agentText: "<SYSTEM_MESSAGE>\n[Message] provider lifecycle update"
      })
    });
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-lifecycle-before-answer",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    expect(poller.poll()).toEqual([]);
    expect(poller.turnCompleteCandidate).toBe(false);

    insertStep(db, {
      idx: 3,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({ agentText: "Final answer." })
    });
    expect(poller.poll()).toHaveLength(1);
    expect(poller.turnCompleteCandidate).toBe(true);

    poller.close();
    db.close();
  });

  it("does not keep a terminal foreground command task active after an explicit exit code", () => {
    const db = createConversationDb(dir, "conv-terminal-command-task");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "cmd-terminal-task",
            namePrimary: "run_command",
            rawInputJson: '{"CommandLine":"paseo inspect self --json"}'
          })
        }),
        commandResult: encodeCommandResult({
          command: "paseo inspect self --json",
          output: '{"status":"running"}\n',
          exitCode: 0
        })
      }),
      task: encodeTaskDetails({ taskId: "task-3", logUri: "", description: "command" })
    });
    insertStep(db, {
      idx: 2,
      stepType: 19,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "read-policy",
            namePrimary: "view_file",
            rawInputJson: '{"AbsolutePath":"/tmp/agent-routing-policy.json"}'
          })
        }),
        viewFile: encodeViewFileResult({
          fileUri: "file:///tmp/agent-routing-policy.json",
          content: '{"enabled":true}'
        })
      })
    });
    insertStep(db, {
      idx: 3,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({ agentText: '{"validationPassed":true}' })
    });
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-terminal-command-task",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    poller.poll();
    expect(poller.hasActiveBackgroundTasks).toBe(false);
    expect(poller.turnCompleteCandidate).toBe(true);

    poller.close();
    db.close();
  });

  it("tracks background tasks as active until completion system message, without requiring a new user prompt", () => {
    const db = createConversationDb(dir, "conv-bg-active");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 3,
      stepPayload: encodeStepPayload({
        commandResult: encodeCommandResult({ command: "sleep 10 &", output: "Task task-9 launched" })
      }),
      task: encodeTaskDetails({ taskId: "task-9", logUri: "", description: "bg" })
    });
    insertStep(db, {
      idx: 2,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({
        agentText: "Preserving context while waiting for background command output..."
      })
    });
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-bg-active",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    poller.poll();
    expect(poller.hasActiveBackgroundTasks).toBe(true);
    expect(poller.hasUnansweredSystemMessage).toBe(false);

    insertStep(db, {
      idx: 3,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({
        agentText: '<SYSTEM_MESSAGE>\n[Message] sender=task-9 content=Task id "task-9" finished'
      })
    });
    const afterDone = poller.poll();
    // SYSTEM_MESSAGE is filtered from client updates; completion is poller state only.
    expect(afterDone.some((u) => (u as { sessionUpdate?: string }).sessionUpdate === "agent_message_chunk")).toBe(false);
    expect(poller.hasActiveBackgroundTasks).toBe(false);
    expect(poller.hasUnansweredSystemMessage).toBe(true);

    poller.close();
    db.close();
  });

  it("does not complete launched tasks from a non-terminal system message row", () => {
    const db = createConversationDb(dir, "conv-bg-nonterminal-sys");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 3,
      stepPayload: encodeStepPayload({
        commandResult: encodeCommandResult({ command: "sleep 1 &", output: "launched" })
      }),
      task: encodeTaskDetails({ taskId: "task-nt", logUri: "", description: "bg" })
    });
    insertStep(db, {
      idx: 2,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({
        agentText: "Preserving context while waiting for background command output..."
      })
    });
    // Streaming system envelope (status still active) must not end the wait.
    insertStep(db, {
      idx: 3,
      stepType: 15,
      status: 1,
      stepPayload: encodeStepPayload({
        agentText: "<SYSTEM_MESSAGE>\n[Message] partial"
      })
    });
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-bg-nonterminal-sys",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    poller.poll();
    expect(poller.hasActiveBackgroundTasks).toBe(true);

    updateStep(db, 3, {
      status: 3,
      stepPayload: encodeStepPayload({
        agentText: '<SYSTEM_MESSAGE>\n[Message] sender=task-nt content=Task id "task-nt" finished'
      })
    });
    poller.poll();
    expect(poller.hasActiveBackgroundTasks).toBe(false);

    poller.close();
    db.close();
  });

  it("matches completed task ids with token boundaries, not prefixes", () => {
    const db = createConversationDb(dir, "conv-bg-task-prefix");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 3,
      stepPayload: encodeStepPayload({
        commandResult: encodeCommandResult({ command: "a &", output: "launched" })
      }),
      task: encodeTaskDetails({ taskId: "task-1", logUri: "", description: "one" })
    });
    insertStep(db, {
      idx: 2,
      stepType: 21,
      status: 3,
      stepPayload: encodeStepPayload({
        commandResult: encodeCommandResult({ command: "b &", output: "launched" })
      }),
      task: encodeTaskDetails({ taskId: "task-10", logUri: "", description: "ten" })
    });
    insertStep(db, {
      idx: 3,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({
        agentText: "Preserving context while waiting for background command output..."
      })
    });
    insertStep(db, {
      idx: 4,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({
        agentText: '<SYSTEM_MESSAGE>\n[Message] sender=task-10 content=Task id "task-10" finished'
      })
    });
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-bg-task-prefix",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    poller.poll();
    // task-10 completed; task-1 must remain active (includes() would false-complete it).
    expect(poller.hasActiveBackgroundTasks).toBe(true);

    insertStep(db, {
      idx: 5,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({
        agentText: '<SYSTEM_MESSAGE>\n[Message] sender=task-1 content=Task id "task-1" finished'
      })
    });
    poller.poll();
    expect(poller.hasActiveBackgroundTasks).toBe(false);

    poller.close();
    db.close();
  });

  it("does not treat prose about preserving context as a background wait without a task", () => {
    const db = createConversationDb(dir, "conv-bg-prose-only");
    insertStep(db, {
      idx: 1,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({
        agentText: "Preserving context while waiting for background command output..."
      })
    });
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-bg-prose-only",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    poller.poll();
    expect(poller.hasActiveBackgroundTasks).toBe(false);

    poller.close();
    db.close();
  });

  it("does not clear background wait on empty stepType 101, but clears on system message wake", () => {
    const db = createConversationDb(dir, "conv-bg-stop-hook");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      status: 3,
      stepPayload: encodeStepPayload({
        commandResult: encodeCommandResult({ command: "sleep 1 &", output: "launched" })
      }),
      task: encodeTaskDetails({ taskId: "task-42", logUri: "", description: "bg" })
    });
    insertStep(db, {
      idx: 2,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({
        agentText: "The test run task has been launched in the background. I will wait for it to complete before providing the final summary."
      })
    });
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-bg-stop-hook",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    poller.poll();
    expect(poller.hasActiveBackgroundTasks).toBe(true);

    // Empty stepType 101 turn-end marker appended by agy at prompt end must NOT clear active tasks
    insertStep(db, {
      idx: 3,
      stepType: 101,
      status: 3,
      stepPayload: encodeStepPayload({})
    });
    poller.poll();
    expect(poller.hasActiveBackgroundTasks).toBe(true);

    // Genuine system message completion wake clears the task
    insertStep(db, {
      idx: 4,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({
        agentText: '<SYSTEM_MESSAGE>\n[Message] sender=task-42 content=Task id "task-42" finished'
      })
    });
    poller.poll();
    expect(poller.hasActiveBackgroundTasks).toBe(false);

    poller.close();
    db.close();
  });

  it("does not close tasks launched after an id-less terminal lifecycle row", () => {
    const db = createConversationDb(dir, "conv-bg-lifecycle-precedes-launch");
    // Auto-proceed stop_hook with no embedded task id, written BEFORE the launch.
    insertStep(db, {
      idx: 1,
      stepType: 101,
      status: 3,
      stepPayload: encodeStepPayload({})
    });
    insertStep(db, {
      idx: 2,
      stepType: 21,
      status: 3,
      stepPayload: encodeStepPayload({
        commandResult: encodeCommandResult({ command: "sleep 10 &", output: "launched" })
      }),
      task: encodeTaskDetails({ taskId: "task-b", logUri: "", description: "bg" })
    });
    insertStep(db, {
      idx: 3,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({
        agentText: "Preserving context while waiting for background command output..."
      })
    });
    const poller = new StreamPoller({
      dir,
      conversationId: "conv-bg-lifecycle-precedes-launch",
      baseStepIdx: -1,
      skipNarration: false,
      snapshot: null
    });

    poller.poll();
    expect(poller.hasActiveBackgroundTasks).toBe(true);

    // Any later revision re-reads the old id-less lifecycle row; it must not
    // close task-b, which launched after that row was written.
    insertStep(db, {
      idx: 4,
      stepType: 15,
      status: 1,
      stepPayload: encodeStepPayload({ agentText: "still working" })
    });
    poller.poll();
    expect(poller.hasActiveBackgroundTasks).toBe(true);

    // The genuine completion message still closes it.
    insertStep(db, {
      idx: 5,
      stepType: 15,
      status: 3,
      stepPayload: encodeStepPayload({
        agentText: '<SYSTEM_MESSAGE>\n[Message] sender=task-b content=Task id "task-b" finished'
      })
    });
    poller.poll();
    expect(poller.hasActiveBackgroundTasks).toBe(false);

    poller.close();
    db.close();
  });
});

describe("ReplayCache", () => {
  it("serves unchanged cache hits and rebuilds grouped messages after growth", () => {
    const db = createConversationDb(dir, "conv-5");
    insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "Hello" }) });

    const cache = new ReplayCache(8);
    const first = cache.get(dir, "conv-5", { skipNarration: false });
    expect(first?.updates).toHaveLength(1);

    const cached = cache.get(dir, "conv-5", { skipNarration: false });
    expect(cached?.updates).toBe(first?.updates); // same array reference: fast path, no rebuild

    insertStep(db, { idx: 2, stepType: 15, stepPayload: encodeStepPayload({ agentText: " world" }) });
    db.close();

    const grown = cache.get(dir, "conv-5", { skipNarration: false });
    expect(grown?.updates).toEqual([
      {
        sessionUpdate: "agent_message_chunk",
        messageId: "1",
        content: { type: "text", text: "Hello\n world" },
        _meta: { stepIdx: 1, endStepIdx: 2 }
      }
    ]);
    expect(grown?.maxIdx).toBe(2);
  });

  it("rebuilds cached replay after an in-place step update", () => {
    const db = createConversationDb(dir, "conv-replay-mutation");
    insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "partial" }) });

    const cache = new ReplayCache(8);
    expect(cache.get(dir, "conv-replay-mutation", { skipNarration: false })?.updates).toMatchObject([
      { content: { text: "partial" } }
    ]);

    updateStepPayload(db, 1, encodeStepPayload({ agentText: "complete result" }));
    db.close();

    expect(cache.get(dir, "conv-replay-mutation", { skipNarration: false })?.updates).toMatchObject([
      { content: { text: "complete result" } }
    ]);
  });

  it("rebuilds cached replay after an in-place step update the (mtime,size) check misses", () => {
    const dbPath = path.join(dir, "conv-replay-same-size.db");
    const db = createConversationDb(dir, "conv-replay-same-size");
    insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "hello" }) });

    // Pin the main-file mtime to a fixed, ms-precision value so we can restore it
    // exactly after the update and defeat the old (mtime, size) staleness check.
    const pinnedTime = new Date(2020, 0, 1, 0, 0, 0);
    fs.utimesSync(dbPath, pinnedTime, pinnedTime);

    const cache = new ReplayCache(8);
    const first = cache.get(dir, "conv-replay-same-size", { skipNarration: false });
    expect(first?.updates).toMatchObject([{ content: { text: "hello" } }]);
    const sizeBefore = fs.statSync(dbPath).size;

    // Same string length ("hello" vs "world") keeps the main-file byte size unchanged.
    updateStepPayload(db, 1, encodeStepPayload({ agentText: "world" }));
    db.close();

    // Restore the exact mtime the cache recorded: with size also unchanged, only the
    // SQLite header change counter differs, so this fails unless the widened
    // fingerprint (change counter / WAL / journal) is doing the work.
    fs.utimesSync(dbPath, pinnedTime, pinnedTime);
    expect(fs.statSync(dbPath).size).toBe(sizeBefore);

    const second = cache.get(dir, "conv-replay-same-size", { skipNarration: false });
    expect(second?.updates).toMatchObject([{ content: { text: "world" } }]);
    expect(second?.updates).not.toBe(first?.updates);
  });

  it("detects committed WAL state changes via the wal-index when WAL metadata is unchanged", () => {
    const db = createConversationDb(dir, "conv-wal-committed");
    insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "hi" }) });
    db.close();

    // Synthesize WAL + wal-index sidecars. A commit publishes mxFrame and the
    // cumulative frame checksum in the wal-index; that publication is the same
    // event that makes new rows visible to SQLite readers, so keying the
    // fingerprint on it catches commits even when the WAL file's size/mtime
    // (same-tick write, reused spill frames) and the main-file change counter
    // (pre-checkpoint) all stay fixed.
    const pinnedTime = new Date(2020, 0, 1, 0, 0, 0);
    fs.writeFileSync(path.join(dir, "conv-wal-committed.db-wal"), Buffer.alloc(64));
    fs.utimesSync(path.join(dir, "conv-wal-committed.db-wal"), pinnedTime, pinnedTime);

    const shmPath = path.join(dir, "conv-wal-committed.db-shm");
    const shm = Buffer.alloc(48);
    shm.writeUInt32LE(3007000, 0); // wal-index iVersion
    shm.writeUInt32LE(10, 16); // mxFrame
    shm.writeUInt32LE(0x11111111, 24); // aFrameCksum[0]
    shm.writeUInt32LE(0x22222222, 28); // aFrameCksum[1]
    fs.writeFileSync(shmPath, shm);
    fs.utimesSync(shmPath, pinnedTime, pinnedTime);

    const before = statConversation(dir, "conv-wal-committed");
    expect(before?.walMxFrame).toBe(10);
    expect(before?.walFrameCksum0).toBe(0x11111111);
    expect(before?.walFrameCksum1).toBe(0x22222222);

    // Publish a new commit: mxFrame advances and the checksum chain moves,
    // while every other tracked field stays identical.
    shm.writeUInt32LE(12, 16);
    shm.writeUInt32LE(0x33333333, 24);
    shm.writeUInt32LE(0x44444444, 28);
    fs.writeFileSync(shmPath, shm);
    fs.utimesSync(shmPath, pinnedTime, pinnedTime);

    const after = statConversation(dir, "conv-wal-committed");
    expect(after?.mtimeMs).toBe(before?.mtimeMs);
    expect(after?.walMtimeMs).toBe(before?.walMtimeMs);
    expect(after?.walSize).toBe(before?.walSize);
    expect(after?.changeCounter).toBe(before?.changeCounter);
    expect(after?.walMxFrame).toBe(12);
    expect(after?.walFrameCksum0).toBe(0x33333333);
    expect(isDbStatUnchanged(before as DbStat, after as DbStat)).toBe(false);
  });

  it("parses big-endian wal-index headers", () => {
    const db = createConversationDb(dir, "conv-wal-be");
    insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "hi" }) });
    db.close();
    fs.writeFileSync(path.join(dir, "conv-wal-be.db-wal"), Buffer.alloc(64));

    const shm = Buffer.alloc(48);
    shm.writeUInt32BE(3007000, 0);
    shm.writeUInt32BE(7, 16);
    shm.writeUInt32BE(0xaaaaaaaa, 24);
    shm.writeUInt32BE(0xbbbbbbbb, 28);
    fs.writeFileSync(path.join(dir, "conv-wal-be.db-shm"), shm);

    const stat = statConversation(dir, "conv-wal-be");
    expect(stat?.walMxFrame).toBe(7);
    expect(stat?.walFrameCksum0).toBe(0xaaaaaaaa);
    expect(stat?.walFrameCksum1).toBe(0xbbbbbbbb);
  });

  it("isDbStatUnchanged treats any single fingerprint field as significant", () => {
    const base: DbStat = {
      mtimeMs: 100,
      size: 4096,
      walMtimeMs: 200,
      walSize: 32,
      walMxFrame: 10,
      walFrameCksum0: 0x11111111,
      walFrameCksum1: 0x22222222,
      journalMtimeMs: undefined,
      journalSize: undefined,
      changeCounter: 7
    };
    expect(isDbStatUnchanged(base, { ...base })).toBe(true);

    const fields: Array<[keyof DbStat, number]> = [
      ["mtimeMs", 101],
      ["size", 4097],
      ["walMtimeMs", 201],
      ["walSize", 33],
      ["walMxFrame", 11],
      ["walFrameCksum0", 0x33333333],
      ["walFrameCksum1", 0x44444444],
      ["changeCounter", 8]
    ];
    for (const [field, value] of fields) {
      expect(isDbStatUnchanged(base, { ...base, [field]: value })).toBe(false);
    }
  });

  it("allows manual invalidation via invalidate() and clear()", () => {
    const db = createConversationDb(dir, "conv-replay-inv");
    insertStep(db, { idx: 1, stepType: 15, stepPayload: encodeStepPayload({ agentText: "v1" }) });

    const cache = new ReplayCache(8);
    const first = cache.get(dir, "conv-replay-inv", { skipNarration: false });
    expect(first?.updates).toMatchObject([{ content: { text: "v1" } }]);

    cache.invalidate("conv-replay-inv");
    const second = cache.get(dir, "conv-replay-inv", { skipNarration: false });
    expect(second?.updates).not.toBe(first?.updates);

    cache.clear();
    const third = cache.get(dir, "conv-replay-inv", { skipNarration: false });
    expect(third?.updates).not.toBe(second?.updates);
    db.close();
  });

  it("rebuilds cached locations when a referenced file is deleted", () => {
    const file = path.join(dir, "cached-location.txt");
    fs.writeFileSync(file, "content");
    const db = createConversationDb(dir, "conv-replay-deleted-location");
    insertStep(db, {
      idx: 1,
      stepType: 8,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "cached-view",
            namePrimary: "view_file",
            rawInputJson: JSON.stringify({ AbsolutePath: file })
          })
        }),
        viewFile: encodeViewFileResult({ fileUri: `file://${file}`, content: "content" })
      })
    });
    db.close();

    const cache = new ReplayCache(8);
    const first = cache.get(dir, "conv-replay-deleted-location", { skipNarration: false });
    expect((first?.updates[0] as { locations?: unknown[] }).locations).toEqual([{ path: file, line: 1 }]);

    fs.rmSync(file);

    const rebuilt = cache.get(dir, "conv-replay-deleted-location", { skipNarration: false });
    expect((rebuilt?.updates[0] as { locations?: unknown[] }).locations).toBeUndefined();
    expect(rebuilt?.updates).not.toBe(first?.updates);
  });

  it("rebuilds cached locations when a referenced file is restored", () => {
    const file = path.join(dir, "restored-location.txt");
    const db = createConversationDb(dir, "conv-replay-restored-location");
    insertStep(db, {
      idx: 1,
      stepType: 8,
      status: 3,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "restored-view",
            namePrimary: "view_file",
            rawInputJson: JSON.stringify({ AbsolutePath: file })
          })
        }),
        viewFile: encodeViewFileResult({ fileUri: `file://${file}`, content: "content" })
      })
    });
    db.close();

    const cache = new ReplayCache(8);
    const first = cache.get(dir, "conv-replay-restored-location", { skipNarration: false });
    expect((first?.updates[0] as { locations?: unknown[] }).locations).toBeUndefined();

    fs.writeFileSync(file, "content");

    const rebuilt = cache.get(dir, "conv-replay-restored-location", { skipNarration: false });
    expect((rebuilt?.updates[0] as { locations?: unknown[] }).locations).toEqual([{ path: file, line: 1 }]);
    expect(rebuilt?.updates).not.toBe(first?.updates);
  });

  it("returns null for a missing conversation", () => {
    const cache = new ReplayCache(8);
    expect(cache.get(dir, "missing", { skipNarration: false })).toBeNull();
  });
});

describe("conversation scan", () => {
  it("binds the single new .db file created since a snapshot", () => {
    createConversationDb(dir, "existing").close();
    const before = conversationSnapshot(dir);

    createConversationDb(dir, "fresh").close();
    expect(newConversationId(dir, before)).toBe("fresh");
  });

  it("refuses to bind when multiple new conversations appear", () => {
    const before = conversationSnapshot(dir);
    createConversationDb(dir, "a").close();
    createConversationDb(dir, "b").close();
    expect(newConversationId(dir, before)).toBeNull();
  });
});

describe("tool call name support (gh#52)", () => {
  it("emits programmatic tool call name on tool_call session updates", () => {
    const db = createConversationDb(dir, "conv-name-test");
    insertStep(db, {
      idx: 1,
      stepType: 21,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({ callId: "c1", namePrimary: "run_command", rawInputJson: '{"CommandLine":"echo hi"}' })
        })
      })
    });
    insertStep(db, {
      idx: 2,
      stepType: 8,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({ callId: "c2", namePrimary: "view_file", rawInputJson: '{"AbsolutePath":"/tmp/test.txt"}' })
        })
      })
    });
    insertStep(db, {
      idx: 3,
      stepType: 5,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({ callId: "c3", namePrimary: "replace_file_content", rawInputJson: '{"TargetFile":"/tmp/test.txt","TargetContent":"a","ReplacementContent":"b"}' })
        })
      })
    });
    insertStep(db, {
      idx: 4,
      stepType: 132,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "c4",
            nameSecondary: "custom_secondary_tool",
            rawInputJson: '{"value":"test"}'
          }),
          titlePrimary: "Custom secondary tool"
        })
      })
    });
    insertStep(db, {
      idx: 5,
      stepType: 21,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "c5",
            nameSecondary: "custom_command_tool",
            rawInputJson: '{"CommandLine":"echo secondary"}'
          })
        })
      })
    });
    insertStep(db, {
      idx: 6,
      stepType: 17,
      stepPayload: encodeStepPayload({
        toolRun: encodeToolRun({
          call: encodeToolCall({
            callId: "c6",
            nameSecondary: "run_command",
            rawInputJson: '{"CommandLine":"echo routed"}'
          })
        })
      })
    });
    db.close();

    const conn = ConversationDb.open(dir, "conv-name-test");
    expect(conn).not.toBeNull();
    const rows = conn!.readAfter(0);
    conn!.close();

    const execUpdate = sessionUpdateFromStep(rows[0]) as any;
    expect(execUpdate.name).toBe("run_command");

    const readUpdate = sessionUpdateFromStep(rows[1]) as any;
    expect(readUpdate.name).toBe("view_file");

    const editUpdate = sessionUpdateFromStep(rows[2]) as any;
    expect(editUpdate.name).toBe("replace_file_content");

    const genericUpdate = sessionUpdateFromStep(rows[3]) as any;
    expect(genericUpdate.name).toBe("custom_secondary_tool");

    const executeUpdate = sessionUpdateFromStep(rows[4]) as any;
    expect(executeUpdate.name).toBe("custom_command_tool");

    const routedUpdate = sessionUpdateFromStep(rows[5]) as any;
    expect(routedUpdate).toMatchObject({ name: "run_command", kind: "execute" });
  });
});

describe("user prompt envelope replay", () => {
  function promptUpdates(id: string, text: string): Array<Record<string, unknown>> {
    const db = createConversationDb(dir, id);
    insertStep(db, { idx: 1, stepType: 14, status: 3, stepPayload: encodeStepPayload({ userPrompt: text }) });
    db.close();
    const conn = ConversationDb.open(dir, id);
    const rows = conn!.readAfter(-1);
    conn!.close();
    return sessionUpdateFromStep(rows[0]) as unknown as Array<Record<string, unknown>>;
  }

  it("unwraps a fully-tagged legacy envelope row", () => {
    const updates = promptUpdates(
      "conv-legacy-envelope",
      '<user_text>\nhello\n</user_text>\n<embedded_resource uri="file:///x.ts">\nbody\n</embedded_resource>'
    );
    expect(updates).toEqual([
      { sessionUpdate: "user_message_chunk", messageId: "1", content: { type: "text", text: "hello" } },
      {
        sessionUpdate: "user_message_chunk",
        messageId: "1",
        content: { type: "resource", resource: { uri: "file:///x.ts", text: "body" } }
      }
    ]);
  });

  it("replays verbatim a raw prompt that quotes a legacy-looking tag among other text", () => {
    const raw = 'what does <embedded_resource uri="x">\nfoo\n</embedded_resource> do?';
    const updates = promptUpdates("conv-raw-quoted-envelope", raw);
    expect(updates).toEqual([
      { sessionUpdate: "user_message_chunk", messageId: "1", content: { type: "text", text: raw } }
    ]);
  });

  it("replays verbatim a raw prompt with an envelope-shaped prefix and trailing text", () => {
    const raw = '<user_text>\nhello\n</user_text>\nwait, ignore that tag';
    const updates = promptUpdates("conv-raw-envelope-prefix", raw);
    expect(updates).toEqual([
      { sessionUpdate: "user_message_chunk", messageId: "1", content: { type: "text", text: raw } }
    ]);
  });

  it("preserves surrounding whitespace when replaying a raw prompt", () => {
    const raw = "\n  const value = 1;  \n\n";
    const updates = promptUpdates("conv-raw-whitespace", raw);
    expect(updates).toEqual([
      { sessionUpdate: "user_message_chunk", messageId: "1", content: { type: "text", text: raw } }
    ]);
  });
});
