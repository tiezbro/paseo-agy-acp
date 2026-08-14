// ACP `auth/logout` (v2): same best-effort agy TUI `/logout` as v1 `logout`.
// Docs: https://agentclientprotocol.com/protocol/v1/authentication#logging-out

import type { LogoutAuthRequest, LogoutAuthResponse } from "@agentclientprotocol/sdk/experimental/v2";
import type { AgyCliBackend, AgyCliConfig } from "../../agy/cli.js";
import { handleLogout } from "../logout.js";

export async function handleLogoutAuth(
  params: LogoutAuthRequest = {},
  backend: AgyCliBackend,
  config: AgyCliConfig,
  ensureAgyReady: () => Promise<string | null>
): Promise<LogoutAuthResponse> {
  return handleLogout(params, backend, config, ensureAgyReady);
}
