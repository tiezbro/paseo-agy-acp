import { isRecord } from "./json-rpc.js";

export const PRODUCT_AGENT_NAME = "agy-acp";
export const PRODUCT_AGENT_TITLE = "paseo-agy-acp (official Antigravity ACP kernel)";

export function overlayProductIdentity(result: unknown, version: string): unknown {
  if (!isRecord(result)) return result;
  const next: Record<string, unknown> = { ...result };
  const previousInfo = isRecord(next.agentInfo) ? next.agentInfo : {};
  next.agentInfo = {
    ...previousInfo,
    name: PRODUCT_AGENT_NAME,
    title: PRODUCT_AGENT_TITLE,
    version
  };
  return next;
}
