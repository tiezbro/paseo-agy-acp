import { describe, expect, it } from "vitest";
import {
  isPlanFile,
  parsePlanEntries,
  planIdForPath,
  planRemovedFromPath,
  planUpdateFromMarkdown,
  reconcilePlanEntryIds,
  type PlanEntry
} from "../src/agy/acp/agent-plan/index.js";

describe("isPlanFile", () => {
  it("matches agy brain markdown paths", () => {
    expect(
      isPlanFile(
        "/Users/me/.gemini/antigravity-cli/brain/abc/.system_generated/steps/1/implementation_plan.md"
      )
    ).toBe(true);
  });

  it("rejects ordinary project files", () => {
    expect(isPlanFile("/repo/docs/plan.md")).toBe(false);
    expect(isPlanFile("/Users/me/.gemini/antigravity-cli/brain/x/note.txt")).toBe(false);
  });

  it("rejects non-plan brain markdown artifacts", () => {
    const base = "/Users/me/.gemini/antigravity-cli/brain/abc";
    expect(isPlanFile(`${base}/code_review_v0.3.3.md`)).toBe(false);
    expect(isPlanFile(`${base}/walkthrough.md`)).toBe(false);
    expect(isPlanFile(`${base}/task.md`)).toBe(false);
    expect(isPlanFile(`${base}/content.md`)).toBe(false);
    expect(isPlanFile(`${base}/comparison_analysis.md`)).toBe(false);
  });
});

describe("parsePlanEntries", () => {
  it("parses numbered and bulleted items with stable content-hash ids", () => {
    const entries = parsePlanEntries("# Plan\n\n1. First\n2. Second\n- Third\n");
    expect(entries.map((e) => e.content)).toEqual(["First", "Second", "Third"]);
    // IDs are content-hash-based, not ordinal
    for (const e of entries) {
      expect((e as Record<string, unknown>).id).toMatch(/^entry_[0-9a-f]+$/);
    }
  });

  it("maps checkbox markers to status with content-hash ids", () => {
    const entries = parsePlanEntries("- [ ] open\n- [x] done\n- [~] mid\n- [X] DONE2\n");
    expect(entries).toMatchObject([
      { content: "open", priority: "high", status: "pending" },
      { content: "done", priority: "high", status: "completed" },
      { content: "mid", priority: "high", status: "in_progress" },
      { content: "DONE2", priority: "medium", status: "completed" }
    ]);
    // Each entry has a content-hash id
    for (const e of entries) {
      expect((e as Record<string, unknown>).id).toMatch(/^entry_[0-9a-f]+$/);
    }
  });

  it("preserves entry identity when items are reordered", () => {
    const before = parsePlanEntries("- [ ] alpha\n- [x] beta\n");
    const after = parsePlanEntries("- [x] beta\n- [ ] alpha\n");
    const idOf = (e: Record<string, unknown>) => e.id;
    // alpha keeps same id regardless of position
    expect(idOf(before[0] as Record<string, unknown>)).toBe(
      idOf(after[1] as Record<string, unknown>)
    );
    // beta keeps same id regardless of position
    expect(idOf(before[1] as Record<string, unknown>)).toBe(
      idOf(after[0] as Record<string, unknown>)
    );
  });

  it("assigns distinct entry IDs to duplicate task text", () => {
    const entries = parsePlanEntries("- [ ] Run tests\n- [ ] Build\n- [ ] Run tests\n");
    const ids = entries.map((e) => (e as Record<string, unknown>).id);
    expect(ids[0]).not.toBe(ids[2]);
    expect(new Set(ids).size).toBe(3);
  });

  it("keeps IDs unique when content matches an occurrence-style suffix", () => {
    // Second "A" must not collide with a first-occurrence literal "A#1".
    const entries = parsePlanEntries("- [ ] A\n- [ ] A\n- [ ] A#1\n");
    const ids = entries.map((e) => (e as Record<string, unknown>).id as string);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it("falls back to the first heading when there is no list", () => {
    const entries = parsePlanEntries("# Ship the feature\n\nSome prose only.\n");
    expect(entries).toMatchObject([
      { content: "Ship the feature", priority: "medium", status: "pending" }
    ]);
    expect((entries[0] as Record<string, unknown>).id).toMatch(/^entry_[0-9a-f]+$/);
  });
});

describe("reconcilePlanEntryIds", () => {
  const idOf = (e: PlanEntry) => e.id as string;

  it("keeps a completed duplicate's id when an identical task is inserted before it", () => {
    // Regression: occurrence-only ids reassigned the old row's id to the new row.
    const before = parsePlanEntries("- [x] Deploy\n");
    const after = reconcilePlanEntryIds(before, parsePlanEntries("- [ ] Deploy\n- [x] Deploy\n"));
    expect(after).toMatchObject([
      { content: "Deploy", status: "pending" },
      { content: "Deploy", status: "completed" }
    ]);
    // The existing completed row keeps its id; the inserted pending row is fresh.
    expect(idOf(after[1])).toBe(idOf(before[0]));
    expect(idOf(after[0])).not.toBe(idOf(before[0]));
    expect(new Set(after.map(idOf)).size).toBe(2);
  });

  it("keeps entry ids when a checkbox flips", () => {
    const before = parsePlanEntries("- [ ] alpha\n- [ ] beta\n");
    const after = reconcilePlanEntryIds(before, parsePlanEntries("- [x] alpha\n- [ ] beta\n"));
    expect(after.map(idOf)).toEqual(before.map(idOf));
    expect(after[0].status).toBe("completed");
  });

  it("keeps the surviving duplicate's id when one copy is removed", () => {
    const before = parsePlanEntries("- [ ] A\n- [ ] A\n");
    const after = reconcilePlanEntryIds(before, parsePlanEntries("- [ ] A\n"));
    expect(idOf(after[0])).toBe(idOf(before[0]));
  });

  it("keeps all ids unique when fresh duplicates join claimed rows", () => {
    const before = parsePlanEntries("- [ ] A\n- [ ] A\n");
    const after = reconcilePlanEntryIds(before, parsePlanEntries("- [ ] A\n- [ ] A\n- [ ] A\n"));
    expect(after.slice(0, 2).map(idOf)).toEqual(before.map(idOf));
    expect(new Set(after.map(idOf)).size).toBe(3);
  });

  it("matches a fresh parse when there is no previous snapshot", () => {
    const md = "- [ ] A\n- [ ] A\n- [x] B\n";
    const reconciled = reconcilePlanEntryIds(undefined, parsePlanEntries(md));
    expect(reconciled.map(idOf)).toEqual(parsePlanEntries(md).map(idOf));
  });
});

describe("planUpdateFromMarkdown & planRemovedFromPath", () => {
  it("builds a classic plan update with stable meta and entry ids", () => {
    const path = "/Users/me/.gemini/antigravity-cli/brain/c/plan.md";
    const md = "1. A\n2. B\n";
    const update = planUpdateFromMarkdown(path, md) as {
      sessionUpdate: string;
      entries: unknown[];
      _meta?: Record<string, unknown>;
    };
    expect(update.sessionUpdate).toBe("plan");
    expect(update.entries).toHaveLength(2);
    expect(update._meta?.["agy-acp/planId"]).toBe(planIdForPath(path));
    expect(update._meta?.["agy-acp/planMarkdown"]).toBe(md);
  });

  it("reconciles entry ids against a previous snapshot when given one", () => {
    const path = "/Users/me/.gemini/antigravity-cli/brain/c/plan.md";
    const first = planUpdateFromMarkdown(path, "- [x] Deploy\n") as unknown as { entries: PlanEntry[] };
    const second = planUpdateFromMarkdown(path, "- [ ] Deploy\n- [x] Deploy\n", first.entries) as unknown as {
      entries: PlanEntry[];
    };
    // Inserted pending duplicate gets a fresh id; the completed row keeps its own.
    expect(second.entries[1].id).toBe(first.entries[0].id);
    expect(second.entries[0].id).not.toBe(first.entries[0].id);
  });

  it("builds a plan_removed update for empty/deleted plans", () => {
    const path = "/Users/me/.gemini/antigravity-cli/brain/c/plan.md";
    const update = planRemovedFromPath(path) as {
      sessionUpdate: string;
      planId: string;
      _meta?: Record<string, unknown>;
    };
    expect(update.sessionUpdate).toBe("plan_removed");
    expect(update.planId).toBe(planIdForPath(path));
    expect(update._meta?.["agy-acp/planId"]).toBe(planIdForPath(path));
  });
});
