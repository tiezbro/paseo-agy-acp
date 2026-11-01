import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { liveProviderEnvironment, withRedactedLiveConfig } from "../scripts/paseo-live-config.mjs";

for (const failure of ["none", "create", "start", "stop"]) {
  test(`真实验收配置脱敏并删除：${failure}`, async t => {
    const parent = path.resolve("node_modules/.cache");
    await mkdir(parent, { recursive: true });
    const home = await mkdtemp(path.join(parent, "live-config-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const sensitive = "private-proxy-value-" + failure;
    const environment = liveProviderEnvironment({ HTTPS_PROXY: sensitive,
      PASEO_AGY_ACP_OFFICIAL_BIN: "/private/kernel", API_KEY: "must-not-copy", OAUTH_TOKEN: "must-not-copy",
      ARBITRARY_SETTING: "must-not-copy", HTTP_PROXY: null });
    assert.deepEqual(environment, { PASEO_AGY_ACP_OFFICIAL_BIN: "/private/kernel", HTTPS_PROXY: sensitive });
    const persisted = { agents: { providers: { test: { env: environment } } } };
    const run = withRedactedLiveConfig(home, persisted, async () => {
      const bytes = await readFile(path.join(home, "config.json"), "utf8");
      assert.ok(!bytes.includes(sensitive));
      assert.ok(!bytes.includes("/private/kernel"));
      assert.deepEqual(JSON.parse(bytes).agents.providers.test.env,
        { PASEO_AGY_ACP_OFFICIAL_BIN: "[REDACTED]", HTTPS_PROXY: "[REDACTED]" });
      if (process.platform !== "win32") assert.equal((await stat(path.join(home, "config.json"))).mode & 0o777, 0o600);
      // 运行时内存值可供启动使用；写盘脱敏不改变它。
      assert.equal(persisted.agents.providers.test.env.HTTPS_PROXY, sensitive);
      if (failure !== "none") throw new Error(failure);
      return "passed";
    });
    if (failure === "none") assert.equal(await run, "passed");
    else await assert.rejects(run, new RegExp(failure));
    await assert.rejects(stat(path.join(home, "config.json")), { code: "ENOENT" });
  });
}
