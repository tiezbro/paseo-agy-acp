import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseAcpQuota, queryOfficialQuota } from "../ACP Connector/official-kernel/usage.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("ACP 账号额度解析", () => {
  it("区分会话 token、剩余额度和未提供的重置时间", () => {
    const result = parseAcpQuota("### Session Usage\n100 tokens\n### Quota Limits\n- **Gemini Models**\n  - **Weekly Limit Remaining:** 46% remaining (resets Dec 02, 2026, 09:05 UTC)\n  - **5h Limit Remaining:** 0% remaining\n");
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.windows[0]).toMatchObject({ label: "Gemini · Weekly", remainingPct: 46, usedPct: 54, durationSeconds: 604800, resetsAt: "2026-12-02T09:05:00.000Z" });
    expect(result.windows[1]).toMatchObject({ remainingPct: 0, usedPct: 100, durationSeconds: 18000, resetsAt: null });
  });
  it.each(["Not applicable for current authentication method.", "No quota limits reported.", "data not available yet"])("无额度不伪造 100%%：%s", text => {
    expect(parseAcpQuota(`### Quota Limits\n- ${text}`).status).toBe("unavailable");
  });
  it("后端错误和未知格式必须显式失败", () => {
    expect(() => parseAcpQuota("### Quota Limits\n- Unable to retrieve quota status (private-auth-secret)")).toThrow("ACP 内核查询账号额度失败");
    expect(() => parseAcpQuota("hello")).toThrow();
    expect(() => parseAcpQuota("### Quota Limits\n- **Gemini**\n  - **Weekly:** 101% remaining")).toThrow();
  });
  it("未知窗口、绝对数量和不可解析日期不推测", () => {
    const result = parseAcpQuota("### Quota Limits\n- **Other Models**\n  - **Daily:** 20% remaining (resets unknown)\n  - **Credits:** 10 units remaining");
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0].durationSeconds).toBeUndefined();
    expect(result.windows[0].resetsAt).toBeNull();
  });
});

// 假内核用可执行 shebang；Windows 的协议覆盖由普通 provider CI 承担。
describe.skipIf(process.platform === "win32")("独立 ACP 额度连接", () => {
  function environment(extra: NodeJS.ProcessEnv = {}) {
    const directory = mkdtempSync(path.join(tmpdir(), "acp-quota-test-"));
    directories.push(directory);
    const binary = path.join(directory, "quota-kernel.mjs");
    const helper = readFileSync(path.resolve("tests/helpers/quota-acp-kernel.mjs"), "utf8");
    writeFileSync(binary, helper.replace("#!/usr/bin/env node", `#!${process.execPath}`), "utf8");
    chmodSync(binary, 0o755);
    return { ...process.env, PASEO_AGY_ACP_OFFICIAL_BIN: binary, QUOTA_TEST_TRACE: path.join(directory, "trace"), ...extra };
  }
  it("只发送 ACP /usage，不 authenticate 或调用 agy CLI", async () => {
    const env = environment({ GEMINI_HOME: "/isolated-acp-account", ANTIGRAVITY_HOME: "/different-cli-account" });
    const result = await queryOfficialQuota(env);
    expect(result.status).toBe("available");
    if (result.status !== "available") return;
    expect(result.windows).toHaveLength(4);
    expect(result.windows[3]).toMatchObject({ remainingPct: null, usedPct: null, resetsAt: null });
    const requests = readFileSync(env.QUOTA_TEST_TRACE!, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(requests.map(request => request.method)).toEqual(["initialize", "session/new", "session/prompt"]);
    expect(requests[2].params.prompt).toEqual([{ type: "text", text: "/usage" }]);
    expect(requests[1].params.mcpServers).toEqual([]);
    expect(() => readFileSync(path.join(requests[1].params.cwd, "anything"), "utf8")).toThrow();
  });
  it("未声明 usage 时不发任何 prompt", async () => {
    const env = environment({ QUOTA_TEST_NO_COMMAND: "1" });
    await expect(queryOfficialQuota(env)).rejects.toThrow("未声明 /usage");
    expect(readFileSync(env.QUOTA_TEST_TRACE!, "utf8")).not.toContain("session/prompt");
  });
  it("认证失败不泄漏上游消息", async () => {
    await expect(queryOfficialQuota(environment({ QUOTA_TEST_FAIL: "1" }))).rejects.toThrow("请检查 ACP 登录状态");
  });
  it("超时终止查询", async () => {
    await expect(queryOfficialQuota(environment({ QUOTA_TEST_HANG: "1" }), 300)).rejects.toThrow("超时");
  });
});
