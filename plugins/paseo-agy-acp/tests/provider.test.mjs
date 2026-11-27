import assert from "node:assert/strict";
import { test } from "node:test";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import contribute from "../index.server.ts";

test("插件保留 Paseo 原生 provider 注册，不再注册后台自动用量数据源", () => {
  let provider;
  let usageRegistrations = 0;
  contribute({
    registerProvider(value) { provider = value; },
    registerUsageSource() { usageRegistrations += 1; },
  });
  const original = runAcpProvider({ id: "paseo-agy-acp", label: "Antigravity ACP", command: ["paseo-agy-acp"] });
  assert.equal(original.status, undefined, "锁定的 Paseo SDK 原生 provider 没有额度状态门禁");
  assert.equal(provider.id, "paseo-agy-acp");
  assert.equal(provider.status, original.status);
  assert.equal(typeof provider.connect, "function");
  assert.equal(usageRegistrations, 0, "不得注册会触发后台自动查询的用量数据源");
});
