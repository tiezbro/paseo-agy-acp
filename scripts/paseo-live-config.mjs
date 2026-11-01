import { writeFile, rm } from "node:fs/promises";
import path from "node:path";

// 复用已登录账号目录；不复制源配置中的 API key、OAuth token 或任意 provider 选项。
const environmentNames = ["PASEO_AGY_ACP_OFFICIAL_BIN", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
  "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"];

export function liveProviderEnvironment(source = {}) {
  return Object.fromEntries(environmentNames.filter(name => typeof source[name] === "string")
    .map(name => [name, source[name]]));
}

export async function withRedactedLiveConfig(home, persisted, run) {
  const file = path.join(home, "config.json");
  const safe = structuredClone(persisted);
  for (const provider of Object.values(safe.agents.providers)) {
    if (provider.env) provider.env = Object.fromEntries(Object.keys(provider.env).map(name => [name, "[REDACTED]"]));
  }
  try {
    await writeFile(file, JSON.stringify(safe, null, 2), { encoding: "utf8", mode: 0o600 });
    return await run();
  } finally {
    // 包括创建 daemon、启动和停止失败的路径；磁盘上不保留运行时环境配置。
    await rm(file, { force: true });
  }
}
