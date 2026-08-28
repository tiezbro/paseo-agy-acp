import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import type { KernelCompatPatchPlan } from "../ACP Connector/official-kernel/kernel-compat-lifecycle.js";
import type { KernelCompatPins } from "../ACP Connector/official-kernel/kernel-compat-pins.js";

const RUNFILES_ROOT = "agy_acp_server.runfiles";
const ACP_SERVER_DIRECTORY = "google3/cloud/developer_experience/antigravity_extensions/acp_server";

export type KernelCompatP2UnsafeSymlink = "absolute" | "escape" | "broken" | "chained";

export interface KernelCompatP2FixtureOptions {
  readonly partialUnpack?: boolean;
  readonly modelSource?: string;
  readonly proxySource?: string;
  readonly serverSource?: string;
  readonly compatSource?: string;
  readonly unsafeSymlink?: KernelCompatP2UnsafeSymlink;
}

export interface KernelCompatP2Fixture {
  readonly root: string;
  readonly stateRoot: string;
  readonly parPath: string;
  readonly externalHarnessPath: string;
  readonly compatModulePath: string;
  readonly observationPath: string;
  readonly pins: KernelCompatPins;
  readonly patchPlan: KernelCompatPatchPlan;
  readonly prepareOptions: {
    readonly parPath: string;
    readonly externalHarnessPath: string;
    readonly compatModulePath: string;
    readonly patchPlan: KernelCompatPatchPlan;
  };
}

const DEFAULT_MODEL_SOURCE = "MODEL_IMPORT_MARKER\nMODEL_CATALOG_MARKER\n";
const DEFAULT_PROXY_SOURCE = "PROXY_IMPORT_MARKER\nPROXY_TRANSFORM_MARKER\n";
const DEFAULT_SERVER_SOURCE = "OFFICIAL_SERVER_CONTROL\n";

export const P2_PATCH_PLAN: KernelCompatPatchPlan = Object.freeze({
  edits: Object.freeze([
    Object.freeze({
      id: "model-import",
      target: "modelSelection" as const,
      find: "MODEL_IMPORT_MARKER",
      replacement: "MODEL_IMPORT_MARKER\nimport paseo_model_compat"
    }),
    Object.freeze({
      id: "model-catalog",
      target: "modelSelection" as const,
      find: "MODEL_CATALOG_MARKER",
      replacement: "MODEL_CATALOG_MARKER\nis_catalog_model(model_id)"
    }),
    Object.freeze({
      id: "proxy-import",
      target: "proxyServer" as const,
      find: "PROXY_IMPORT_MARKER",
      replacement: "PROXY_IMPORT_MARKER\nfrom paseo_model_compat import transform_request"
    }),
    Object.freeze({
      id: "proxy-transform",
      target: "proxyServer" as const,
      find: "PROXY_TRANSFORM_MARKER",
      replacement: "PROXY_TRANSFORM_MARKER\nbody = transform_request(model_id, body)"
    })
  ])
});

export function createKernelCompatP2Fixture(options: KernelCompatP2FixtureOptions = {}): KernelCompatP2Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "agy-kernel-compat-p2-"));
  const sourceDirectory = path.join(root, "source");
  mkdirSync(sourceDirectory, { mode: 0o700 });
  const parPath = path.join(sourceDirectory, "fake-official.par");
  const externalHarnessPath = path.join(sourceDirectory, "fake-external-harness");
  const compatModulePath = path.join(sourceDirectory, "paseo_model_compat.py");
  const observationPath = path.join(root, "kernel-observation.json");
  const modelSource = options.modelSource ?? DEFAULT_MODEL_SOURCE;
  const proxySource = options.proxySource ?? DEFAULT_PROXY_SOURCE;
  const serverSource = options.serverSource ?? DEFAULT_SERVER_SOURCE;
  writeFileSync(parPath, renderFakeSelfUnpacker({
    partialUnpack: options.partialUnpack ?? false,
    modelSource,
    proxySource,
    serverSource,
    unsafeSymlink: options.unsafeSymlink
  }), { mode: 0o775 });
  chmodSync(parPath, 0o775);
  writeFileSync(externalHarnessPath, "#!/usr/bin/env bash\nexit 0\n", { mode: 0o775 });
  chmodSync(externalHarnessPath, 0o775);
  writeFileSync(compatModulePath, options.compatSource ?? "P2 compatibility module fixture\n", { mode: 0o400 });
  chmodSync(compatModulePath, 0o400);

  const pins: KernelCompatPins = {
    profileId: "p2-fixture",
    parSha256: sha256File(parPath),
    externalHarnessSha256: sha256File(externalHarnessPath),
    targets: {
      modelSelection: {
        relativePath: `${ACP_SERVER_DIRECTORY}/model_selection.py`,
        preimageSha256: sha256Text(modelSource),
        patchable: true
      },
      proxyServer: {
        relativePath: `${ACP_SERVER_DIRECTORY}/ccpa_connection/proxy_server.py`,
        preimageSha256: sha256Text(proxySource),
        patchable: true
      },
      serverControl: {
        relativePath: `${ACP_SERVER_DIRECTORY}/server.py`,
        preimageSha256: sha256Text(serverSource),
        patchable: false
      }
    }
  };
  return {
    root,
    stateRoot: path.join(root, "state"),
    parPath,
    externalHarnessPath,
    compatModulePath,
    observationPath,
    pins,
    patchPlan: P2_PATCH_PLAN,
    prepareOptions: {
      parPath,
      externalHarnessPath,
      compatModulePath,
      patchPlan: P2_PATCH_PLAN
    }
  };
}

export function removeKernelCompatP2Fixture(fixture: KernelCompatP2Fixture): void {
  makeTreeWritableForTestCleanup(fixture.root);
  rmSync(fixture.root, { recursive: true, force: true });
}

export function writeP2CompatModule(fixture: KernelCompatP2Fixture, content: string): void {
  chmodSync(fixture.compatModulePath, 0o600);
  writeFileSync(fixture.compatModulePath, content, { mode: 0o400 });
  chmodSync(fixture.compatModulePath, 0o400);
}

export function writeP2LifecycleLock(
  fixture: KernelCompatP2Fixture,
  lock: { readonly pid: number; readonly procStartTime: string },
  modifiedAt?: Date
): string {
  return writeP2LifecycleLockText(fixture, `${JSON.stringify({ schemaVersion: 1, ...lock })}\n`, modifiedAt);
}

export function writeP2MalformedLifecycleLock(
  fixture: KernelCompatP2Fixture,
  content: string,
  modifiedAt?: Date
): string {
  return writeP2LifecycleLockText(fixture, content, modifiedAt);
}

function writeP2LifecycleLockText(fixture: KernelCompatP2Fixture, content: string, modifiedAt?: Date): string {
  mkdirSync(fixture.stateRoot, { mode: 0o700 });
  const lockPath = path.join(fixture.stateRoot, ".kernel-compat.lock");
  writeFileSync(lockPath, content, { mode: 0o600 });
  chmodSync(lockPath, 0o600);
  if (modifiedAt !== undefined) utimesSync(lockPath, modifiedAt, modifiedAt);
  return lockPath;
}

export function currentP2ProcessStartTime(): string {
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const closingParen = stat.lastIndexOf(")");
  if (closingParen < 0) throw new Error("fixture could not parse /proc process stat");
  const fields = stat.slice(closingParen + 2).trim().split(/\s+/);
  const startTime = fields[19];
  if (startTime === undefined || !/^\d+$/.test(startTime)) {
    throw new Error("fixture could not read /proc process start time");
  }
  return startTime;
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256File(filename: string): string {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

function renderFakeSelfUnpacker(payload: {
  readonly partialUnpack: boolean;
  readonly modelSource: string;
  readonly proxySource: string;
  readonly serverSource: string;
  readonly unsafeSymlink?: KernelCompatP2UnsafeSymlink;
}): string {
  const writeRunfile = (relativePath: string, content: string, mode: number): string => [
    `mkdir -p -- "${"$runfiles_dir"}/${path.posix.dirname(relativePath)}"`,
    `printf %s ${shellQuote(Buffer.from(content, "utf8").toString("base64"))} | base64 -d > "${"$runfiles_dir"}/${relativePath}"`,
    `chmod ${mode.toString(8)} -- "${"$runfiles_dir"}/${relativePath}"`
  ].join("\n");
  const mainLink = `"$runfiles_dir/${ACP_SERVER_DIRECTORY}/main"`;
  const symlinkCommand = payload.unsafeSymlink === "absolute"
    ? `ln -s -- /etc/passwd ${mainLink}`
    : payload.unsafeSymlink === "escape"
      ? `ln -s -- ../../../../../../../outside-release ${mainLink}`
      : payload.unsafeSymlink === "broken"
        ? `ln -s -- ../../../../../../missing-binary ${mainLink}`
        : payload.unsafeSymlink === "chained"
          ? [
            `ln -s -- chained-main ${mainLink}`,
            `ln -s -- /etc/passwd "$runfiles_dir/${ACP_SERVER_DIRECTORY}/chained-main"`
          ].join("\n")
          : `ln -s -- ../../../../../../agy_acp_server ${mainLink}`;
  const observeProgram = [
    "const { writeFileSync } = require(\"node:fs\");",
    "if (process.env.P2_KERNEL_OBSERVATION) {",
    "  writeFileSync(process.env.P2_KERNEL_OBSERVATION, JSON.stringify({",
    "    argv: process.argv.slice(1),",
    "    harness: process.env.ANTIGRAVITY_HARNESS_PATH,",
    "    noBytecode: process.env.PYTHONDONTWRITEBYTECODE,",
    "    pythonPath: process.env.PYTHONPATH,",
    "    binary: process.env.P2_FAKE_BINARY",
    "  }));",
    "}"
  ].join("\n");
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "binary_dir=\"$(cd -- \"$(dirname -- \"$0\")\" && pwd -P)\"",
    "if [ \"$#\" -eq 1 ] && [ \"$1\" = \"--unpack_par_and_exit\" ]; then",
    `  runfiles_dir=\"$binary_dir/${RUNFILES_ROOT}\"`,
    `  ${writeRunfile(`${ACP_SERVER_DIRECTORY}/model_selection.py`, payload.modelSource, 0o400).replace(/\n/g, "\n  ")}`,
    `  mkdir -p -- "$runfiles_dir/${ACP_SERVER_DIRECTORY}"`,
    `  ${symlinkCommand.replace(/\n/g, "\n  ")}`,
    ...(payload.partialUnpack ? [] : [
      `  ${writeRunfile(`${ACP_SERVER_DIRECTORY}/ccpa_connection/proxy_server.py`, payload.proxySource, 0o400).replace(/\n/g, "\n  ")}`,
      `  ${writeRunfile(`${ACP_SERVER_DIRECTORY}/server.py`, payload.serverSource, 0o400).replace(/\n/g, "\n  ")}`
    ]),
    "  chmod 775 -- \"$binary_dir/agy_acp_server\"",
    "  exit 0",
    "fi",
    `P2_FAKE_BINARY=\"$binary_dir/agy_acp_server\" node -e ${shellQuote(observeProgram)} -- \"$@\"`
  ].join("\n") + "\n";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\\"'\\\"'")}'`;
}

function makeTreeWritableForTestCleanup(candidate: string): void {
  const stat = lstatSync(candidate);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    for (const entry of readdirSync(candidate)) {
      makeTreeWritableForTestCleanup(path.join(candidate, entry));
    }
    chmodSync(candidate, 0o700);
    return;
  }
  if (stat.isFile()) chmodSync(candidate, 0o600);
}
