import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { acpEnvironment, commandEnvironment, quotaScratch } from "../scripts/quota-install-environment.mjs";

test("临时 provider 配置只包含 ACP 路径，不落盘进程环境和代理凭据", () => {
  const inherited = { HOME: "/home/account", PATH: "/bin", GEMINI_HOME: "/acp-a", UNRELATED_SECRET: "do-not-copy", OPENAI_API_KEY: "do-not-copy", NODE_OPTIONS: "do-not-copy", HTTPS_PROXY: "https://user:password@proxy" };
  const provider = { GEMINI_HOME: "/acp-b", PASEO_AGY_ACP_OFFICIAL_BIN: "/kernel", EXTRA_TOKEN: "do-not-copy" };
  assert.deepEqual(acpEnvironment(inherited, provider), { HOME: "/home/account", GEMINI_HOME: "/acp-b", PASEO_AGY_ACP_OFFICIAL_BIN: "/kernel" });
  const transport = commandEnvironment(inherited);
  assert.equal(transport.HTTPS_PROXY, inherited.HTTPS_PROXY);
  for (const key of ["UNRELATED_SECRET", "OPENAI_API_KEY", "NODE_OPTIONS", "EXTRA_TOKEN"]) assert.equal(transport[key], undefined);
});

for (const failed of [false, true]) test(`临时内容在停止 daemon ${failed ? "失败" : "成功"}时都删除`, () => {
  let stopped = 0;
  const scratch = quotaScratch(tmpdir(), () => { stopped++; if (failed) throw Error("synthetic stop failure"); });
  mkdirSync(scratch.area + "/daemon");
  writeFileSync(scratch.area + "/daemon/config.json", "synthetic-private-test-data", "utf8");
  try {
    if (failed) assert.throws(() => scratch.cleanup(), /synthetic/); else scratch.cleanup();
    assert.equal(existsSync(scratch.area), false);
    scratch.cleanup(); assert.equal(stopped, 1);
  } finally { rmSync(scratch.area, { recursive: true, force: true }); }
});
