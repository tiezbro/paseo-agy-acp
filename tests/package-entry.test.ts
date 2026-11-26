import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const builtEntry = path.join(repositoryRoot, "dist/ACP Connector/agent.js");
const builtCliEntry = path.join(repositoryRoot, "dist/ACP Connector/main.js");

describe("published package entry", () => {
  it("probes quota capability through --version without starting the kernel", () => {
    const result = spawnSync(process.execPath, [builtCliEntry, "--version", "--capabilities"], {
      cwd: repositoryRoot, encoding: "utf8",
      env: { ...process.env, PASEO_AGY_ACP_OFFICIAL_BIN: "/missing-kernel-must-not-start" }, timeout: 2000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({ name: "paseo-agy-acp", version: "2.11.0", capabilities: { accountQuota: 1 } });
  });
  it("imports from the built package layout", () => {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(pathToFileURL(builtEntry).href)})`],
      {
        cwd: repositoryRoot,
        encoding: "utf8"
      }
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("prints its package version without waiting for ACP stdin", async () => {
    const child = spawn(process.execPath, [builtCliEntry, "--version"], {
      cwd: repositoryRoot,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });

    const result = await Promise.race([
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      }),
      new Promise<{ timeout: true }>((resolve) => {
        setTimeout(() => resolve({ timeout: true }), 1_000).unref();
      })
    ]);
    if ("timeout" in result) child.kill("SIGKILL");

    expect(result).toEqual({ code: 0, signal: null });
    expect(stdout).toBe("2.11.0\n");
    expect(stderr).toBe("");
  });
});
