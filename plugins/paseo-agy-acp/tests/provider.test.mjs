import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { test } from "node:test";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";

test("普通 provider 保留 Paseo 原生状态判断，不挂额度能力检查", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const directory = await mkdtemp(path.join(root, ".tmp-provider-contract-"));
  try {
    // Node 类型擦除不解析 .js -> .ts；仅为测试调整源码中的本地扩展名。
    const source = (await readFile(path.join(root, "index.server.ts"), "utf8"))
      .replace('"./server/usage.js"', JSON.stringify(pathToFileURL(path.join(root, "server/usage.ts")).href));
    const entry = path.join(directory, "index.server.ts"); await writeFile(entry, source, "utf8");
    let provider, usage;
    (await import(pathToFileURL(entry).href)).default({ registerProvider(value) { provider = value; }, registerUsageSource(value) { usage = value; } });
    const original = runAcpProvider({ id: "paseo-agy-acp", label: "Antigravity ACP", command: ["paseo-agy-acp"] });
    assert.equal(original.status, undefined, "锁定的 Paseo SDK 原生 provider 没有额度状态门禁");
    assert.equal(provider.status, original.status);
    assert.equal(typeof provider.connect, "function");
    assert.equal(typeof usage.fetch, "function");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
