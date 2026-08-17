import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { client as acpClient, methods, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { buildSession } from "../ACP Connector/acp/session/setup.js";
import { AgyCliBackend } from "../ACP Connector/agy/cli.js";

const temporaryDirectories: string[] = [];
const repositoryRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const builtEntry = path.join(repositoryRoot, "dist/ACP Connector/main.js");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("admission production composition", () => {
  it("answers provider discovery before Paseo assigns the agent identity", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-admission-discovery-"));
    temporaryDirectories.push(directory);
    const agyBinary = path.join(directory, "agy");
    fs.writeFileSync(
      agyBinary,
      [
        "#!/usr/bin/env node",
        "if (process.argv.includes('--version')) {",
        "  process.stdout.write('1.1.13\\n');",
        "  process.exit(0);",
        "}",
        "if (process.argv.includes('models')) {",
        "  process.stdout.write('gemini-3.1-pro-low\\tGemini 3.1 Pro (Low)\\n');",
        "  process.exit(0);",
        "}",
        "process.exit(1);"
      ].join("\n"),
      { mode: 0o700 }
    );
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      AGY_BIN: agyBinary,
      AGY_ACP_ADMISSION_ENABLED: "true",
      AGY_ACP_STATE_DIR: directory,
      NODE_ENV: "test"
    };
    delete environment.PASEO_AGENT_ID;

    const child = spawn(process.execPath, [builtEntry], {
      cwd: directory,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stderr: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    const connection = acpClient({ name: "provider-discovery-test" }).connect(
      ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
      )
    );

    try {
      const initialized = await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {}
      });
      expect(initialized).toMatchObject({
        protocolVersion: 1,
        agentInfo: { name: "agy-acp", version: "2.0.0.1" }
      });
      const session = await connection.agent.request(methods.agent.session.new, {
        cwd: directory,
        additionalDirectories: [],
        mcpServers: []
      });
      expect(session).toMatchObject({
        sessionId: expect.any(String),
        configOptions: expect.arrayContaining([
          expect.objectContaining({ id: "model" })
        ])
      });
      await expect(connection.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "must not run" }]
      })).rejects.toMatchObject({ code: -32601 });
      expect(fs.existsSync(path.join(directory, "runtime.sqlite"))).toBe(false);
    } finally {
      connection.close();
      child.stdin.end();
    }
    expect(await exited).toBe(0);
    expect(Buffer.concat(stderr).toString("utf8")).toBe("");
  });

  it("probes the configured agy binary before starting prompt-free dispatch", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agy-admission-composition-"));
    temporaryDirectories.push(directory);
    const agyBinary = path.join(directory, "agy");
    fs.writeFileSync(
      agyBinary,
      [
        "#!/usr/bin/env node",
        "if (process.argv.includes('--version')) {",
        "  process.stdout.write('1.1.13\\n');",
        "  process.exit(0);",
        "}",
        "process.stdin.resume();",
        "process.stdin.on('end', () => process.exit(0));"
      ].join("\n"),
      { mode: 0o700 }
    );

    const session = await buildSession(directory, [], null, {
      env: { ...process.env, AGY_BIN: agyBinary },
      argv: ["--dangerously-skip-permissions"],
      backend: new AgyCliBackend(),
      getModelOptions: async () => ["gemini-3.1-pro"],
      admissionEnabled: true
    });

    const launched = session.agy.startPromptFreeProcess("production composition canary");
    expect(launched.launchSpecification.agyVersion).toBe("1.1.13");
    expect(launched.writeBusinessPrompt()).toEqual({ status: "accepted" });
    await expect(launched.exit).resolves.toEqual({ exitCode: 0, signal: null });
  });
});
