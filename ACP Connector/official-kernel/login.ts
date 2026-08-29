import {
  isJsonRpcFailure,
  isJsonRpcSuccess,
  type JsonRpcId,
  type JsonRpcMessage
} from "./json-rpc.js";
import { createNdjsonParser, encodeNdjson } from "./ndjson.js";
import { spawnOfficialKernel } from "./spawn.js";

const AUTHENTICATE_TIMEOUT_MS = 10 * 60_000;

export async function runOfficialLogin(environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  process.stderr.write(
    "Starting official Antigravity ACP login (authenticate methodId=oauth-personal).\n"
  );
  const child = spawnOfficialKernel(environment);
  const pending = new Map<JsonRpcId, (message: JsonRpcMessage) => void>();
  let nextId = 1;

  const parse = createNdjsonParser((message) => {
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
  });
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
      clientInfo: { name: "agy-acp", version: "2.2.0.0" },
      capabilities: {}
    });
    if (isJsonRpcFailure(initialized)) {
      throw new Error(initialized.error.message);
    }
    const authenticated = await request("authenticate", { methodId: "oauth-personal" });
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

function summarizeAuthUpdate(method: string, params: unknown): string {
  if (typeof params === "object" && params !== null) {
    return `official kernel: ${method} ${JSON.stringify(params).slice(0, 400)}`;
  }
  return `official kernel: ${method}`;
}
