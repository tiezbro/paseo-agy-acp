// ACP Agent Plan: map agy brain-plan markdown artifacts onto plan session updates.
// Docs: https://agentclientprotocol.com/protocol/v1/agent-plan
//
// agy does not expose a structured plan control plane — only markdown files
// under ~/.gemini/antigravity-cli/brain/**. We surface those as:
//   - v1 classic `sessionUpdate: "plan"` with checklist-style entries
//   - v2 `plan_update` with type "items" (mapped at the protocol boundary)
//
// Entry status is inferred only from checkbox markers in the markdown; there is
// no live task-progress channel from agy, so in-progress/completed only update
// when the plan file itself is rewritten with new markers.

import type { PlanEntry as ACPPlanEntry, PlanEntryPriority, PlanEntryStatus, SessionUpdate } from "@agentclientprotocol/sdk";

export type PlanEntry = ACPPlanEntry & { id?: string };

/** Stable plan id derived from the absolute brain file path. */
export function planIdForPath(targetFile: string): string {
  return `file:${targetFile}`;
}

/**
 * Plan artifact filenames agy writes under `brain/**`. Only these are the
 * checklist-style plan; the brain directory also holds many prose artifacts
 * (`task.md`, `walkthrough.md`, `content.md`, `code_review_*.md`,
 * `*_analysis.md`, ...) that must NOT be shredded into bogus plan entries.
 */
const PLAN_FILENAMES = new Set(["implementation_plan.md", "plan.md"]);

/** True when a write target is an agy brain *plan* artifact (not any brain md). */
export function isPlanFile(targetFile: string): boolean {
  if (
    !targetFile.includes(".gemini") ||
    !targetFile.includes("antigravity-cli") ||
    !targetFile.includes("brain")
  ) {
    return false;
  }
  const base = (targetFile.split(/[\\/]/).pop() ?? "").toLowerCase();
  return PLAN_FILENAMES.has(base);
}

/**
 * Parse markdown list items into ACP plan entries.
 *
 * Recognizes:
 *   - `- [ ] task` / `* [x] task` / `1. [~] task`  (checkbox → status)
 *   - `- task` / `* task` / `1. task`               (plain list → pending)
 *
 * When no list items exist, falls back to a single entry from the first
 * meaningful line (heading stripped).
 */
export function parsePlanEntries(markdown: string): PlanEntry[] {
  const entries: PlanEntry[] = [];
  const contentCounts = new Map<string, number>();
  const usedIds = new Set<string>();

  function makeId(content: string): string {
    const count = contentCounts.get(content) ?? 0;
    contentCounts.set(content, count + 1);
    let occurrence = count;
    let id = entryIdFromContent(content, occurrence);
    // Guarantee uniqueness even under rare 32-bit hash collisions.
    while (usedIds.has(id)) {
      occurrence += 1;
      id = entryIdFromContent(content, occurrence);
    }
    usedIds.add(id);
    return id;
  }

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) continue;

    const checkbox = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX~-])\]\s+(.+)$/.exec(line);
    if (checkbox) {
      const content = checkbox[2].trim();
      if (!content) continue;
      entries.push({
        id: makeId(content),
        content,
        priority: defaultPriority(entries.length),
        status: checkboxStatus(checkbox[1])
      });
      continue;
    }

    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (bullet) {
      const content = bullet[1].trim();
      // Skip nested bullets that are only emphasis or empty after strip.
      if (!content || content === "-" || content === "*") continue;
      // Ignore list markers that are really horizontal rules / separators.
      if (/^[-*_]{3,}$/.test(content)) continue;
      entries.push({
        id: makeId(content),
        content,
        priority: defaultPriority(entries.length),
        status: "pending"
      });
    }
  }

  if (entries.length > 0) return entries;

  const fallback = firstMeaningfulLine(markdown);
  return [
    {
      id: makeId(fallback),
      content: fallback,
      priority: "medium",
      status: "pending"
    }
  ];
}

/**
 * Reconcile freshly parsed entries against the previous snapshot of the same
 * plan so entry IDs preserve task identity across successive list edits.
 * Occurrence-based IDs alone reshuffle when a duplicate task is inserted
 * before an existing one (the new row steals the old row's ID, and an ID-keyed
 * client reads that as reverting the old task and appending a new one).
 *
 * Matching runs most-specific first:
 *   1. same content AND same status — a status-stable duplicate keeps its ID
 *      even when an identical task is inserted before it;
 *   2. same content, any status — a checkbox flip keeps the entry's ID.
 * Rows with no previous counterpart get a fresh content-hash ID, bumped until
 * unique against every ID already claimed in this snapshot.
 */
export function reconcilePlanEntryIds(
  previous: readonly PlanEntry[] | undefined,
  next: PlanEntry[]
): PlanEntry[] {
  if (!previous || previous.length === 0) return next;

  const remaining = previous.filter((p) => typeof p.id === "string" && p.id.length > 0);
  const unmatched = new Set(next);

  const claim = (entry: PlanEntry, withStatus: boolean): void => {
    const idx = remaining.findIndex(
      (p) => p.content === entry.content && (!withStatus || p.status === entry.status)
    );
    if (idx === -1) return;
    const [matched] = remaining.splice(idx, 1);
    entry.id = matched.id;
    unmatched.delete(entry);
  };

  for (const entry of [...unmatched]) claim(entry, true);
  for (const entry of [...unmatched]) claim(entry, false);

  // Fresh rows: re-derive IDs so a claimed duplicate's original occurrence
  // hash cannot collide with a new row's.
  const used = new Set(next.filter((e) => !unmatched.has(e)).map((e) => e.id as string));
  for (const entry of next) {
    if (!unmatched.has(entry)) continue;
    let occurrence = 0;
    let id = entryIdFromContent(entry.content, occurrence);
    while (used.has(id)) {
      occurrence += 1;
      id = entryIdFromContent(entry.content, occurrence);
    }
    entry.id = id;
    used.add(id);
  }
  return next;
}

/** Build a classic ACP v1 `plan` session update from plan markdown. */
export function planUpdateFromMarkdown(
  targetFile: string,
  markdown: string,
  previous?: readonly PlanEntry[]
): SessionUpdate {
  const entries = reconcilePlanEntryIds(previous, parsePlanEntries(markdown));
  // Stash path for v2 planId mapping / progressive snapshot keys without
  // inventing a non-schema field on the wire — clients ignore unknown keys? 
  // Actually ACP forbids assumptions on unknown keys but _meta is reserved.
  // Use _meta for agent-side mapping only; strip at boundary if needed.
  return {
    sessionUpdate: "plan",
    entries,
    _meta: {
      "agy-acp/planId": planIdForPath(targetFile),
      "agy-acp/planPath": targetFile,
      "agy-acp/planMarkdown": markdown
    }
  } as SessionUpdate;
}

/** Build an ACP `plan_removed` session update when plan artifact is cleared/deleted. */
export function planRemovedFromPath(targetFile: string): SessionUpdate {
  return {
    sessionUpdate: "plan_removed",
    planId: planIdForPath(targetFile),
    _meta: {
      "agy-acp/planId": planIdForPath(targetFile),
      "agy-acp/planPath": targetFile
    }
  } as SessionUpdate;
}

function checkboxStatus(mark: string): PlanEntryStatus {
  const m = mark.toLowerCase();
  if (m === "x") return "completed";
  if (m === "~" || m === "-") return "in_progress";
  return "pending";
}

function defaultPriority(index: number): PlanEntryPriority {
  // First few items are typically the critical path; rest medium.
  return index < 3 ? "high" : "medium";
}

function firstMeaningfulLine(markdown: string): string {
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Strip ATX headings.
    const withoutHeading = line.replace(/^#{1,6}\s+/, "").trim();
    if (withoutHeading) return withoutHeading.slice(0, 500);
  }
  return "Plan";
}

/**
 * Derive a stable entry ID from the entry's text content and occurrence index.
 * Occurrence is mixed in as a separate hash domain (not string-concatenated
 * onto the content) so a second `A` cannot collide with a first `A#1`.
 * Duplicate plan rows stay distinct; reordering of unique text keeps identity.
 */
function entryIdFromContent(content: string, occurrence = 0): string {
  let hash = 5381;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) + hash + content.charCodeAt(i)) | 0;
  }
  // Domain separator + occurrence so content never collides with a synthetic key.
  hash = ((hash << 5) + hash + 0) | 0;
  hash = ((hash << 5) + hash + occurrence) | 0;
  // Convert to unsigned hex for a short, URL-safe id.
  return `entry_${(hash >>> 0).toString(16)}`;
}
