// Read the official kernel reply below the adapter, not Paseo's projected controls.
export const fixedDisplayIds = new Set(["claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"]);
export const displayLevels = ["low", "medium", "high"];
export const rawModel = state => state.configOptions?.find(option => option.category === "model");
export const rawThought = state => state.configOptions?.find(option => option.category === "thought_level");
const values = options => (options ?? []).flatMap(option => Array.isArray(option.options)
  ? values(option.options) : typeof option.value === "string" ? [option.value] : []);

export const rawGroupedIds = state => values(rawModel(state)?.options);

export function advertisedCapabilities(state, id) {
  const thought = rawThought(state);
  if (thought) {
    const levels = [...new Set(values(thought.options))];
    return thought.type === "select" && levels.length
      ? { kind: "native", id: thought.id, levels }
      : { kind: "unsupported-native-option", id: thought.id, levels };
  }
  return fixedDisplayIds.has(id) ? { kind: "fixed", levels: displayLevels } : { kind: "not-bridged" };
}

export function actualForNativeLevel(state, family, level) {
  // The grouped config describes the family; the raw official flat catalog has
  // the concrete IDs. Do not match on display names or infer an absent variant.
  const actual = family + "-" + level;
  return state.modelIds?.includes(actual) ? actual : undefined;
}

export function trackedFamilies(ids) {
  return [
    ["claude-4.6", /^claude-.+-4-6(?:-|$)/],
    ["claude-5.5", /^claude-.+-5-5(?:-|$)/],
    ["GPT-OSS", /^gpt-oss-/],
    ["Gemini Flash", /^gemini-.+-flash(?:-|$)/],
    ["Gemini Extra", /^gemini-4-(?:neon|hydrogen)(?:-|$)/]
  ].filter(([, pattern]) => !ids.some(id => pattern.test(id))).map(([family]) => family);
}
