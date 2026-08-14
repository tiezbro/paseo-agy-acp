// ACP `auth/login` (v2): same keyring-login confirmation as v1 `authenticate`.
// Docs: https://agentclientprotocol.com/protocol/v1/authentication

import type { LoginAuthRequest, LoginAuthResponse } from "@agentclientprotocol/sdk/experimental/v2";
import type { AgyCliBackend, AgyCliConfig } from "../../agy/cli.js";
import { handleAuthenticate } from "../authenticate.js";

export async function handleLoginAuth(
  params: LoginAuthRequest,
  backend: AgyCliBackend,
  config: AgyCliConfig,
  ensureAgyReady: () => Promise<string | null>
): Promise<LoginAuthResponse> {
  return handleAuthenticate({ methodId: params.methodId }, backend, config, ensureAgyReady);
}
