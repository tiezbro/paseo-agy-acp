import { describe, expect, it } from "vitest";
import { SystemMessageFolder } from "../ACP Connector/official-kernel/system-message-fold.js";
import type { JsonRpcMessage } from "../ACP Connector/official-kernel/json-rpc.js";

interface SessionUpdatePayload {
  sessionUpdate?: string;
  _meta?: Record<string, unknown>;
  messageId?: string;
  content?: {
    type?: string;
    text?: string;
  };
}

function getUpdate(message: JsonRpcMessage): SessionUpdatePayload {
  const msg = message as { params?: { update?: SessionUpdatePayload } };
  return msg.params?.update ?? {};
}

describe("SystemMessageFolder", () => {
  it("leaves regular agent_message_chunk unchanged", () => {
    const folder = new SystemMessageFolder();
    const msg = {
      jsonrpc: "2.0" as const,
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Hello from assistant" }
        }
      }
    };
    const results = folder.transform(msg);
    expect(results).toEqual([msg]);
  });

  it("marks a complete <SYSTEM_MESSAGE> block as system text without inventing thought", () => {
    const folder = new SystemMessageFolder();
    const rawSystemMessage = `The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.

<SYSTEM_MESSAGE>
[Message] timestamp=2026-10-05T13:28:59Z sender=task-675 content=Task finished with result:
Output: {"status": "ok"}
</SYSTEM_MESSAGE>`;
    const msg = {
      jsonrpc: "2.0" as const,
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { type: "text", text: rawSystemMessage }
        }
      }
    };
    const results = folder.transform(msg);
    expect(results).toHaveLength(1);
    const update = getUpdate(results[0]);
    expect(update.sessionUpdate).toBe("agent_message_chunk");
    expect(update.messageId).toBe("m1:system");
    expect(update._meta).toEqual({ "paseo.dev/messageKind": "system" });
    expect(update.content?.text).toBe(rawSystemMessage);
  });

  it("splits a chunk containing regular text before and after <SYSTEM_MESSAGE>", () => {
    const folder = new SystemMessageFolder();
    const chunkText = "Start text.\n<SYSTEM_MESSAGE>[Message] sender=test-task content=Task output</SYSTEM_MESSAGE>\nEnd text.";
    const msg = {
      jsonrpc: "2.0" as const,
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { type: "text", text: chunkText }
        }
      }
    };
    const results = folder.transform(msg);
    expect(results).toHaveLength(3);

    // Segment 1: regular message before
    const up1 = getUpdate(results[0]);
    expect(up1.sessionUpdate).toBe("agent_message_chunk");
    expect(up1.content?.text).toBe("Start text.\n");

    // Segment 2: system message keeps a distinct identity
    const up2 = getUpdate(results[1]);
    expect(up2.sessionUpdate).toBe("agent_message_chunk");
    expect(up2.messageId).toBe("m1:system");
    expect(up2.content?.text).toBe("<SYSTEM_MESSAGE>[Message] sender=test-task content=Task output</SYSTEM_MESSAGE>");

    // Segment 3: regular message after
    const up3 = getUpdate(results[2]);
    expect(up3.sessionUpdate).toBe("agent_message_chunk");
    expect(up3.content?.text).toBe("\nEnd text.");
  });

  it("handles multi-chunk streaming across boundaries", () => {
    const folder = new SystemMessageFolder();

    // Chunk 1: Start of system message
    const chunk1 = {
      jsonrpc: "2.0" as const,
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { type: "text", text: "<SYSTEM_MESSAGE>\n[Message] sender=test-task" }
        }
      }
    };
    const res1 = folder.transform(chunk1);
    expect(res1).toEqual([]);

    // Chunk 2: Middle of system message
    const chunk2 = {
      jsonrpc: "2.0" as const,
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { type: "text", text: "\ncontent=Task finished with code 0\n" }
        }
      }
    };
    const res2 = folder.transform(chunk2);
    expect(res2).toEqual([]);

    // Chunk 3: End of system message + normal response
    const chunk3 = {
      jsonrpc: "2.0" as const,
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "m1",
          content: { type: "text", text: "</SYSTEM_MESSAGE>\n\nAll tasks completed successfully." }
        }
      }
    };
    const res3 = folder.transform(chunk3);
    expect(res3).toHaveLength(2);
    const up3_1 = getUpdate(res3[0]);
    expect(up3_1.sessionUpdate).toBe("agent_message_chunk");
    expect(up3_1.content?.text).toBe("<SYSTEM_MESSAGE>\n[Message] sender=test-task\ncontent=Task finished with code 0\n</SYSTEM_MESSAGE>");
    const up3_2 = getUpdate(res3[1]);
    expect(up3_2.sessionUpdate).toBe("agent_message_chunk");
    expect(up3_2.content?.text).toBe("\n\nAll tasks completed successfully.");
  });

  it("handles partial prefix split across chunk boundaries", () => {
    const folder = new SystemMessageFolder();

    // Chunk 1 ends with partial prefix "The following is a <SYSTEM_"
    const chunk1 = {
      jsonrpc: "2.0" as const,
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Intro.\n<SYSTEM_" }
        }
      }
    };
    const res1 = folder.transform(chunk1);
    expect(res1).toHaveLength(1);
    expect(getUpdate(res1[0]).sessionUpdate).toBe("agent_message_chunk");
    expect(getUpdate(res1[0]).content?.text).toBe("Intro.\n");

    // Chunk 2 completes the tag and finishes
    const chunk2 = {
      jsonrpc: "2.0" as const,
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "MESSAGE>\n[Message] sender=test-task content=body\n</SYSTEM_MESSAGE>" }
        }
      }
    };
    const res2 = folder.transform(chunk2);
    expect(res2).toHaveLength(1);
    expect(getUpdate(res2[0]).sessionUpdate).toBe("agent_message_chunk");
    expect(getUpdate(res2[0]).content?.text).toBe("<SYSTEM_MESSAGE>\n[Message] sender=test-task content=body\n</SYSTEM_MESSAGE>");
  });

  it("maintains separate state per sessionId and resets cleanly", () => {
    const folder = new SystemMessageFolder();

    const msgS1 = {
      jsonrpc: "2.0" as const,
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "<SYSTEM_MESSAGE>[Message] sender=test-task content=s1 active" }
        }
      }
    };
    const msgS2 = {
      jsonrpc: "2.0" as const,
      method: "session/update",
      params: {
        sessionId: "s2",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "s2 regular" }
        }
      }
    };

    const resS1 = folder.transform(msgS1);
    const resS2 = folder.transform(msgS2);

    expect(resS1).toEqual([]);
    expect(getUpdate(resS2[0]).sessionUpdate).toBe("agent_message_chunk");

    folder.reset("s1");
    // After reset of s1, next text is not considered inSystemMessage unless new tag appears
    const msgS1After = {
      jsonrpc: "2.0" as const,
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "s1 normal again" }
        }
      }
    };
    const resS1After = folder.transform(msgS1After);
    expect(getUpdate(resS1After[0]).sessionUpdate).toBe("agent_message_chunk");
  });
});
