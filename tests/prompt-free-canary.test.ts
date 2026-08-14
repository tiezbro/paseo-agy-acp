import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  REPO_OWNED_AGY_LAUNCH_RUNNER,
  createAgyLaunchSpecification,
  isExactFreshPtyAgyLaunch,
  isVerifiedAgyBinary,
  probeExactAgyBinaryVersion,
  type AgyLaunchSpecification,
  type VerifiedAgyBinary
} from "../ACP Connector/agy/launch-spec.js";
import {
  asAgyFreshPtyCanaryVerifier,
  runPromptFreePtyCanary,
  verifyPromptFreePtyCanary,
  type PromptFreePtyCanaryOptions
} from "../ACP Connector/agy/prompt-free-canary.js";
import {
  AgyPromptFreeDispatchBoundary,
  type AgyDispatchFence,
  type AgyDispatchProcess
} from "../ACP Connector/agy/dispatch-boundary.js";

const BUSINESS_PROMPT = "business prompt: hand off client key zeta-42";
const CANARY_KEY = Buffer.from("purpose-specific-canary-key-0001", "utf8");
const ISSUED_AT = 1_700_000_000_000;
const VERIFIED_BINARY = probeFakeAgyVersion("agy version 9.8.7.6");

const FENCE: AgyDispatchFence = {
  requestId: "request-1",
  leaseId: "lease-1",
  generation: 7,
  ownerInstanceId: "connector-1"
};

interface FakeProcess {
  readonly pid: number;
}

interface FakeIdentity {
  readonly startToken: string;
}

function genericLaunchSpecification(transport: "pty" | "stdin"): AgyLaunchSpecification {
  return createAgyLaunchSpecification({
    agyVersion: VERIFIED_BINARY.version,
    launcherFingerprint: VERIFIED_BINARY.launcherFingerprint,
    transport,
    argv: transport === "pty"
      ? [VERIFIED_BINARY.executable, "--prompt-interactive"]
      : [VERIFIED_BINARY.executable, "--print"],
    environment: { TERM: transport === "pty" ? "xterm-256color" : "dumb", SAFE_VALUE: "kept" },
    cwd: "/repo",
    processTitle: `agy-acp:${transport}`,
    temporaryFilePath: `/tmp/paseo-agy-acp/${transport}.probe`,
    launcherDiagnostics: [`transport=${transport}`, "launcher=agy-acp"]
  });
}

function probeFakeAgyVersion(output: string): VerifiedAgyBinary {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-version-probe-"));
  const executable = path.join(dir, "fake-agy");
  try {
    fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s\\n' '${output}'\n`, "utf8");
    fs.chmodSync(executable, 0o700);
    return probeExactAgyBinaryVersion({ executable, cwd: os.tmpdir() });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function options(overrides: Partial<PromptFreePtyCanaryOptions> = {}): PromptFreePtyCanaryOptions {
  return {
    businessPrompt: BUSINESS_PROMPT,
    verifiedAgyBinary: VERIFIED_BINARY,
    agyVersion: VERIFIED_BINARY.version,
    launcherFingerprint: VERIFIED_BINARY.launcherFingerprint,
    canaryKey: CANARY_KEY,
    fakeChild: () => ({ exitCode: 0 }),
    now: () => ISSUED_AT,
    ...overrides
  };
}

function ptyCandidate(onWrite: () => void): AgyDispatchProcess<FakeProcess, FakeIdentity> {
  return {
    process: { pid: 42 },
    identity: { startToken: "boot-1:100" },
    promptChannel: "pty",
    writeInitialPrompt: () => {
      onWrite();
      return { status: "accepted" };
    }
  };
}

describe("prompt-free fresh PTY canary foundation", () => {
  it("rejects a caller-owned launch callback even when it self-reports safe observation", () => {
    let callbackCalls = 0;
    let fakeChildCalls = 0;
    const canary = runPromptFreePtyCanary(options({
      launchSpecification: genericLaunchSpecification("pty"),
      fakeChild: () => {
        fakeChildCalls += 1;
        return { exitCode: 0 };
      },
      launch: (() => {
        callbackCalls += 1;
        return {
          protocol: "agy-prompt-free-pty-v1",
          transport: "pty",
          launcherFingerprint: VERIFIED_BINARY.launcherFingerprint,
          promptDigest: "forged",
          sentinel: "forged",
          exitCode: 0,
          argv: ["agy"],
          environment: {},
          processTitle: "forged",
          temporaryFilePath: "/tmp/forged",
          launcherDiagnostics: ["forged"]
        };
      }) as PromptFreePtyCanaryOptions["launch"]
    }));

    expect(canary.status).toBe("failed");
    expect(callbackCalls).toBe(0);
    expect(fakeChildCalls).toBe(0);
  });

  it("does not let the public spec builder establish fresh-PTY authenticity", () => {
    const specification = genericLaunchSpecification("pty");
    let fakeChildCalls = 0;

    expect(isExactFreshPtyAgyLaunch(
      specification,
      VERIFIED_BINARY.version,
      VERIFIED_BINARY.launcherFingerprint
    )).toBe(false);
    expect(runPromptFreePtyCanary(options({
      launchSpecification: specification,
      fakeChild: () => {
        fakeChildCalls += 1;
        return { exitCode: 0 };
      }
    })).status).toBe("failed");
    expect(fakeChildCalls).toBe(0);
  });

  it("never treats a stdin launch spec as fresh-PTY canary evidence", () => {
    const stdinSpecification = genericLaunchSpecification("stdin");
    let fakeChildCalls = 0;

    expect(isExactFreshPtyAgyLaunch(
      stdinSpecification,
      VERIFIED_BINARY.version,
      VERIFIED_BINARY.launcherFingerprint
    )).toBe(false);
    expect(runPromptFreePtyCanary(options({
      launchSpecification: stdinSpecification,
      fakeChild: () => {
        fakeChildCalls += 1;
        return { exitCode: 0 };
      }
    })).status).toBe("failed");
    expect(fakeChildCalls).toBe(0);
  });

  it("rejects every caller-supplied runner before fake child startup", () => {
    let fakeChildCalls = 0;
    const canary = runPromptFreePtyCanary(options({
      runner: REPO_OWNED_AGY_LAUNCH_RUNNER,
      fakeChild: () => {
        fakeChildCalls += 1;
        return { exitCode: 0 };
      }
    }));

    expect(canary.status).toBe("failed");
    expect(fakeChildCalls).toBe(0);
  });

  it("issues binary identity only from an exact successful agy version probe", () => {
    expect(isVerifiedAgyBinary(VERIFIED_BINARY, VERIFIED_BINARY.executable)).toBe(true);
    expect(isVerifiedAgyBinary({ ...VERIFIED_BINARY }, VERIFIED_BINARY.executable)).toBe(false);
    expect(isVerifiedAgyBinary(VERIFIED_BINARY, "/other/agy")).toBe(false);
    expect(() => probeExactAgyBinaryVersion({
      executable: "/tmp/does-not-exist-agy",
      cwd: os.tmpdir()
    })).toThrow();
    expect(() => probeFakeAgyVersion("connector version 2.0.0.0")).toThrow();
  });

  it("rejects a copied binary identity before fake child startup", () => {
    const forgedIdentity = Object.freeze({ ...VERIFIED_BINARY }) as VerifiedAgyBinary;
    let fakeChildCalls = 0;

    const canary = runPromptFreePtyCanary(options({
      verifiedAgyBinary: forgedIdentity,
      agyVersion: VERIFIED_BINARY.version,
      launcherFingerprint: VERIFIED_BINARY.launcherFingerprint,
      fakeChild: () => {
        fakeChildCalls += 1;
        return { exitCode: 0 };
      }
    }));

    expect(canary.status).toBe("failed");
    expect(fakeChildCalls).toBe(0);
  });

  it("fails closed when the asserted version or fingerprint differs from the verified binary", () => {
    let fakeChildCalls = 0;

    const canary = runPromptFreePtyCanary(options({
      agyVersion: VERIFIED_BINARY.version,
      launcherFingerprint: "different-agy-launcher",
      fakeChild: () => {
        fakeChildCalls += 1;
        return { exitCode: 0 };
      }
    }));

    expect(canary.status).toBe("failed");
    expect(fakeChildCalls).toBe(0);
  });

  it("keeps prompts and sentinels out of generic launch surfaces", () => {
    const specification = genericLaunchSpecification("pty");
    expect(() => REPO_OWNED_AGY_LAUNCH_RUNNER.run(
      specification,
      () => ({ exitCode: 0 }),
      [BUSINESS_PROMPT, "sentinel-secret"]
    )).not.toThrow();
    expect(() => REPO_OWNED_AGY_LAUNCH_RUNNER.run(
      createAgyLaunchSpecification({
        ...specification,
        launcherDiagnostics: ["transport=pty", `leak=${BUSINESS_PROMPT}`]
      }),
      () => ({ exitCode: 0 }),
      [BUSINESS_PROMPT]
    )).toThrow();
  });

  it("does not start a fake child without a private exact prompt-free PTY source", () => {
    let fakeChildCalls = 0;

    const canary = runPromptFreePtyCanary(options({
      fakeChild: () => {
        fakeChildCalls += 1;
        return { exitCode: 0 };
      }
    }));

    expect(canary.status).toBe("failed");
    expect(fakeChildCalls).toBe(0);
  });

  it("keeps the fresh-PTY dispatch boundary fail closed until a real prompt-free PTY source is integrated", () => {
    const canary = runPromptFreePtyCanary(options());
    let writes = 0;
    const boundary = new AgyPromptFreeDispatchBoundary(
      BUSINESS_PROMPT,
      FENCE,
      {
        spawnPromptFree: () => ptyCandidate(() => { writes += 1; }),
        verifyFreshPtyCanary: asAgyFreshPtyCanaryVerifier(canary, {
          businessPrompt: BUSINESS_PROMPT,
          verifiedAgyBinary: VERIFIED_BINARY,
          agyVersion: VERIFIED_BINARY.version,
          launcherFingerprint: VERIFIED_BINARY.launcherFingerprint,
          canaryKey: CANARY_KEY,
          now: () => ISSUED_AT
        }),
        persistProcessIdentity: () => ({ status: "recorded" }),
        recheckCancellation: () => ({ generationMatches: true, ownerMatches: true, cancelled: false }),
        commitDispatchIntent: () => ({ status: "committed" })
      }
    );

    expect(boundary.run()).toMatchObject({
      state: "blocked",
      reason: "fresh_pty_uncertified",
      writeAttempts: 0
    });
    expect(writes).toBe(0);
    expect(verifyPromptFreePtyCanary(canary, {
      businessPrompt: BUSINESS_PROMPT,
      verifiedAgyBinary: VERIFIED_BINARY,
      agyVersion: VERIFIED_BINARY.version,
      launcherFingerprint: VERIFIED_BINARY.launcherFingerprint,
      canaryKey: CANARY_KEY,
      now: () => ISSUED_AT
    })).toBe(false);
  });
});
