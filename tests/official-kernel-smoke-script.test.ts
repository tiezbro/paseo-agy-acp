import { execFile } from "node:child_process";
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")("冒烟脚本使用 Paseo 的 clientCapabilities 握手", async () => {
  const directory = await mkdtemp(path.join(process.cwd(), ".tmp-smoke-contract-"));
  try {
    const kernel = path.join(directory, "kernel.mjs");
    const trace = path.join(directory, "requests.ndjson");
    await copyFile(path.resolve("tests/helpers/paseo-contract-kernel.mjs"), kernel);
    await chmod(kernel, 0o755);
    const { stdout } = await promisify(execFile)(process.execPath, ["scripts/official-kernel-smoke.mjs"], {
      timeout: 10_000, env: { ...process.env, HOME: directory, PASEO_HOME: directory,
        PASEO_AGENT_ID: "", PASEO_AGENT_CWD: "", AGY_ACP_ADMISSION_ENABLED: "false",
        PASEO_AGY_ACP_OFFICIAL_BIN: kernel, PASEO_CONTRACT_TRACE: trace }
    });
    expect(JSON.parse(stdout)).toMatchObject({ ok: true, agentInfo: { name: "agy-acp", version: "2.7.1" } });
    const messages = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const initialize = messages.find(message => message.method === "initialize");
    expect(initialize.params.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: true });
    expect(initialize.params).not.toHaveProperty("capabilities");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
