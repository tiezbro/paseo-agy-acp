import { isRecord } from "./json-rpc.js";

interface HeaderPair {
  name: string;
  value: string;
}

function toHeaderArray(value: unknown): HeaderPair[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const name = typeof entry.name === "string" ? entry.name : typeof entry.key === "string" ? entry.key : "";
      const headerValue = typeof entry.value === "string" ? entry.value : "";
      return name ? [{ name, value: headerValue }] : [];
    });
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([name, headerValue]) =>
      typeof headerValue === "string" ? [{ name, value: headerValue }] : []
    );
  }
  return [];
}

function rewriteMcpServer(server: unknown): unknown {
  if (!isRecord(server)) return server;
  const next: Record<string, unknown> = { ...server };
  if (next.type === "http") next.type = "sse";
  if (next.headers === undefined || (isRecord(next.headers) && !Array.isArray(next.headers))) {
    next.headers = toHeaderArray(next.headers);
  } else if (Array.isArray(next.headers)) {
    next.headers = toHeaderArray(next.headers);
  }
  return next;
}

export function rewriteMcpServers(params: unknown): unknown {
  if (!isRecord(params)) return params;
  const servers = params.mcpServers;
  if (!Array.isArray(servers)) return params;
  return { ...params, mcpServers: servers.map(rewriteMcpServer) };
}
