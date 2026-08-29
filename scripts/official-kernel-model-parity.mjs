#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MODEL_IDS = Object.freeze([
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium"
]);
const DEFAULT_CATALOG_COUNT = 14;
const MAX_NDJSON_LINE_BYTES = 1024 * 1024;
const MAX_FINAL_MESSAGE_CHARS = 64 * 1024;
const EXIT_GRACE_MS = 500;
const TERMINATE_GRACE_MS = 1_500;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_.-]{0,63}$/;
const TINY_IMAGE_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIW2Nk+M/wHwAF/gL+3MxZ8wAAAABJRU5ErkJggg==";
const TINY_AUDIO_WAV_BASE64 = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
const OBSERVED_UPDATE_KINDS = Object.freeze([
  "agent_thought_chunk",
  "agent_message_chunk",
  "tool_call",
  "tool_call_update"
]);

class HarnessError extends Error {
  constructor(kind) {
    super(kind);
    this.name = "HarnessError";
    this.kind = kind;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function boundedInteger(value, label, minimum, maximum) {
  if (!/^(?:0|[1-9]\d*)$/.test(value ?? "")) throw new HarnessError("invalid_arguments");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HarnessError("invalid_arguments");
  }
  return parsed;
}

function safeIdentifier(value) {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value) ? value : undefined;
}

function safeBuildId(value) {
  return typeof value === "string" && SAFE_BUILD_ID.test(value) ? value : "unknown";
}

function safeErrorCode(value) {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && SAFE_ERROR_CODE.test(value)) return value;
  return null;
}

function safeStopReason(value) {
  if (value === "end_turn" || value === "end_of_turn") return "end_turn";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  return "unknown";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireAbsoluteFile(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new HarnessError("invalid_arguments");
  const resolved = path.resolve(value);
  try {
    const stat = statSync(resolved);
    if (!stat.isFile()) throw new HarnessError("invalid_arguments");
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    throw new HarnessError("invalid_arguments");
  }
  return resolved;
}

function parseModelList(value) {
  if (typeof value !== "string" || value.length === 0) throw new HarnessError("invalid_arguments");
  const values = value.split(",").map((entry) => entry.trim());
  if (values.length === 0 || values.some((entry) => !safeIdentifier(entry))) {
    throw new HarnessError("invalid_arguments");
  }
  return values;
}

function unique(values) {
  return [...new Set(values)];
}

function parseProductAdapterEnvironment(environment) {
  const value = environment.P4_MODEL_PARITY_THROUGH_PRODUCT;
  if (value === undefined || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new HarnessError("invalid_arguments");
}

function printUsage() {
  process.stdout.write(
    "usage: node scripts/official-kernel-model-parity.mjs (--kernel PATH | --per-release-wrapper PATH | --stable-wrapper PATH | --direct-par PATH) [--live] [--tools] [--resume] [--cold-load] [--media] [--timeout] [--cancel] [--invalid-model] [--authenticate]\n\nDefault mode verifies the native catalog through session/new using existing cached OAuth state. It sends no authenticate request and does not test unauthenticated access. --cold-load and --media require --live and only run after their ACP capabilities are advertised. --timeout requires --live and passes only after a request timeout and process-group cleanup are both observed. Use --authenticate only for an explicit auth flow. Default request/overall timeouts are 180000ms/600000ms.\n"
  );
}

function parseArguments(argv, environment) {
  const expectedFromEnvironment = environment.P4_MODEL_PARITY_EXPECTED_MODELS;
  const options = {
    target: undefined,
    targetKind: undefined,
    expectedModelIds: expectedFromEnvironment === undefined
      ? [...DEFAULT_MODEL_IDS]
      : parseModelList(expectedFromEnvironment),
    expectedCount: boundedInteger(
      environment.P4_MODEL_PARITY_EXPECTED_COUNT ?? String(DEFAULT_CATALOG_COUNT),
      "expected count",
      1,
      1_000
    ),
    selectedModelIds: [],
    requestTimeoutMs: boundedInteger(
      environment.P4_MODEL_PARITY_REQUEST_TIMEOUT_MS ?? "180000",
      "request timeout",
      100,
      600_000
    ),
    overallTimeoutMs: boundedInteger(
      environment.P4_MODEL_PARITY_OVERALL_TIMEOUT_MS ?? "600000",
      "overall timeout",
      500,
      1_800_000
    ),
    cancelAfterMs: boundedInteger(
      environment.P4_MODEL_PARITY_CANCEL_AFTER_MS ?? "250",
      "cancel delay",
      10,
      60_000
    ),
    buildId: safeBuildId(environment.P4_MODEL_PARITY_BUILD_ID),
    authenticate: false,
    authMethod: undefined,
    live: false,
    tools: false,
    resume: false,
    coldLoad: false,
    media: false,
    timeout: false,
    cancel: false,
    invalidModel: false,
    throughProduct: parseProductAdapterEnvironment(environment)
  };
  let expectedModelsOverridden = false;

  const valueOptions = new Set([
    "kernel",
    "per-release-wrapper",
    "stable-wrapper",
    "direct-par",
    "expected-model",
    "expected-count",
    "model",
    "request-timeout-ms",
    "overall-timeout-ms",
    "cancel-after-ms",
    "build-id",
    "auth-method"
  ]);
  const flags = new Set([
    "authenticate",
    "live",
    "tools",
    "resume",
    "cold-load",
    "media",
    "timeout",
    "cancel",
    "invalid-model",
    "help"
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new HarnessError("invalid_arguments");
    const name = token.slice(2);
    if (flags.has(name)) {
      if (name === "help") return { help: true };
      const optionName = name === "invalid-model"
        ? "invalidModel"
        : name === "cold-load"
          ? "coldLoad"
          : name;
      options[optionName] = true;
      continue;
    }
    if (!valueOptions.has(name)) throw new HarnessError("invalid_arguments");
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new HarnessError("invalid_arguments");
    index += 1;

    if (name === "kernel" || name === "per-release-wrapper" || name === "stable-wrapper" || name === "direct-par") {
      if (options.target !== undefined) throw new HarnessError("invalid_arguments");
      options.target = requireAbsoluteFile(value);
      options.targetKind = name === "kernel" ? "wrapper" : name;
      continue;
    }
    if (name === "expected-model") {
      if (!expectedModelsOverridden) {
        options.expectedModelIds = [];
        expectedModelsOverridden = true;
      }
      if (!safeIdentifier(value)) throw new HarnessError("invalid_arguments");
      options.expectedModelIds.push(value);
      continue;
    }
    if (name === "expected-count") {
      options.expectedCount = boundedInteger(value, name, 1, 1_000);
      continue;
    }
    if (name === "model") {
      if (!safeIdentifier(value)) throw new HarnessError("invalid_arguments");
      options.selectedModelIds.push(value);
      continue;
    }
    if (name === "request-timeout-ms") {
      options.requestTimeoutMs = boundedInteger(value, name, 100, 600_000);
      continue;
    }
    if (name === "overall-timeout-ms") {
      options.overallTimeoutMs = boundedInteger(value, name, 500, 1_800_000);
      continue;
    }
    if (name === "cancel-after-ms") {
      options.cancelAfterMs = boundedInteger(value, name, 10, 60_000);
      continue;
    }
    if (name === "build-id") {
      options.buildId = safeBuildId(value);
      if (options.buildId === "unknown") throw new HarnessError("invalid_arguments");
      continue;
    }
    if (name === "auth-method") {
      if (!safeIdentifier(value)) throw new HarnessError("invalid_arguments");
      options.authMethod = value;
    }
  }

  if (options.target === undefined || options.targetKind === undefined) throw new HarnessError("invalid_arguments");
  if (options.targetKind === "direct-par" && !options.target.endsWith(".par")) {
    throw new HarnessError("invalid_arguments");
  }
  options.expectedModelIds = unique(options.expectedModelIds);
  options.selectedModelIds = unique(options.selectedModelIds);
  if (options.expectedModelIds.length === 0) throw new HarnessError("invalid_arguments");
  if (!options.authenticate && options.authMethod !== undefined) throw new HarnessError("invalid_arguments");
  if ((options.tools || options.resume || options.coldLoad || options.media || options.timeout || options.cancel) && !options.live) {
    throw new HarnessError("live_flag_required");
  }
  return options;
}

function makeCoverage(options) {
  return {
    scope: "single_run_not_plan_5_2_completion",
    run: {
      catalog: "not_run",
      text: "not_run",
      tools: "not_run",
      warmResume: "not_run",
      coldLoad: "not_run",
      media: "not_run",
      mcp: "not_run",
      invalidModel: "not_run",
      cancel: "not_run",
      timeout: "not_run",
      thoughtSeparation: "not_run",
      processCleanup: "not_run",
      configuredStress: "not_run"
    },
    deterministicFakeSuite: {
      catalog: true,
      text: true,
      tools: true,
      warmResume: true,
      coldLoad: true,
      media: true,
      invalidModel: true,
      cancel: true,
      timeout: true,
      thoughtSeparation: true,
      processCleanup: true,
      configuredStress: true
    },
    deferred: {
      complexParallelToolSchemas: {
        covered: false,
        status: "deferred",
        reason: "existing_profile_fixture_only"
      },
      mcp: {
        covered: false,
        status: "deferred",
        reason: "standards_correct_local_server_not_pinned"
      },
      real503Quota: {
        covered: false,
        status: "deferred",
        reason: "real_provider_failure_not_induced"
      },
      productionRollback: {
        covered: false,
        status: "deferred",
        owner: "lifecycle_manual_packages"
      }
    }
  };
}

function makeReceipt(options) {
  return {
    ok: false,
    buildId: options?.buildId ?? "unknown",
    adapter: options?.throughProduct ? "product" : "kernel",
    target: options?.targetKind === "direct-par" ? "direct-par" : options?.targetKind ?? "unknown",
    catalog: null,
    models: [],
    authentication: {
      mode: options?.authenticate ? "explicit_authenticate" : "cached_auth_session_new",
      authenticateSent: false,
      sessionNewVerified: false,
      unauthenticatedAccessTested: false,
      errorCode: null
    },
    capabilities: {
      resumeRequested: Boolean(options?.resume),
      resumeAdvertised: false,
      coldLoadRequested: Boolean(options?.coldLoad),
      loadAdvertised: false,
      mediaRequested: Boolean(options?.media),
      imageAdvertised: false,
      audioAdvertised: false,
      mcpHttpAdvertised: false,
      mcpSseAdvertised: false
    },
    invalidModel: { attempted: Boolean(options?.invalidModel), assertedLocal: false, errorCode: null },
    cancellation: {
      attempted: Boolean(options?.cancel),
      attempts: 0,
      racedCompletions: 0,
      cancelled: false,
      stopReason: null,
      durationMs: null
    },
    coldLoad: {
      requested: Boolean(options?.coldLoad),
      attempted: false,
      status: "not_run",
      reason: null,
      historyReplayed: false,
      sessionRetained: false,
      currentModelMatched: false,
      errorCode: null
    },
    media: {
      requested: Boolean(options?.media),
      attempted: false,
      status: "not_run",
      reason: null,
      imageSent: false,
      audioSent: false,
      markerMatched: false,
      stopReason: null,
      errorCode: null
    },
    timeout: {
      requested: Boolean(options?.timeout),
      attempted: false,
      status: "not_run",
      timedOut: false,
      processGroupCleaned: null
    },
    coverage: makeCoverage(options),
    timing: { totalMs: 0, initializeMs: null, sessionMs: null },
    diagnostics: { failure: null, errorCodes: [], malformedNdjson: false, stderrBytes: 0 }
  };
}

function classifyFailure(error) {
  if (error instanceof HarnessError) return error.kind;
  return "unexpected_failure";
}

function extractResponseError(response) {
  if (!isRecord(response) || !isRecord(response.error)) return null;
  return safeErrorCode(response.error.code);
}

function responseStopReason(response) {
  if (!isRecord(response) || !isRecord(response.result)) return "unknown";
  return safeStopReason(response.result.stopReason ?? response.result.stop_reason);
}

function nativeModelConfiguration(result) {
  if (!isRecord(result)) throw new HarnessError("invalid_catalog");
  const options = result.configOptions ?? result.config_options;
  if (!Array.isArray(options)) throw new HarnessError("invalid_catalog");
  const model = options.find((entry) => {
    if (!isRecord(entry)) return false;
    return entry.id === "model" || entry.configId === "model" || entry.name === "model";
  });
  if (!isRecord(model)) throw new HarnessError("invalid_catalog");
  const rawOptions = model.options;
  if (!Array.isArray(rawOptions)) throw new HarnessError("invalid_catalog");
  const ids = [];
  for (const option of rawOptions) {
    const candidate = typeof option === "string"
      ? option
      : isRecord(option)
        ? option.value ?? option.id ?? option.modelId
        : undefined;
    if (!safeIdentifier(candidate)) throw new HarnessError("invalid_catalog");
    ids.push(candidate);
  }
  const modelIds = unique(ids).sort();
  if (modelIds.length !== ids.length || modelIds.length === 0) throw new HarnessError("invalid_catalog");
  const current = model.currentValue ?? model.current_value ?? result.currentModelId ?? result.current_model_id;
  return { modelIds, currentModelId: safeIdentifier(current) ?? null };
}

function advertisesResumeCapability(result) {
  if (!isRecord(result)) return false;
  const agentCapabilities = result.agentCapabilities ?? result.agent_capabilities;
  if (!isRecord(agentCapabilities)) return false;
  const sessionCapabilities = agentCapabilities.sessionCapabilities ?? agentCapabilities.session_capabilities;
  if (!isRecord(sessionCapabilities)) return false;
  return isRecord(sessionCapabilities.resume);
}

function optionalCapabilities(result) {
  if (!isRecord(result)) {
    return { load: false, image: false, audio: false, mcpHttp: false, mcpSse: false };
  }
  const agentCapabilities = result.agentCapabilities ?? result.agent_capabilities;
  if (!isRecord(agentCapabilities)) {
    return { load: false, image: false, audio: false, mcpHttp: false, mcpSse: false };
  }
  const promptCapabilities = agentCapabilities.promptCapabilities ?? agentCapabilities.prompt_capabilities;
  const mcpCapabilities = agentCapabilities.mcpCapabilities ?? agentCapabilities.mcp_capabilities;
  return {
    load: agentCapabilities.loadSession === true || agentCapabilities.load_session === true,
    image: isRecord(promptCapabilities) && promptCapabilities.image === true,
    audio: isRecord(promptCapabilities) && promptCapabilities.audio === true,
    mcpHttp: isRecord(mcpCapabilities) && mcpCapabilities.http === true,
    mcpSse: isRecord(mcpCapabilities) && mcpCapabilities.sse === true
  };
}

function initializeTracker(sessionId, marker) {
  return {
    sessionId,
    marker,
    finalText: "",
    markerMatched: false,
    updateCounts: Object.fromEntries(OBSERVED_UPDATE_KINDS.map((kind) => [kind, 0])),
    otherUpdates: 0
  };
}

function updateKind(params) {
  if (!isRecord(params)) return "";
  const update = isRecord(params.update) ? params.update : params;
  return typeof update.sessionUpdate === "string"
    ? update.sessionUpdate
    : typeof update.session_update === "string"
      ? update.session_update
      : typeof update.type === "string"
        ? update.type
        : "";
}

function updateSessionId(params) {
  if (!isRecord(params)) return undefined;
  const direct = params.sessionId ?? params.session_id;
  if (typeof direct === "string") return direct;
  const update = isRecord(params.update) ? params.update : undefined;
  const nested = update?.sessionId ?? update?.session_id;
  return typeof nested === "string" ? nested : undefined;
}

function messageText(params) {
  if (!isRecord(params)) return "";
  const update = isRecord(params.update) ? params.update : params;
  const content = update.content;
  if (isRecord(content) && content.type === "text" && typeof content.text === "string") return content.text;
  if (Array.isArray(content)) {
    return content
      .filter((entry) => isRecord(entry) && entry.type === "text" && typeof entry.text === "string")
      .map((entry) => entry.text)
      .join("");
  }
  return "";
}

function mergeUpdateCounts(target, source) {
  for (const kind of OBSERVED_UPDATE_KINDS) target[kind] += source[kind];
  target.other += source.otherUpdates;
}

class NdjsonKernelClient {
  constructor(launch, requestTimeoutMs, diagnostics) {
    this.launch = launch;
    this.requestTimeoutMs = requestTimeoutMs;
    this.diagnostics = diagnostics;
    this.pending = new Map();
    this.nextId = 1;
    this.stdoutBuffer = "";
    this.trackers = new Map();
    this.closed = false;
    this.terminalError = undefined;
    this.child = undefined;
    this.exitPromise = undefined;
  }

  async start() {
    const child = spawn(this.launch.command, this.launch.args, {
      cwd: repositoryRoot,
      env: this.launch.environment,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"]
    });
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      child.kill("SIGKILL");
      throw new HarnessError("process_start_failed");
    }
    this.child = child;
    this.exitPromise = new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.consumeStdout(chunk));
    child.stderr.on("data", (chunk) => {
      const size = Buffer.byteLength(chunk);
      this.diagnostics.stderrBytes = Math.min(1_000_000, this.diagnostics.stderrBytes + size);
    });
    child.once("error", () => this.fail(new HarnessError("process_start_failed")));
    child.once("exit", () => {
      if (!this.closed && this.pending.size > 0) this.fail(new HarnessError("process_exited"));
    });
  }

  consumeStdout(chunk) {
    if (this.terminalError !== undefined) return;
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer) > MAX_NDJSON_LINE_BYTES * 2) {
      this.diagnostics.malformedNdjson = true;
      this.fail(new HarnessError("malformed_ndjson"));
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length === 0) continue;
      if (Buffer.byteLength(line) > MAX_NDJSON_LINE_BYTES) {
        this.diagnostics.malformedNdjson = true;
        this.fail(new HarnessError("malformed_ndjson"));
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.diagnostics.malformedNdjson = true;
        this.fail(new HarnessError("malformed_ndjson"));
        return;
      }
      if (!isRecord(message)) {
        this.diagnostics.malformedNdjson = true;
        this.fail(new HarnessError("malformed_ndjson"));
        return;
      }
      this.consumeMessage(message);
    }
  }

  consumeMessage(message) {
    if (typeof message.method === "string" && message.method === "session/update") {
      const sessionId = updateSessionId(message.params);
      const tracker = sessionId === undefined ? undefined : this.trackers.get(sessionId);
      if (tracker !== undefined) {
        const kind = updateKind(message.params);
        if (OBSERVED_UPDATE_KINDS.includes(kind)) tracker.updateCounts[kind] += 1;
        else tracker.otherUpdates += 1;
        if (kind === "agent_message_chunk") {
          const text = messageText(message.params);
          if (tracker.finalText.length < MAX_FINAL_MESSAGE_CHARS) {
            tracker.finalText += text.slice(0, MAX_FINAL_MESSAGE_CHARS - tracker.finalText.length);
          }
          if (!tracker.markerMatched && tracker.finalText.includes(tracker.marker)) {
            tracker.markerMatched = true;
          }
        }
      }
      return;
    }
    if ((typeof message.id === "number" || typeof message.id === "string") && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      pending.resolve(message);
    }
  }

  request(method, params) {
    if (this.terminalError !== undefined) return Promise.reject(this.terminalError);
    if (this.closed || this.child?.stdin.destroyed) return Promise.reject(new HarnessError("process_closed"));
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HarnessError("request_timeout"));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new HarnessError("process_write_failed"));
      }
    });
  }

  notify(method, params) {
    if (this.closed || this.child?.stdin.destroyed) throw new HarnessError("process_closed");
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    } catch {
      throw new HarnessError("process_write_failed");
    }
  }

  track(tracker) {
    this.trackers.set(tracker.sessionId, tracker);
  }

  untrack(tracker) {
    this.trackers.delete(tracker.sessionId);
  }

  fail(error) {
    if (this.terminalError !== undefined) return;
    this.terminalError = error;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  processGroupAlive() {
    const child = this.child;
    if (child === undefined || child.pid === undefined || child.pid <= 0) return false;
    if (process.platform === "win32") return child.exitCode === null && child.signalCode === null;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  }

  async close(requireProcessGroupCleanup = false) {
    if (this.closed) {
      return { attempted: requireProcessGroupCleanup, confirmed: !this.processGroupAlive() };
    }
    this.closed = true;
    const child = this.child;
    if (child === undefined || this.exitPromise === undefined) {
      return { attempted: requireProcessGroupCleanup, confirmed: !this.processGroupAlive() };
    }
    if (requireProcessGroupCleanup) {
      this.kill("SIGTERM");
      await Promise.race([this.exitPromise, sleep(TERMINATE_GRACE_MS)]);
      if (this.processGroupAlive()) {
        this.kill("SIGKILL");
        await Promise.race([this.exitPromise, sleep(EXIT_GRACE_MS)]);
      }
      return { attempted: true, confirmed: !this.processGroupAlive() };
    }
    try {
      child.stdin.end();
    } catch {
      // Process termination below remains authoritative.
    }
    await Promise.race([this.exitPromise, sleep(EXIT_GRACE_MS)]);
    if (child.exitCode === null && child.signalCode === null) {
      this.kill("SIGTERM");
      await Promise.race([this.exitPromise, sleep(TERMINATE_GRACE_MS)]);
    }
    if (child.exitCode === null && child.signalCode === null) this.kill("SIGKILL");
    await Promise.race([this.exitPromise, sleep(EXIT_GRACE_MS)]);
    return { attempted: false, confirmed: null };
  }

  kill(signal) {
    const child = this.child;
    if (child === undefined || child.pid === undefined || child.pid <= 0) return;
    if (process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Fall back to the direct child if its process group is already gone.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // The process already exited.
    }
  }
}

function launchFor(options, environment) {
  const childEnvironment = { ...environment };
  if (options.throughProduct) {
    const productCli = path.join(repositoryRoot, "dist", "ACP Connector", "main.js");
    if (!existsSync(productCli)) throw new HarnessError("product_adapter_missing");
    childEnvironment.PASEO_AGY_ACP_KERNEL = "official";
    childEnvironment.PASEO_AGY_ACP_OFFICIAL_BIN = options.target;
    return { command: process.execPath, args: [productCli], environment: childEnvironment };
  }
  const args = options.targetKind === "direct-par" ? ["--uid="] : [];
  return { command: options.target, args, environment: childEnvironment };
}

function makeWorkspace() {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "paseo-agy-acp-model-parity-"));
  chmodSync(workspace, 0o700);
  return workspace;
}

function makeMarker(workspace, label) {
  const marker = `P4_${label}_${randomBytes(18).toString("hex")}`;
  const filename = path.join(workspace, `${label.toLowerCase()}-${randomBytes(10).toString("hex")}.txt`);
  writeFileSync(filename, marker, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { marker, filename };
}

function makePrompt(marker, kind, filename) {
  if (kind === "tool") {
    return [
      "Use view_file to read exactly the private file below and return only its contents.",
      `P4_TOOL_FILE=${filename}`
    ].join("\n");
  }
  if (kind === "cancel") return "P4_CANCEL_REQUEST";
  return `Return this exact marker with no explanation: P4_EXPECT_MARKER=${marker}`;
}

function sessionIdFrom(response) {
  if (!isRecord(response) || !isRecord(response.result) || typeof response.result.sessionId !== "string") {
    throw new HarnessError("invalid_response");
  }
  return response.result.sessionId;
}

async function createSession(client, workspace, diagnostics) {
  const response = await client.request("session/new", { cwd: workspace, mcpServers: [] });
  const errorCode = extractResponseError(response);
  if (errorCode !== null) {
    diagnostics.errorCodes.add(errorCode);
    diagnostics.sessionCreateErrorCode = errorCode;
    throw new HarnessError("session_create_failed");
  }
  return { sessionId: sessionIdFrom(response), configuration: nativeModelConfiguration(response.result) };
}

async function setModel(client, sessionId, modelId, diagnostics) {
  const response = await client.request("session/set_config_option", {
    sessionId,
    configId: "model",
    value: modelId
  });
  const errorCode = extractResponseError(response);
  if (errorCode !== null) diagnostics.errorCodes.add(errorCode);
  return { response, errorCode };
}

async function runPrompt(client, sessionId, marker, prompt) {
  const tracker = initializeTracker(sessionId, marker);
  client.track(tracker);
  try {
    const response = await client.request("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text: prompt }]
    });
    return {
      markerMatched: tracker.markerMatched,
      stopReason: responseStopReason(response),
      errorCode: extractResponseError(response),
      updateCounts: { ...tracker.updateCounts, other: tracker.otherUpdates }
    };
  } finally {
    client.untrack(tracker);
  }
}

function makeMediaPrompt(marker, capabilities) {
  return [
    {
      type: "text",
      text: `Return this exact marker with no explanation: P4_EXPECT_MARKER=${marker} P6_MEDIA_REQUEST`
    },
    ...(capabilities.image
      ? [{ type: "image", mimeType: "image/png", data: TINY_IMAGE_PNG_BASE64 }]
      : []),
    ...(capabilities.audio
      ? [{ type: "audio", mimeType: "audio/wav", data: TINY_AUDIO_WAV_BASE64 }]
      : [])
  ];
}

function makeTimeoutPrompt(marker) {
  return `P6_TIMEOUT_REQUEST P4_EXPECT_MARKER=${marker}`;
}

async function runPromptContent(client, sessionId, marker, prompt) {
  const tracker = initializeTracker(sessionId, marker);
  client.track(tracker);
  try {
    const response = await client.request("session/prompt", { sessionId, prompt });
    return {
      markerMatched: tracker.markerMatched,
      stopReason: responseStopReason(response),
      errorCode: extractResponseError(response),
      updateCounts: { ...tracker.updateCounts, other: tracker.otherUpdates }
    };
  } finally {
    client.untrack(tracker);
  }
}

async function loadSession(client, sessionId, workspace, historyMarker, diagnostics) {
  const tracker = initializeTracker(sessionId, historyMarker);
  client.track(tracker);
  try {
    const response = await client.request("session/load", { sessionId, cwd: workspace, mcpServers: [] });
    const errorCode = extractResponseError(response);
    if (errorCode !== null) {
      diagnostics.errorCodes.add(errorCode);
      return { ok: false, historyReplayed: false, configuration: null, errorCode };
    }
    return {
      ok: true,
      historyReplayed: tracker.markerMatched,
      configuration: nativeModelConfiguration(response.result),
      errorCode: null
    };
  } finally {
    client.untrack(tracker);
  }
}

async function runColdLoadAcceptance(client, workspace, modelId, diagnostics) {
  const result = {
    historyReplayed: false,
    sessionRetained: false,
    currentModelMatched: false,
    errorCode: null,
    passed: false
  };
  const created = await createSession(client, workspace, diagnostics);
  if (!created.configuration.modelIds.includes(modelId)) {
    result.errorCode = "MODEL_NOT_IN_NATIVE_CATALOG";
    return result;
  }
  const selection = await setModel(client, created.sessionId, modelId, diagnostics);
  if (selection.errorCode !== null) {
    result.errorCode = selection.errorCode;
    return result;
  }

  const historyMarker = `P4_COLD_LOAD_${randomBytes(18).toString("hex")}`;
  const seed = await runPrompt(client, created.sessionId, historyMarker, makePrompt(historyMarker, "text"));
  if (seed.errorCode !== null) {
    diagnostics.errorCodes.add(seed.errorCode);
    result.errorCode = seed.errorCode;
    return result;
  }
  if (!seed.markerMatched || seed.stopReason !== "end_turn") return result;

  const loaded = await loadSession(client, created.sessionId, workspace, historyMarker, diagnostics);
  if (!loaded.ok || loaded.configuration === null) {
    result.errorCode = loaded.errorCode;
    return result;
  }
  result.historyReplayed = loaded.historyReplayed;
  result.currentModelMatched = loaded.configuration.currentModelId === modelId
    && loaded.configuration.modelIds.includes(modelId);

  const retainedMarker = `P4_COLD_RETAINED_${randomBytes(18).toString("hex")}`;
  const retained = await runPrompt(client, created.sessionId, retainedMarker, makePrompt(retainedMarker, "text"));
  if (retained.errorCode !== null) {
    diagnostics.errorCodes.add(retained.errorCode);
    result.errorCode = retained.errorCode;
    return result;
  }
  result.sessionRetained = retained.markerMatched && retained.stopReason === "end_turn";
  result.passed = result.historyReplayed && result.sessionRetained && result.currentModelMatched;
  return result;
}

async function runMediaAcceptance(client, workspace, modelId, capabilities, diagnostics) {
  const result = {
    imageSent: false,
    audioSent: false,
    markerMatched: false,
    stopReason: null,
    errorCode: null,
    passed: false
  };
  const created = await createSession(client, workspace, diagnostics);
  if (!created.configuration.modelIds.includes(modelId)) {
    result.errorCode = "MODEL_NOT_IN_NATIVE_CATALOG";
    return result;
  }
  const selection = await setModel(client, created.sessionId, modelId, diagnostics);
  if (selection.errorCode !== null) {
    result.errorCode = selection.errorCode;
    return result;
  }
  const marker = `P4_MEDIA_${randomBytes(18).toString("hex")}`;
  const prompt = makeMediaPrompt(marker, capabilities);
  result.imageSent = capabilities.image;
  result.audioSent = capabilities.audio;
  const turn = await runPromptContent(client, created.sessionId, marker, prompt);
  result.markerMatched = turn.markerMatched;
  result.stopReason = turn.stopReason;
  if (turn.errorCode !== null) {
    diagnostics.errorCodes.add(turn.errorCode);
    result.errorCode = turn.errorCode;
    return result;
  }
  result.passed = result.markerMatched && result.stopReason === "end_turn";
  return result;
}

async function runTimeoutAcceptance(client, workspace, modelId, diagnostics) {
  const created = await createSession(client, workspace, diagnostics);
  if (!created.configuration.modelIds.includes(modelId)) return { timedOut: false };
  const selection = await setModel(client, created.sessionId, modelId, diagnostics);
  if (selection.errorCode !== null) {
    diagnostics.errorCodes.add(selection.errorCode);
    return { timedOut: false };
  }
  const marker = `P4_TIMEOUT_${randomBytes(18).toString("hex")}`;
  try {
    const turn = await runPrompt(client, created.sessionId, marker, makeTimeoutPrompt(marker));
    if (turn.errorCode !== null) diagnostics.errorCodes.add(turn.errorCode);
    return { timedOut: false };
  } catch (error) {
    if (error instanceof HarnessError && error.kind === "request_timeout") return { timedOut: true };
    throw error;
  }
}

async function resumeSession(client, sessionId, workspace, expectedModelId, diagnostics) {
  const response = await client.request("session/resume", { sessionId, cwd: workspace, mcpServers: [] });
  const errorCode = extractResponseError(response);
  if (errorCode !== null) {
    diagnostics.errorCodes.add(errorCode);
    return { ok: false, sessionId, currentModelMatched: false, errorCode };
  }
  const configuration = nativeModelConfiguration(response.result);
  return {
    ok: true,
    // RC01 ResumeSessionResponse does not contain a sessionId; resume stays on the caller's session.
    sessionId,
    currentModelMatched: configuration.currentModelId === expectedModelId,
    errorCode: null
  };
}

async function runModel(client, workspace, modelId, options, diagnostics) {
  const startedAt = Date.now();
  const aggregateUpdates = Object.fromEntries([...OBSERVED_UPDATE_KINDS, "other"].map((kind) => [kind, 0]));
  const result = {
    id: modelId,
    selected: false,
    errorCodes: [],
    stopReason: null,
    messageMarkerMatched: false,
    toolRounds: [],
    resumed: null,
    updates: aggregateUpdates,
    durationMs: 0,
    passed: false
  };

  const created = await createSession(client, workspace, diagnostics);
  if (!created.configuration.modelIds.includes(modelId)) {
    result.errorCodes.push("MODEL_NOT_IN_NATIVE_CATALOG");
    result.durationMs = Date.now() - startedAt;
    return result;
  }
  let sessionId = created.sessionId;
  const selected = await setModel(client, sessionId, modelId, diagnostics);
  if (selected.errorCode !== null) {
    result.errorCodes.push(selected.errorCode);
    result.durationMs = Date.now() - startedAt;
    return result;
  }
  result.selected = true;

  const textMarker = `P4_TEXT_${randomBytes(18).toString("hex")}`;
  const text = await runPrompt(client, sessionId, textMarker, makePrompt(textMarker, "text"));
  mergeUpdateCounts(result.updates, { ...text.updateCounts, otherUpdates: text.updateCounts.other });
  result.stopReason = text.stopReason;
  result.messageMarkerMatched = text.markerMatched;
  if (text.errorCode !== null) {
    result.errorCodes.push(text.errorCode);
    diagnostics.errorCodes.add(text.errorCode);
  }

  if (options.tools) {
    const first = makeMarker(workspace, "TOOL_ONE");
    const turn = await runPrompt(client, sessionId, first.marker, makePrompt(first.marker, "tool", first.filename));
    mergeUpdateCounts(result.updates, { ...turn.updateCounts, otherUpdates: turn.updateCounts.other });
    result.toolRounds.push({
      markerMatched: turn.markerMatched,
      stopReason: turn.stopReason,
      toolEvents: turn.updateCounts.tool_call + turn.updateCounts.tool_call_update
    });
    if (turn.errorCode !== null) {
      result.errorCodes.push(turn.errorCode);
      diagnostics.errorCodes.add(turn.errorCode);
    }
  }

  if (options.resume) {
    const resumed = await resumeSession(client, sessionId, workspace, modelId, diagnostics);
    result.resumed = { ok: resumed.ok, currentModelMatched: resumed.currentModelMatched, markerMatched: false };
    if (resumed.errorCode !== null) result.errorCodes.push(resumed.errorCode);
    if (resumed.ok) {
      sessionId = resumed.sessionId;
      const resumeMarker = `P4_RESUME_${randomBytes(18).toString("hex")}`;
      const turn = await runPrompt(client, sessionId, resumeMarker, makePrompt(resumeMarker, "text"));
      mergeUpdateCounts(result.updates, { ...turn.updateCounts, otherUpdates: turn.updateCounts.other });
      result.resumed.markerMatched = turn.markerMatched;
      if (turn.errorCode !== null) {
        result.errorCodes.push(turn.errorCode);
        diagnostics.errorCodes.add(turn.errorCode);
      }
    }
  }

  if (options.tools) {
    const second = makeMarker(workspace, "TOOL_TWO");
    const turn = await runPrompt(client, sessionId, second.marker, makePrompt(second.marker, "tool", second.filename));
    mergeUpdateCounts(result.updates, { ...turn.updateCounts, otherUpdates: turn.updateCounts.other });
    result.toolRounds.push({
      markerMatched: turn.markerMatched,
      stopReason: turn.stopReason,
      toolEvents: turn.updateCounts.tool_call + turn.updateCounts.tool_call_update
    });
    if (turn.errorCode !== null) {
      result.errorCodes.push(turn.errorCode);
      diagnostics.errorCodes.add(turn.errorCode);
    }
  }

  const toolsPassed = !options.tools || result.toolRounds.length === 2 && result.toolRounds.every(
    (round) => round.markerMatched && round.stopReason === "end_turn" && round.toolEvents > 0
  );
  const resumePassed = !options.resume || result.resumed?.ok === true && result.resumed.currentModelMatched === true && result.resumed.markerMatched === true;
  result.passed = result.selected && result.errorCodes.length === 0 && result.stopReason === "end_turn" && result.messageMarkerMatched && toolsPassed && resumePassed;
  result.durationMs = Date.now() - startedAt;
  return result;
}

async function runCancellationAttempt(client, workspace, modelId, cancelAfterMs, diagnostics) {
  const created = await createSession(client, workspace, diagnostics);
  if (!created.configuration.modelIds.includes(modelId)) return { cancelled: false, stopReason: "unknown" };
  const selection = await setModel(client, created.sessionId, modelId, diagnostics);
  if (selection.errorCode !== null) return { cancelled: false, stopReason: "unknown" };
  const tracker = initializeTracker(created.sessionId, "P4_CANCEL_NEVER_MATCHES");
  client.track(tracker);
  try {
    const request = client.request("session/prompt", {
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: makePrompt("", "cancel") }]
    });
    await sleep(cancelAfterMs);
    client.notify("session/cancel", { sessionId: created.sessionId });
    const response = await request;
    const errorCode = extractResponseError(response);
    if (errorCode !== null) diagnostics.errorCodes.add(errorCode);
    const stopReason = responseStopReason(response);
    return { cancelled: stopReason === "cancelled", stopReason };
  } finally {
    client.untrack(tracker);
  }
}

async function runCancellation(client, workspace, modelId, options, diagnostics) {
  const startedAt = Date.now();
  const first = await runCancellationAttempt(client, workspace, modelId, options.cancelAfterMs, diagnostics);
  const result = {
    attempted: true,
    attempts: 1,
    racedCompletions: first.stopReason === "end_turn" ? 1 : 0,
    cancelled: first.cancelled,
    stopReason: first.stopReason,
    durationMs: null
  };
  if (!result.cancelled && first.stopReason === "end_turn") {
    const retry = await runCancellationAttempt(client, workspace, modelId, 10, diagnostics);
    result.attempts = 2;
    result.racedCompletions += retry.stopReason === "end_turn" ? 1 : 0;
    result.cancelled = retry.cancelled;
    result.stopReason = retry.stopReason;
  }
  result.durationMs = Date.now() - startedAt;
  return result;
}

async function execute(options, receipt, environment) {
  const workspace = makeWorkspace();
  const diagnostics = {
    errorCodes: new Set(),
    stderrBytes: 0,
    malformedNdjson: false,
    sessionCreateErrorCode: null
  };
  const client = new NdjsonKernelClient(launchFor(options, environment), options.requestTimeoutMs, diagnostics);
  const startedAt = Date.now();
  const overallTimer = setTimeout(() => client.fail(new HarnessError("overall_timeout")), options.overallTimeoutMs);
  let requireProcessGroupCleanup = false;
  let processGroupCleaned = null;
  try {
    await client.start();
    const initializeStartedAt = Date.now();
    const initialized = await client.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "paseo-model-parity", version: "p4" },
      clientCapabilities: {}
    });
    receipt.timing.initializeMs = Date.now() - initializeStartedAt;
    const initializeErrorCode = extractResponseError(initialized);
    if (initializeErrorCode !== null) diagnostics.errorCodes.add(initializeErrorCode);
    if (initializeErrorCode !== null || !isRecord(initialized.result)) {
      throw new HarnessError("initialize_failed");
    }
    const kernelBuildId = isRecord(initialized.result.agentInfo)
      ? safeBuildId(initialized.result.agentInfo.version)
      : "unknown";
    if (receipt.buildId === "unknown") receipt.buildId = kernelBuildId;
    receipt.capabilities.resumeAdvertised = advertisesResumeCapability(initialized.result);
    const optional = optionalCapabilities(initialized.result);
    receipt.capabilities.loadAdvertised = optional.load;
    receipt.capabilities.imageAdvertised = optional.image;
    receipt.capabilities.audioAdvertised = optional.audio;
    receipt.capabilities.mcpHttpAdvertised = optional.mcpHttp;
    receipt.capabilities.mcpSseAdvertised = optional.mcpSse;
    if (options.resume && !receipt.capabilities.resumeAdvertised) {
      throw new HarnessError("resume_capability_missing");
    }

    if (options.authenticate) {
      receipt.authentication.authenticateSent = true;
      const auth = await client.request("authenticate", { methodId: options.authMethod ?? "oauth-personal" });
      const errorCode = extractResponseError(auth);
      if (errorCode !== null) {
        diagnostics.errorCodes.add(errorCode);
        receipt.authentication.errorCode = errorCode;
        throw new HarnessError("authentication_failed");
      }
    }

    const sessionStartedAt = Date.now();
    receipt.coverage.run.catalog = "attempted";
    // RC01 catalog checks exercise a pre-existing local OAuth cache via session/new.
    // Explicit authenticate is opt-in because its refresh path can race the kernel cache.
    const catalogSession = await createSession(client, workspace, diagnostics);
    receipt.timing.sessionMs = Date.now() - sessionStartedAt;
    receipt.authentication.sessionNewVerified = true;
    const missing = options.expectedModelIds.filter((modelId) => !catalogSession.configuration.modelIds.includes(modelId));
    receipt.catalog = {
      count: catalogSession.configuration.modelIds.length,
      modelIds: catalogSession.configuration.modelIds,
      currentModelId: catalogSession.configuration.currentModelId
    };
    if (missing.length > 0 || receipt.catalog.count !== options.expectedCount) {
      throw new HarnessError("catalog_mismatch");
    }
    receipt.coverage.run.catalog = "passed";

    if (options.invalidModel) {
      receipt.coverage.run.invalidModel = "attempted";
      const invalid = await setModel(client, catalogSession.sessionId, "p4-invalid-model", diagnostics);
      receipt.invalidModel = {
        attempted: true,
        assertedLocal: invalid.errorCode === -32602,
        errorCode: invalid.errorCode
      };
      if (!receipt.invalidModel.assertedLocal) throw new HarnessError("invalid_model_not_local");
      receipt.coverage.run.invalidModel = "passed";
    }

    if (options.live) {
      receipt.coverage.run.text = "attempted";
      if (options.tools) receipt.coverage.run.tools = "attempted";
      if (options.resume) receipt.coverage.run.warmResume = "attempted";
      receipt.coverage.run.thoughtSeparation = "attempted";
      const selectedModels = options.selectedModelIds.length > 0 ? options.selectedModelIds : options.expectedModelIds;
      for (const modelId of selectedModels) {
        const model = await runModel(client, workspace, modelId, options, diagnostics);
        receipt.models.push(model);
      }
      const modelsPassed = receipt.models.every((model) => model.passed);
      receipt.coverage.run.text = modelsPassed ? "passed" : "failed";
      if (options.tools) receipt.coverage.run.tools = modelsPassed ? "passed" : "failed";
      if (options.resume) receipt.coverage.run.warmResume = modelsPassed ? "passed" : "failed";
      const thoughtSeparationObserved = receipt.models.some(
        (model) => model.updates.agent_thought_chunk > 0 && model.messageMarkerMatched
      );
      receipt.coverage.run.thoughtSeparation = thoughtSeparationObserved ? "passed" : "deferred";
      if (!thoughtSeparationObserved) {
        receipt.coverage.deferred.thoughtSeparation = {
          covered: false,
          status: "deferred",
          reason: "no_thought_update_observed"
        };
      }
      if (!modelsPassed) throw new HarnessError("model_acceptance_failed");
    }

    const lifecycleModelId = options.selectedModelIds[0] ?? options.expectedModelIds[0];
    if (options.coldLoad) {
      if (!receipt.capabilities.loadAdvertised) {
        receipt.coldLoad.status = "deferred";
        receipt.coldLoad.reason = "load_session_not_advertised";
        receipt.coverage.run.coldLoad = "deferred";
      } else {
        receipt.coldLoad.attempted = true;
        receipt.coldLoad.status = "attempted";
        receipt.coverage.run.coldLoad = "attempted";
        try {
          const coldLoad = await runColdLoadAcceptance(client, workspace, lifecycleModelId, diagnostics);
          receipt.coldLoad.historyReplayed = coldLoad.historyReplayed;
          receipt.coldLoad.sessionRetained = coldLoad.sessionRetained;
          receipt.coldLoad.currentModelMatched = coldLoad.currentModelMatched;
          receipt.coldLoad.errorCode = coldLoad.errorCode;
          if (!coldLoad.passed) throw new HarnessError("cold_load_failed");
          receipt.coldLoad.status = "passed";
          receipt.coverage.run.coldLoad = "passed";
        } catch (error) {
          receipt.coldLoad.status = "failed";
          receipt.coverage.run.coldLoad = "failed";
          throw error;
        }
      }
    }

    if (options.media) {
      if (!receipt.capabilities.imageAdvertised && !receipt.capabilities.audioAdvertised) {
        receipt.media.status = "deferred";
        receipt.media.reason = "image_audio_not_advertised";
        receipt.coverage.run.media = "deferred";
      } else {
        receipt.media.attempted = true;
        receipt.media.status = "attempted";
        receipt.coverage.run.media = "attempted";
        try {
          const media = await runMediaAcceptance(client, workspace, lifecycleModelId, {
            image: receipt.capabilities.imageAdvertised,
            audio: receipt.capabilities.audioAdvertised
          }, diagnostics);
          receipt.media.imageSent = media.imageSent;
          receipt.media.audioSent = media.audioSent;
          receipt.media.markerMatched = media.markerMatched;
          receipt.media.stopReason = media.stopReason;
          receipt.media.errorCode = media.errorCode;
          if (!media.passed) throw new HarnessError("media_acceptance_failed");
          receipt.media.status = "passed";
          receipt.coverage.run.media = "passed";
        } catch (error) {
          receipt.media.status = "failed";
          receipt.coverage.run.media = "failed";
          throw error;
        }
      }
    }

    if (options.timeout) {
      requireProcessGroupCleanup = true;
      receipt.timeout.attempted = true;
      receipt.timeout.status = "attempted";
      receipt.coverage.run.timeout = "attempted";
      receipt.coverage.run.processCleanup = "attempted";
      try {
        const timeout = await runTimeoutAcceptance(client, workspace, lifecycleModelId, diagnostics);
        receipt.timeout.timedOut = timeout.timedOut;
        if (!timeout.timedOut) throw new HarnessError("timeout_not_confirmed");
        receipt.timeout.status = "passed";
        receipt.coverage.run.timeout = "passed";
      } catch (error) {
        receipt.timeout.status = "failed";
        receipt.coverage.run.timeout = "failed";
        throw error;
      }
    }

    if (options.cancel) {
      receipt.coverage.run.cancel = "attempted";
      const modelId = options.selectedModelIds[0] ?? options.expectedModelIds[0];
      receipt.cancellation = await runCancellation(client, workspace, modelId, options, diagnostics);
      receipt.coverage.run.cancel = receipt.cancellation.cancelled ? "passed" : "failed";
      if (!receipt.cancellation.cancelled) throw new HarnessError("cancellation_not_confirmed");
    }

    receipt.ok = true;
  } finally {
    clearTimeout(overallTimer);
    receipt.timing.totalMs = Date.now() - startedAt;
    receipt.diagnostics.stderrBytes = diagnostics.stderrBytes;
    receipt.diagnostics.malformedNdjson = diagnostics.malformedNdjson;
    receipt.diagnostics.errorCodes = [...diagnostics.errorCodes].sort((left, right) => String(left).localeCompare(String(right)));
    if (receipt.authentication.errorCode === null && diagnostics.sessionCreateErrorCode !== null) {
      receipt.authentication.errorCode = diagnostics.sessionCreateErrorCode;
    }
    const cleanup = await client.close(requireProcessGroupCleanup);
    if (requireProcessGroupCleanup) {
      processGroupCleaned = cleanup.confirmed === true;
      receipt.timeout.processGroupCleaned = processGroupCleaned;
      if (!processGroupCleaned) receipt.timeout.status = "failed";
      receipt.coverage.run.processCleanup = processGroupCleaned ? "passed" : "failed";
    }
    rmSync(workspace, { recursive: true, force: true });
  }
  if (requireProcessGroupCleanup && processGroupCleaned !== true) {
    throw new HarnessError("process_cleanup_unconfirmed");
  }
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2), process.env);
  } catch (error) {
    const receipt = makeReceipt(undefined);
    receipt.diagnostics.failure = classifyFailure(error);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    printUsage();
    return;
  }
  const receipt = makeReceipt(options);
  try {
    await execute(options, receipt, process.env);
  } catch (error) {
    receipt.ok = false;
    receipt.diagnostics.failure = classifyFailure(error);
  }
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  if (!receipt.ok) process.exitCode = 1;
}

void main();
