import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import { assertQuotaCapability, createUsageSource } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  const provider = runAcpProvider({
    id: "paseo-agy-acp",
    label: "Antigravity ACP",
    description: "官方 ACP 内核与独立 ACP 账号额度",
    command: ["paseo-agy-acp"],
  });
  server.registerProvider({ ...provider,
    async status(request) {
      if (!request.launch) return { available: false, diagnostic: "未找到 ACP 适配器，请检查 daemon PATH 或 provider command" };
      try { await assertQuotaCapability(request.launch); }
      catch (error) { return { available: false, diagnostic: error instanceof Error ? error.message : String(error) }; }
      return provider.status ? provider.status(request) : { available: true };
    },
  });
  server.registerUsageSource(createUsageSource());
  return () => {};
}
