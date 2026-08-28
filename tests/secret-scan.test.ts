import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const scannerPath = path.join(repositoryRoot, "scripts/verify-no-secrets.mjs");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("secret scan validation seam", () => {
  it("passes the repository without test fixture findings", () => {
    const result = runScanner();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("secret scan: PASS");
    expect(result.stderr).toBe("");
  });

  it("detects the built-in fixture without persisting a credential fixture", () => {
    const cleanRoot = createTemporaryRoot();
    writeFileSync(path.join(cleanRoot, "README.md"), "fixture root without secrets\n");

    const result = runScanner("--root", cleanRoot, "--include-test-fixture");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("secret scan: FAIL");
    expect(result.stderr).toContain("<builtin-fixture>/fixture.env:1 generic-sensitive-assignment");
    expect(result.stderr).not.toContain("fixture_not_live_secret");
  });

  it("scans Python compatibility modules for secret-like assignments", () => {
    const cleanRoot = createTemporaryRoot();
    writeFileSync(
      path.join(cleanRoot, "paseo_model_compat.py"),
      "PASEO_API_TOKEN = \"0123456789abcdef0123456789abcdef\"\n"
    );

    const result = runScanner("--root", cleanRoot);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("secret scan: FAIL");
    expect(result.stderr).toContain("paseo_model_compat.py:1 generic-sensitive-assignment");
  });
});

function createTemporaryRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "paseo-secret-scan-"));
  temporaryRoots.push(root);
  return root;
}

function runScanner(...args: string[]) {
  return spawnSync(process.execPath, [scannerPath, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
}
