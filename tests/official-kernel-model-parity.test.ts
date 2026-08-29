import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const driver = path.join(repositoryRoot, "scripts", "official-kernel-model-parity.mjs");
const stressEvidence = path.join(repositoryRoot, "scripts", "official-kernel-stress-evidence.mjs");
const stressScript = path.join(repositoryRoot, "scripts", "isolated-official-kernel-stress.sh");
const fakeKernel = path.join(repositoryRoot, "tests", "helpers", "fake-model-parity-acp-kernel.mjs");
const temporaryDirectories: string[] = [];

const EXPECTED_ARGUMENTS = [
  "--expected-count",
  "3",
  "--expected-model",
  "claude-sonnet-4-6",
  "--expected-model",
  "claude-opus-4-6-thinking",
  "--expected-model",
  "gpt-oss-120b-medium",
  "--request-timeout-ms",
  "1000",
  "--overall-timeout-ms",
  "8000"
];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

function executable(filename: string, content: string): string {
  writeFileSync(filename, content, { encoding: "utf8", mode: 0o700 });
  chmodSync(filename, 0o700);
  return filename;
}

function fakeWrapper(options: { readonly extension?: string; readonly wrapperManagedUid?: boolean } = {}) {
  const root = temporaryDirectory("paseo-model-parity-fake-");
  const observationPath = path.join(root, "observation.ndjson");
  const wrapperArgsPath = path.join(root, "wrapper-args.txt");
  const extension = options.extension ?? "";
  const uid = options.wrapperManagedUid === false ? "" : "--uid= ";
  const target = executable(
    path.join(root, `fake-kernel${extension}`),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `printf '%s\\n' "$@" > ${shellQuote(wrapperArgsPath)}`,
      `exec ${shellQuote(process.execPath)} ${shellQuote(fakeKernel)} ${uid}"$@"`
    ].join("\n") + "\n"
  );
  return { root, target, observationPath, wrapperArgsPath };
}

function observations(filename: string): Array<{
  method?: string;
  args?: string[];
  params?: {
    sessionId?: string;
    cwd?: string;
    mcpServers?: unknown;
    protocolVersion?: number;
    clientInfo?: { name?: string; version?: string };
    clientCapabilities?: unknown;
    promptParts?: Array<{ type?: string; mimeType?: string; dataBytes?: number }>;
  };
}> {
  if (!existsSync(filename)) return [];
  return readFileSync(filename, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as {
      method?: string;
      args?: string[];
      params?: {
        sessionId?: string;
        cwd?: string;
        mcpServers?: unknown;
        protocolVersion?: number;
        clientInfo?: { name?: string; version?: string };
        clientCapabilities?: unknown;
        promptParts?: Array<{ type?: string; mimeType?: string; dataBytes?: number }>;
      };
    });
}

function runNode(script: string, args: string[], environment: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    encoding: "utf8",
    timeout: 20_000
  });
  const output = result.stdout.trim();
  let receipt: Record<string, unknown> | undefined;
  if (output.length > 0) {
    try {
      receipt = JSON.parse(output) as Record<string, unknown>;
    } catch {
      receipt = undefined;
    }
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, receipt };
}

function runHarness(targetFlag: string, target: string, extra: string[] = [], environment: NodeJS.ProcessEnv = {}) {
  return runNode(driver, [targetFlag, target, ...EXPECTED_ARGUMENTS, ...extra], environment);
}

type EvidenceDatabaseOptions = {
  startEventTimes?: number[];
  startHistoryTimes?: number[];
  extraAdmittedEvents?: number;
};

function makeEvidenceDatabase({
  startEventTimes = [1_001, 3_001, 5_001, 7_001],
  startHistoryTimes = [7_001],
  extraAdmittedEvents = 0
}: EvidenceDatabaseOptions = {}): string {
  const root = temporaryDirectory("paseo-model-parity-evidence-");
  const databasePath = path.join(root, "runtime.sqlite");
  const database = new Database(databasePath);
  try {
    database.exec(`
      CREATE TABLE policy_state (
        id INTEGER PRIMARY KEY,
        max_active_turns INTEGER NOT NULL,
        max_concurrent_starts INTEGER NOT NULL,
        min_start_interval_ms INTEGER NOT NULL
      );
      CREATE TABLE turn_requests (state TEXT NOT NULL);
      CREATE TABLE leases (lease_id TEXT NOT NULL);
      CREATE TABLE turn_payloads (request_id TEXT NOT NULL);
      CREATE TABLE start_history (started_at INTEGER NOT NULL);
      CREATE TABLE events (
        event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        occurred_at INTEGER NOT NULL
      );
    `);
    database.prepare(
      "INSERT INTO policy_state (id, max_active_turns, max_concurrent_starts, min_start_interval_ms) VALUES (1, 3, 2, 2000)"
    ).run();
    const insertEvent = database.prepare(
      "INSERT INTO events (kind, from_state, to_state, occurred_at) VALUES (?, ?, ?, ?)"
    );
    const insertState = database.prepare("INSERT INTO turn_requests (state) VALUES ('completed')");
    for (let index = 0; index < 4; index += 1) {
      insertEvent.run("request_enqueued", "absent", "queued", index);
      insertState.run();
    }
    for (let index = 0; index < 4; index += 1) {
      const time = 1_000 + index * 2_000;
      insertEvent.run("request_admitted", "queued", "admitted", time);
      const startTime = startEventTimes[index];
      if (startTime !== undefined) {
        insertEvent.run("request_starting", "admitted", "starting", startTime);
      }
      insertEvent.run("request_dispatch_intent", "starting", "dispatch_intent", time + 2);
      insertEvent.run("request_active", "dispatch_intent", "active", time + 3);
      insertEvent.run("request_provider_terminal", "active", "provider_terminal", time + 4);
      insertEvent.run("request_released", "provider_terminal", "completed", time + 5);
    }
    for (let index = 0; index < extraAdmittedEvents; index += 1) {
      const time = 10_000 + index * 2;
      insertEvent.run("request_enqueued", "absent", "queued", time);
      insertEvent.run("request_admitted", "queued", "admitted", time + 1);
    }
    const insertStart = database.prepare("INSERT INTO start_history (started_at) VALUES (?)");
    for (const startedAt of startHistoryTimes) insertStart.run(startedAt);
  } finally {
    database.close();
  }
  return databasePath;
}

async function waitForProcessExit(processId: number): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!existsSync(`/proc/${processId}`)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !existsSync(`/proc/${processId}`);
}

describe("official kernel model parity acceptance harness", () => {
  it("defaults to cached-auth catalog-only without claiming unauthenticated access", () => {
    const fake = fakeWrapper();
    const result = runHarness("--kernel", fake.target, [], {
      P4_FAKE_BEHAVIOR: "cached-success",
      P4_FAKE_OBSERVATION: fake.observationPath
    });

    expect(result.status).toBe(0);
    expect(result.receipt).toMatchObject({
      ok: true,
      buildId: "fake-rc01",
      catalog: {
        count: 3,
        modelIds: ["claude-opus-4-6-thinking", "claude-sonnet-4-6", "gpt-oss-120b-medium"]
      },
      authentication: {
        mode: "cached_auth_session_new",
        authenticateSent: false,
        sessionNewVerified: true,
        unauthenticatedAccessTested: false
      },
      coverage: {
        scope: "single_run_not_plan_5_2_completion",
        run: { catalog: "passed", text: "not_run", configuredStress: "not_run" },
        deterministicFakeSuite: { catalog: true, timeout: true, configuredStress: true },
        deferred: {
          real503Quota: {
            covered: false,
            status: "deferred",
            reason: "real_provider_failure_not_induced"
          }
        }
      }
    });
    expect(result.stdout).not.toContain("fake-session-");
    const methods = observations(fake.observationPath).map((entry) => entry.method);
    expect(methods).toContain("initialize");
    expect(methods).toContain("session/new");
    expect(methods).not.toContain("authenticate");
    expect(methods).not.toContain("session/set_config_option");
    expect(methods).not.toContain("session/prompt");
  });

  it("documents cached-auth behavior and real-safe default timeouts", () => {
    const help = runNode(driver, ["--help"]);
    expect(help.status).toBe(0);
    expect(help.receipt).toBeUndefined();
    expect(help.stdout).toContain("cached OAuth state");
    expect(help.stdout).toContain("does not test unauthenticated access");
    expect(help.stdout).toContain("180000ms/600000ms");
    expect(help.stdout).toContain("--cold-load");
    expect(help.stdout).toContain("--media");
    expect(help.stdout).toContain("--timeout");
  });

  it("accumulates split final chunks while keeping thought content out of the receipt", () => {
    const fake = fakeWrapper();
    const result = runHarness("--kernel", fake.target, [
      "--live",
      "--tools",
      "--resume",
      "--invalid-model",
      "--cancel",
      "--model",
      "gpt-oss-120b-medium"
    ], { P4_FAKE_OBSERVATION: fake.observationPath });

    expect(result.status).toBe(0);
    expect(result.receipt).toMatchObject({
      ok: true,
      invalidModel: { assertedLocal: true, errorCode: -32602 },
      capabilities: { resumeRequested: true, resumeAdvertised: true },
      cancellation: { attempted: true, attempts: 1, racedCompletions: 0, cancelled: true, stopReason: "cancelled" },
      coverage: {
        run: {
          catalog: "passed",
          text: "passed",
          tools: "passed",
          warmResume: "passed",
          invalidModel: "passed",
          cancel: "passed",
          thoughtSeparation: "passed",
          timeout: "not_run",
          processCleanup: "not_run",
          configuredStress: "not_run"
        }
      }
    });
    const model = (result.receipt?.models as Array<Record<string, unknown>>)[0]!;
    expect(model).toMatchObject({
      id: "gpt-oss-120b-medium",
      selected: true,
      stopReason: "end_turn",
      messageMarkerMatched: true,
      resumed: { ok: true, currentModelMatched: true, markerMatched: true },
      passed: true
    });
    expect(model.toolRounds).toEqual([
      { markerMatched: true, stopReason: "end_turn", toolEvents: 2 },
      { markerMatched: true, stopReason: "end_turn", toolEvents: 2 }
    ]);
    expect(model.updates).toMatchObject({
      agent_thought_chunk: 4,
      agent_message_chunk: 8,
      tool_call: 2,
      tool_call_update: 2
    });
    expect(result.stdout).not.toContain("PRIVATE_THOUGHT_MUST_NOT_APPEAR");
    expect(result.stdout).not.toContain("P4_TOOL_FILE=");
    expect(result.stdout).not.toContain("fake-session-");
    const observed = observations(fake.observationPath);
    const resume = observed.filter((entry) => entry.method === "session/resume");
    expect(resume).toHaveLength(1);
    expect(resume[0]?.params).toEqual({
      sessionId: "fake-session-2",
      cwd: expect.any(String),
      mcpServers: []
    });
    expect(path.isAbsolute(resume[0]?.params?.cwd ?? "")).toBe(true);
    const resumeIndex = observed.findIndex((entry) => entry.method === "session/resume");
    const postResumePrompt = observed.slice(resumeIndex + 1).find((entry) => entry.method === "session/prompt");
    expect(postResumePrompt?.params).toEqual({ sessionId: "fake-session-2" });
  });

  it("keeps cached auth as the default and exercises explicit authentication only on request", () => {
    const required = fakeWrapper();
    const cachedAttempt = runHarness("--kernel", required.target, [], {
      P4_FAKE_BEHAVIOR: "auth-required",
      P4_FAKE_OBSERVATION: required.observationPath
    });
    expect(cachedAttempt.status).toBe(1);
    expect(cachedAttempt.receipt).toMatchObject({
      authentication: {
        mode: "cached_auth_session_new",
        authenticateSent: false,
        sessionNewVerified: false,
        unauthenticatedAccessTested: false,
        errorCode: -32000
      },
      diagnostics: { failure: "session_create_failed", errorCodes: [-32000] }
    });
    expect(observations(required.observationPath).map((entry) => entry.method)).not.toContain("authenticate");

    const explicitSuccess = fakeWrapper();
    const authenticated = runHarness("--kernel", explicitSuccess.target, ["--authenticate"], {
      P4_FAKE_BEHAVIOR: "explicit-auth-success",
      P4_FAKE_OBSERVATION: explicitSuccess.observationPath
    });
    expect(authenticated.status).toBe(0);
    expect(authenticated.receipt).toMatchObject({
      authentication: {
        mode: "explicit_authenticate",
        authenticateSent: true,
        sessionNewVerified: true,
        unauthenticatedAccessTested: false,
        errorCode: null
      }
    });
    expect(observations(explicitSuccess.observationPath).map((entry) => entry.method)).toContain("authenticate");

    const explicitFailure = fakeWrapper();
    const failedAuthentication = runHarness("--kernel", explicitFailure.target, ["--authenticate"], {
      P4_FAKE_BEHAVIOR: "explicit-auth-failure",
      P4_FAKE_OBSERVATION: explicitFailure.observationPath
    });
    expect(failedAuthentication.status).toBe(1);
    expect(failedAuthentication.receipt).toMatchObject({
      authentication: { mode: "explicit_authenticate", authenticateSent: true, errorCode: -32000 },
      diagnostics: { failure: "authentication_failed", errorCodes: [-32000] }
    });
    expect(failedAuthentication.stdout).not.toContain("authentication refresh failed");
  });

  it("requires the advertised ACP resume capability before attempting a warm resume", () => {
    const fake = fakeWrapper();
    const result = runHarness("--kernel", fake.target, ["--live", "--resume", "--model", "claude-sonnet-4-6"], {
      P4_FAKE_BEHAVIOR: "missing-resume-capability",
      P4_FAKE_OBSERVATION: fake.observationPath
    });
    expect(result.status).toBe(1);
    expect(result.receipt).toMatchObject({
      capabilities: { resumeRequested: true, resumeAdvertised: false },
      coverage: { run: { warmResume: "not_run" } },
      diagnostics: { failure: "resume_capability_missing" }
    });
    const methods = observations(fake.observationPath).map((entry) => entry.method);
    expect(methods).toEqual(["initialize"]);
  });

  it("accepts native resume-capability aliases and the fake rejects malformed resume setup", () => {
    const snake = fakeWrapper();
    const resumed = runHarness("--kernel", snake.target, ["--live", "--resume", "--model", "claude-sonnet-4-6"], {
      P4_FAKE_BEHAVIOR: "snake-resume-capability"
    });
    expect(resumed.status).toBe(0);
    expect(resumed.receipt).toMatchObject({
      capabilities: { resumeRequested: true, resumeAdvertised: true },
      coverage: { run: { warmResume: "passed" } }
    });

    const requests = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "session/resume", params: { sessionId: "fake-session-1", mcpServers: [] } },
      { jsonrpc: "2.0", id: 3, method: "session/resume", params: { sessionId: "fake-session-1", cwd: "relative", mcpServers: [] } },
      { jsonrpc: "2.0", id: 4, method: "session/resume", params: { sessionId: "fake-session-1", cwd: "/workspace", mcpServers: {} } }
    ];
    const fake = spawnSync(process.execPath, [fakeKernel], {
      cwd: repositoryRoot,
      env: { ...process.env, P4_FAKE_BEHAVIOR: "normal" },
      encoding: "utf8",
      input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`
    });
    expect(fake.status).toBe(0);
    const replies = fake.stdout.trim().split("\n").map((line) => JSON.parse(line) as {
      id: number;
      error?: { code?: number };
    });
    for (const id of [2, 3, 4]) {
      expect(replies.find((reply) => reply.id === id)?.error?.code).toBe(-32602);
    }
  });

  it("uses exact advertised cold-load and media ACP shapes without placing media contents in the receipt", () => {
    const fake = fakeWrapper();
    const result = runHarness("--kernel", fake.target, [
      "--live",
      "--cold-load",
      "--media",
      "--model",
      "claude-sonnet-4-6"
    ], {
      P4_FAKE_BEHAVIOR: "rc01-capabilities",
      P4_FAKE_OBSERVATION: fake.observationPath
    });

    expect(result.status).toBe(0);
    expect(result.receipt).toMatchObject({
      ok: true,
      capabilities: {
        coldLoadRequested: true,
        loadAdvertised: true,
        mediaRequested: true,
        imageAdvertised: true,
        audioAdvertised: true
      },
      coldLoad: {
        requested: true,
        attempted: true,
        status: "passed",
        historyReplayed: true,
        sessionRetained: true,
        currentModelMatched: true,
        errorCode: null
      },
      media: {
        requested: true,
        attempted: true,
        status: "passed",
        imageSent: true,
        audioSent: true,
        markerMatched: true,
        errorCode: null
      },
      coverage: {
        run: { coldLoad: "passed", media: "passed", mcp: "not_run" },
        deferred: {
          mcp: {
            covered: false,
            status: "deferred",
            reason: "standards_correct_local_server_not_pinned"
          }
        }
      }
    });
    expect(result.stdout).not.toContain("fake-session-");
    expect(result.stdout).not.toContain("P6_MEDIA_REQUEST");
    expect(result.stdout).not.toContain("iVBOR");

    const observed = observations(fake.observationPath);
    const initialize = observed.find((entry) => entry.method === "initialize");
    expect(initialize?.params).toEqual({
      protocolVersion: 1,
      clientInfo: { name: "paseo-model-parity", version: "p4" },
      clientCapabilities: {}
    });
    const loadIndex = observed.findIndex((entry) => entry.method === "session/load");
    expect(loadIndex).toBeGreaterThan(-1);
    const load = observed[loadIndex];
    expect(load?.params).toEqual({
      sessionId: expect.any(String),
      cwd: expect.any(String),
      mcpServers: []
    });
    expect(path.isAbsolute(load?.params?.cwd ?? "")).toBe(true);
    const postLoadPrompt = observed.slice(loadIndex + 1).find((entry) => entry.method === "session/prompt");
    expect(postLoadPrompt?.params).toEqual({ sessionId: load?.params?.sessionId });

    const mediaPrompt = observed.find((entry) => entry.params?.promptParts !== undefined);
    expect(mediaPrompt?.params?.promptParts).toEqual([
      { type: "text" },
      { type: "image", mimeType: "image/png", dataBytes: expect.any(Number) },
      { type: "audio", mimeType: "audio/wav", dataBytes: expect.any(Number) }
    ]);
    for (const part of mediaPrompt?.params?.promptParts?.slice(1) ?? []) {
      expect(part.dataBytes).toBeGreaterThan(0);
    }
  });

  it("defers unsupported optional cold-load and media paths without sending their methods or media blocks", () => {
    const fake = fakeWrapper();
    const result = runHarness("--kernel", fake.target, [
      "--live",
      "--cold-load",
      "--media",
      "--model",
      "claude-sonnet-4-6"
    ], { P4_FAKE_OBSERVATION: fake.observationPath });

    expect(result.status).toBe(0);
    expect(result.receipt).toMatchObject({
      ok: true,
      coldLoad: {
        requested: true,
        attempted: false,
        status: "deferred",
        reason: "load_session_not_advertised"
      },
      media: {
        requested: true,
        attempted: false,
        status: "deferred",
        reason: "image_audio_not_advertised"
      },
      coverage: { run: { coldLoad: "deferred", media: "deferred" } }
    });
    const observed = observations(fake.observationPath);
    expect(observed.map((entry) => entry.method)).not.toContain("session/load");
    expect(observed.some((entry) => entry.params?.promptParts !== undefined)).toBe(false);
  });

  it("sends only the individually advertised image or audio content block", () => {
    for (const mediaCase of [
      { behavior: "image-only-capability", image: true, audio: false, type: "image", mimeType: "image/png" },
      { behavior: "audio-only-capability", image: false, audio: true, type: "audio", mimeType: "audio/wav" }
    ]) {
      const fake = fakeWrapper();
      const result = runHarness("--kernel", fake.target, [
        "--live",
        "--media",
        "--model",
        "claude-sonnet-4-6"
      ], {
        P4_FAKE_BEHAVIOR: mediaCase.behavior,
        P4_FAKE_OBSERVATION: fake.observationPath
      });

      expect(result.status).toBe(0);
      expect(result.receipt).toMatchObject({
        capabilities: { imageAdvertised: mediaCase.image, audioAdvertised: mediaCase.audio },
        media: {
          status: "passed",
          imageSent: mediaCase.image,
          audioSent: mediaCase.audio,
          markerMatched: true
        }
      });
      const mediaPrompt = observations(fake.observationPath).find((entry) => entry.params?.promptParts !== undefined);
      expect(mediaPrompt?.params?.promptParts).toEqual([
        { type: "text" },
        { type: mediaCase.type, mimeType: mediaCase.mimeType, dataBytes: expect.any(Number) }
      ]);
    }
  });

  it("retries a cancellation race once in a fresh session and still requires cancellation", () => {
    const fake = fakeWrapper();
    const raced = runHarness("--kernel", fake.target, [
      "--live",
      "--cancel",
      "--cancel-after-ms",
      "20",
      "--model",
      "claude-sonnet-4-6"
    ], { P4_FAKE_BEHAVIOR: "race-then-cancel", P4_FAKE_OBSERVATION: fake.observationPath });
    expect(raced.status).toBe(0);
    expect(raced.receipt).toMatchObject({
      cancellation: {
        attempted: true,
        attempts: 2,
        racedCompletions: 1,
        cancelled: true,
        stopReason: "cancelled"
      }
    });
    const methods = observations(fake.observationPath).map((entry) => entry.method);
    expect(methods.filter((method) => method === "session/new")).toHaveLength(4);
    expect(methods.filter((method) => method === "session/cancel")).toHaveLength(2);

    const alwaysRaces = fakeWrapper();
    const notCancelled = runHarness("--kernel", alwaysRaces.target, [
      "--live",
      "--cancel",
      "--cancel-after-ms",
      "10",
      "--model",
      "claude-sonnet-4-6"
    ], { P4_FAKE_BEHAVIOR: "cancel-race-always" });
    expect(notCancelled.status).toBe(1);
    expect(notCancelled.receipt).toMatchObject({
      cancellation: { attempts: 2, racedCompletions: 2, cancelled: false, stopReason: "end_turn" },
      diagnostics: { failure: "cancellation_not_confirmed" }
    });
  });

  it("retains only sanitized provider error codes and does not classify real provider failures", () => {
    for (const [behavior, errorCode] of [["provider-503", 503], ["quota-error", "QUOTA_EXHAUSTED"]] as const) {
      const fake = fakeWrapper();
      const result = runHarness("--kernel", fake.target, ["--live", "--model", "claude-sonnet-4-6"], {
        P4_FAKE_BEHAVIOR: behavior
      });
      expect(result.status).toBe(1);
      expect(result.receipt).toMatchObject({
        diagnostics: { failure: "model_acceptance_failed", errorCodes: [errorCode] },
        coverage: {
          deferred: {
            real503Quota: {
              covered: false,
              status: "deferred",
              reason: "real_provider_failure_not_induced"
            }
          }
        }
      });
      expect(result.stdout).not.toContain("upstream unavailable");
      expect(result.stdout).not.toContain("quota unavailable");
    }
  });

  it("leaves wrapper-managed uid alone and adds exactly one uid for a direct PAR", () => {
    const wrapper = fakeWrapper();
    const wrapped = runHarness("--per-release-wrapper", wrapper.target, [], {
      P4_FAKE_OBSERVATION: wrapper.observationPath
    });
    expect(wrapped.status).toBe(0);
    expect(readFileSync(wrapper.wrapperArgsPath, "utf8").trim()).toBe("");
    expect(observations(wrapper.observationPath).every((entry) => entry.args?.join(",") === "--uid=")).toBe(true);

    const direct = fakeWrapper({ extension: ".par", wrapperManagedUid: false });
    const before = readFileSync(direct.target, "utf8");
    const directResult = runHarness("--direct-par", direct.target, [], {
      P4_FAKE_OBSERVATION: direct.observationPath
    });
    expect(directResult.status).toBe(0);
    expect(readFileSync(direct.target, "utf8")).toBe(before);
    expect(observations(direct.observationPath).every((entry) => entry.args?.join(",") === "--uid=")).toBe(true);
  });

  it("uses the built product adapter only when its explicit environment switch is enabled", () => {
    const wrapper = fakeWrapper();
    const result = runHarness("--stable-wrapper", wrapper.target, [], {
      P4_MODEL_PARITY_THROUGH_PRODUCT: "1",
      P4_FAKE_OBSERVATION: wrapper.observationPath
    });

    expect(result.status).toBe(0);
    expect(result.receipt).toMatchObject({ ok: true, adapter: "product", target: "stable-wrapper" });
    expect(readFileSync(wrapper.wrapperArgsPath, "utf8").trim()).toBe("");
  });

  it("bounds timeout paths, redacts child diagnostics, and tears down a child process group", async () => {
    const timeout = fakeWrapper();
    const timedOut = runHarness("--kernel", timeout.target, ["--live", "--request-timeout-ms", "150"], {
      P4_FAKE_BEHAVIOR: "timeout"
    });
    expect(timedOut.status).toBe(1);
    expect(timedOut.receipt).toMatchObject({ ok: false, diagnostics: { failure: "request_timeout" } });

    const redacted = fakeWrapper();
    const redaction = runHarness("--kernel", redacted.target, ["--live"], {
      P4_FAKE_BEHAVIOR: "redacted-error"
    });
    expect(redaction.status).toBe(1);
    expect(redaction.receipt).toMatchObject({
      diagnostics: { failure: "model_acceptance_failed", errorCodes: [-32099] }
    });
    expect(redaction.stdout).not.toContain("SECRET_TOKEN");
    expect(redaction.stdout).not.toContain("SECRET_AUTH_CONTEXT");

    const malformed = fakeWrapper();
    const malformedResult = runHarness("--kernel", malformed.target, ["--live"], {
      P4_FAKE_BEHAVIOR: "malformed"
    });
    expect(malformedResult.status).toBe(1);
    expect(malformedResult.receipt).toMatchObject({ diagnostics: { failure: "malformed_ndjson", malformedNdjson: true } });
    expect(malformedResult.stdout).not.toContain("MALFORMED_NDJSON_SECRET");

    const hanging = fakeWrapper();
    const childPidPath = path.join(hanging.root, "child.pid");
    const cleanup = runHarness("--kernel", hanging.target, ["--request-timeout-ms", "150", "--overall-timeout-ms", "2000"], {
      P4_FAKE_BEHAVIOR: "hang-child",
      P4_FAKE_CHILD_PID_FILE: childPidPath
    });
    expect(cleanup.status).toBe(1);
    expect(cleanup.receipt).toMatchObject({ diagnostics: { failure: "request_timeout" } });
    const childPid = Number(readFileSync(childPidPath, "utf8"));
    expect(await waitForProcessExit(childPid)).toBe(true);
  });

  it("passes optional timeout acceptance only after request timeout and process-group cleanup are both observed", async () => {
    const fake = fakeWrapper();
    const childPidPath = path.join(fake.root, "timeout-child.pid");
    const result = runHarness("--kernel", fake.target, [
      "--live",
      "--timeout",
      "--model",
      "claude-sonnet-4-6",
      "--request-timeout-ms",
      "150",
      "--overall-timeout-ms",
      "2000"
    ], {
      P4_FAKE_BEHAVIOR: "timeout-child",
      P4_FAKE_CHILD_PID_FILE: childPidPath
    });

    expect(result.status).toBe(0);
    expect(result.receipt).toMatchObject({
      ok: true,
      timeout: {
        requested: true,
        attempted: true,
        status: "passed",
        timedOut: true,
        processGroupCleaned: true
      },
      coverage: { run: { timeout: "passed", processCleanup: "passed" } }
    });
    expect(result.stdout).not.toContain("P6_TIMEOUT_REQUEST");
    const childPid = Number(readFileSync(childPidPath, "utf8"));
    expect(await waitForProcessExit(childPid)).toBe(true);

    const respondsTooSoon = fakeWrapper();
    const failed = runHarness("--kernel", respondsTooSoon.target, [
      "--live",
      "--timeout",
      "--model",
      "claude-sonnet-4-6",
      "--request-timeout-ms",
      "150"
    ]);
    expect(failed.status).toBe(1);
    expect(failed.receipt).toMatchObject({
      ok: false,
      timeout: { status: "failed" },
      coverage: { run: { timeout: "failed" } },
      diagnostics: { failure: "timeout_not_confirmed" }
    });
  });
});

describe("isolated stress evidence", () => {
  it("validates configured bounds, queue progress, interval, and resource release without reading payloads", () => {
    const databasePath = makeEvidenceDatabase();
    const result = runNode(stressEvidence, [
      "--database",
      databasePath,
      "--expected-runs",
      "4",
      "--max-active-turns",
      "3",
      "--max-concurrent-starts",
      "2",
      "--min-start-interval-ms",
      "2000"
    ]);
    expect(result.status).toBe(0);
    expect(result.receipt).toMatchObject({
      ok: true,
      policy: { maxActiveTurns: 3, maxConcurrentStarts: 2, minStartIntervalMs: 2000 },
      runs: { expected: 4, observed: 4, enqueued: 4, admitted: 4 },
      bounds: { startEventsObserved: 4, minStartGapMs: 2000 },
      queue: { maxQueuedObserved: 4, progressed: true },
      release: { leases: 0, payloads: 0, nonterminal: 0 }
    });
  });

  it("requires durable start events even when unrelated admissions and current-window history exist", () => {
    const databasePath = makeEvidenceDatabase({ startEventTimes: [], extraAdmittedEvents: 1 });
    const result = runNode(stressEvidence, [
      "--database",
      databasePath,
      "--expected-runs",
      "4",
      "--max-active-turns",
      "3",
      "--max-concurrent-starts",
      "2",
      "--min-start-interval-ms",
      "2000"
    ]);
    expect(result.status).toBe(1);
    expect(result.receipt).toEqual({ ok: false, failure: "start_evidence_missing" });
  });

  it("rejects a too-small durable start gap even when the pruned history has one valid row", () => {
    const databasePath = makeEvidenceDatabase({ startEventTimes: [1_001, 1_002, 5_001, 7_001] });
    const result = runNode(stressEvidence, [
      "--database",
      databasePath,
      "--expected-runs",
      "4",
      "--max-active-turns",
      "3",
      "--max-concurrent-starts",
      "2",
      "--min-start-interval-ms",
      "2000"
    ]);
    expect(result.status).toBe(1);
    expect(result.receipt).toEqual({ ok: false, failure: "start_interval_violated" });
  });

  it("requires explicit admission settings and consumes the sanitized evidence helper", () => {
    const script = readFileSync(stressScript, "utf8");
    const syntax = spawnSync("bash", ["-n", stressScript], { encoding: "utf8" });
    expect(syntax.status).toBe(0);
    expect(script).toContain("AGY_ACP_ADMISSION_MAX_ACTIVE_TURNS");
    expect(script).toContain("AGY_ACP_ADMISSION_MAX_CONCURRENT_STARTS");
    expect(script).toContain("AGY_ACP_ADMISSION_MIN_START_INTERVAL_MS");
    expect(script).toContain("STRESS_CONCURRENCY");
    expect(script).toContain('CONCURRENCY="$((MAX_ACTIVE_TURNS + 1))"');
    expect(script).toContain("admission policy active=");
    expect(script).toContain("official-kernel-stress-evidence.mjs");
    expect(script).toContain('PRESERVE_FAILURE="${STRESS_PRESERVE_FAILURE:-0}"');
    expect(script).toContain('require_binary_flag "$PRESERVE_FAILURE" "STRESS_PRESERVE_FAILURE"');
    expect(script).toContain('[[ "$value" == "0" || "$value" == "1" ]]');
    expect(script).toContain('exit_status" -ne 0 && "$PRESERVE_FAILURE" == "1"');
    expect(script).toContain("mode 0700");
    expect(script).toContain("may contain sensitive local diagnostics");
    expect(script).toContain("retention handler does not automatically read or print retained files");
    expect(script).toContain("exit-success=%s stdout-bytes=%s stderr-bytes=%s");
    expect(script).toContain('stat -c %s "$filename"');
    expect(script).toContain("ordinal=%d status=%s agent-id-present=%s");
    expect(script).toContain("safe_statuses=");
    expect(script).not.toContain("STRESS_CONCURRENCY:-6");
    expect(script).not.toMatch(/STRESS_CONCURRENCY:-[0-9]+/);
    expect(script).not.toContain('CONCURRENCY="8"');
    expect(script).not.toContain('cat "$TMPHOME/run-');
    expect(script).not.toContain('wc -c < "$filename"');
    expect(script).not.toContain("payload=%s");
    expect(script).not.toContain('raise SystemExit("isolated run returned an unexpected status")');
  });
});
