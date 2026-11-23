import { expect, it } from "vitest";
import { describeOfficialModes } from "../ACP Connector/official-kernel/mode-map.js";

it("只修改模型名称，保留选项值、档位与未知元数据，不修改原始回包", () => {
  const input = { models: { currentModelId: "gpt-oss-120b-medium" }, _meta: { retained: true }, configOptions: [
    { category: "model", currentValue: "gpt-oss-120b-medium", options: [
      { group: "vendor", options: [
        { value: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", _meta: { x: 1 } },
        { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
        { value: "future", name: "Future (Preview)" }
      ] }
    ] },
    { category: "thought_level", currentValue: "high", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] }
  ] };
  const before = structuredClone(input);
  expect(describeOfficialModes(input)).toEqual({ _meta: input._meta, configOptions: [
    { ...input.configOptions[0], options: [{ group: "vendor", options: [
      { value: "claude-opus-4-6-thinking", name: "Claude Opus 4.6", _meta: { x: 1 } },
      { value: "gpt-oss-120b-medium", name: "GPT-OSS 120B" },
      { value: "future", name: "Future (Preview)" }
    ] }] }, input.configOptions[1]
  ] });
  expect(input).toEqual(before);
});

it("单档模型沿用原始 ID，不合成档位选择器", () => {
  const value = { configOptions: [{ id: "model", category: "model", currentValue: "gpt-oss-120b-medium",
    options: [{ value: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" }] }] };
  expect(describeOfficialModes(value)).toEqual({ configOptions: [{ ...value.configOptions[0],
    options: [{ value: "gpt-oss-120b-medium", name: "GPT-OSS 120B" }] }] });
});
