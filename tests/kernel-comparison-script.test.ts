import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const folders: string[] = [];
const fakeKernel = String.raw`
import { createInterface } from "node:readline";
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const pending = new Map();
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: "fake", version: "test" }, agentCapabilities: {} } });
  else if (m.method === "session/new") send(process.env.COMPARE_FIXTURE_RPC_FAIL
    ? { id: m.id, error: { code: -32603, message: "session upstream Error 503 private-error-detail" } }
    : { id: m.id, result: { sessionId: "s", models: { currentModelId: "test-model" }, configOptions: [{ id: "model", category: "model", type: "select", currentValue: "test-model", options: [{ value: "test-model", name: "test-model" }] }] } });
  else if (m.method === "session/prompt") {
    const timer = setTimeout(() => {
      pending.delete(m.id);
      send({ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: process.env.COMPARE_FIXTURE_FAIL ? "unexpected" : "ACP_KERNEL_OK" } } } });
      send({ id: m.id, result: { stopReason: "end_turn" } });
    }, Number(process.env.COMPARE_FIXTURE_DELAY ?? 300));
    pending.set(m.id, timer);
  } else if (m.method === "session/cancel") {
    for (const [id, timer] of pending) { clearTimeout(timer); send({ id, result: { stopReason: "cancelled" } }); }
    pending.clear();
  } else if (m.id !== undefined) send({ id: m.id, result: {} });
});
`;

async function probe(extra: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const folder = mkdtempSync(path.join(os.tmpdir(), "kernel-comparison-test-"));
  folders.push(folder);
  const kernel = path.join(folder, "kernel");
  writeFileSync(kernel, `#!${process.execPath}\n${fakeKernel}`, { mode: 0o700 });
  const output = path.join(folder, "report.json");
  const result = await execute(process.execPath, ["scripts/compare-kernel.mjs", "--run", "--kernel", kernel, "--concurrency", "3", "--timeout-ms", "15000", "--output", output, ...extra], {
    cwd: process.cwd(), timeout: 25000,
    env: { ...process.env, AGY_ACP_ADMISSION_ENABLED: "true", AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS: "1", ...env }
  }).then(() => 0, (error: { code: number }) => error.code);
  const report = JSON.parse(readFileSync(output, "utf8"));
  folders.push(report.experiment);
  return { result, report };
}

afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

describe.skipIf(process.platform !== "linux")("isolated native/adapter comparison", () => {
  it("compares the same model through native and adapter processes", async () => {
    const { result, report } = await probe();
    expect(result).toBe(0);
    expect(report.groups.map((g: { group: string }) => g.group)).toEqual(["native", "adapter"]);
    for (const group of report.groups) {
      expect(group.rows).toHaveLength(3);
      expect(group.rows.every((r: { status: string; model: string }) => r.status === "passed" && r.model === "test-model")).toBe(true);
    }
  }, 25000);

  it("cancels all independent prompts through both paths", async () => {
    const { result, report } = await probe(["--cancel-after-ms", "1000"], { COMPARE_FIXTURE_DELAY: "3000" });
    expect(result).toBe(0);
    for (const group of report.groups) {
      expect(group.rows.every((r: { status: string; cancelAckMs: number }) => r.status === "cancelled" && r.cancelAckMs < 2000)).toBe(true);
    }
  }, 25000);

  it("records the failing RPC stage and fixed error terms without saving its body", async () => {
    const { result, report } = await probe(["--concurrency", "1"], { COMPARE_FIXTURE_RPC_FAIL: "1" });
    expect(result).toBe(1);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]).toMatchObject({ setupError: "rpc-error", rpcCode: -32603, rpcMethod: "session/new", rpcTerms: ["503", "session"] });
    expect(JSON.stringify(report)).not.toContain("private-error-detail");
  }, 25000);

  it("stops on an unexpected response without trying the remaining groups", async () => {
    const { result, report } = await probe([], { COMPARE_FIXTURE_FAIL: "1" });
    expect(result).toBe(1);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0].rows.every((r: { status: string }) => r.status === "unexpected-result")).toBe(true);
  }, 25000);
});
