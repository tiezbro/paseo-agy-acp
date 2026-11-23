import assert from "node:assert/strict";
import test from "node:test";
import { actualForNativeLevel, advertisedCapabilities, trackedFamilies } from "../scripts/paseo-live-model-capabilities.mjs";

test("native option wins, even for a fixed allowlist ID; native Extra is not truncated", () => {
  const thought = { id: "thinking_level", category: "thought_level", type: "select", options: [
    { value: "high" }, { options: [{ value: "xhigh" }, { value: "low" }] }
  ] };
  const raw = { configOptions: [thought], modelIds: ["gemini-4-neon-high", "gemini-4-neon-xhigh"] };
  assert.deepEqual(advertisedCapabilities(raw, "claude-opus-4-6-thinking"), { kind: "native", id: "thinking_level", levels: ["high", "xhigh", "low"] });
  assert.equal(actualForNativeLevel(raw, "gemini-4-neon", "xhigh"), "gemini-4-neon-xhigh");
  assert.equal(actualForNativeLevel(raw, "gemini-4-neon", "low"), undefined);
});

test("only known fixed IDs are synthetic; missing account families stay missing", () => {
  assert.equal(advertisedCapabilities({}, "gpt-oss-120b-medium").kind, "fixed");
  assert.equal(advertisedCapabilities({}, "claude-opus-5-5").kind, "not-bridged");
  assert.deepEqual(trackedFamilies(["claude-opus-5-5", "gemini-3.8-flash"]), ["claude-4.6", "GPT-OSS", "Gemini Extra"]);
});

test("an unrecognized or empty native selector is not treated as a fixed tier", () => {
  assert.equal(advertisedCapabilities({ configOptions: [{ category: "thought_level", type: "boolean", options: [] }] }, "gpt-oss-120b-medium").kind, "unsupported-native-option");
});
