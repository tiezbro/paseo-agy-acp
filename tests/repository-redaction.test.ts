import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

type Row = { path: string; reason: string; originalBlob: string; redactedBlob: string; originalSha256: string; redactedSha256: string };
type Map = { schemaVersion: number; sourceCommit: string; redactionCommit: string; files: Row[] };
const verifier = path.resolve("scripts/verify-repository-redaction.mjs");
const roots: string[] = [];
const mapPath = "docs/operations/repository-redaction-map.json";
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const parent = path.join(process.cwd(), "node_modules", ".cache", "repository-redaction");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, "fixture-"));
  roots.push(root);
  const git = (args: string[], input?: string) => execFileSync("git", args, {
    cwd: root, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" }
  }).trim();
  git(["init"]);
  const names = Array.from({ length: 89 }, (_, index) => "docs/design/receipts/item-" + index + ".ndjson");
  mkdirSync(path.join(root, "docs/design/receipts"), { recursive: true });
  mkdirSync(path.join(root, "docs/operations"), { recursive: true });
  for (const name of names) writeFileSync(path.join(root, name), "original evidence\n", "utf8");
  git(["add", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "fixture source"]);
  const sourceCommit = git(["rev-parse", "HEAD"]);
  const map: Map = { schemaVersion: 1, sourceCommit, redactionCommit: "", files: names.map(name => {
    const originalBlob = git(["rev-parse", sourceCommit + ":" + name]);
    const redacted = "redacted evidence\n";
    writeFileSync(path.join(root, name), redacted, "utf8");
    return { path: name, reason: "maintainer-home", originalBlob,
      redactedBlob: git(["hash-object", "-w", "--stdin"], redacted),
      originalSha256: digest("original evidence\n"), redactedSha256: digest(redacted) };
  }) };
  git(["add", "."]);
  git(["-c", "commit.gpgsign=false", "commit", "-m", "fixture redaction"]);
  map.redactionCommit = git(["rev-parse", "HEAD"]);
  const save = () => writeFileSync(path.join(root, mapPath), JSON.stringify(map), "utf8");
  save();
  const run = () => { save(); return spawnSync(process.execPath, [verifier, root], { encoding: "utf8" }); };
  return { root, git, map, run };
}

describe("只读脱敏映射校验", () => {
  it("逐条验证 89 个映射和 NDJSON secrets，且不改动工作树", () => {
    const f = fixture();
    const before = f.git(["status", "--porcelain"]);
    const bytes = readFileSync(path.join(f.root, mapPath), "utf8");
    const result = f.run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("89 secret scans");
    expect(result.stderr).toBe("");
    expect(f.git(["status", "--porcelain"])).toBe(before);
    expect(readFileSync(path.join(f.root, mapPath), "utf8")).toBe(bytes);
  }, 30_000);

  it.each([
    ["不可读取的 sourceCommit", (f: ReturnType<typeof fixture>) => { f.map.sourceCommit = "0".repeat(40); }, "Git object/path unavailable"],
    ["不可读取的脱敏快照", (f: ReturnType<typeof fixture>) => { f.map.redactionCommit = "0".repeat(40); }, "Git object/path unavailable"],
    ["不存在的原始 blob", (f: ReturnType<typeof fixture>) => { f.map.files[0]!.originalBlob = "0".repeat(40); }, "source path/blob mismatch"],
    ["原始 blob 指向其他路径", (f: ReturnType<typeof fixture>) => { f.map.files[0]!.path = "missing.md"; }, "Git object/path unavailable"],
    ["脱敏 blob 与快照路径不匹配", (f: ReturnType<typeof fixture>) => { f.map.files[0]!.redactedBlob = "0".repeat(40); }, "snapshot path/blob mismatch"],
    ["原始摘要篡改", (f: ReturnType<typeof fixture>) => { f.map.files[0]!.originalSha256 = "0".repeat(64); }, "original SHA-256 mismatch"],
    ["脱敏摘要篡改", (f: ReturnType<typeof fixture>) => { f.map.files[0]!.redactedSha256 = "0".repeat(64); }, "redacted SHA-256 mismatch"],
    ["遗漏映射", (f: ReturnType<typeof fixture>) => { f.map.files.pop(); }, "expected exactly 89 mappings"],
    ["重复路径", (f: ReturnType<typeof fixture>) => { f.map.files[1] = { ...f.map.files[0]! }; }, "duplicate path"],
    ["路径越界", (f: ReturnType<typeof fixture>) => { f.map.files[0]!.path = "../outside.md"; }, "invalid relative path"],
    ["当前文件漂移", (f: ReturnType<typeof fixture>) => { writeFileSync(path.join(f.root, f.map.files[0]!.path), "drift\n", "utf8"); }, "current file differs"],
    ["未列入映射的改动", (f: ReturnType<typeof fixture>) => { writeFileSync(path.join(f.root, "extra.md"), "extra\n", "utf8"); f.git(["add", "extra.md"]); f.git(["-c", "commit.gpgsign=false", "commit", "-m", "extra snapshot path"]); f.map.redactionCommit = f.git(["rev-parse", "HEAD"]); }, "path coverage mismatch"]
  ] as const)("拒绝%s", (_label, mutate, message) => {
    const f = fixture();
    mutate(f);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
  });

  it.each(["binary", "oversized"])("拒绝会被 secrets scanner 跳过的 %s 文件", kind => {
    const f = fixture();
    const text = kind === "binary" ? "binary\0data" : "x".repeat(1_000_001);
    const row = f.map.files[0]!;
    writeFileSync(path.join(f.root, row.path), text, "utf8");
    row.redactedBlob = f.git(["hash-object", "-w", "--stdin"], text);
    row.redactedSha256 = digest(text);
    f.git(["add", row.path]);
    f.git(["-c", "commit.gpgsign=false", "commit", "-m", "updated fixture snapshot"]);
    f.map.redactionCommit = f.git(["rev-parse", "HEAD"]);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("mapped file would be skipped by secret scan");
  });

  it("即使 blob 和摘要匹配，也拒绝 NDJSON 内新引入的凭据且不打印内容", () => {
    const f = fixture();
    const value = ["fixture", "not", "live", "0123456789abcdef0123456789abcdef"].join("_");
    const text = 'PASEO_API_TOKEN="' + value + '"\n';
    const row = f.map.files[0]!;
    writeFileSync(path.join(f.root, row.path), text, "utf8");
    row.redactedBlob = f.git(["hash-object", "-w", "--stdin"], text);
    row.redactedSha256 = digest(text);
    f.git(["add", row.path]);
    f.git(["-c", "commit.gpgsign=false", "commit", "-m", "updated fixture snapshot"]);
    f.map.redactionCommit = f.git(["rev-parse", "HEAD"]);
    const result = f.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("secret scan failed");
    expect(result.stderr + result.stdout).not.toContain(value);
  });
});
