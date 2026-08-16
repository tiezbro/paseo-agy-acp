import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const builtEntry = path.join(repositoryRoot, "dist/ACP Connector/agent.js");

describe("published package entry", () => {
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
});
