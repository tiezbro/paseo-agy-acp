import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { McpProtocolBridge, bridgeOfficialMcpServers, downgradeMcpInitializeBody, downgradeMcpProtocolVersion } from "../ACP Connector/official-kernel/mcp-protocol-bridge.js";

const bridges: McpProtocolBridge[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("MCP protocol bridge", () => {
  it("leaves an already accepted protocol version unchanged", () => {
    expect(downgradeMcpProtocolVersion("2025-11-25")).toBe("2025-11-25");
    expect(downgradeMcpProtocolVersion("2025-06-18")).toBe("2025-06-18");
  });

  it("forwards only http and https MCP server URLs", async () => {
    const bridged = await bridgeOfficialMcpServers({
      mcpServers: [
        { name: "local", type: "stdio", command: "paseo" },
        { name: "paseo", type: "sse", url: "http://127.0.0.1:9/mcp" }
      ]
    });
    const servers = (bridged as { mcpServers: Array<{ url?: string; command?: string }> }).mcpServers;
    expect(servers[0]).toEqual({ name: "local", type: "stdio", command: "paseo" });
    expect(servers[1]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/b\/[a-f0-9]{16}\/mcp$/);
  });

  it("downgrades the harness protocol version before forwarding to Paseo", async () => {
    expect(downgradeMcpProtocolVersion("2026-07-28")).toBe("2025-11-25");
    const body = downgradeMcpInitializeBody(
      Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } })),
      "application/json"
    );
    expect(JSON.parse(body.toString("utf8")).params.protocolVersion).toBe("2025-11-25");

    const seen: Array<{ version: string | undefined; body: string }> = [];
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const version = request.headers["mcp-protocol-version"];
        seen.push({ version: Array.isArray(version) ? version[0] : version, body: Buffer.concat(chunks).toString("utf8") });
        if (version === "2026-07-28") {
          response.writeHead(400, { "content-type": "application/json" }).end(
            JSON.stringify({ error: "Unsupported protocol version: 2026-07-28" })
          );
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" }).end(
          `event: endpoint\ndata: http://127.0.0.1:${(upstream.address() as { port: number }).port}/mcp/message\n\n`
        );
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    closers.push(() => new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())));
    const port = (upstream.address() as { port: number }).port;

    const bridge = new McpProtocolBridge();
    bridges.push(bridge);
    const localUrl = await bridge.register(`http://127.0.0.1:${port}/mcp/agents?caller=1`);
    const response = await fetch(localUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "2026-07-28" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } })
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(seen).toEqual([{
      version: "2025-11-25",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })
    }]);
    expect(text).toBe(
      `event: endpoint\ndata: ${new URL(localUrl).origin}/b/${new URL(localUrl).pathname.split("/")[2]}/mcp/message\n\n`
    );
  });
});
