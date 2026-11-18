import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const connectorRoot = path.join(root, "ACP Connector");
const failures = [];

for (const required of [connectorRoot]) {
  if (!existsSync(required) || !statSync(required).isDirectory()) {
    failures.push(`missing source module: ${path.basename(required)}`);
  }
}
if (existsSync(path.join(root, "src"))) failures.push("legacy src/ source area must not exist");

for (const retired of ["Admission Controller", "ACP Connector/admission", "ACP Connector/official-kernel/admission-fence.ts"]) {
  if (existsSync(path.join(root, retired))) failures.push(`retired scheduling module must not exist: ${retired}`);
}
for (const file of sourceFiles(connectorRoot)) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\b(?:from\s+|import\s*\()(["'])([^"']+)\1/g)) {
    if (/admission|better-sqlite3/i.test(match[2])) failures.push(`retired scheduling dependency: ${relative(file)} -> ${match[2]}`);
  }
}

const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
if (packageJson.dependencies && Object.keys(packageJson.dependencies).length) failures.push("adapter must have no runtime npm dependencies");
for (const [field, expected] of [
  ["main", "dist/ACP Connector/agent.js"],
  ["types", "dist/ACP Connector/agent.d.ts"],
  ["bin.agy-acp", "dist/ACP Connector/main.js"]
]) {
  const actual = field === "bin.agy-acp" ? packageJson.bin?.["agy-acp"] : packageJson[field];
  if (actual !== expected) failures.push(`${field} must be ${expected}`);
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`architecture boundary violation: ${failure}`);
  process.exitCode = 1;
} else {
  console.log("architecture boundaries: PASS");
}

function sourceFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(target) : entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
  });
}

function relative(file) {
  return path.relative(root, file).split(path.sep).join("/");
}
