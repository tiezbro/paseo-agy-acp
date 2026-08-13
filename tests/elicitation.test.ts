import { describe, expect, it } from "vitest";
import { handleInitializeV1, handleInitializeV2 } from "../src/agy/acp/initialize.js";
import {
  buildElicitationRequestFromAskQuestion,
  encodeElicitationKeys,
  parseAskQuestionFull
} from "../src/agy/acp/tool-calls/elicitation.js";
import { canBridgeInteraction } from "../src/agy/acp/tool-calls/permissions.js";
import type { SessionUpdate } from "@agentclientprotocol/sdk";

describe("ACP Elicitation Capabilities", () => {
  it("reads v1 client elicitation support without advertising an agent capability", () => {
    const { response, clientElicitation } = handleInitializeV1(
      {
        protocolVersion: 1,
        clientCapabilities: {
          elicitation: { form: {}, url: {} }
        }
      },
      "1.0.0"
    );

    expect(response.agentCapabilities).not.toHaveProperty("elicitation");
    expect(clientElicitation).toEqual({ form: true, url: true });
  });

  it("reads v2 client elicitation support without advertising an agent capability", () => {
    const { response, clientElicitation } = handleInitializeV2(
      {
        protocolVersion: 2,
        capabilities: {
          elicitation: { form: {} }
        }
      } as any,
      "1.0.0"
    );

    expect(response.capabilities).not.toHaveProperty("elicitation");
    expect(clientElicitation).toEqual({ form: true, url: false });
  });
});

describe("AskQuestion Payload Parsing & Elicitation Requests", () => {
  it("parses single-select ask_question and builds form elicitation request", () => {
    const toolCall: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc_1",
      title: "Ask Question",
      rawInput: {
        questions: [
          {
            question: "Which refactoring strategy?",
            options: ["conservative", "balanced", "aggressive"],
            is_multi_select: false
          }
        ]
      }
    } as any;

    const parsed = parseAskQuestionFull(toolCall);
    expect(parsed).not.toBeNull();
    expect(parsed?.items).toHaveLength(1);
    expect(parsed?.items[0].options).toEqual(["conservative", "balanced", "aggressive"]);

    const req = buildElicitationRequestFromAskQuestion(toolCall, "sess_123");
    expect(req).toEqual({
      sessionId: "sess_123",
      toolCallId: "tc_1",
      mode: "form",
      message: "Which refactoring strategy?",
      requestedSchema: {
        type: "object",
        properties: {
          q0: {
            type: "string",
            title: "Which refactoring strategy?",
            oneOf: [
              { const: "conservative", title: "conservative" },
              { const: "balanced", title: "balanced" },
              { const: "aggressive", title: "aggressive" }
            ]
          }
        },
        required: ["q0"]
      }
    });
  });

  it("parses multi-select ask_question and builds form elicitation request", () => {
    const toolCall: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc_2",
      title: "Select Features",
      rawInput: {
        questions: [
          {
            question: "Select enabled features:",
            options: ["auth", "logging", "metrics"],
            is_multi_select: true
          }
        ]
      }
    } as any;

    const req = buildElicitationRequestFromAskQuestion(toolCall, "sess_456");
    expect(req).toEqual({
      sessionId: "sess_456",
      toolCallId: "tc_2",
      mode: "form",
      message: "Select enabled features:",
      requestedSchema: {
        type: "object",
        properties: {
          q0: {
            type: "array",
            title: "Select enabled features:",
            items: {
              anyOf: [
                { const: "auth", title: "auth" },
                { const: "logging", title: "logging" },
                { const: "metrics", title: "metrics" }
              ]
            }
          }
        },
        required: ["q0"]
      }
    });
  });

  it("parses free-text ask_question and builds form elicitation request", () => {
    const toolCall: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc_3",
      title: "Input Name",
      rawInput: {
        questions: [
          {
            question: "What should the function name be?",
            options: [],
            is_multi_select: false
          }
        ]
      }
    } as any;

    const req = buildElicitationRequestFromAskQuestion(toolCall, "sess_789");
    expect(req).toEqual({
      sessionId: "sess_789",
      toolCallId: "tc_3",
      mode: "form",
      message: "What should the function name be?",
      requestedSchema: {
        type: "object",
        properties: {
          q0: {
            type: "string",
            title: "What should the function name be?"
          }
        },
        required: ["q0"]
      }
    });
  });

  it("builds form elicitation request per questionIndex for multi-question dialogs", () => {
    const multiQCall: SessionUpdate = {
      sessionUpdate: "tool_call",
      toolCallId: "tc_mq",
      title: "Wizard",
      rawInput: {
        questions: [
          { question: "Env?", options: ["Dev", "Prod"], is_multi_select: false },
          { question: "Features?", options: ["Auth", "DB"], is_multi_select: true }
        ]
      }
    } as any;

    const req0 = buildElicitationRequestFromAskQuestion(multiQCall, "sess_1", 0);
    expect(req0?.message).toBe("[Question 1/2] Env?");
    expect(req0?.requestedSchema?.required).toEqual(["q0"]);

    const req1 = buildElicitationRequestFromAskQuestion(multiQCall, "sess_1", 1);
    expect(req1?.message).toBe("[Question 2/2] Features?");
    expect(req1?.requestedSchema?.required).toEqual(["q1"]);

    expect(encodeElicitationKeys(multiQCall, { q0: "Prod" }, 0)).toBe("\x1b[B\r");
    expect(encodeElicitationKeys(multiQCall, { q1: ["Auth", "DB"] }, 1)).toBe(" \x1b[B \r");
  });
});

describe("Encoding Elicitation Responses to PTY Keypresses", () => {
  const toolCall: SessionUpdate = {
    sessionUpdate: "tool_call",
    toolCallId: "tc_1",
    rawInput: {
      questions: [
        {
          question: "Choose option",
          options: ["Opt 0", "Opt 1", "Opt 2"],
          is_multi_select: false
        }
      ]
    }
  } as any;

  it("encodes single-select choice index or matching string", () => {
    expect(encodeElicitationKeys(toolCall, { q0: "Opt 1" })).toBe("\x1b[B\r");
    expect(encodeElicitationKeys(toolCall, { q0: "Opt 2" })).toBe("\x1b[B\x1b[B\r");
    expect(encodeElicitationKeys(toolCall, { q0: "Opt 0" })).toBe("\r");
  });

  it("encodes multi-select choices", () => {
    const multiCall: SessionUpdate = {
      sessionUpdate: "tool_call",
      rawInput: {
        questions: [
          {
            question: "Pick items",
            options: ["A", "B", "C"],
            is_multi_select: true
          }
        ]
      }
    } as any;

    // Toggle option 0 (space), move down to 1, move down to 2, toggle option 2 (space), enter
    expect(encodeElicitationKeys(multiCall, { q0: ["A", "C"] })).toBe(" \x1b[B\x1b[B \r");
  });

  it("encodes free-text response", () => {
    const textCall: SessionUpdate = {
      sessionUpdate: "tool_call",
      rawInput: {
        questions: [
          {
            question: "Type text",
            options: [],
            is_multi_select: false
          }
        ]
      }
    } as any;

    expect(encodeElicitationKeys(textCall, { q0: "my_function_name" })).toBe("my_function_name\r");
    expect(
      encodeElicitationKeys(textCall, { q0: "first\nsecond\r\x1b[2J\tthird\x00" })
    ).toBe("first second [2J third\r");
  });

  it("returns escape key on cancel or decline", () => {
    expect(encodeElicitationKeys(toolCall, undefined)).toBe("\x1b");
  });
});

describe("Interaction Bridging with Elicitation", () => {
  const multiSelectCall: SessionUpdate = {
    sessionUpdate: "tool_call",
    rawInput: {
      questions: [
        {
          question: "Multi select",
          options: ["A", "B"],
          is_multi_select: true
        }
      ]
    }
  } as any;

  it("allows multi-select ask_question when client has elicitation capability", () => {
    expect(canBridgeInteraction("ask_question", multiSelectCall, { hasElicitation: true })).toBe(true);
  });

  it("allows multi-select ask_question even when client lacks elicitation capability", () => {
    expect(canBridgeInteraction("ask_question", multiSelectCall, { hasElicitation: false })).toBe(true);
  });
});
