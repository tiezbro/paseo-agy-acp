#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(process.argv[2] ?? process.cwd());
const mapPath = "docs/operations/repository-redaction-map.json";
// 这些文件只承载映射、说明、验证器及 CI；其他改动必须逐条进入映射。
const supportPaths = new Set([
  mapPath, "docs/operations/repository-privacy-cleanup.md",
  ".github/workflows/ci.yml", "scripts/verify-repository-redaction.mjs",
  "tests/repository-redaction.test.ts"
]);
const scanner = fileURLToPath(new URL("./verify-no-secrets.mjs", import.meta.url));

try {
  verifyRedaction();
} catch (error) {
  // 不输出原始文件内容或 Git 子进程的 stdout/stderr。
  console.error("redaction mappings: FAIL (" + (error instanceof Error ? error.message : "verification error") + ")");
  process.exitCode = 1;
}

function verifyRedaction() {
  const map = JSON.parse(readFileSync(path.join(root, mapPath), "utf8"));
  check(map.schemaVersion === 1, "unsupported schema");
  for (const field of ["sourceCommit", "redactionCommit"]) {
    check(/^[a-f0-9]{40}$/.test(map[field]), "invalid " + field);
    check(git(["cat-file", "-t", map[field]]).toString("utf8").trim() === "commit", field + " is not a commit");
  }
  git(["merge-base", "--is-ancestor", map.sourceCommit, map.redactionCommit]);
  check(Array.isArray(map.files) && map.files.length === 89, "expected exactly 89 mappings");
  const seen = new Set();
  for (const row of map.files) {
    const name = row.path;
    check(typeof name === "string" && name.length > 0 && !path.posix.isAbsolute(name)
      && !name.includes("\\") && !name.includes("\0")
      && name.split("/").every(part => part !== "" && part !== "." && part !== ".."), "invalid relative path");
    check(!seen.has(name), "duplicate path: " + name);
    check(!supportPaths.has(name), "support file cannot be a redaction: " + name);
    seen.add(name);
    check(["maintainer-home", "internal-mirror-address", "maintainer-home-and-internal-mirror-address", "documentation-contract-path"].includes(row.reason), "invalid reason: " + name);
    for (const field of ["originalBlob", "redactedBlob"]) check(/^[a-f0-9]{40}$/.test(row[field]), "invalid " + field + ": " + name);
    for (const field of ["originalSha256", "redactedSha256"]) check(/^[a-f0-9]{64}$/.test(row[field]), "invalid " + field + ": " + name);
    const originalBlob = git(["rev-parse", map.sourceCommit + ":" + name]).toString("utf8").trim();
    check(originalBlob === row.originalBlob, "source path/blob mismatch: " + name);
    const snapshotBlob = git(["rev-parse", map.redactionCommit + ":" + name]).toString("utf8").trim();
    check(snapshotBlob === row.redactedBlob, "snapshot path/blob mismatch: " + name);
    const original = git(["cat-file", "blob", row.originalBlob]);
    const redacted = git(["cat-file", "blob", row.redactedBlob]);
    check(digest(original) === row.originalSha256, "original SHA-256 mismatch: " + name);
    check(digest(redacted) === row.redactedSha256, "redacted SHA-256 mismatch: " + name);
    check(row.originalBlob !== row.redactedBlob, "unchanged mapping: " + name);
    const file = path.join(root, name);
    check(lstatSync(file).isFile(), "current path is not a regular file: " + name);
    const current = readFileSync(file);
    check(current.length <= 1_000_000 && !current.includes(0), "mapped file would be skipped by secret scan: " + name);
    check(current.equals(redacted), "current file differs from redacted blob: " + name);
    check(git(["hash-object", "--stdin"], current).toString("utf8").trim() === row.redactedBlob, "current blob mismatch: " + name);
  }
  const changed = git(["diff", "--name-only", "--no-renames", "-z", map.sourceCommit, map.redactionCommit, "--"])
    .toString("utf8").split("\0").filter(Boolean).filter(name => !supportPaths.has(name));
  check(changed.length === seen.size && changed.every(name => seen.has(name)), "path coverage mismatch (missing or extra paths)");
  // 显式以单文件为扫描根，覆盖默认扫描排除的历史 receipt 和 .ndjson。
  for (const name of seen) {
    const result = spawnSync(process.execPath, [scanner, "--root", path.join(root, name)], { encoding: "utf8" });
    check(result.status === 0 && /secret scan: PASS \(1 file checked\)/.test(result.stdout ?? ""), "secret scan failed: " + name);
  }
  console.log("redaction mappings: PASS (89 entries; source and redaction commits; blob identities; SHA-256; current files; exact path coverage; 89 secret scans)");
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(args, input) {
  try {
    return execFileSync("git", args, { cwd: root, input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    throw new Error("Git object/path unavailable (fetch full history before verification)");
  }
}
