import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { managedOfficialKernelRoot } from "../ACP Connector/official-kernel/ensure-managed-kernel.js";
import { PRODUCTION_KERNEL_COMPAT_PINS } from "../ACP Connector/official-kernel/kernel-compat-pins.js";

const ACP_SERVER_DIRECTORY = "google3/cloud/developer_experience/antigravity_extensions/acp_server";
const SDK_DIRECTORY = "google3/third_party/py/google/antigravity/connections/local";

function candidateRoots(): string[] {
  return [
    process.env.PASEO_AGY_ACP_OFFICIAL_KERNEL_ROOT,
    managedOfficialKernelRoot()
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function sha256File(file: string): string {
  const result = spawnSync("sha256sum", [file], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim().split(/\s+/)[0];
}

function readParEntry(par: string, name: string): Buffer {
  const script = [
    "import sys, zipfile",
    "sys.stdout.buffer.write(zipfile.ZipFile(sys.argv[1]).read(sys.argv[2]))"
  ].join("\n");
  const result = spawnSync("python3", ["-B", "-c", script, par, name], {
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024
  });
  expect(result.status, result.stderr?.toString("utf8")).toBe(0);
  return result.stdout;
}

function countOccurrences(source: string, marker: string): number {
  let count = 0;
  let start = 0;
  while (true) {
    const index = source.indexOf(marker, start);
    if (index === -1) return count;
    count += 1;
    start = index + marker.length;
  }
}

function harnessContains(harness: string, marker: string): boolean {
  const result = spawnSync("grep", ["-a", "-F", "-q", marker, harness]);
  return result.status === 0;
}

const roots = candidateRoots();
const installed = roots.find(root => existsSync(path.join(root, "agy_acp_server.par")) && existsSync(path.join(root, "localharness_external")));

describe.skipIf(installed === undefined)("installed 1.5.2 retry source pin", () => {
  const root = installed ?? path.join(os.tmpdir(), "missing-official-kernel");
  const par = path.join(root, "agy_acp_server.par");
  const harness = path.join(root, "localharness_external");

  it("matches the production PAR and harness pins", () => {
    expect(sha256File(par)).toBe(PRODUCTION_KERNEL_COMPAT_PINS.parSha256);
    expect(sha256File(harness)).toBe(PRODUCTION_KERNEL_COMPAT_PINS.externalHarnessSha256);
  });

  it("keeps the server control preimage untouched and the patch markers unique", () => {
    const server = readParEntry(par, `${ACP_SERVER_DIRECTORY}/server.py`);
    const proxy = readParEntry(par, `${ACP_SERVER_DIRECTORY}/proxy_agent_config.py`);
    const local = readParEntry(par, `${SDK_DIRECTORY}/local_connection.py`);
    const serverHash = spawnSync("sha256sum", { input: server, encoding: "utf8" });
    expect(serverHash.stdout.trim().split(/\s+/)[0]).toBe(PRODUCTION_KERNEL_COMPAT_PINS.targets.serverControl.preimageSha256);
    const proxyHash = spawnSync("sha256sum", { input: proxy, encoding: "utf8" });
    expect(proxyHash.stdout.trim().split(/\s+/)[0]).toBe(PRODUCTION_KERNEL_COMPAT_PINS.targets.proxyAgentConfig.preimageSha256);

    const proxyText = proxy.toString("utf8");
    expect(countOccurrences(proxyText, "  def create_strategy(\n      self, *, tool_runner: Any, hook_runner: Any\n  ) -> sdk_connection_module.ConnectionStrategy:\n")).toBe(1);
    expect(countOccurrences(proxyText, "    harness_config = super()._build_harness_config()\n")).toBe(1);

    const localText = local.toString("utf8");
    expect(countOccurrences(localText, "  def _drain():\n")).toBe(1);
    expect(countOccurrences(localText, "logging.info(\"harness stderr: %s\", line)")).toBe(1);
  });

  it("ships the planner retry decision template in the pinned harness", () => {
    // klog assembles the "planner_generator.go:359]" header at the call site,
    // so only the pinned harness template itself is a stable binary string.
    expect(harnessContains(harness, "Encountered retryable api error. retrying in ")).toBe(true);
  });
});
