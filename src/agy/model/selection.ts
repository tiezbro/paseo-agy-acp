// Model/reasoning-effort selection math backing the ACP `model` and
// `reasoningEffort` config options: choosing an initial selection, recovering
// a persisted one against the current catalog, and applying a selection onto
// an agy CLI session. No ACP types involved — see acp/session/config-options.ts
// for the config-option wire builders that call into this.

import type { AgyCliSession } from "../cli.js";
import { defaultReasoningEffortForBase, NO_REASONING_VALUE, type ModelCatalog } from "./catalog.js";

export function initialModelSelection(
  configuredModel: string | undefined,
  catalog: ModelCatalog
): { baseModel: string; reasoningEffort: string } {
  if (!configuredModel) {
    const [firstBaseModel] = catalog.baseModels();
    if (!firstBaseModel) {
      throw new Error("No models available. Ensure agy models succeeds.");
    }
    return {
      baseModel: firstBaseModel,
      reasoningEffort: defaultReasoningEffortForBase(firstBaseModel, catalog)
    };
  }

  const { base, reasoningEffort } = catalog.split(configuredModel);
  const effects = catalog.effortsFor(base);
  if (effects.length === 0) {
    return {
      baseModel: base,
      reasoningEffort: NO_REASONING_VALUE
    };
  }

  return {
    baseModel: base,
    reasoningEffort: reasoningEffort && effects.includes(reasoningEffort)
      ? reasoningEffort
      : effects[0]
  };
}

/** Like `initialModelSelection`, but for a persisted choice: falls back to the
 *  default selection if the model no longer appears in the current catalog. */
export function restoredModelSelection(
  storedModel: string,
  storedReasoningEffort: string,
  catalog: ModelCatalog
): { baseModel: string; reasoningEffort: string } {
  const baseModel = normalizeStoredBaseModel(storedModel, catalog);
  if (!baseModel) {
    return initialModelSelection(undefined, catalog);
  }
  const effects = catalog.effortsFor(baseModel);
  if (effects.length === 0) {
    return { baseModel, reasoningEffort: NO_REASONING_VALUE };
  }
  return {
    baseModel,
    reasoningEffort: normalizeStoredReasoningEffort(storedReasoningEffort, effects)
  };
}

function normalizeStoredBaseModel(modelId: string, catalog: ModelCatalog): string | undefined {
  if (catalog.baseModels().includes(modelId)) {
    return modelId;
  }
  return catalog.slugForAgyBase(modelId);
}

function normalizeStoredReasoningEffort(storedEffect: string, effects: string[]): string {
  if (effects.includes(storedEffect)) {
    return storedEffect;
  }
  const lower = storedEffect.toLowerCase();
  if (effects.includes(lower)) {
    return lower;
  }
  const legacyEffects: Record<string, string> = {
    Low: "low",
    Medium: "medium",
    High: "high"
  };
  const mapped = legacyEffects[storedEffect];
  if (mapped && effects.includes(mapped)) {
    return mapped;
  }
  if (storedEffect === "__none__" || storedEffect === NO_REASONING_VALUE) {
    return NO_REASONING_VALUE;
  }
  return effects[0];
}

export function applyModelSelection(
  agy: AgyCliSession,
  selectedBaseModel: string,
  selectedReasoningEffort: string,
  catalog: ModelCatalog
): void {
  // agy ≥1.1.5: --model is the base (slug or legacy display base), --effort is separate.
  agy.setModel(catalog.agyBaseName(selectedBaseModel));

  const effects = catalog.effortsFor(selectedBaseModel);
  if (effects.length === 0) {
    agy.setEffort(undefined);
    return;
  }

  if (selectedReasoningEffort === NO_REASONING_VALUE || !effects.includes(selectedReasoningEffort)) {
    agy.setEffort(effects[0]);
    return;
  }

  agy.setEffort(selectedReasoningEffort);
}
