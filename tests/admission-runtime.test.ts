import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdmissionRuntimeError,
  createAdmissionRuntime
} from "../ACP Connector/admission/runtime.js";
import { ADMISSION_SCHEMA_VERSION } from "../Admission Controller/schema.js";

const stateDirs: string[] = [];

function stateDir(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-runtime-"));
  stateDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of stateDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Admission Controller runtime factory", () => {
  it("does not create state while admission is absent or explicitly disabled", () => {
    const root = stateDir();
    const absentStateDir = path.join(root, "absent");
    const disabledStateDir = path.join(root, "disabled");

    expect(createAdmissionRuntime({ AGY_ACP_STATE_DIR: absentStateDir })).toBeNull();
    expect(createAdmissionRuntime({
      AGY_ACP_ADMISSION_ENABLED: "false",
      AGY_ACP_STATE_DIR: disabledStateDir
    })).toBeNull();

    expect(existsSync(absentStateDir)).toBe(false);
    expect(existsSync(disabledStateDir)).toBe(false);
  });

  it("materializes only the secure shared-queue controller and closes idempotently", () => {
    const directory = path.join(stateDir(), "admission");
    const runtime = createAdmissionRuntime({
      AGY_ACP_ADMISSION_ENABLED: "1",
      AGY_ACP_STATE_DIR: directory,
      PASEO_AGENT_ID: "runtime-test-agent"
    });

    expect(runtime).not.toBeNull();
    expect(runtime?.controller.schemaVersion).toBe(ADMISSION_SCHEMA_VERSION);
    expect(Object.keys(runtime ?? {})).not.toContain("composition");
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(directory, "admission.key")).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(directory, "runtime.sqlite")).mode & 0o777).toBe(0o600);

    runtime?.close();
    expect(() => runtime?.close()).not.toThrow();
    expect(() => runtime?.controller).toThrow(AdmissionRuntimeError);
  });

  it("claims the durable policy and rejects a mismatched runtime opener", () => {
    const directory = path.join(stateDir(), "shared-policy");
    const first = createAdmissionRuntime({
      AGY_ACP_ADMISSION_ENABLED: "1",
      AGY_ACP_STATE_DIR: directory,
      PASEO_AGENT_ID: "runtime-policy-owner-a"
    });

    try {
      let failure: unknown;
      try {
        const second = createAdmissionRuntime({
          AGY_ACP_ADMISSION_ENABLED: "1",
          AGY_ACP_STATE_DIR: directory,
          AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS: "1",
          PASEO_AGENT_ID: "runtime-policy-owner-b"
        });
        second?.close();
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        name: "AdmissionRuntimeError",
        message: "admission runtime error: durable policy does not match shared runtime policy"
      });
    } finally {
      first?.close();
    }
  });

  it("rejects an unsafe existing database instead of changing its permissions", () => {
    const directory = stateDir();
    const databasePath = path.join(directory, "runtime.sqlite");
    writeFileSync(databasePath, "", { mode: 0o600 });
    chmodSync(databasePath, 0o640);

    expect(() => createAdmissionRuntime({
      AGY_ACP_ADMISSION_ENABLED: "true",
      AGY_ACP_STATE_DIR: directory,
      PASEO_AGENT_ID: "runtime-test-agent"
    })).toThrow(/must not grant group or other access/);
    expect(statSync(databasePath).mode & 0o777).toBe(0o640);
  });

  it("rejects symbolic and multiply-linked database paths", () => {
    const symlinkDirectory = stateDir();
    const target = path.join(symlinkDirectory, "target.sqlite");
    writeFileSync(target, "", { mode: 0o600 });
    symlinkSync(target, path.join(symlinkDirectory, "runtime.sqlite"));

    expect(() => createAdmissionRuntime({
      AGY_ACP_ADMISSION_ENABLED: "true",
      AGY_ACP_STATE_DIR: symlinkDirectory,
      PASEO_AGENT_ID: "runtime-test-agent"
    })).toThrow(/regular file/);

    const linkedDirectory = stateDir();
    const databasePath = path.join(linkedDirectory, "runtime.sqlite");
    writeFileSync(databasePath, "", { mode: 0o600 });
    linkSync(databasePath, path.join(linkedDirectory, "runtime-copy.sqlite"));

    expect(() => createAdmissionRuntime({
      AGY_ACP_ADMISSION_ENABLED: "true",
      AGY_ACP_STATE_DIR: linkedDirectory,
      PASEO_AGENT_ID: "runtime-test-agent"
    })).toThrow(/exactly one link/);
  });
});
