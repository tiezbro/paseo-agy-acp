#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const defaultStateRoot = path.join(os.homedir(), ".local", "opt", "paseo-agy-acp-kernel-compat");

function fail(message) {
  process.stderr.write(`agy-acp kernel compatibility lifecycle failed: ${message}\n`);
  process.exitCode = 1;
}

function printUsage() {
  process.stdout.write(
    "usage: node scripts/prepare-official-kernel-compat.mjs <prepare|verify|activate|rollback|status|cleanup> [options]\n"
  );
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") return { help: true };
  const values = new Map();
  const booleans = new Set();
  const valueOptions = new Set([
    "state-root",
    "par",
    "external-harness",
    "compat-module",
    "patch-plan",
    "compatibility-version",
    "compat-destination",
    "importer-env",
    "artifact-id"
  ]);
  const booleanOptions = new Set(["activate", "remove-unreferenced"]);
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument ${JSON.stringify(token)}`);
    const name = token.slice(2);
    if (booleanOptions.has(name)) {
      booleans.add(name);
      continue;
    }
    if (!valueOptions.has(name)) throw new Error(`unknown option --${name}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    if (values.has(name)) throw new Error(`--${name} may be provided once`);
    values.set(name, value);
    index += 1;
  }
  return { command, values, booleans };
}

function required(values, name) {
  const value = values.get(name);
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

function absolute(value, label) {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return path.resolve(value);
}

function readPatchPlan(filename) {
  const patchPlanPath = absolute(filename, "patch plan path");
  try {
    return JSON.parse(readFileSync(patchPlanPath, "utf8"));
  } catch {
    throw new Error("patch plan must be a readable local JSON file");
  }
}

function parseImporterEnvironment(value) {
  if (value === undefined) return undefined;
  const result = {};
  for (const entry of value.split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error("--importer-env entries must use NAME=relative/path");
    }
    result[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return result;
}

function prepareOptions(values) {
  const layout = {
    ...(values.has("compat-destination") ? { compatModuleRelativePath: values.get("compat-destination") } : {}),
    ...(values.has("importer-env") ? { importerEnvironment: parseImporterEnvironment(values.get("importer-env")) } : {})
  };
  return {
    parPath: absolute(required(values, "par"), "PAR path"),
    externalHarnessPath: absolute(required(values, "external-harness"), "external harness path"),
    compatModulePath: absolute(required(values, "compat-module"), "compatibility module path"),
    patchPlan: readPatchPlan(required(values, "patch-plan")),
    ...(values.has("compatibility-version") ? { compatibilityVersion: values.get("compatibility-version") } : {}),
    ...(Object.keys(layout).length > 0 ? { layout } : {})
  };
}

async function loadLifecycleModule() {
  const modulePath = path.join(
    repositoryRoot,
    "dist",
    "ACP Connector",
    "official-kernel",
    "kernel-compat-lifecycle.js"
  );
  if (!existsSync(modulePath)) {
    throw new Error("built lifecycle module is missing; run npm run build before invoking this local script");
  }
  return import(pathToFileURL(modulePath).href);
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    printUsage();
    return;
  }
  const { command, values, booleans } = parsed;
  if (!new Set(["prepare", "verify", "activate", "rollback", "status", "cleanup"]).has(command)) {
    throw new Error(`unknown lifecycle command ${JSON.stringify(command)}`);
  }
  if (booleans.has("activate") && command !== "prepare") throw new Error("--activate is valid only with prepare");
  if (booleans.has("remove-unreferenced") && command !== "cleanup") {
    throw new Error("--remove-unreferenced is valid only with cleanup");
  }
  const { OfficialKernelCompatLifecycle } = await loadLifecycleModule();
  const stateRoot = absolute(values.get("state-root") ?? defaultStateRoot, "state root");
  const lifecycle = new OfficialKernelCompatLifecycle({ stateRoot });

  let result;
  if (command === "prepare") {
    const prepared = await lifecycle.prepare(prepareOptions(values));
    result = booleans.has("activate")
      ? { prepared, activation: await lifecycle.activate(prepared.artifactId) }
      : { prepared };
  } else if (command === "verify") {
    result = await lifecycle.verify(values.get("artifact-id"));
  } else if (command === "activate") {
    result = await lifecycle.activate(required(values, "artifact-id"));
  } else if (command === "rollback") {
    result = await lifecycle.rollback();
  } else if (command === "status") {
    result = await lifecycle.status();
  } else {
    result = await lifecycle.cleanup({ removeUnreferenced: booleans.has("remove-unreferenced") });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => fail(error instanceof Error ? error.message : "unknown local lifecycle error"));
