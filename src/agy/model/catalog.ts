// Model Catalog: resolution, slug helpers, and config options for agy --model and --effort.

import type { SessionConfigOption as V1SessionConfigOption } from "@agentclientprotocol/sdk";

const MODEL_CONFIG_ID = "model";
const REASONING_EFFORT_CONFIG_ID = "reasoningEffort";
export const NO_REASONING_VALUE = "none";

export function defaultReasoningEffortForBase(selectedBaseModel: string, catalog: ModelCatalog): string {
  const effects = catalog.effortsFor(selectedBaseModel);
  return effects[0] ?? NO_REASONING_VALUE;
}
/** Legacy `agy models` lines: `Gemini 3.5 Flash (Medium)`. */
const LEGACY_EFFORT_PATTERN = /\((low|medium|high)\)\s*$/i;
/** Legacy thinking models: `Claude Sonnet 4.6 (Thinking)`. */
const LEGACY_THINKING_PATTERN = /\(thinking\)\s*$/i;
/** Stable slug effort variants from agy ≥1.1.5: `gemini-3.5-flash-medium`. */
const SLUG_EFFORT_PATTERN = /^(.*)-(low|medium|high)$/i;
/** Stable slug thinking models: `claude-opus-4-6-thinking` (not an --effort value). */
const SLUG_THINKING_PATTERN = /-thinking$/i;

export interface ModelCatalog {
  readonly entries: readonly string[];
  baseModels(): string[];
  effortsFor(baseModel: string): string[];
  resolve(baseModel: string, reasoningEffort: string): string;
  split(fullModel: string): { base: string; reasoningEffort?: string };
  /** Map a legacy agy display name (or base slug) to its ACP model slug, if known. */
  slugForAgyBase(agyBase: string): string | undefined;
  /**
   * Value for `agy --model`: base slug (modern) or legacy display base name.
   * Effort is passed separately via `--effort`.
   */
  agyBaseName(slug: string): string;
  /** Human-readable label for the model picker. */
  displayName(slug: string): string;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

export function buildModelCatalog(entries: string[]): ModelCatalog {
  const uniqueEntries = dedupe(entries);
  const baseOrder: string[] = [];
  const effectsByBase = new Map<string, string[]>();
  const agyBaseBySlug = new Map<string, string>();
  const displayNameBySlug = new Map<string, string>();

  for (const entry of uniqueEntries) {
    const { agyBase, base, reasoningEffort, displayBase } = splitModelEntry(entry);
    if (!effectsByBase.has(base)) {
      baseOrder.push(base);
      effectsByBase.set(base, []);
      agyBaseBySlug.set(base, agyBase);
      displayNameBySlug.set(base, displayBase);
    }
    if (reasoningEffort) {
      const effects = effectsByBase.get(base)!;
      if (!effects.includes(reasoningEffort)) {
        effects.push(reasoningEffort);
      }
    }
  }

  return {
    entries: uniqueEntries,
    baseModels: () => baseOrder,
    effortsFor: (baseModel: string) => effectsByBase.get(baseModel) ?? [],
    resolve: (baseModel: string, reasoningEffort: string) => {
      const resolved = uniqueEntries.find((entry) => {
        const parsed = splitModelEntry(entry);
        return parsed.base === baseModel && parsed.reasoningEffort === reasoningEffort;
      });
      if (!resolved) {
        throw new Error(`Unknown model selection: ${baseModel} (${reasoningEffort})`);
      }
      return resolved;
    },
    split: (fullModel: string) => {
      const { base, reasoningEffort } = splitModelEntry(fullModel);
      return { base, reasoningEffort };
    },
    slugForAgyBase: (agyBase: string) => {
      const slug = toModelSlug(agyBase);
      if (agyBaseBySlug.has(slug)) {
        return slug;
      }
      // Stored full variant slug (e.g. gemini-3.5-flash-medium) or display line.
      const fromEntry = splitModelEntry(agyBase);
      return agyBaseBySlug.has(fromEntry.base) ? fromEntry.base : undefined;
    },
    agyBaseName: (slug: string) => {
      const agyBase = agyBaseBySlug.get(slug);
      if (!agyBase) {
        throw new Error(`Unknown model slug: ${slug}`);
      }
      return agyBase;
    },
    displayName: (slug: string) => {
      const name = displayNameBySlug.get(slug);
      if (!name) {
        throw new Error(`Unknown model slug: ${slug}`);
      }
      return name;
    }
  };
}

export function modelConfigOption(selectedBaseModel: string, catalog: ModelCatalog): V1SessionConfigOption {
  return {
    id: MODEL_CONFIG_ID,
    name: "Model",
    description: "ACP model slug passed to agy --model (reasoningEffort is selected separately).",
    category: "model",
    type: "select",
    currentValue: selectedBaseModel,
    options: catalog.baseModels().map((slug) => ({
      value: slug,
      name: catalog.displayName(slug)
    }))
  };
}

export function reasoningEffortConfigOption(
  selectedBaseModel: string,
  selectedReasoningEffort: string,
  catalog: ModelCatalog
): V1SessionConfigOption {
  return {
    id: REASONING_EFFORT_CONFIG_ID,
    name: "Reasoning Effort",
    description: "Value for agy --effort (low | medium | high) for the selected model.",
    category: "thought_level",
    type: "select",
    currentValue: selectedReasoningEffort,
    options: reasoningEffortOptions(selectedBaseModel, catalog)
  };
}

function reasoningEffortOptions(
  selectedBaseModel: string,
  catalog: ModelCatalog
): Array<{ value: string; name: string }> {
  const efforts = catalog.effortsFor(selectedBaseModel);
  if (efforts.length === 0) {
    return [{ value: NO_REASONING_VALUE, name: "N/A" }];
  }
  return efforts.map((effort) => ({
    value: effort,
    name: effort.charAt(0).toUpperCase() + effort.slice(1)
  }));
}

export function reasoningEffortValues(selectedBaseModel: string, catalog: ModelCatalog): string[] {
  return reasoningEffortOptions(selectedBaseModel, catalog).map((option) => option.value);
}

/** Split one `agy models` line into base model + optional effort. */
function splitModelEntry(model: string): {
  agyBase: string;
  base: string;
  displayBase: string;
  reasoningEffort?: string;
} {
  const trimmed = model.trim();

  if (LEGACY_THINKING_PATTERN.test(trimmed)) {
    const base = toModelSlug(trimmed);
    return { agyBase: trimmed, base, displayBase: trimmed };
  }

  const legacyEffort = trimmed.match(LEGACY_EFFORT_PATTERN);
  if (legacyEffort && legacyEffort.index !== undefined) {
    const displayBase = trimmed.slice(0, legacyEffort.index).trim();
    return {
      agyBase: displayBase,
      base: toModelSlug(displayBase),
      displayBase,
      reasoningEffort: legacyEffort[1].toLowerCase()
    };
  }

  if (SLUG_THINKING_PATTERN.test(trimmed)) {
    const base = toModelSlug(trimmed);
    return {
      agyBase: base,
      base,
      displayBase: prettifyModelSlug(base)
    };
  }

  const slugEffort = trimmed.match(SLUG_EFFORT_PATTERN);
  if (slugEffort && isLikelyModelSlug(trimmed)) {
    const base = toModelSlug(slugEffort[1]);
    return {
      agyBase: base,
      base,
      displayBase: prettifyModelSlug(base),
      reasoningEffort: slugEffort[2].toLowerCase()
    };
  }

  const base = toModelSlug(trimmed);
  const looksLikeSlug = isLikelyModelSlug(trimmed) || trimmed === base;
  return {
    agyBase: looksLikeSlug ? base : trimmed,
    base,
    displayBase: looksLikeSlug ? prettifyModelSlug(base) : trimmed
  };
}

export function toModelSlug(model: string): string {
  return model
    .toLowerCase()
    .replace(/[()]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function isLikelyModelSlug(value: string): boolean {
  return /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/i.test(value.trim()) && !/\s/.test(value);
}

export function prettifyModelSlug(slug: string): string {
  const parts = slug.split("-").filter(Boolean);
  const merged: string[] = [];
  for (const part of parts) {
    if (/^\d+$/.test(part) && merged.length > 0 && /^\d+(?:\.\d+)*$/.test(merged[merged.length - 1]!)) {
      merged[merged.length - 1] = `${merged[merged.length - 1]}.${part}`;
      continue;
    }
    if (/^\d+(?:\.\d+)*$/.test(part)) {
      merged.push(part);
      continue;
    }
    if (part.toLowerCase() === "gpt" || part.toLowerCase() === "oss") {
      merged.push(part.toUpperCase());
      continue;
    }
    merged.push(part.charAt(0).toUpperCase() + part.slice(1).toLowerCase());
  }
  return merged.join(" ");
}
