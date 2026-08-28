#!/usr/bin/env node

import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  writeSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const defaultStateRoot = path.join(os.homedir(), ".local", "opt", "paseo-agy-acp-kernel-compat");
const defaultOfficialKernelRoot = path.join(
  os.homedir(),
  ".local",
  "opt",
  "agy-acp-server-agy_acp_server_20260818_01_RC01"
);
const defaultParPath = path.join(defaultOfficialKernelRoot, "agy_acp_server.par");
const defaultExternalHarnessPath = path.join(defaultOfficialKernelRoot, "localharness_external");
const defaultCompatModulePath = path.join(
  repositoryRoot,
  "assets",
  "official-kernel-compat",
  "rc01",
  "paseo_model_compat.py"
);

const MAX_COMPAT_MODULE_BYTES = 1_000_000;
const MAX_PATCH_PLAN_BYTES = 64 * 1024;
const CLOEXEC = constants.O_CLOEXEC ?? 0;

function fail(message) {
  process.stderr.write(`agy-acp kernel compatibility lifecycle failed: ${message}\n`);
  process.exitCode = 1;
}

function printUsage() {
  process.stdout.write(
    "usage: agy-acp-prepare-official-kernel-compat <prepare|verify|activate|rollback|status|cleanup> [options]\n"
  );
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") return { help: true };
  const values = new Map();
  const booleans = new Set();
  const seenOptions = new Set();
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
    if (!valueOptions.has(name) && !booleanOptions.has(name)) throw new Error(`unknown option --${name}`);
    if (seenOptions.has(name)) throw new Error(`--${name} may be provided once`);
    seenOptions.add(name);
    if (booleanOptions.has(name)) {
      booleans.add(name);
      continue;
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} requires a value`);
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
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return path.resolve(value);
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

function prepareOptions(values, builtInPatchPlan) {
  const layout = {
    ...(values.has("compat-destination") ? { compatModuleRelativePath: values.get("compat-destination") } : {}),
    ...(values.has("importer-env") ? { importerEnvironment: parseImporterEnvironment(values.get("importer-env")) } : {})
  };
  const selectedCompatModule = values.has("compat-module")
    ? { path: absolute(values.get("compat-module"), "compatibility module path"), builtIn: false }
    : { path: defaultCompatModulePath, builtIn: true };
  const stagedCompatModule = materializeCompatModule(selectedCompatModule.path, selectedCompatModule.builtIn);
  try {
    return {
      options: {
        parPath: absolute(values.get("par") ?? defaultParPath, "PAR path"),
        externalHarnessPath: absolute(values.get("external-harness") ?? defaultExternalHarnessPath, "external harness path"),
        compatModulePath: stagedCompatModule.path,
        patchPlan: values.has("patch-plan") ? readPatchPlan(values.get("patch-plan")) : builtInPatchPlan,
        ...(values.has("compatibility-version") ? { compatibilityVersion: values.get("compatibility-version") } : {}),
        ...(Object.keys(layout).length > 0 ? { layout } : {})
      },
      cleanup: stagedCompatModule.cleanup
    };
  } catch (error) {
    stagedCompatModule.cleanup();
    throw error;
  }
}

function readPatchPlan(filename) {
  const patchPlanPath = absolute(filename, "patch plan path");
  const text = readStableTextFile(patchPlanPath, "patch plan", MAX_PATCH_PLAN_BYTES, false);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("patch plan must be a readable local JSON file");
  }
}

function materializeCompatModule(sourcePath, builtIn) {
  const label = builtIn ? "built-in compatibility module" : "compatibility module override";
  const source = openStableRegularFile(sourcePath, label, MAX_COMPAT_MODULE_BYTES, builtIn);
  let directory;
  let destination;
  try {
    directory = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-acp-compat-"));
    chmodSync(directory, 0o700);
    const directoryStat = lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory() || (directoryStat.mode & 0o777) !== 0o700) {
      throw new Error("compatibility module staging directory must have mode 0700");
    }

    const destinationPath = path.join(directory, "paseo_model_compat.py");
    destination = openPrivateOutput(destinationPath, 0o400);
    copyStableFile(source, destination, label);
    fchmodSync(destination, 0o400);
    fsyncSync(destination);
    const destinationStat = fstatSync(destination);
    if (!destinationStat.isFile() || (destinationStat.mode & 0o777) !== 0o400) {
      throw new Error("compatibility module staging file must have mode 0400");
    }
    closeSync(destination);
    destination = undefined;

    return {
      path: destinationPath,
      cleanup: () => rmSync(directory, { force: true, recursive: true })
    };
  } catch (error) {
    if (destination !== undefined) closeSync(destination);
    if (directory !== undefined) rmSync(directory, { force: true, recursive: true });
    throw error;
  } finally {
    closeSync(source.fd);
  }
}

function readStableTextFile(filename, label, maximumBytes, builtIn) {
  const source = openStableRegularFile(filename, label, maximumBytes, builtIn);
  try {
    const content = readStableFile(source, label);
    return content.toString("utf8");
  } finally {
    closeSync(source.fd);
  }
}

function openStableRegularFile(filename, label, maximumBytes, builtIn) {
  assertExistingPathHasNoSymlinkComponents(filename, label);
  const before = lstatSync(filename);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} must be a regular file and not a symbolic link`);
  }
  if (!Number.isSafeInteger(before.size) || before.size < 0 || before.size > maximumBytes) {
    throw new Error(`${label} exceeds the ${maximumBytes}-byte limit`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (!builtIn && (uid === undefined || before.uid !== uid)) {
    throw new Error(`${label} must be owned by the current user`);
  }
  if ((before.mode & 0o002) !== 0 || (!builtIn && (before.mode & 0o020) !== 0)) {
    throw new Error(`${label} must not be group- or world-writable`);
  }
  if (builtIn && uid !== undefined && before.uid !== uid && (before.mode & 0o022) !== 0) {
    throw new Error(`${label} from another owner must not be group- or world-writable`);
  }

  const fd = openReadOnlyNoFollow(filename);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !sameFileSnapshot(opened, before)) {
      throw new Error(`${label} changed while it was being opened`);
    }
    return { fd, before: opened };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function assertExistingPathHasNoSymlinkComponents(candidate, label) {
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  let cursor = parsed.root;
  for (const part of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch {
      throw new Error(`${label} must be a readable local file`);
    }
    if (stat.isSymbolicLink()) throw new Error(`${label} must not traverse a symbolic link`);
    if (cursor !== resolved && !stat.isDirectory()) throw new Error(`${label} has a non-directory parent`);
  }
}

function openReadOnlyNoFollow(filename) {
  const noFollow = constants.O_NOFOLLOW;
  if (noFollow === undefined) throw new Error("kernel compatibility CLI requires O_NOFOLLOW support");
  return openSync(filename, constants.O_RDONLY | noFollow | CLOEXEC);
}

function openPrivateOutput(filename, mode) {
  const noFollow = constants.O_NOFOLLOW;
  if (noFollow === undefined) throw new Error("kernel compatibility CLI requires O_NOFOLLOW support");
  return openSync(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow | CLOEXEC, mode);
}

function readStableFile(source, label) {
  const output = Buffer.alloc(source.before.size);
  let offset = 0;
  while (offset < output.length) {
    const count = readSync(source.fd, output, offset, output.length - offset, offset);
    if (count === 0) throw new Error(`${label} changed while it was being read`);
    offset += count;
  }
  assertStableFile(source, label);
  return output;
}

function copyStableFile(source, destination, label) {
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(source.before.size, 1)));
  let position = 0;
  while (position < source.before.size) {
    const count = readSync(source.fd, buffer, 0, Math.min(buffer.length, source.before.size - position), position);
    if (count === 0) throw new Error(`${label} changed while it was being copied`);
    writeAll(destination, buffer.subarray(0, count));
    position += count;
  }
  assertStableFile(source, label);
}

function assertStableFile(source, label) {
  if (!sameFileSnapshot(fstatSync(source.fd), source.before)) {
    throw new Error(`${label} changed while it was being read`);
  }
}

function sameFileSnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function writeAll(fd, data) {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset);
    if (written <= 0) throw new Error("could not materialize compatibility module");
    offset += written;
  }
}

async function loadLifecycleModule() {
  const modulePath = path.join(
    repositoryRoot,
    "dist",
    "ACP Connector",
    "official-kernel",
    "kernel-compat-lifecycle.js"
  );
  try {
    lstatSync(modulePath);
  } catch {
    throw new Error("built lifecycle module is missing; run npm run build before invoking this command");
  }
  return import(pathToFileURL(modulePath).href);
}

async function loadBuiltInPatchPlan() {
  const modulePath = path.join(
    repositoryRoot,
    "dist",
    "ACP Connector",
    "official-kernel",
    "kernel-compat-rc01-recipe.js"
  );
  try {
    lstatSync(modulePath);
  } catch {
    throw new Error("built RC01 patch recipe is missing; run npm run build before invoking prepare");
  }
  const module = await import(pathToFileURL(modulePath).href);
  if (module.RC01_KERNEL_COMPAT_PATCH_PLAN === undefined) {
    throw new Error("built RC01 patch recipe is invalid");
  }
  return module.RC01_KERNEL_COMPAT_PATCH_PLAN;
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
    const preparedOptions = prepareOptions(values, await loadBuiltInPatchPlan());
    try {
      const prepared = await lifecycle.prepare(preparedOptions.options);
      result = booleans.has("activate")
        ? { prepared, activation: await lifecycle.activate(prepared.artifactId) }
        : { prepared };
    } finally {
      preparedOptions.cleanup();
    }
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
