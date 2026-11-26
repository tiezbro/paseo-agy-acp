import { mkdtempSync, chmodSync, rmSync } from "node:fs";
import path from "node:path";

// 账号只由 ACP 自己的凭据目录解析。禁止 API key、令牌、NODE_OPTIONS 等无关值穿透。
export function acpEnvironment(inherited, provider = {}) {
  const result = {};
  for (const key of ["HOME", "USERPROFILE", "GEMINI_HOME", "PASEO_AGY_ACP_OFFICIAL_BIN"]) {
    const value = provider[key] ?? inherited[key];
    if (typeof value === "string" && value) result[key] = value;
  }
  return result;
}

// 仅用于子进程内存环境，不序列化到 daemon 配置。
export function commandEnvironment(inherited) {
  const result = {};
  for (const key of ["PATH", "HOME", "USERPROFILE", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TMP", "TEMP", "LANG", "LC_ALL",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"]) {
    if (typeof inherited[key] === "string") result[key] = inherited[key];
  }
  return result;
}

export function quotaScratch(root, stop) {
  const area = mkdtempSync(path.join(root, ".tmp-quota-install-"));
  chmodSync(area, 0o700);
  let cleaned = false;
  return { area, cleanup() {
    if (cleaned) return;
    cleaned = true;
    try { stop(); } finally { rmSync(area, { recursive: true, force: true }); }
  } };
}
