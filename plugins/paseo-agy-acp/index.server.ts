import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import { createUsageSource } from "./server/usage.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(runAcpProvider({
    id: "paseo-agy-acp",
    label: "Antigravity ACP",
    description: "官方 ACP 内核与独立 ACP 账号额度",
    command: ["paseo-agy-acp"],
  }));
  server.registerUsageSource(createUsageSource());
  return () => {};
}
