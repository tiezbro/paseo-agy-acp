import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createUsageSource } from "../server/usage.ts";

test("只发现 ACP provider，账号目录不同则额度身份不同", async () => {
  const source = createUsageSource();
  const launch = { command: "node", args: ["adapter"], env: { HOME: "/home/example", GEMINI_HOME: "/accounts/acp-a", ANTIGRAVITY_HOME: "/accounts/cli" } };
  assert.deepEqual(await source.discover({ kind: "session", provider: "antigravity", env: {}, launch }), []);
  const [first] = await source.discover({ kind: "global", launch });
  const [same] = await source.discover({ kind: "global", launch: { ...launch, env: { ...launch.env, ANTIGRAVITY_HOME: "/another-cli" } } });
  const [other] = await source.discover({ kind: "global", launch: { ...launch, env: { ...launch.env, GEMINI_HOME: "/accounts/acp-b" } } });
  assert.equal(first.key, same.key);
  assert.notEqual(first.key, other.key);
  assert.ok(!JSON.stringify(first).includes("/accounts/"));
  assert.equal(source.provider, "paseo-agy-acp");
});

test("额度刷新使用完整 ACP launch、--usage 和 ACP 环境", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-quota-plugin-"));
  try {
    const adapter = path.join(directory, "adapter.mjs");
    const trace = path.join(directory, "trace.json");
    const expected = { status: "available", windows: [{ id: "gemini-weekly", label: "Gemini · Weekly", shortLabel: "Gemini wk", summary: true, remainingPct: 46, usedPct: 54, resetsAt: null, durationSeconds: 604800 }] };
    await writeFile(adapter, `import{writeFileSync}from'node:fs';writeFileSync(process.env.TEST_TRACE,JSON.stringify({args:process.argv.slice(2),geminiHome:process.env.GEMINI_HOME}), 'utf8');process.stdout.write(JSON.stringify(${JSON.stringify(expected)}));`, "utf8");
    const source = createUsageSource();
    const launch = { command: process.execPath, args: [adapter], env: { ...process.env, TEST_TRACE: trace, GEMINI_HOME: "/only-acp-account", ANTIGRAVITY_HOME: "/never-cli-account" } };
    const [account] = await source.discover({ kind: "session", provider: "paseo-agy-acp", env: launch.env, launch });
    assert.deepEqual(await source.fetch(account.input), expected);
    assert.deepEqual(JSON.parse(await readFile(trace, "utf8")), { args: ["--usage"], geminiHome: "/only-acp-account" });
    await assert.rejects(source.fetch({ locator: "unknown" }), /已失效/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
