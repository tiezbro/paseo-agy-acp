// ACP `authenticate` (v1 root method): confirm keyring login after terminal auth,
// or succeed immediately when already signed in.
// Docs: https://agentclientprotocol.com/protocol/v1/authentication

import { RequestError } from "@agentclientprotocol/sdk";
import type { AuthenticateRequest, AuthenticateResponse } from "@agentclientprotocol/sdk";
import { AUTH_REQUIRED_MESSAGE, isAgyAuthenticated, isKnownAuthMethodId, v1AuthMethods } from "../agy/auth.js";
import type { AgyCliBackend, AgyCliConfig } from "../agy/cli.js";

export async function handleAuthenticate(
  params: AuthenticateRequest,
  backend: AgyCliBackend,
  config: AgyCliConfig,
  ensureAgyReady: () => Promise<string | null>
): Promise<AuthenticateResponse> {
  await ensureAgyReady();
  if (!isKnownAuthMethodId(params.methodId)) {
    throw RequestError.invalidParams({ methodId: params.methodId }, `Unknown auth method: ${params.methodId}`);
  }
  const status = await isAgyAuthenticated(backend, config);
  if (status.ok) return {};
  console.error(`[agy-acp] auth required: ${status.reason}`);
  throw RequestError.authRequired({ authMethods: v1AuthMethods() }, AUTH_REQUIRED_MESSAGE);
}
