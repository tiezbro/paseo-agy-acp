#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const models = (process.env.P4_FAKE_MODELS ?? [
  "claude-sonnet-4-6",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium"
].join(","))
  .split(",")
  .filter(Boolean);
const behavior = process.env.P4_FAKE_BEHAVIOR ?? "normal";
let currentModel = models[0];
let sessionNumber = 0;
let authenticated = false;
let cancellationPromptCount = 0;
const pendingCancels = new Map();
const sessionModels = new Map();
const sessionHistory = new Map();

function observe(value) {
  if (process.env.P4_FAKE_OBSERVATION === undefined) return;
  appendFileSync(process.env.P4_FAKE_OBSERVATION, `${JSON.stringify(value)}\n`, "utf8");
}

function observedRequest(message) {
  const observed = { method: message.method, args: process.argv.slice(2) };
  if (message.method === "initialize") {
    observed.params = {
      protocolVersion: message.params?.protocolVersion,
      clientInfo: message.params?.clientInfo,
      clientCapabilities: message.params?.clientCapabilities
    };
  } else if (message.method === "session/resume" || message.method === "session/load") {
    observed.params = {
      sessionId: message.params?.sessionId,
      cwd: message.params?.cwd,
      mcpServers: message.params?.mcpServers
    };
  } else if (message.method === "session/prompt") {
    observed.params = { sessionId: message.params?.sessionId };
    const promptParts = observedMediaPromptShape(message.params);
    if (promptParts !== undefined) observed.params.promptParts = promptParts;
  }
  return observed;
}

function observedMediaPromptShape(params) {
  if (!Array.isArray(params?.prompt)) return undefined;
  const parts = params.prompt
    .filter((part) => part && typeof part === "object")
    .map((part) => {
      const observed = { type: part.type };
      if ((part.type === "image" || part.type === "audio") && typeof part.mimeType === "string") {
        observed.mimeType = part.mimeType;
        observed.dataBytes = typeof part.data === "string" ? Buffer.from(part.data, "base64").byteLength : 0;
      }
      return observed;
    });
  return parts.some((part) => part.type === "image" || part.type === "audio") ? parts : undefined;
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function update(sessionId, sessionUpdate, text) {
  write({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate,
        ...(text === undefined ? {} : { content: { type: "text", text } })
      }
    }
  });
}

function configuration(sessionId) {
  return [{
    id: "model",
    currentValue: sessionModels.get(sessionId) ?? currentModel,
    options: models.map((value) => ({ value }))
  }];
}

function promptText(params) {
  const prompt = params?.prompt;
  if (!Array.isArray(prompt)) return "";
  return prompt
    .filter((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function expectedMarker(text) {
  const match = /P4_EXPECT_MARKER=([^\s]+)/.exec(text);
  return match?.[1] ?? "";
}

function toolMarker(text) {
  const match = /^P4_TOOL_FILE=(.+)$/m.exec(text);
  if (match === null) return "";
  try {
    return readFileSync(match[1], "utf8").trim();
  } catch {
    return "";
  }
}

function spawnHangingChild() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  if (process.env.P4_FAKE_CHILD_PID_FILE !== undefined && child.pid !== undefined) {
    writeFileSync(process.env.P4_FAKE_CHILD_PID_FILE, String(child.pid), "utf8");
  }
}

function requiresExplicitAuthentication() {
  return behavior === "auth-required" || behavior === "explicit-auth-success";
}

function initializeCapabilities() {
  if (behavior === "missing-resume-capability") return { agentCapabilities: { sessionCapabilities: {} } };
  if (behavior === "snake-resume-capability") {
    return { agent_capabilities: { session_capabilities: { resume: {} } } };
  }
  if (behavior === "image-only-capability") {
    return { agentCapabilities: { sessionCapabilities: { resume: {} }, promptCapabilities: { image: true } } };
  }
  if (behavior === "audio-only-capability") {
    return { agentCapabilities: { sessionCapabilities: { resume: {} }, promptCapabilities: { audio: true } } };
  }
  if (behavior === "rc01-capabilities") {
    return {
      agentCapabilities: {
        loadSession: true,
        sessionCapabilities: { resume: {} },
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true }
      }
    };
  }
  return { agentCapabilities: { sessionCapabilities: { resume: {} } } };
}

function validResumeParams(params) {
  return params !== null && typeof params === "object" && !Array.isArray(params)
    && typeof params.sessionId === "string"
    && typeof params.cwd === "string"
    && path.isAbsolute(params.cwd)
    && Array.isArray(params.mcpServers);
}

function validInitializeParams(params) {
  return params !== null && typeof params === "object" && !Array.isArray(params)
    && params.protocolVersion === 1
    && params.clientInfo !== null && typeof params.clientInfo === "object" && !Array.isArray(params.clientInfo)
    && typeof params.clientInfo.name === "string"
    && typeof params.clientInfo.version === "string"
    && params.clientCapabilities !== null && typeof params.clientCapabilities === "object"
    && !Array.isArray(params.clientCapabilities);
}

function validLoadParams(params) {
  return validResumeParams(params);
}

function hasValidMediaPrompt(params) {
  const prompt = params?.prompt;
  if (!Array.isArray(prompt)) return false;
  return prompt.some((part) => part && typeof part === "object"
    && (part.type === "image" || part.type === "audio")
    && typeof part.mimeType === "string"
    && typeof part.data === "string"
    && Buffer.from(part.data, "base64").byteLength > 0);
}

function replyPrompt(message) {
  const sessionId = message.params?.sessionId;
  const text = promptText(message.params);
  if (typeof sessionId !== "string") {
    write({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "invalid session" } });
    return;
  }
  if (behavior === "timeout") return;
  if (behavior === "malformed") {
    process.stdout.write("MALFORMED_NDJSON_SECRET=never-return-this\n");
    return;
  }
  if (behavior === "redacted-error") {
    write({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32099, message: "SECRET_TOKEN=must-not-appear", data: { token: "must-not-appear" } }
    });
    return;
  }
  if (behavior === "provider-503") {
    write({ jsonrpc: "2.0", id: message.id, error: { code: 503, message: "upstream unavailable" } });
    return;
  }
  if (behavior === "quota-error") {
    write({ jsonrpc: "2.0", id: message.id, error: { code: "QUOTA_EXHAUSTED", message: "quota unavailable" } });
    return;
  }
  if (text.includes("P6_TIMEOUT_REQUEST") && behavior === "timeout-child") {
    spawnHangingChild();
    return;
  }
  if (text.includes("P6_MEDIA_REQUEST") && !hasValidMediaPrompt(message.params)) {
    write({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "invalid media prompt" } });
    return;
  }
  if (text.includes("P4_CANCEL_REQUEST")) {
    cancellationPromptCount += 1;
    if (behavior === "race-then-cancel" && cancellationPromptCount === 1) {
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    if (behavior === "cancel-race-always") {
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    pendingCancels.set(sessionId, message.id);
    return;
  }
  update(sessionId, "agent_thought_chunk", "PRIVATE_THOUGHT_MUST_NOT_APPEAR");
  if (text.includes("P4_TOOL_FILE=")) {
    update(sessionId, "tool_call");
    update(sessionId, "tool_call_update");
  }
  const finalText = toolMarker(text) || expectedMarker(text);
  const history = sessionHistory.get(sessionId) ?? [];
  history.push(finalText);
  sessionHistory.set(sessionId, history);
  const splitAt = Math.max(1, Math.floor(finalText.length / 2));
  update(sessionId, "agent_message_chunk", finalText.slice(0, splitAt));
  update(sessionId, "agent_message_chunk", finalText.slice(splitAt));
  write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
}

process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    observe(observedRequest(message));
    if (message.method === "initialize") {
      if (behavior === "hang-child") {
        spawnHangingChild();
        continue;
      }
      if (!validInitializeParams(message.params)) {
        write({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "invalid initialize parameters" } });
        continue;
      }
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "fake-kernel", version: "fake-rc01" },
          authMethods: ["oauth-personal"],
          ...initializeCapabilities()
        }
      });
      continue;
    }
    if (message.method === "authenticate") {
      if (behavior === "explicit-auth-failure") {
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "authentication refresh failed" }
        });
        continue;
      }
      authenticated = true;
      write({ jsonrpc: "2.0", id: message.id, result: {} });
      continue;
    }
    if (message.method === "session/new") {
      if (requiresExplicitAuthentication() && !authenticated) {
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "authentication required" }
        });
        continue;
      }
      sessionNumber += 1;
      const sessionId = `fake-session-${sessionNumber}`;
      sessionModels.set(sessionId, currentModel);
      sessionHistory.set(sessionId, []);
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: { sessionId, configOptions: configuration(sessionId) }
      });
      continue;
    }
    if (message.method === "session/resume") {
      if (!validResumeParams(message.params)) {
        write({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "invalid resume parameters" } });
        continue;
      }
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: { configOptions: configuration(message.params?.sessionId) }
      });
      continue;
    }
    if (message.method === "session/load") {
      if (!validLoadParams(message.params)) {
        write({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "invalid load parameters" } });
        continue;
      }
      const sessionId = message.params.sessionId;
      if (!sessionModels.has(sessionId)) {
        write({ jsonrpc: "2.0", id: message.id, error: { code: -32002, message: "session not found" } });
        continue;
      }
      for (const marker of sessionHistory.get(sessionId) ?? []) {
        update(sessionId, "agent_message_chunk", marker);
      }
      write({ jsonrpc: "2.0", id: message.id, result: { configOptions: configuration(sessionId) } });
      continue;
    }
    if (message.method === "session/set_config_option") {
      const value = message.params?.value;
      if (message.params?.configId !== "model" || !models.includes(value)) {
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32602,
            message: "SECRET_AUTH_CONTEXT must not leak",
            data: { availableModels: models, account: "private" }
          }
        });
      } else {
        currentModel = value;
        if (typeof message.params?.sessionId === "string") {
          sessionModels.set(message.params.sessionId, currentModel);
        }
        write({ jsonrpc: "2.0", id: message.id, result: { currentValue: currentModel } });
      }
      continue;
    }
    if (message.method === "session/prompt") {
      replyPrompt(message);
      continue;
    }
    if (message.method === "session/cancel") {
      const sessionId = message.params?.sessionId;
      const requestId = pendingCancels.get(sessionId);
      if (requestId !== undefined) {
        pendingCancels.delete(sessionId);
        update(sessionId, "agent_thought_chunk", "CANCELLED_PRIVATE_THOUGHT");
        write({ jsonrpc: "2.0", id: requestId, result: { stopReason: "cancelled" } });
      }
    }
  }
});
