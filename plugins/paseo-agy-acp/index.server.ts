import type { PluginServerContext } from "@getpaseo/plugin/server";
import { runAcpProvider } from "@getpaseo/plugin/server/acp";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(runAcpProvider({
    id: "paseo-agy-acp",
    label: "Antigravity ACP",
    description: "通过官方 ACP 内核运行 Antigravity agent",
    command: ["paseo-agy-acp"],
  }));
  return () => {};
}
