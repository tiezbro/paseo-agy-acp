import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { execCommand } from "@getpaseo/plugin/server";
import type { ProviderLaunch } from "@getpaseo/plugin/server/provider";
import { hashAccountKey, type UsageSourceRegistration } from "@getpaseo/plugin/server/usage";

const input = z.object({ locator: z.string() }).strict();
const window = z.object({
  id: z.string(), label: z.string(), shortLabel: z.string(), summary: z.boolean(),
  remainingPct: z.number().min(0).max(100).nullable(), usedPct: z.number().min(0).max(100).nullable(),
  resetsAt: z.iso.datetime().nullable(), durationSeconds: z.number().positive().optional(),
});
const report = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available"), windows: z.array(window).min(1) }),
  z.object({ status: z.literal("unavailable"), problem: z.object({ kind: z.literal("no_quota"), detail: z.string() }) }),
]);

/** 所有环境只保留在插件进程内，Paseo 拿到的 locator 不含凭据。 */
export function createUsageSource(): UsageSourceRegistration {
  const launches = new Map<string, ProviderLaunch>();
  return {
    id: "acp-quota", label: "Antigravity ACP", provider: "paseo-agy-acp", input,
    async discover(scope) {
      if (scope.kind === "session" && scope.provider !== "paseo-agy-acp") return [];
      if (!scope.launch) return [];
      const launch = scope.launch;
      const home = launch.env.HOME || launch.env.USERPROFILE || homedir();
      const configured = launch.env.GEMINI_HOME;
      const geminiHome = configured
        ? configured.replace(/^~(?=[/\\]|$)/, home)
        : path.join(home, ".gemini");
      // ACP 独立凭据目录；绝不使用 antigravity-cli 账号作为额度身份。
      const key = hashAccountKey(path.resolve(geminiHome, "antigravity-acp"));
      const locator = hashAccountKey(JSON.stringify(launch));
      launches.set(locator, launch);
      return [{ key, provider: "paseo-agy-acp", harness: "Antigravity ACP", input: { locator } }];
    },
    async fetch(value) {
      const launch = launches.get(input.parse(value).locator);
      if (!launch) throw new Error("ACP 额度启动配置已失效，请刷新");
      let stdout: string;
      try {
        ({ stdout } = await execCommand(launch.command, [...launch.args, "--usage"], {
          env: launch.env, timeout: 19_000, maxBuffer: 1024 * 1024,
        }));
      } catch {
        throw new Error("ACP 额度查询失败或超时，请在相同环境运行 paseo-agy-acp --usage 检查 ACP 登录状态");
      }
      try { return report.parse(JSON.parse(stdout)); }
      catch { throw new Error("ACP 返回了无法识别的额度数据，请检查适配器版本"); }
    },
  };
}
