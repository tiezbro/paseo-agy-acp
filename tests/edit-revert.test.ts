import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { hasUniqueOccurrence, revertEditToolCall } from "../src/agy/edit/revert.js";

function diffToolCall(blocks: Array<{ path: string; oldText: string | null; newText: string }>): SessionUpdate {
  return {
    sessionUpdate: "tool_call",
    toolCallId: "x",
    title: "Edit",
    kind: "edit",
    status: "completed",
    content: blocks.map((b) => ({ type: "diff" as const, ...b }))
  } as SessionUpdate;
}

describe("hasUniqueOccurrence", () => {
  it("returns true for exact unique occurrence", () => {
    expect(hasUniqueOccurrence("hello world", "world")).toBe(true);
  });

  it("returns false when string occurs multiple times", () => {
    expect(hasUniqueOccurrence("hello world hello", "hello")).toBe(false);
    expect(hasUniqueOccurrence("repeat repeat", "repeat")).toBe(false);
  });

  it("returns false when string is missing or empty", () => {
    expect(hasUniqueOccurrence("hello world", "foo")).toBe(false);
    expect(hasUniqueOccurrence("hello world", "")).toBe(false);
  });
});

describe("revertEditToolCall", () => {
  it("restores the prior full-file content", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-revert-"));
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "new content", "utf8");

    const restored = revertEditToolCall(diffToolCall([{ path: file, oldText: "old content", newText: "new content" }]));

    expect(fs.readFileSync(file, "utf8")).toBe("old content");
    expect(restored).toEqual([{ path: file, oldText: "old content", newText: "new content" }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reverts a chunked replace by substring", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-revert-"));
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "before\nNEW\nafter", "utf8");

    const restored = revertEditToolCall(diffToolCall([{ path: file, oldText: "OLD", newText: "NEW" }]));

    expect(fs.readFileSync(file, "utf8")).toBe("before\nOLD\nafter");
    expect(restored).toEqual([{ path: file, oldText: "OLD", newText: "NEW" }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves the file alone when newText appears multiple times (ambiguous match, gh#80)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-revert-"));
    const file = path.join(dir, "a.txt");
    const content = "line 1 NEW\nline 2 NEW\nline 3";
    fs.writeFileSync(file, content, "utf8");

    const restored = revertEditToolCall(diffToolCall([{ path: file, oldText: "OLD", newText: "NEW" }]));

    expect(fs.readFileSync(file, "utf8")).toBe(content);
    expect(restored).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("deletes a file that was newly created (oldText null)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-revert-"));
    const file = path.join(dir, "new.txt");
    fs.writeFileSync(file, "created", "utf8");

    const restored = revertEditToolCall(diffToolCall([{ path: file, oldText: null, newText: "created" }]));

    expect(fs.existsSync(file)).toBe(false);
    expect(restored).toEqual([{ path: file, oldText: null, newText: "created" }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("restores only the blocks that still match when several target one file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-revert-"));
    const file = path.join(dir, "a.txt");
    // Block two's newText is gone from disk, so only block one may be restored.
    fs.writeFileSync(file, "one TWO", "utf8");

    const restored = revertEditToolCall(diffToolCall([
      { path: file, oldText: "ONE", newText: "one" },
      { path: file, oldText: "two", newText: "diverged" }
    ]));

    expect(fs.readFileSync(file, "utf8")).toBe("ONE TWO");
    expect(restored).toEqual([{ path: file, oldText: "ONE", newText: "one" }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves the file alone when content has diverged since the edit", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-revert-"));
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "something else entirely", "utf8");

    const restored = revertEditToolCall(diffToolCall([{ path: file, oldText: "old", newText: "new" }]));

    expect(fs.readFileSync(file, "utf8")).toBe("something else entirely");
    expect(restored).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("no-ops when the file no longer exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-revert-"));
    const file = path.join(dir, "gone.txt");

    expect(revertEditToolCall(diffToolCall([{ path: file, oldText: "old", newText: "new" }]))).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
