import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOrCreateAdmissionKey, AdmissionKeyStoreError } from "../src/admission/key-store.js";

const stateDirs: string[] = [];

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

describe("Admission Controller key store", () => {
  it("creates one stable 32-byte key with restrictive permissions", () => {
    const dir = path.join(stateDir(), "runtime");
    const first = loadOrCreateAdmissionKey(dir);
    const second = loadOrCreateAdmissionKey(dir);

    expect(first).toHaveLength(32);
    expect(second.equals(first)).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, "admission.key")).mode & 0o777).toBe(0o600);
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
});
