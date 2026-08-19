import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_TEXT_BYTES,
  buildReconcileEditUpdate,
  isValidUtf8,
  observeEditedPaths,
  reconcileWorkingTree,
  snapshotWorkingTree,
  type WorkingTreeSnapshot
} from "../ACP Connector/agy/edit/reconcile.js";
import { diffBlocks } from "../ACP Connector/agy/edit/revert.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-reconcile-"));
}

function gitRepo(): string {
  const dir = tmpDir();
  execFileSync("git", ["-C", dir, "init", "-q"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "t@t"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "t"]);
  return dir;
}

/** Absolute path each snapshot entry would emit, in listing order. */
function emittedPaths(snapshot: WorkingTreeSnapshot): string[] {
  return [...snapshot.files.values()].map((file) => file.path);
}

describe("reconcileWorkingTree", () => {
  it("reflects a modified tracked file with the pre-edit content as oldText", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "before", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(file, "after", "utf8");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline);
    expect(unsupported).toEqual([]);
    expect(reflected).toEqual([{ path: file, oldText: "before", newText: "after" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reflects a newly created untracked file with oldText null", async () => {
    const dir = gitRepo();
    const baseline = await snapshotWorkingTree([dir]);
    const file = path.join(dir, "new.txt");
    fs.writeFileSync(file, "created", "utf8");

    const { reflected } = await reconcileWorkingTree(baseline);
    expect(reflected).toEqual([{ path: file, oldText: null, newText: "created" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not re-emit a path whose reported content was observed", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "before", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(file, "after-structured", "utf8");
    await observeEditedPaths(baseline, [{ path: file }]);

    expect(await reconcileWorkingTree(baseline)).toEqual({ reflected: [], unsupported: [] });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("still reflects a later unstructured change after a recognized edit on the same path", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "before", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(file, "structured", "utf8");
    await observeEditedPaths(baseline, [{ path: file }]);
    fs.writeFileSync(file, "shell", "utf8");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline);
    expect(unsupported).toEqual([]);
    expect(reflected).toEqual([{ path: file, oldText: "structured", newText: "shell" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a whole-file write whose reported oldText never existed pre-turn", async () => {
    // A shell command changed the file before the write completed, so the
    // reported oldText ("shell") is not the pre-turn text. The reported body is
    // the whole file and equals disk, so nothing unreported survives and no
    // second, contradictory before→final edit is emitted.
    const dir = gitRepo();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "before", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(file, "shell", "utf8");
    fs.writeFileSync(file, "final", "utf8");
    await observeEditedPaths(baseline, [
      { path: file, wholeFile: true, blocks: [{ oldText: "shell", newText: "final" }] }
    ]);

    expect(await reconcileWorkingTree(baseline)).toEqual({ reflected: [], unsupported: [] });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a replacement that accounts for every difference on disk", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "alpha\nOLD\nomega\n", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(file, "alpha\nNEW\nomega\n", "utf8");
    await observeEditedPaths(baseline, [{ path: file, blocks: [{ oldText: "OLD", newText: "NEW" }] }]);

    expect(await reconcileWorkingTree(baseline)).toEqual({ reflected: [], unsupported: [] });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reflects a later edit outside the reported replacement", async () => {
    // A formatter (or shell command) rewrote another section before the
    // tool-call was polled. Disk still contains the reported snippet, but the
    // rest of the file changed too, so the surviving content must be reported.
    const dir = gitRepo();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "alpha\nOLD\nomega\n", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(file, "ALPHA\nNEW\nomega\n", "utf8");
    await observeEditedPaths(baseline, [{ path: file, blocks: [{ oldText: "OLD", newText: "NEW" }] }]);

    const { reflected, unsupported } = await reconcileWorkingTree(baseline);
    expect(unsupported).toEqual([]);
    expect(reflected).toEqual([
      { path: file, oldText: "alpha\nOLD\nomega\n", newText: "ALPHA\nNEW\nomega\n" }
    ]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not accept an empty replacement target as accounting for any file", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "before", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(file, "changed by shell", "utf8");
    await observeEditedPaths(baseline, [{ path: file, blocks: [{ oldText: "", newText: "" }] }]);

    const { reflected } = await reconcileWorkingTree(baseline);
    expect(reflected).toEqual([{ path: file, oldText: "before", newText: "changed by shell" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves a path the reported edit no longer accounts for to reconciliation", async () => {
    // The reported target is gone from disk, so this update never told the
    // client what the file now holds: reconciliation still has to.
    const dir = gitRepo();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "before", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(file, "overwritten by shell", "utf8");
    await observeEditedPaths(baseline, [
      { path: file, blocks: [{ oldText: "structured", newText: "changed" }] }
    ]);

    const { reflected, unsupported } = await reconcileWorkingTree(baseline);
    expect(unsupported).toEqual([]);
    expect(reflected).toEqual([{ path: file, oldText: "before", newText: "overwritten by shell" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps reporting a deletion when the reported edit did not cause it", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "before", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.rmSync(file);
    await observeEditedPaths(baseline, [
      { path: file, blocks: [{ oldText: "before", newText: "structured" }] }
    ]);

    const { reflected, unsupported } = await reconcileWorkingTree(baseline);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([{ path: file, reason: "deleted" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("re-observing a reverted edit does not report the restoration as a change", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "before", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(file, "edited", "utf8");
    await observeEditedPaths(baseline, [{ path: file }]);
    // Local review rejected the edit: revert put the pre-edit text back.
    fs.writeFileSync(file, "before", "utf8");
    await observeEditedPaths(baseline, [{ path: file }]);

    expect(await reconcileWorkingTree(baseline)).toEqual({ reflected: [], unsupported: [] });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ignores gitignored files", async () => {
    const dir = gitRepo();
    fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(path.join(dir, "ignored.txt"), "secret", "utf8");

    expect(await reconcileWorkingTree(baseline)).toEqual({ reflected: [], unsupported: [] });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not invent a creation when removing an ignore rule exposes an existing file", async () => {
    const dir = gitRepo();
    const ignoreFile = path.join(dir, ".gitignore");
    const ignoredFile = path.join(dir, "ignored.txt");
    fs.writeFileSync(ignoreFile, "ignored.txt\n", "utf8");
    fs.writeFileSync(ignoredFile, "pre-existing", "utf8");
    execFileSync("git", ["-C", dir, "add", ".gitignore"]);

    const baseline = await snapshotWorkingTree([dir]);
    expect(emittedPaths(baseline)).not.toContain(ignoredFile);
    expect(baseline.excluded).toContain(ignoredFile);
    fs.writeFileSync(ignoreFile, "", "utf8");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline);
    expect(reflected).toEqual([{ path: ignoreFile, oldText: "ignored.txt\n", newText: "" }]);
    expect(unsupported).toEqual([{ path: ignoredFile, reason: "previously-excluded" }]);
    expect(fs.readFileSync(ignoredFile, "utf8")).toBe("pre-existing");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps pre-turn exclusions intact after observing a structured ignore-rule edit", async () => {
    const dir = gitRepo();
    const ignoreFile = path.join(dir, ".gitignore");
    const ignoredFile = path.join(dir, "ignored.txt");
    fs.writeFileSync(ignoreFile, "ignored.txt\n", "utf8");
    fs.writeFileSync(ignoredFile, "pre-existing", "utf8");
    execFileSync("git", ["-C", dir, "add", ".gitignore"]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(ignoreFile, "", "utf8");
    await observeEditedPaths(baseline, [{ path: ignoreFile }]);

    const { reflected, unsupported } = await reconcileWorkingTree(baseline);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([{ path: ignoredFile, reason: "previously-excluded" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("still reflects an unrelated creation when ignore rules also change", async () => {
    const dir = gitRepo();
    const ignoreFile = path.join(dir, ".gitignore");
    const createdFile = path.join(dir, "src", "new.ts");
    fs.writeFileSync(ignoreFile, "", "utf8");
    execFileSync("git", ["-C", dir, "add", ".gitignore"]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(ignoreFile, "dist/\n", "utf8");
    fs.mkdirSync(path.dirname(createdFile), { recursive: true });
    fs.writeFileSync(createdFile, "export {};\n", "utf8");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline);
    expect(reflected).toHaveLength(2);
    expect(reflected).toEqual(expect.arrayContaining([
      { path: ignoreFile, oldText: "", newText: "dist/\n" },
      { path: createdFile, oldText: null, newText: "export {};\n" }
    ]));
    expect(unsupported).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not report a baseline file as deleted when a new ignore rule hides it", async () => {
    const dir = gitRepo();
    const ignoreFile = path.join(dir, ".gitignore");
    const file = path.join(dir, "later-ignored.txt");
    fs.writeFileSync(ignoreFile, "", "utf8");
    fs.writeFileSync(file, "unchanged", "utf8");
    execFileSync("git", ["-C", dir, "add", ".gitignore"]);

    const baseline = await snapshotWorkingTree([dir]);
    expect(emittedPaths(baseline)).toContain(file);
    fs.writeFileSync(ignoreFile, "later-ignored.txt\n", "utf8");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline);
    expect(reflected).toEqual([{ path: ignoreFile, oldText: "", newText: "later-ignored.txt\n" }]);
    expect(unsupported).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reflects a change to a file a new ignore rule hides", async () => {
    const dir = gitRepo();
    const ignoreFile = path.join(dir, ".gitignore");
    const file = path.join(dir, "later-ignored.txt");
    fs.writeFileSync(ignoreFile, "", "utf8");
    fs.writeFileSync(file, "before", "utf8");
    execFileSync("git", ["-C", dir, "add", ".gitignore"]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(ignoreFile, "later-ignored.txt\n", "utf8");
    fs.writeFileSync(file, "after", "utf8");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline);
    expect(unsupported).toEqual([]);
    expect(reflected).toEqual(expect.arrayContaining([
      { path: ignoreFile, oldText: "", newText: "later-ignored.txt\n" },
      { path: file, oldText: "before", newText: "after" }
    ]));

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports a binary change as unsupported instead of diffing it", async () => {
    const dir = gitRepo();
    const baseline = await snapshotWorkingTree([dir]);
    const file = path.join(dir, "blob.bin");
    fs.writeFileSync(file, Buffer.from([0x00, 0x01, 0x02, 0x00]));

    const { reflected, unsupported } = await reconcileWorkingTree(baseline);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([{ path: file, reason: "binary" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports invalid UTF-8 (NUL-free) as binary, not as text", async () => {
    const dir = gitRepo();
    const baseline = await snapshotWorkingTree([dir]);
    const file = path.join(dir, "bad.bin");
    // Lone 0xff is not valid UTF-8 and has no NUL — text write-through would
    // rewrite it as U+FFFD.
    fs.writeFileSync(file, Buffer.from([0xff]));

    expect(isValidUtf8(Buffer.from([0xff]))).toBe(false);
    const { reflected, unsupported } = await reconcileWorkingTree(baseline);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([{ path: file, reason: "binary" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports a binary-to-text replacement as unsupported, not as a create", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "blob.bin");
    fs.writeFileSync(file, Buffer.from([0x00, 0x01]));
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    expect(baseline.files.get(fs.realpathSync(file))?.text).toBeNull();
    fs.writeFileSync(file, "now text", "utf8");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([{ path: file, reason: "binary" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports an oversized change as unsupported", async () => {
    const dir = gitRepo();
    const baseline = await snapshotWorkingTree([dir]);
    const file = path.join(dir, "big.txt");
    fs.writeFileSync(file, "a".repeat(MAX_TEXT_BYTES + 1), "utf8");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([{ path: file, reason: "oversized" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not buffer an oversized baseline file into memory as text", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "huge.bin");
    fs.writeFileSync(file, Buffer.alloc(MAX_TEXT_BYTES + 1, 1));
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    const record = baseline.files.get(fs.realpathSync(file));
    expect(record).toBeDefined();
    expect(record!.text).toBeNull();
    expect(record!.size).toBe(MAX_TEXT_BYTES + 1);
    expect(record!.sha1.startsWith("oversized:")).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("detects an oversized same-size replacement even when mtime is preserved", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "huge.bin");
    fs.writeFileSync(file, Buffer.alloc(MAX_TEXT_BYTES + 1, 1));
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    const originalTimes = fs.statSync(file);
    fs.writeFileSync(file, Buffer.alloc(MAX_TEXT_BYTES + 1, 2));
    fs.utimesSync(file, originalTimes.atime, originalTimes.mtime);

    const { reflected, unsupported } = await reconcileWorkingTree(baseline);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([{ path: file, reason: "oversized" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("attributes an oversized whole-file write by digest instead of warning about it", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "big.txt");
    fs.writeFileSync(file, "a".repeat(MAX_TEXT_BYTES + 1), "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    const written = "b".repeat(MAX_TEXT_BYTES + 1);
    fs.writeFileSync(file, written, "utf8");
    await observeEditedPaths(baseline, [
      { path: file, wholeFile: true, blocks: [{ oldText: null, newText: written }] }
    ]);

    // The client was told the whole body, so there is nothing left to warn
    // about even though the file is too large to diff.
    expect(await reconcileWorkingTree(baseline)).toEqual({ reflected: [], unsupported: [] });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("still warns about an oversized file the reported write does not account for", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "big.txt");
    fs.writeFileSync(file, "a".repeat(MAX_TEXT_BYTES + 1), "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(file, "b".repeat(MAX_TEXT_BYTES + 1), "utf8");
    await observeEditedPaths(baseline, [
      { path: file, wholeFile: true, blocks: [{ oldText: null, newText: "not what is on disk" }] }
    ]);

    const { reflected, unsupported } = await reconcileWorkingTree(baseline);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([{ path: file, reason: "oversized" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports a deleted file as unsupported", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "a.txt");
    fs.writeFileSync(file, "before", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.rmSync(file);

    const { reflected, unsupported } = await reconcileWorkingTree(baseline);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([{ path: file, reason: "deleted" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves unchanged files alone", async () => {
    const dir = gitRepo();
    fs.writeFileSync(path.join(dir, "a.txt"), "same", "utf8");
    execFileSync("git", ["-C", dir, "add", "."]);

    const baseline = await snapshotWorkingTree([dir]);
    expect(await reconcileWorkingTree(baseline)).toEqual({ reflected: [], unsupported: [] });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("works for a non-git root via the recursive-walk fallback", async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "node_modules"));
    fs.writeFileSync(path.join(dir, "node_modules", "dep.js"), "vendor", "utf8");

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(path.join(dir, "src.txt"), "hello", "utf8");
    // A change under node_modules must be skipped by the walk.
    fs.writeFileSync(path.join(dir, "node_modules", "dep.js"), "changed", "utf8");

    const { reflected } = await reconcileWorkingTree(baseline);
    expect(reflected).toEqual([{ path: path.join(dir, "src.txt"), oldText: null, newText: "hello" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("ignores observed paths outside the configured roots", async () => {
    const dir = gitRepo();
    const outside = tmpDir();
    const file = path.join(outside, "structured.txt");
    fs.writeFileSync(file, "created", "utf8");

    const baseline = await snapshotWorkingTree([dir]);
    await observeEditedPaths(baseline, [{ path: file }]);
    expect(baseline.files.size).toBe(0);
    fs.rmSync(file);

    expect(await reconcileWorkingTree(baseline)).toEqual({ reflected: [], unsupported: [] });

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "ignores files a root retargeted mid-turn exposes from outside the workspace",
    async () => {
      const dir = gitRepo();
      const extraRoot = tmpDir();
      const outside = tmpDir();
      fs.writeFileSync(path.join(outside, "secret.txt"), "outside secret", "utf8");

      const baseline = await snapshotWorkingTree([dir, extraRoot]);
      // The additional root is replaced by a symlink pointing out of the
      // workspace; its listing now reaches files no root ever contained.
      fs.rmSync(extraRoot, { recursive: true });
      fs.symlinkSync(outside, extraRoot, "dir");

      expect(await reconcileWorkingTree(baseline)).toEqual({ reflected: [], unsupported: [] });
      expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("outside secret");

      fs.rmSync(extraRoot, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  );

  it("reports deletion of an in-root file created by a structured edit", async () => {
    const dir = gitRepo();
    const createdDir = path.join(dir, "created");
    const file = path.join(createdDir, "structured.txt");
    const baseline = await snapshotWorkingTree([dir]);
    fs.mkdirSync(createdDir);
    fs.writeFileSync(file, "created", "utf8");
    await observeEditedPaths(baseline, [{ path: file }]);
    fs.rmSync(createdDir, { recursive: true });

    const { reflected, unsupported } = await reconcileWorkingTree(baseline);
    expect(reflected).toEqual([]);
    expect(unsupported).toEqual([{ path: file, reason: "deleted" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not report a surviving ignored structured creation as deleted", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "ignored.txt");
    fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n", "utf8");
    execFileSync("git", ["-C", dir, "add", ".gitignore"]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(file, "created", "utf8");
    await observeEditedPaths(baseline, [{ path: file }]);

    expect(await reconcileWorkingTree(baseline)).toEqual({ reflected: [], unsupported: [] });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reflects a later change to an ignored file a structured edit created", async () => {
    const dir = gitRepo();
    const file = path.join(dir, "ignored.txt");
    fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n", "utf8");
    execFileSync("git", ["-C", dir, "add", ".gitignore"]);

    const baseline = await snapshotWorkingTree([dir]);
    fs.writeFileSync(file, "created", "utf8");
    await observeEditedPaths(baseline, [{ path: file }]);
    fs.writeFileSync(file, "changed by shell", "utf8");

    const { reflected, unsupported } = await reconcileWorkingTree(baseline);
    expect(unsupported).toEqual([]);
    expect(reflected).toEqual([{ path: file, oldText: "created", newText: "changed by shell" }]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not follow a tracked symlink to a directory", async () => {
    const dir = gitRepo();
    const outside = tmpDir();
    fs.writeFileSync(path.join(outside, "secret.txt"), "nope", "utf8");
    fs.symlinkSync(outside, path.join(dir, "linkdir"));
    execFileSync("git", ["-C", dir, "add", "-A"]);

    const baseline = await snapshotWorkingTree([dir]);
    expect(emittedPaths(baseline).some((p) => p.includes("secret.txt"))).toBe(false);
    expect(emittedPaths(baseline)).not.toContain(path.join(dir, "linkdir"));

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it.skipIf(process.platform === "win32")(
    "deduplicates workspace roots that alias the same checkout",
    async () => {
      const dir = gitRepo();
      const aliasParent = tmpDir();
      const alias = path.join(aliasParent, "alias");
      fs.symlinkSync(dir, alias, "dir");
      const file = path.join(dir, "a.txt");
      const aliasedFile = path.join(alias, "a.txt");
      fs.writeFileSync(file, "before", "utf8");
      execFileSync("git", ["-C", dir, "add", "."]);

      // Keep the first spelling (cwd) while deduplicating by physical root.
      const baseline = await snapshotWorkingTree([alias, dir]);
      expect(baseline.roots).toHaveLength(1);
      expect(emittedPaths(baseline)).toEqual([aliasedFile]);
      fs.writeFileSync(file, "after", "utf8");
      // A structured tool may report the canonical absolute path even though
      // the workspace scan retained the cwd alias.
      await observeEditedPaths(baseline, [{ path: file }]);

      expect(await reconcileWorkingTree(baseline)).toEqual({ reflected: [], unsupported: [] });

      fs.rmSync(aliasParent, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  );

  it.skipIf(process.platform === "win32")(
    "deduplicates files shared by overlapping aliased roots",
    async () => {
      const dir = gitRepo();
      const subdir = path.join(dir, "subdir");
      const aliasParent = tmpDir();
      const alias = path.join(aliasParent, "alias");
      fs.mkdirSync(subdir);
      fs.symlinkSync(subdir, alias, "dir");
      const file = path.join(subdir, "a.txt");
      const aliasedFile = path.join(alias, "a.txt");
      fs.writeFileSync(file, "before", "utf8");
      execFileSync("git", ["-C", dir, "add", "."]);

      const baseline = await snapshotWorkingTree([alias, dir]);
      expect(emittedPaths(baseline).filter((p) => p.endsWith("a.txt"))).toEqual([aliasedFile]);
      fs.writeFileSync(file, "after", "utf8");

      const { reflected, unsupported } = await reconcileWorkingTree(baseline);
      expect(unsupported).toEqual([]);
      expect(reflected).toEqual([{ path: aliasedFile, oldText: "before", newText: "after" }]);

      fs.rmSync(aliasParent, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  );

  it.skipIf(process.platform === "win32")(
    "aligns structured creations with the retained alias spelling",
    async () => {
      const dir = gitRepo();
      const subdir = path.join(dir, "subdir");
      const aliasParent = tmpDir();
      const alias = path.join(aliasParent, "alias");
      fs.mkdirSync(subdir);
      fs.symlinkSync(subdir, alias, "dir");
      const file = path.join(subdir, "new.txt");
      const aliasedFile = path.join(alias, "new.txt");
      const baseline = await snapshotWorkingTree([alias, dir]);
      fs.writeFileSync(file, "structured", "utf8");
      await observeEditedPaths(baseline, [{ path: file }]);

      expect(await reconcileWorkingTree(baseline)).toEqual({ reflected: [], unsupported: [] });

      fs.writeFileSync(file, "later", "utf8");
      const { reflected, unsupported } = await reconcileWorkingTree(baseline);
      expect(unsupported).toEqual([]);
      expect(reflected).toEqual([{ path: aliasedFile, oldText: "structured", newText: "later" }]);

      fs.rmSync(aliasParent, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  );

  it.skipIf(process.platform === "win32")(
    "matches ignore-rule exposure across a symlinked root and its canonical parent",
    async () => {
      const dir = gitRepo();
      const subdir = path.join(dir, "subdir");
      const aliasParent = tmpDir();
      const alias = path.join(aliasParent, "alias");
      const ignoreFile = path.join(dir, ".gitignore");
      const hidden = path.join(subdir, "hidden.txt");
      fs.mkdirSync(subdir);
      fs.symlinkSync(subdir, alias, "dir");
      fs.writeFileSync(ignoreFile, "subdir/hidden.txt\n", "utf8");
      fs.writeFileSync(hidden, "pre-existing", "utf8");
      execFileSync("git", ["-C", dir, "add", ".gitignore"]);

      // cwd is the symlinked subdirectory; the extra root is its canonical parent.
      const baseline = await snapshotWorkingTree([alias, dir]);
      expect(emittedPaths(baseline).some((p) => p.endsWith("hidden.txt"))).toBe(false);
      fs.writeFileSync(ignoreFile, "", "utf8");

      const { reflected, unsupported } = await reconcileWorkingTree(baseline);
      expect(reflected).toEqual([{ path: ignoreFile, oldText: "subdir/hidden.txt\n", newText: "" }]);
      expect(unsupported).toEqual([{ path: path.join(alias, "hidden.txt"), reason: "previously-excluded" }]);
      expect(fs.readFileSync(hidden, "utf8")).toBe("pre-existing");

      fs.rmSync(aliasParent, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  );

  it.skipIf(process.platform === "win32")(
    "ignores a structured path that resolves outside the roots through a symlink",
    async () => {
      const dir = gitRepo();
      const outside = tmpDir();
      const link = path.join(dir, "link");
      const file = path.join(link, "outside.txt");
      fs.symlinkSync(outside, link, "dir");
      const baseline = await snapshotWorkingTree([dir]);
      fs.writeFileSync(file, "created", "utf8");
      await observeEditedPaths(baseline, [{ path: file }]);
      fs.rmSync(file);
      fs.unlinkSync(link);

      expect(await reconcileWorkingTree(baseline)).toEqual({ reflected: [], unsupported: [] });

      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  );

  it.skipIf(process.platform === "win32")(
    "reports an in-root observed file replaced by an outside symlink as deleted",
    async () => {
      const dir = gitRepo();
      const outside = tmpDir();
      const file = path.join(dir, "structured.txt");
      const target = path.join(outside, "target.txt");
      const baseline = await snapshotWorkingTree([dir]);
      fs.writeFileSync(file, "created", "utf8");
      fs.writeFileSync(target, "outside", "utf8");
      await observeEditedPaths(baseline, [{ path: file }]);
      fs.rmSync(file);
      fs.symlinkSync(target, file);

      const { reflected, unsupported } = await reconcileWorkingTree(baseline);
      expect(reflected).toEqual([]);
      expect(unsupported).toEqual([{ path: file, reason: "deleted" }]);
      expect(fs.readFileSync(target, "utf8")).toBe("outside");

      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  );

  it.skipIf(process.platform === "win32")(
    "does not read through a replaced parent directory symlink",
    async () => {
      const dir = gitRepo();
      const outside = tmpDir();
      const createdDir = path.join(dir, "created");
      const file = path.join(createdDir, "structured.txt");
      const target = path.join(outside, "structured.txt");
      const baseline = await snapshotWorkingTree([dir]);
      fs.mkdirSync(createdDir);
      fs.writeFileSync(file, "created", "utf8");
      await observeEditedPaths(baseline, [{ path: file }]);
      fs.rmSync(createdDir, { recursive: true });
      fs.writeFileSync(target, "outside secret", "utf8");
      fs.symlinkSync(outside, createdDir, "dir");

      const { reflected, unsupported } = await reconcileWorkingTree(baseline);
      expect(reflected).toEqual([]);
      expect(unsupported).toEqual([{ path: file, reason: "deleted" }]);
      expect(fs.readFileSync(target, "utf8")).toBe("outside secret");

      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  );

  it.skipIf(process.platform === "win32")(
    "does not follow a baseline file replaced by a symlink during direct resnapshot",
    async () => {
      const dir = gitRepo();
      const outside = tmpDir();
      const ignoreFile = path.join(dir, ".gitignore");
      const file = path.join(dir, "hidden.txt");
      const target = path.join(outside, "target.txt");
      fs.writeFileSync(ignoreFile, "", "utf8");
      fs.writeFileSync(file, "inside", "utf8");
      fs.writeFileSync(target, "outside secret", "utf8");
      execFileSync("git", ["-C", dir, "add", ".gitignore"]);

      const baseline = await snapshotWorkingTree([dir]);
      fs.rmSync(file);
      fs.symlinkSync(target, file);
      fs.writeFileSync(ignoreFile, "hidden.txt\n", "utf8");

      const { reflected, unsupported } = await reconcileWorkingTree(baseline);
      expect(reflected).toEqual([{ path: ignoreFile, oldText: "", newText: "hidden.txt\n" }]);
      expect(unsupported).toEqual([{ path: file, reason: "deleted" }]);
      expect(fs.readFileSync(target, "utf8")).toBe("outside secret");

      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  );

  it("recurses into a checked-out submodule without applying parent ignore rules", async () => {
    const root = tmpDir();
    const subSrc = path.join(root, "sub-src");
    const parent = path.join(root, "parent");
    fs.mkdirSync(subSrc);
    fs.mkdirSync(parent);

    execFileSync("git", ["-C", subSrc, "init", "-q"]);
    execFileSync("git", ["-C", subSrc, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", subSrc, "config", "user.name", "t"]);
    fs.writeFileSync(path.join(subSrc, "inside.txt"), "sub-before", "utf8");
    execFileSync("git", ["-C", subSrc, "add", "."]);
    execFileSync("git", ["-C", subSrc, "commit", "-qm", "sub"]);

    execFileSync("git", ["-C", parent, "init", "-q"]);
    execFileSync("git", ["-C", parent, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", parent, "config", "user.name", "t"]);
    fs.writeFileSync(path.join(parent, "root.txt"), "root", "utf8");
    execFileSync("git", ["-C", parent, "add", "."]);
    execFileSync("git", ["-C", parent, "commit", "-qm", "root"]);
    // protocol.file.allow must be on the invoking process (-c), not only the
    // repo config — submodule add clones via the file transport.
    execFileSync("git", [
      "-C", parent,
      "-c", "protocol.file.allow=always",
      "submodule", "add", subSrc, "vendor"
    ]);
    const parentIgnore = path.join(parent, ".gitignore");
    fs.writeFileSync(parentIgnore, "*.txt\n", "utf8");
    execFileSync("git", ["-C", parent, "add", ".gitignore"]);
    execFileSync("git", ["-C", parent, "commit", "-qm", "add vendor"]);

    const inside = path.join(parent, "vendor", "inside.txt");
    const created = path.join(parent, "vendor", "new.txt");
    const baseline = await snapshotWorkingTree([parent]);
    expect(emittedPaths(baseline)).toContain(inside);

    // Parent ignore rules do not cross the nested repository boundary. Changing
    // the parent rule must not make the submodule creation look newly exposed.
    fs.writeFileSync(parentIgnore, "*.log\n", "utf8");
    fs.writeFileSync(inside, "sub-after", "utf8");
    fs.writeFileSync(created, "sub-created", "utf8");
    const { reflected, unsupported } = await reconcileWorkingTree(baseline);
    expect(unsupported).toEqual([]);
    expect(reflected).toHaveLength(3);
    expect(reflected).toEqual(expect.arrayContaining([
      { path: parentIgnore, oldText: "*.txt\n", newText: "*.log\n" },
      { path: inside, oldText: "sub-before", newText: "sub-after" },
      { path: created, oldText: null, newText: "sub-created" }
    ]));

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not recurse into a deinitialized submodule", async () => {
    // A deinitialized submodule's gitlink remains as an empty directory where
    // git discovers the *parent* repository and lists the gitlink itself as
    // "./" — recursing into it would repeat the same listing forever and the
    // snapshot would never complete.
    const root = tmpDir();
    const subSrc = path.join(root, "sub-src");
    const parent = path.join(root, "parent");
    fs.mkdirSync(subSrc);
    fs.mkdirSync(parent);

    execFileSync("git", ["-C", subSrc, "init", "-q"]);
    execFileSync("git", ["-C", subSrc, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", subSrc, "config", "user.name", "t"]);
    fs.writeFileSync(path.join(subSrc, "inside.txt"), "sub", "utf8");
    execFileSync("git", ["-C", subSrc, "add", "."]);
    execFileSync("git", ["-C", subSrc, "commit", "-qm", "sub"]);

    execFileSync("git", ["-C", parent, "init", "-q"]);
    execFileSync("git", ["-C", parent, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", parent, "config", "user.name", "t"]);
    fs.writeFileSync(path.join(parent, "root.txt"), "root", "utf8");
    execFileSync("git", ["-C", parent, "add", "."]);
    execFileSync("git", ["-C", parent, "commit", "-qm", "root"]);
    execFileSync("git", [
      "-C", parent,
      "-c", "protocol.file.allow=always",
      "submodule", "add", subSrc, "vendor"
    ]);
    execFileSync("git", ["-C", parent, "commit", "-qm", "add vendor"]);
    execFileSync("git", ["-C", parent, "submodule", "deinit", "-f", "vendor"]);

    const baseline = await snapshotWorkingTree([parent]);
    expect(emittedPaths(baseline).sort()).toEqual(
      [path.join(parent, ".gitmodules"), path.join(parent, "root.txt")].sort()
    );

    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("buildReconcileEditUpdate", () => {
  it("produces a completed edit tool_call whose diff round-trips through diffBlocks", () => {
    const edit = { path: "/repo/src/a.txt", oldText: "old", newText: "new" };
    const update = buildReconcileEditUpdate(edit, 0, "/repo");

    expect(update).toMatchObject({
      sessionUpdate: "tool_call",
      toolCallId: "agy-fs-reconcile-0",
      kind: "edit",
      status: "completed",
      title: "Edit src/a.txt"
    });
    expect(diffBlocks(update)).toEqual([{ path: "/repo/src/a.txt", oldText: "old", newText: "new" }]);
  });

  it("names a create (oldText null) write_to_file", () => {
    const update = buildReconcileEditUpdate({ path: "/repo/new.txt", oldText: null, newText: "x" }, 1, "/repo");
    expect(update).toMatchObject({ toolCallId: "agy-fs-reconcile-1", name: "write_to_file" });
  });

  it("qualifies the tool-call ID with a per-turn token when provided", () => {
    const edit = { path: "/repo/a.txt", oldText: null, newText: "x" };
    const turn0 = buildReconcileEditUpdate(edit, 0, "/repo", "0");
    const turn1 = buildReconcileEditUpdate(edit, 0, "/repo", "1");
    expect(turn0).toMatchObject({ toolCallId: "agy-fs-reconcile-0-0" });
    expect(turn1).toMatchObject({ toolCallId: "agy-fs-reconcile-1-0" });
    // Same index in different turns must not collide.
    expect((turn0 as { toolCallId: string }).toolCallId).not.toBe((turn1 as { toolCallId: string }).toolCallId);
  });

  it("keeps tool-call IDs unique when turn tokens are UUIDs (session reload safe)", () => {
    const edit = { path: "/repo/a.txt", oldText: null, newText: "x" };
    const a = buildReconcileEditUpdate(edit, 0, "/repo", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    const b = buildReconcileEditUpdate(edit, 0, "/repo", "ffffffff-0000-1111-2222-333333333333");
    expect((a as { toolCallId: string }).toolCallId).toBe(
      "agy-fs-reconcile-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee-0"
    );
    expect((a as { toolCallId: string }).toolCallId).not.toBe((b as { toolCallId: string }).toolCallId);
  });
});
