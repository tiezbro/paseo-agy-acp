import { describe, expect, it } from "vitest";
import { sessionUpdateShowsVisibleOutput } from "../ACP Connector/official-kernel/errors.js";

describe("ACP 输出内容形态矩阵", () => {
  it.each([
    ["missing", undefined, false], ["null", null, false], ["empty record", {}, false],
    ["empty text", { type: "text", text: "" }, false],
    ["whitespace", { type: "text", text: " \t\r\n" }, false],
    ["text", { type: "text", text: "正文" }, true],
    ["legacy text", { text: "正文" }, true],
    ["empty array", [], false],
    ["blank array", [{ type: "text", text: " " }, { type: "text", text: "" }], false],
    ["text array", [{ type: "text", text: " " }, { type: "text", text: "正文" }], true],
    ["image", { type: "image", data: "AAAA", mimeType: "image/png" }, true],
    ["audio", { type: "audio", data: "AAAA", mimeType: "audio/wav" }, true],
    ["resource", { type: "resource", resource: { uri: "file:///sample.txt", text: "body" } }, true],
    ["resource link", { type: "resource_link", uri: "file:///sample.txt", name: "sample" }, true],
    ["resource array", [{ type: "text", text: " " }, { type: "resource_link", uri: "file:///sample.txt" }], true],
    ["extension", { type: "future_video", uri: "file:///sample.mp4" }, true],
    ["extension array", [{ type: "future_video", data: "AAAA" }], true],
    ["tag only", { type: "image" }, false],
    ["metadata only", { type: "future_video", _meta: { trace: "id" } }, false],
    ["invalid tag", { type: 123, data: "AAAA" }, false],
    ["invalid array", [null, 42, " ", {}], false]
  ] as const)("%s", (_label, content, visible) => {
    for (const sessionUpdate of ["agent_message_chunk", "agent_message", "message", "agent_thought_chunk"]) {
      expect(sessionUpdateShowsVisibleOutput({ update: { sessionUpdate, content } })).toBe(visible);
    }
  });

  it.each(["tool_call", "tool_call_update", "tool", "tool_update"])("%s 无文本仍算工具活动", kind => {
    for (const field of ["sessionUpdate", "session_update", "type"]) {
      expect(sessionUpdateShowsVisibleOutput({ update: { [field]: kind, toolCallId: "t1" } })).toBe(true);
    }
  });

  it("状态与命令通知、缺失 envelope 不算正文", () => {
    for (const value of [undefined, null, [], {}, { update: {} },
      { update: { sessionUpdate: "available_commands_update", availableCommands: [] } },
      { update: { sessionUpdate: "current_mode_update", currentModeId: "default" } }]) {
      expect(sessionUpdateShowsVisibleOutput(value)).toBe(false);
    }
  });
});
