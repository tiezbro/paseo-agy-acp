import { isRecord } from "./json-rpc.js";

const FIXED_MODEL_IDS = new Set(["claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"]);
const EFFORT_ID = "thinking_level";
const EFFORT_CHOICES = ["high", "medium", "low"] as const;
type Effort = typeof EFFORT_CHOICES[number];

type SessionEffort =
  | { kind: "native"; currentValue: Effort }
  | { kind: "fixed"; currentValue: Effort; configOptions: unknown[] };
type FixedSession = Extract<SessionEffort, { kind: "fixed" }>;

function isEffort(value: unknown): value is Effort {
  return value === "high" || value === "medium" || value === "low";
}

function containsChoice(choices: unknown[], selected: string): boolean {
  return choices.some(choice => isRecord(choice) && (
    choice.value === selected ||
    (Array.isArray(choice.options) && choice.options.some(item => isRecord(item) && item.value === selected))
  ));
}

/** Stock Paseo uses a session-wide effort option to keep the selection UI and
 * saved preferences working. Fixed official models never receive these writes. */
export class FixedModelEffort {
  #paseo = false;
  readonly #sessions = new Map<string, SessionEffort>();

  observeClient(params: unknown): void {
    this.#paseo = isRecord(params) && isRecord(params.clientInfo) && params.clientInfo.name === "Paseo";
    this.clear();
  }

  present(sessionId: string | undefined, normalized: unknown): unknown {
    if (!this.#paseo || !sessionId || !isRecord(normalized) || !Array.isArray(normalized.configOptions)) return normalized;
    const configOptions: unknown[] = normalized.configOptions;
    const model = configOptions.find(option => isRecord(option) && option.category === "model" && option.type === "select");
    const nativeEffort = configOptions.find(option => isRecord(option) && option.category === "thought_level");
    if (isRecord(nativeEffort)) {
      if (nativeEffort.type === "select" && isEffort(nativeEffort.currentValue)) {
        this.#sessions.set(sessionId, { kind: "native", currentValue: nativeEffort.currentValue });
      } else this.forget(sessionId);
      return normalized;
    }
    const modelId = isRecord(model) ? model.currentValue : undefined;
    if (
      typeof modelId !== "string" || !FIXED_MODEL_IDS.has(modelId) || !isRecord(model) ||
      !Array.isArray(model.options) || !containsChoice(model.options, modelId) ||
      configOptions.some(option => isRecord(option) && option.id === EFFORT_ID)
    ) {
      this.forget(sessionId);
      return normalized;
    }
    // Paseo may skip a saved effort replay when its native startup already had
    // that value. Mirror the last displayed value across the model switch.
    const state: FixedSession = {
      kind: "fixed",
      currentValue: this.#sessions.get(sessionId)?.currentValue ?? "medium",
      configOptions
    };
    this.#sessions.set(sessionId, state);
    return { ...normalized, configOptions: this.#presentOptions(state) };
  }

  apply(sessionId: string | undefined, params: unknown): { configOptions: unknown[] } | undefined {
    if (!sessionId || !isRecord(params) || params.configId !== EFFORT_ID || !isEffort(params.value)) return undefined;
    const state = this.#sessions.get(sessionId);
    if (state?.kind !== "fixed") return undefined;
    state.currentValue = params.value;
    return { configOptions: this.#presentOptions(state) };
  }

  forget(sessionId: string): void { this.#sessions.delete(sessionId); }
  clear(): void { this.#sessions.clear(); }

  #presentOptions(state: FixedSession): unknown[] {
    return [...state.configOptions, {
      type: "select",
      id: EFFORT_ID,
      name: "Thinking level",
      description: "Paseo preference only. The selected official model uses a fixed effort.",
      category: "thought_level",
      currentValue: state.currentValue,
      options: EFFORT_CHOICES.map(value => ({
        value,
        name: value[0].toUpperCase() + value.slice(1)
      }))
    }];
  }
}
