#!/usr/bin/env node
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return;
  const message = JSON.parse(trimmed);
  if (typeof message.method !== "string" || message.id === undefined) return;

  if (message.method === "initialize") {
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentInfo: { name: "antigravity-acp", version: "rc01" },
        agentCapabilities: { promptCapabilities: { image: true } },
        authMethods: []
      }
    });
    return;
  }

  if (message.method === "authenticate") {
    write({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }

  if (message.method === "session/new") {
    if (message.params?.emitAvailableCommands) {
      write({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-official-1",
          update: {
            sessionUpdate: "available_commands_update",
            availableCommands: [
              { name: "plan", description: "Plan mode" },
              { name: "logout", description: "Log out" }
            ]
          }
        }
      });
    }
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessionId: "session-official-1",
        mcpServers: message.params?.mcpServers ?? [],
        modeId: message.params?.modeId
      }
    });
    return;
  }

  if (message.method === "session/set_mode") {
    write({ jsonrpc: "2.0", id: message.id, result: { modeId: message.params?.modeId } });
    return;
  }

  if (message.method === "session/prompt") {
    const prompt = JSON.stringify(message.params ?? {});
    if (prompt.includes("BLANK_TURN")) {
      write({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
      return;
    }
    write({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: message.params?.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "pong-official" }
        }
      }
    });
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn", echoedPrompt: message.params?.prompt }
    });
  }
});
