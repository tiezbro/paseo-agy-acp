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
    await writeFile(adapter, `import{writeFileSync}from'node:fs';if(process.argv.includes('--version')){process.stdout.write(JSON.stringify({name:'paseo-agy-acp',version:'2.10.0',capabilities:{accountQuota:1}}));}else{writeFileSync(process.env.TEST_TRACE,JSON.stringify({args:process.argv.slice(2),geminiHome:process.env.GEMINI_HOME}), 'utf8');process.stdout.write(JSON.stringify(${JSON.stringify(expected)}));}`, "utf8");
    const source = createUsageSource();
    const launch = { command: process.execPath, args: [adapter], env: { ...process.env, TEST_TRACE: trace, GEMINI_HOME: "/only-acp-account", ANTIGRAVITY_HOME: "/never-cli-account" } };
    const [account] = await source.discover({ kind: "session", provider: "paseo-agy-acp", env: launch.env, launch });
    assert.deepEqual(await source.fetch(account.input), expected);
    assert.deepEqual(JSON.parse(await readFile(trace, "utf8")), { args: ["--usage"], geminiHome: "/only-acp-account" });
    await assert.rejects(source.fetch({ locator: "unknown" }), /已失效/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("旧入口和畸形能力只收到安全预检，绝不进入普通 ACP", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "paseo-quota-old-"));
  try {
    const adapter = path.join(directory, "old-adapter.mjs");
    const trace = path.join(directory, "trace");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(directory, "daemon"));
    const configPath = path.join(directory, "daemon", "config.json");
    for (const response of ["2.10.0", "{}", '{"name":"paseo-agy-acp","version":"2.11.0","capabilities":{"accountQuota":2}}', "__exit__", "__hang__"]) {
      await writeFile(trace, "", "utf8");
      await writeFile(adapter, `import{appendFileSync}from'node:fs';appendFileSync(process.env.TEST_TRACE,JSON.stringify(process.argv.slice(2))+'\\n','utf8');if(process.argv.includes('--version')){const response=${JSON.stringify(response)};if(response==='__exit__')process.exit(7);else if(response==='__hang__')setInterval(()=>{},1000);else console.log(response)}else{appendFileSync(process.env.TEST_TRACE,'ORDINARY_ACP_STARTED\\n','utf8')}`, "utf8");
      const source = createUsageSource();
      const launch = { command: process.execPath, args: [adapter], env: { ...process.env, TEST_TRACE: trace, PASEO_HOME: path.join(directory, "daemon") } };
      for (const overridden of [true, false]) {
        await writeFile(configPath, JSON.stringify({ agents: { providers: { "paseo-agy-acp": overridden ? { command: [process.execPath, adapter] } : {} } } }), "utf8");
        const [account] = await source.discover({ kind: "global", launch });
        await assert.rejects(source.fetch(account.input), error => {
          assert.match(error.message, overridden ? /provider 指定的适配器路径/ : /daemon PATH 实际解析的适配器/);
          assert.ok(error.message.includes(overridden ? adapter : process.execPath));
          assert.match(error.message, /仅更新 Paseo 插件无效/);
          return true;
        });
      }
      const requests = (await readFile(trace, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(requests, [["--version", "--capabilities"], ["--version", "--capabilities"]]);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
