import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  chownSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateAdmissionKey, AdmissionKeyStoreError } from "../src/admission/key-store.js";

const stateDirs: string[] = [];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keyStoreSourcePath = path.join(repositoryRoot, "src/admission/key-store.ts");
const keyStoreChildPath = path.join(repositoryRoot, "tests/helpers/admission-key-store-child.mjs");
const typeScriptCompilerPath = path.join(repositoryRoot, "node_modules/typescript/bin/tsc");

function stateDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-key-"));
  stateDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of stateDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createChildKeyStoreModule(dir: string): string {
  const sourcePath = path.join(dir, "key-store-child.mts");
  writeFileSync(sourcePath, readFileSync(keyStoreSourcePath), { mode: 0o600 });
  execFileSync(process.execPath, [
    typeScriptCompilerPath,
    "--ignoreConfig",
    "--module", "NodeNext",
    "--moduleResolution", "NodeNext",
    "--skipLibCheck",
    "--target", "ES2022",
    "--types", "node",
    "--outDir", dir,
    sourcePath
  ], { cwd: repositoryRoot });
  return path.join(dir, "key-store-child.mjs");
}

function spawnKeyStoreChild(modulePath: string, dir: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, [keyStoreChildPath, modulePath, dir, "wait"], {
    cwd: repositoryRoot,
    stdio: "pipe"
  });
}

function waitForChildReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onErrorData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onData = (chunk: string) => {
      output += chunk;
      if (output.includes("ready\n")) {
        cleanup();
        resolve();
      }
    };
    const onErrorData = (chunk: string) => {
      errorOutput += chunk;
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`key-store child exited before ready: code=${code} signal=${signal} stderr=${errorOutput}`));
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.stderr.on("data", onErrorData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function readChildKey(child: ChildProcessWithoutNullStreams): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    const cleanup = () => {
      child.stdout.off("data", onData);
      child.stderr.off("data", onErrorData);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onData = (chunk: string) => {
      output += chunk;
    };
    const onErrorData = (chunk: string) => {
      errorOutput += chunk;
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      if (code !== 0) {
        reject(new Error(`key-store child failed: code=${code} signal=${signal} stderr=${errorOutput}`));
        return;
      }
      const line = output.trim().split(/\r?\n/).at(-1);
      try {
        const parsed = JSON.parse(line ?? "") as { key?: unknown };
        if (typeof parsed.key !== "string") throw new Error("key-store child did not return a key");
        resolve(parsed.key);
      } catch (error) {
        reject(error);
      }
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", onData);
    child.stderr.on("data", onErrorData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

describe("Admission Controller key store", () => {
  it("creates one stable 32-byte key with restrictive permissions", () => {
    const dir = path.join(stateDir(), "runtime");
    const first = loadOrCreateAdmissionKey(dir);
    const second = loadOrCreateAdmissionKey(dir);

    expect(first).toHaveLength(32);
    expect(second.equals(first)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, "admission.key")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(dir, "admission.key")).nlink).toBe(1);
  });

  it("rejects a readable-by-group key instead of silently repairing it", () => {
    const dir = stateDir();
    const keyPath = path.join(dir, "admission.key");
    writeFileSync(keyPath, Buffer.alloc(32, 1), { mode: 0o600 });
    chmodSync(keyPath, 0o640);

    expect(() => loadOrCreateAdmissionKey(dir)).toThrow(AdmissionKeyStoreError);
  });

  it("rejects an invalid key length", () => {
    const dir = stateDir();
    writeFileSync(path.join(dir, "admission.key"), Buffer.alloc(31), { mode: 0o600 });

    expect(() => loadOrCreateAdmissionKey(dir)).toThrow(/exactly 32 bytes/);
  });

  it("rejects a symbolic-link key path without following it", () => {
    const dir = stateDir();
    const target = path.join(dir, "target.key");
    writeFileSync(target, Buffer.alloc(32, 2), { mode: 0o600 });
    symlinkSync(target, path.join(dir, "admission.key"));

    expect(() => loadOrCreateAdmissionKey(dir)).toThrow(/regular file/);
  });

  it("rejects an admission key with multiple hard links", () => {
    const dir = stateDir();
    const keyPath = path.join(dir, "admission.key");
    writeFileSync(keyPath, Buffer.alloc(32, 3), { mode: 0o600 });
    linkSync(keyPath, path.join(dir, "admission.key-copy"));

    expect(() => loadOrCreateAdmissionKey(dir)).toThrow(/exactly one link/);
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() !== 0)("rejects a key owned by another user", () => {
    const dir = stateDir();
    const keyPath = path.join(dir, "admission.key");
    writeFileSync(keyPath, Buffer.alloc(32, 4), { mode: 0o600 });
    chownSync(keyPath, 1, 1);

    expect(() => loadOrCreateAdmissionKey(dir)).toThrow(/current user/);
  });

  it("does not remove a temporary file that belongs to another caller", () => {
    const dir = stateDir();
    const key = Buffer.alloc(32, 5);
    const foreignTemporaryFile = path.join(dir, ".admission.key.foreign.tmp");
    writeFileSync(path.join(dir, "admission.key"), key, { mode: 0o600 });
    writeFileSync(foreignTemporaryFile, "other caller", { mode: 0o600 });

    expect(loadOrCreateAdmissionKey(dir).equals(key)).toBe(true);
    expect(existsSync(foreignTemporaryFile)).toBe(true);
  });

  it("publishes one complete key to simultaneous first creators", async () => {
    const dir = stateDir();
    const childModulePath = createChildKeyStoreModule(dir);
    const children = Array.from({ length: 8 }, () => spawnKeyStoreChild(childModulePath, dir));

    try {
      await Promise.all(children.map(waitForChildReady));
      const results = children.map(readChildKey);
      for (const child of children) child.stdin.end("go\n");
      const keys = await Promise.all(results);

      expect(new Set(keys)).toHaveLength(1);
      expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
      expect(statSync(path.join(dir, "admission.key")).nlink).toBe(1);
      expect(readdirSync(dir).filter((name) => /^\.admission\.key\..+\.tmp$/.test(name))).toEqual([]);
    } finally {
      for (const child of children) {
        if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
      }
    }
  });
});
