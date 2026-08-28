import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".gitnexus",
  ".paseo",
  "coverage",
  "dist",
  "node_modules"
]);

const DEFAULT_IGNORED_PATH_PREFIXES = [
  "docs/design/receipts/"
];

const TEXT_EXTENSIONS = new Set([
  ".cjs",
  ".css",
  ".env",
  ".example",
  ".html",
  ".js",
  ".json",
  ".jsonl",
  ".md",
  ".mjs",
  ".py",
  ".sh",
  ".sql",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml"
]);

const TEXT_FILENAMES = new Set([
  "AGENTS.md",
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "package-lock.json",
  "package.json"
]);

const SECRET_RULES = [
  {
    id: "private-key-block",
    pattern: /-----BEGIN [A-Z0-9 ]{0,32}PRIVATE KEY-----/g
  },
  {
    id: "aws-access-key-id",
    pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g
  },
  {
    id: "provider-token",
    pattern: /\b(?:ghp_[A-Za-z0-9_]{32,}|github_pat_[A-Za-z0-9_]{32,}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9]{32,})\b/g
  },
  {
    id: "generic-sensitive-assignment",
    pattern: /\b[A-Z0-9_-]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|private[_-]?key|secret|password|token)[A-Z0-9_-]*\b\s*[:=]\s*(["'])[A-Za-z0-9][A-Za-z0-9_.+/=@:-]{19,}\1/gi
  },
  {
    id: "generic-env-assignment",
    pattern: /^\s*[A-Z0-9_-]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|private[_-]?key|secret|password|token)[A-Z0-9_-]*\s*=\s*[A-Za-z0-9][A-Za-z0-9_.+/=@:-]{19,}\s*$/gim,
    appliesTo: (relativePath) => path.basename(relativePath).startsWith(".env")
  }
];

const options = parseArgs(process.argv.slice(2));
const scannedFiles = collectFiles(options.root);
const findings = [];

for (const file of scannedFiles) {
  findings.push(...scanFile(file));
}

if (options.includeTestFixture) {
  findings.push(...scanVirtualFile(builtInFixture()));
}

if (findings.length > 0) {
  console.error(`secret scan: FAIL (${findings.length} finding${findings.length === 1 ? "" : "s"})`);
  for (const finding of findings.slice(0, 50)) {
    console.error(`${finding.path}:${finding.line} ${finding.rule}`);
  }
  if (findings.length > 50) console.error(`... ${findings.length - 50} more findings omitted`);
  process.exitCode = 1;
} else {
  console.log(`secret scan: PASS (${scannedFiles.length} file${scannedFiles.length === 1 ? "" : "s"} checked)`);
}

function parseArgs(args) {
  let root = process.cwd();
  let includeTestFixture = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--root") {
      const value = args[index + 1];
      if (!value) throw new Error("--root requires a path");
      root = path.resolve(value);
      index += 1;
    } else if (arg === "--include-test-fixture") {
      includeTestFixture = true;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  return { root, includeTestFixture };
}

function collectFiles(root) {
  if (!existsSync(root)) throw new Error(`secret scan root does not exist: ${root}`);
  const rootStat = statSync(root);
  if (rootStat.isFile()) return [fileRecord(root, path.dirname(root))];
  if (!rootStat.isDirectory()) throw new Error(`secret scan root is not a file or directory: ${root}`);
  return walk(root, root);
}

function walk(directory, root) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      if (DEFAULT_IGNORED_DIRECTORIES.has(entry.name)) return [];

      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizePath(path.relative(root, absolutePath));
      if (isIgnoredPath(relativePath)) return [];

      if (entry.isDirectory()) return walk(absolutePath, root);
      if (!entry.isFile() || !isTextCandidate(entry.name)) return [];
      return [fileRecord(absolutePath, root)];
    });
}

function fileRecord(absolutePath, root) {
  return {
    absolutePath,
    relativePath: normalizePath(path.relative(root, absolutePath))
  };
}

function scanFile(file) {
  const stats = statSync(file.absolutePath);
  if (stats.size > 1_000_000) return [];

  const content = readFileSync(file.absolutePath, "utf8");
  if (content.includes("\0")) return [];

  return scanContent(file.relativePath, content);
}

function scanVirtualFile(file) {
  return scanContent(file.relativePath, file.content);
}

function scanContent(relativePath, content) {
  const findings = [];

  for (const { id, pattern, appliesTo } of SECRET_RULES) {
    if (appliesTo && !appliesTo(relativePath)) continue;
    pattern.lastIndex = 0;
    for (const match of content.matchAll(pattern)) {
      findings.push({
        path: relativePath,
        line: lineNumberForIndex(content, match.index ?? 0),
        rule: id
      });
    }
  }

  return findings;
}

function builtInFixture() {
  const fixtureSecret = [
    "fixture",
    "not",
    "live",
    "secret",
    "0123456789abcdef0123456789abcdef"
  ].join("_");

  return {
    relativePath: "<builtin-fixture>/fixture.env",
    content: `PASEO_SECRET_SCAN_FIXTURE_SECRET="${fixtureSecret}"\n`
  };
}

function lineNumberForIndex(content, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (content.charCodeAt(cursor) === 10) line += 1;
  }
  return line;
}

function isTextCandidate(fileName) {
  if (TEXT_FILENAMES.has(fileName)) return true;
  if (fileName.startsWith(".env")) return true;
  return TEXT_EXTENSIONS.has(path.extname(fileName));
}

function isIgnoredPath(relativePath) {
  return DEFAULT_IGNORED_PATH_PREFIXES.some((prefix) => relativePath === prefix.slice(0, -1) || relativePath.startsWith(prefix));
}

function normalizePath(value) {
  return value.split(path.sep).join("/");
}
