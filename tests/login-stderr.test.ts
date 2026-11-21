import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { runOfficialLogin } from "../ACP Connector/official-kernel/login.js";

describe("官方内核登录输出兼容", () => {
  it.each(["stdout", "stderr", "stderr-split", "both", "stderr-rejected"])(
    "%s 中的授权链接只提示一次，收到回调后仍以 authenticate 响应为准",
    async outputMode => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "paseo-login-stderr-"));
      const kernel = path.join(directory, "kernel.mjs");
      const signal = path.join(directory, "callback-received");
      let callbackCount = 0;
      const server = createServer((_request, response) => {
        callbackCount++;
        writeFileSync(signal, "received", "utf8");
        response.end("Authentication successful");
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing test callback address");
      writeFileSync(kernel, `#!/usr/bin/env node
import { existsSync } from "node:fs";
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
const mode = process.env.TEST_LOGIN_OUTPUT;
const warning = ${JSON.stringify(String.raw`/kernel/google3/third_party/py/google/genai/types.py:18270: SyntaxWarning: "\/" is an invalid escape sequence. Such sequences will not work in the future. Did you mean "\\/"? A raw string is also an option.`)};
const source = ${JSON.stringify('  description="""Output only. The original name of the uploaded file, taken from the `Content-Disposition` header on upload. Between 1 and 255 characters. Control characters and the characters `<>:"|?*\\/` are not accepted.""",')};
process.stderr.write(warning.slice(0, 37));
process.stderr.write(warning.slice(37) + "\\n" + source + "\\n");
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...result }) + "\\n");
lines.on("line", line => {
  const request = JSON.parse(line);
  if (request.method === "initialize") return reply(request.id, { result: {} });
  if (request.method !== "authenticate") return;
  process.stderr.write("Diagnostic documentation: https://example.test/docs\\n");
  const prompt = "Open the following link to authenticate the ACP server: https://accounts.example/authorize\\n";
  if (mode === "stdout" || mode === "both") process.stdout.write(prompt);
  if (mode === "stderr-split") {
    process.stderr.write(prompt.slice(0, 41));
    setTimeout(() => process.stderr.write(prompt.slice(41)), 10);
  } else if (mode !== "stdout") {
    process.stderr.write(prompt);
  }
  const deadline = Date.now() + 750;
  const poll = setInterval(() => {
    if (!existsSync(process.env.TEST_CALLBACK_SIGNAL) && Date.now() < deadline) return;
    clearInterval(poll);
    if (!existsSync(process.env.TEST_CALLBACK_SIGNAL)) {
      reply(request.id, { error: { code: -32603, message: "callback not received" } });
    } else if (mode === "stderr-rejected") {
      reply(request.id, { error: { code: -32603, message: "Internal error" } });
    } else {
      reply(request.id, { result: {} });
    }
  }, 10);
});
`, "utf8");
      chmodSync(kernel, 0o755);
      const input = new PassThrough();
      const output: string[] = [];
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(chunk => {
        const text = String(chunk);
        output.push(text);
        if (text.includes("Paste the OAuth callback URL to finish login:")) {
          input.write(`http://127.0.0.1:${address.port}/?code=example\n`);
        }
        return true;
      });
      try {
        const code = await runOfficialLogin({
          ...process.env, PASEO_AGY_ACP_OFFICIAL_BIN: kernel,
          TEST_CALLBACK_SIGNAL: signal, TEST_LOGIN_OUTPUT: outputMode
        }, "test", input);
        expect(code).toBe(outputMode === "stderr-rejected" ? 1 : 0);
        expect(callbackCount).toBe(1);
        expect(existsSync(signal)).toBe(true);
        const text = output.join("");
        expect(text.match(/Paste the OAuth callback URL to finish login:/g)).toHaveLength(1);
        expect(text.indexOf("https://accounts.example/authorize")).toBeLessThan(text.indexOf("Paste the OAuth callback URL"));
        expect(text).toContain("Diagnostic documentation: https://example.test/docs");
        expect(text).not.toContain("SyntaxWarning:");
        expect(text).not.toContain("description=");
        expect(text.includes("official kernel login succeeded")).toBe(outputMode !== "stderr-rejected");
      } finally {
        stderr.mockRestore();
        input.destroy();
        await new Promise<void>(resolve => server.close(() => resolve()));
        rmSync(directory, { recursive: true, force: true });
      }
    }
  );
});
