#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const send = message => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (process.env.QUOTA_TEST_TRACE) appendFileSync(process.env.QUOTA_TEST_TRACE, line + "\n", "utf8");
  const reply = result => send({ id: request.id, result });
  if (request.method === "initialize") reply({ protocolVersion: 1, agentCapabilities: {} });
  else if (request.method === "session/new") {
    reply({ sessionId: "quota-test" });
    send({ method: "session/update", params: { sessionId: "quota-test", update: {
      sessionUpdate: "available_commands_update", availableCommands: process.env.QUOTA_TEST_NO_COMMAND ? [] : [{ name: "usage" }],
    } } });
  } else if (request.method === "session/prompt") {
    if (request.params.prompt.length !== 1 || request.params.prompt[0].text !== "/usage") process.exit(3);
    if (process.env.QUOTA_TEST_HANG) return;
    if (process.env.QUOTA_TEST_FAIL) {
      send({ id: request.id, error: { code: -32000, message: "private-auth-secret" } });
      return;
    }
    const text = "### Session Usage\n- **Session total:** 100 tokens\n\n### Quota Limits\n- **Gemini Models**\n  - **Weekly Limit Remaining:** 46% remaining (resets Dec 02, 2026, 09:05 UTC)\n  - **Five Hour Limit Remaining:** 100% remaining\n- **Claude and GPT models**\n  - **Weekly Limit Remaining:** 0% remaining\n  - **Five Hour Limit Remaining:** Disabled\n";
    for (const chunk of [text.slice(0, 120), text.slice(120)]) send({ method: "session/update", params: {
      sessionId: "quota-test", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: chunk } },
    } });
    reply({ stopReason: "end_turn" });
  }
});
