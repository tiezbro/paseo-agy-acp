import { homedir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
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
const quotaCapability = z.object({
  name: z.literal("paseo-agy-acp"), version: z.string().min(1),
  capabilities: z.object({ accountQuota: z.literal(1) }),
});

/** 只向错误提示暴露实际可执行文件及脚本路径，不回显其他启动参数或环境。 */
async function adapterLocation(launch: ProviderLaunch): Promise<string> {
  let overridden = launch.args.length > 0;
  try {
    const home = launch.env.PASEO_HOME || process.env.PASEO_HOME || path.join(homedir(), ".paseo");
    const config = JSON.parse(await readFile(path.join(home, "config.json"), "utf8"));
    overridden = Array.isArray(config.agents?.providers?.["paseo-agy-acp"]?.command);
  } catch { /* 无配置读取能力时按实际启动形态提示，并始终包含实际路径。 */ }
  const script = launch.args.find(arg => /\.(?:[cm]?js|ts)$/i.test(arg)) ??
    (/^(?:node|bun)(?:\.exe)?$/i.test(path.basename(launch.command)) && launch.args[0] && !launch.args[0].startsWith("-") ? launch.args[0] : undefined);
  return overridden
    ? `provider 指定的适配器路径 ${script ?? launch.command}（启动器 ${launch.command}）`
    : `daemon PATH 实际解析的适配器 ${launch.command}`;
}

export async function assertQuotaCapability(launch: ProviderLaunch): Promise<void> {
  let supported = false;
  try {
    const probe = await execCommand(launch.command, [...launch.args, "--version", "--capabilities"], {
      env: launch.env, timeout: 2_000, maxBuffer: 8192,
    });
    supported = quotaCapability.safeParse(JSON.parse(probe.stdout)).success;
  } catch { /* 旧版纯文本、错误和超时均拒绝继续发送 --usage。 */ }
  if (!supported) {
    throw new Error(`ACP 额度能力预检失败：${await adapterLocation(launch)} 不支持 accountQuota v1 或无法确认能力。请升级该适配器到包含额度查询的版本；仅更新 Paseo 插件无效。未发送 --usage，也未启动普通 ACP 查询链路。`);
  }
}

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
      // 不单独探测新开关：旧入口认识 --version，会打印版本并退出。
      // 每次刷新都重查，避免 PATH 或 command 更新后沿用旧能力缓存。
      await assertQuotaCapability(launch);
      let stdout: string;
      try {
        ({ stdout } = await execCommand(launch.command, [...launch.args, "--usage"], {
          env: launch.env, timeout: 17_000, maxBuffer: 1024 * 1024,
        }));
      } catch {
        throw new Error("ACP 额度查询失败或超时，请在相同环境运行 paseo-agy-acp --usage 检查 ACP 登录状态");
      }
      try { return report.parse(JSON.parse(stdout)); }
      catch { throw new Error("ACP 返回了无法识别的额度数据，请检查适配器版本"); }
    },
  };
}
