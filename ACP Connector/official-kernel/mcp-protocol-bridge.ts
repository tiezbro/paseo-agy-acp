import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { Transform } from "node:stream";
import { isRecord } from "./json-rpc.js";

const HARNESS_PROTOCOL_VERSION = "2026-07-28";
const PASEO_PROTOCOL_VERSION = "2025-11-25";

export function downgradeMcpProtocolVersion(value: string): string {
  return value === HARNESS_PROTOCOL_VERSION ? PASEO_PROTOCOL_VERSION : value;
}

export function downgradeMcpInitializeBody(body: Buffer, contentType: string): Buffer {
  if (!contentType.toLowerCase().includes("json")) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (!downgradeInitializeMessage(parsed)) return body;
  return Buffer.from(JSON.stringify(parsed));
}

function downgradeInitializeMessage(message: unknown): boolean {
  if (Array.isArray(message)) return message.some(downgradeInitializeMessage);
  if (!isRecord(message) || message.method !== "initialize" || !isRecord(message.params)) return false;
  if (message.params.protocolVersion !== HARNESS_PROTOCOL_VERSION) return false;
  message.params.protocolVersion = PASEO_PROTOCOL_VERSION;
  return true;
}

export class McpProtocolBridge {
  #server = createServer((request, response) => {
    void this.#forward(request, response);
  });
  #port = 0;
  readonly #upstreams = new Map<string, URL>();

  async start(): Promise<void> {
    if (this.#port !== 0) return;
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => {
        this.#server.removeListener("error", reject);
        const address = this.#server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("MCP protocol bridge did not bind a local port"));
          return;
        }
        this.#port = address.port;
        resolve();
      });
    });
  }

  async register(target: string): Promise<string> {
    await this.start();
    const upstream = new URL(target);
    if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
      throw new Error("MCP protocol bridge only forwards http and https servers");
    }
    const id = randomBytes(8).toString("hex");
    this.#upstreams.set(id, upstream);
    const local = new URL(`http://127.0.0.1:${this.#port}/b/${id}${upstream.pathname}`);
    local.search = upstream.search;
    return local.toString();
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.close((error) => error ? reject(error) : resolve());
    });
  }

  async #forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const incoming = new URL(request.url ?? "/", "http://127.0.0.1");
      const match = incoming.pathname.match(/^\/b\/([a-f0-9]{16})(\/.*)?$/);
      const bridgeId = match?.[1];
      const upstreamPath = match?.[2];
      const upstream = bridgeId ? this.#upstreams.get(bridgeId) : undefined;
      if (bridgeId === undefined || upstream === undefined) {
        response.writeHead(404).end();
        return;
      }
      const destination = new URL(upstream.origin);
      destination.pathname = upstreamPath && upstreamPath.length > 0 ? upstreamPath : "/";
      destination.search = incoming.search;
      const body = await readBody(request);
      const contentType = headerValue(request.headers["content-type"]);
      const forwardedBody = downgradeMcpInitializeBody(body, contentType);
      const headers = downgradeRequestHeaders(request.headers, destination, forwardedBody.length);
      const transport = destination.protocol === "https:" ? httpsRequest : httpRequest;
      const upstreamRequest = transport(destination, { method: request.method, headers });
      upstreamRequest.on("error", () => {
        if (!response.headersSent) response.writeHead(502).end();
        else response.end();
      });
      upstreamRequest.on("response", (upstreamResponse) => {
        const responseHeaders: OutgoingHttpHeaders = { ...upstreamResponse.headers };
        delete responseHeaders["transfer-encoding"];
        delete responseHeaders["content-length"];
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        const responseType = headerValue(upstreamResponse.headers["content-type"]);
        if (!shouldRewriteResponse(responseType)) {
          upstreamResponse.pipe(response);
          return;
        }
        upstreamResponse
          .pipe(replaceOriginStream(upstream.origin, `http://127.0.0.1:${this.#port}/b/${bridgeId}`))
          .pipe(response);
      });
      upstreamRequest.end(forwardedBody);
    } catch {
      if (!response.headersSent) response.writeHead(502).end();
    }
  }
}

let shared: McpProtocolBridge | undefined;

export async function bridgeOfficialMcpServers(params: unknown): Promise<unknown> {
  if (!isRecord(params) || !Array.isArray(params.mcpServers)) return params;
  const servers = [];
  for (const server of params.mcpServers) {
    if (!isRecord(server) || typeof server.url !== "string" || !/^https?:\/\//i.test(server.url)) {
      servers.push(server);
      continue;
    }
    shared ??= new McpProtocolBridge();
    servers.push({ ...server, url: await shared.register(server.url) });
  }
  return { ...params, mcpServers: servers };
}

function downgradeRequestHeaders(headers: IncomingHttpHeaders, destination: URL, contentLength: number): OutgoingHttpHeaders {
  const next: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (name === "host" || name === "connection" || name === "content-length" || name === "transfer-encoding") continue;
    if (name === "mcp-protocol-version") {
      const current = Array.isArray(value) ? value[0] : value;
      next[name] = downgradeMcpProtocolVersion(current);
      continue;
    }
    next[name] = value;
  }
  next.host = destination.host;
  next["content-length"] = contentLength;
  return next;
}

function replaceOriginStream(origin: string, local: string): Transform {
  let pending = "";
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending += chunk.toString("utf8");
      const suffix = originPrefixLength(pending, origin);
      const emit = pending.slice(0, pending.length - suffix).replaceAll(origin, local);
      pending = pending.slice(pending.length - suffix);
      callback(null, emit);
    },
    flush(callback) {
      callback(null, pending.replaceAll(origin, local));
    }
  });
}

function originPrefixLength(value: string, origin: string): number {
  const max = Math.min(origin.length - 1, value.length);
  for (let length = max; length > 0; length -= 1) {
    if (origin.startsWith(value.slice(value.length - length))) return length;
  }
  return 0;
}

function shouldRewriteResponse(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return type.includes("json") || type.includes("text/event-stream") || type.startsWith("text/");
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}
