import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const connectorRoot = path.join(root, "ACP Connector");
const controllerRoot = path.join(root, "Admission Controller");
const failures = [];

for (const required of [connectorRoot, controllerRoot]) {
  if (!existsSync(required) || !statSync(required).isDirectory()) {
    failures.push(`missing source module: ${path.basename(required)}`);
  }
}
if (existsSync(path.join(root, "src"))) failures.push("legacy src/ source area must not exist");

for (const file of sourceFiles(controllerRoot)) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\b(?:from\s+|import\s*\()(["'])([^"']+)\1/g)) {
    const specifier = match[2];
    if (specifier.includes("ACP Connector") || specifier.includes("/acp/") || specifier.includes("/agy/")) {
      failures.push(`Admission Controller imports Connector implementation: ${relative(file)} -> ${specifier}`);
    }
  }
}

const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
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
