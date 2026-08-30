import { get } from "node:http";
import { createInterface } from "node:readline/promises";
import type { Readable } from "node:stream";
import {
  isJsonRpcFailure,
  isJsonRpcSuccess,
  type JsonRpcId,
  type JsonRpcMessage
} from "./json-rpc.js";
import { createNdjsonParser, encodeNdjson } from "./ndjson.js";
import { spawnOfficialKernel } from "./spawn.js";

const AUTHENTICATE_TIMEOUT_MS = 10 * 60_000;

export async function runOfficialLogin(
  environment: NodeJS.ProcessEnv = process.env,
  version = "0.0.0",
  input: Readable = process.stdin
): Promise<number> {
  process.stderr.write(
    "Starting official Antigravity ACP login (authenticate methodId=oauth-personal).\n"
  );
  // The official kernel prints the OAuth URL as ordinary stdout text. Its
  // stdout is a pipe here, so force Python to flush that prompt immediately.
  const child = spawnOfficialKernel({ ...environment, PYTHONUNBUFFERED: "1" });
  const pending = new Map<JsonRpcId, (message: JsonRpcMessage) => void>();
  let nextId = 1;
  let authenticationStarted = false;
  let promptCallback: Promise<void> | undefined;
  let rejectLogin: ((reason?: unknown) => void) | undefined;

  const parse = createNdjsonParser(
    (message) => {
      if ("method" in message && !("id" in message)) {
        const params = "params" in message ? message.params : undefined;
        process.stderr.write(`${summarizeAuthUpdate(message.method, params)}\n`);
        return;
      }
      if ("id" in message && pending.has(message.id)) {
        const settle = pending.get(message.id);
        pending.delete(message.id);
        settle?.(message);
      }
    },
    (line) => {
      process.stderr.write(`${formatLoginOutput(line)}\n`);
      if (authenticationStarted && !promptCallback && extractUrl(line)) {
        promptCallback = promptForCallbackUrl(input)
          .then(deliverOAuthCallback)
          .catch((error) => rejectLogin?.(error));
      }
    }
  );
  child.stdout.on("data", parse);

  const request = (method: string, params: unknown): Promise<JsonRpcMessage> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, AUTHENTICATE_TIMEOUT_MS);
      pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.stdin.write(encodeNdjson({ jsonrpc: "2.0", id, method, params }));
    });
  };

  try {
    const initialized = await request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "agy-acp", version },
      capabilities: {}
    });
    if (isJsonRpcFailure(initialized)) {
      throw new Error(initialized.error.message);
    }
    authenticationStarted = true;
    const authenticated = await Promise.race([
      request("authenticate", { methodId: "oauth-personal" }),
      new Promise<never>((_, reject) => {
        rejectLogin = reject;
      })
    ]);
    if (isJsonRpcFailure(authenticated)) {
      throw new Error(authenticated.error.message);
    }
    if (!isJsonRpcSuccess(authenticated) && !isJsonRpcFailure(authenticated)) {
      throw new Error("official authenticate returned an unexpected message");
    }
    process.stderr.write("official kernel login succeeded\n");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    return 1;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  }
}

function extractUrl(line: string): string | undefined {
  return line.match(/https?:\/\/\S+/)?.[0];
}

function formatLoginOutput(line: string): string {
  const url = extractUrl(line);
  if (!url || !line.startsWith("Open the following link to authenticate the ACP server:")) {
    return line;
  }
  return `${line.slice(0, line.indexOf(url)).trimEnd()}\n\n${url}\n`;
}

async function promptForCallbackUrl(input: Readable): Promise<string> {
  const readline = createInterface({ input, output: process.stderr });
  try {
    const callbackUrl = (await readline.question("\nPaste the OAuth callback URL to finish login: ")).trim();
    if (callbackUrl.length === 0) throw new Error("OAuth callback URL is required");
    return callbackUrl;
  } finally {
    readline.close();
  }
}

function deliverOAuthCallback(callbackUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return Promise.reject(new Error("OAuth callback URL is invalid"));
  }
  if (url.protocol !== "http:" || !isLoopbackHost(url.hostname)) {
    return Promise.reject(new Error("OAuth callback URL must use a local HTTP address"));
  }
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      response.resume();
      if ((response.statusCode ?? 500) >= 400) {
        reject(new Error(`OAuth callback returned HTTP ${response.statusCode}`));
      } else {
        resolve();
      }
    });
    request.setTimeout(10_000, () => request.destroy(new Error("OAuth callback timed out")));
    request.once("error", reject);
  });
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function summarizeAuthUpdate(method: string, params: unknown): string {
  if (typeof params === "object" && params !== null) {
    return `official kernel: ${method} ${JSON.stringify(params).slice(0, 400)}`;
  }
  return `official kernel: ${method}`;
}
