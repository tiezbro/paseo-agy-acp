import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { FixedModelEffort } from "../ACP Connector/official-kernel/fixed-model-effort.js";
import { OfficialKernelProxy } from "../ACP Connector/official-kernel/proxy.js";
import { createNdjsonParser, encodeNdjson } from "../ACP Connector/official-kernel/ndjson.js";
import type { JsonRpcMessage } from "../ACP Connector/official-kernel/json-rpc.js";

const gemini = "gemini-3.8-flash";
const fixedModels = ["claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"];
const choices = ["high", "medium", "low"].map((value, i) => ({ value, name: ["High", "Medium", "Low"][i] }));
const native = { category: "thought_level", id: "thinking_level", type: "select", currentValue: "high", options: choices,
  _meta: { vendor: "native" } };
const model = (currentValue: string, options = [gemini, ...fixedModels]) => ({
  category: "model", id: "model", type: "select", currentValue,
  options: [{ group: "official", name: "Official",
    options: options.map(value => ({ value, name: value, _meta: { vendor: value } })) }],
  _meta: { vendor: "grouped" }
});
const effort = (currentValue: string) => ({ id: "thinking_level", category: "thought_level", currentValue, options: choices });

function harness() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const child = Object.assign(new EventEmitter(), { pid: process.pid, stdin: new PassThrough(), stdout: new PassThrough() });
  const requests: JsonRpcMessage[] = [];
  const responses: JsonRpcMessage[] = [];
  child.stdin.on("data", createNdjsonParser(message => requests.push(message)));
  stdout.on("data", createNdjsonParser(message => responses.push(message)));
  const running = new OfficialKernelProxy({ child: child as unknown as ChildProcessWithoutNullStreams, stdin, stdout,
    env: {}, version: "test" }).start();
  const send = (message: JsonRpcMessage) => stdin.write(encodeNdjson(message));
  const reply = (message: JsonRpcMessage) => child.stdout.write(encodeNdjson(message));
  return { requests, responses, send, reply,
    async roundTrip(id: number, method: string, params: unknown, result: unknown) {
      send({ jsonrpc: "2.0", id, method, params });
      await vi.waitFor(() => expect(requests).toContainEqual(expect.objectContaining({ id, method })));
      reply({ jsonrpc: "2.0", id, result });
      return responses.find(message => "id" in message && message.id === id);
    },
    async close() { child.emit("close", 0); await running; }
  };
}

describe("fixed-model effort compatibility", () => {
  it.each(fixedModels)("shows three values for grouped %s without contacting the kernel", async selected => {
    const h = harness();
    const sessionId = "s";
    const configOptions = [model(selected)];
    try {
      const initialize = { protocolVersion: 1, clientInfo: { name: "Paseo", version: "dev" } };
      await h.roundTrip(1, "initialize", initialize, { protocolVersion: 1 });
      expect(h.requests).toContainEqual({ jsonrpc: "2.0", id: 1, method: "initialize", params: initialize });
      const setup = await h.roundTrip(2, "session/new", { cwd: process.cwd(), mcpServers: [] }, {
        sessionId, models: { currentModelId: selected }, configOptions, _meta: { vendor: 7 }
      });
      expect(setup).toMatchObject({ result: { sessionId,
        configOptions: [...configOptions, expect.objectContaining(effort("medium"))], _meta: { vendor: 7 } } });
      expect(setup).not.toHaveProperty("result.models");
      expect(configOptions).toHaveLength(1);
      for (const [i, { value }] of choices.entries()) {
        const id = 3 + i;
        h.send({ jsonrpc: "2.0", id, method: "session/set_config_option", params: { sessionId, configId: "thinking_level", value } });
        expect(h.responses).toContainEqual({ jsonrpc: "2.0", id, result: {
          configOptions: [...configOptions, expect.objectContaining(effort(value))]
        } });
      }
      expect(h.requests).toHaveLength(2);
      h.reply({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId, update: { sessionUpdate: "config_option_update", configOptions, _meta: { vendor: "update" } }
      } });
      expect(h.responses.at(-1)).toMatchObject({ params: {
        sessionId, update: { configOptions: [...configOptions, expect.objectContaining(effort("low"))], _meta: { vendor: "update" } }
      } });
    } finally { await h.close(); }
  });

  it("passes Gemini writes through and handles cold load, synthetic replay and close", async () => {
    const h = harness();
    const sessionId = "cold";
    const write = (value: string) => ({ sessionId, configId: "thinking_level", value });
    try {
      await h.roundTrip(1, "initialize", { clientInfo: { name: "Paseo", version: "dev" } }, {});
      const geminiOptions = [model(gemini), native];
      const restore = await h.roundTrip(2, "session/load", { sessionId, cwd: process.cwd(), mcpServers: [] }, {
        configOptions: geminiOptions
      });
      expect(restore).toMatchObject({ result: { configOptions: geminiOptions } });
      await h.roundTrip(3, "session/set_config_option", write("high"), { configOptions: geminiOptions });
      expect(h.requests.at(-1)).toMatchObject({ id: 3, params: write("high") });
      const fixedOptions = [model(fixedModels[1])];
      const switched = await h.roundTrip(4, "session/set_config_option", { sessionId, configId: "model", value: fixedModels[1] }, {
        configOptions: fixedOptions
      });
      // Stock Paseo skips a matching replay after loading with Gemini High.
      expect(switched).toMatchObject({ result: { configOptions: [...fixedOptions, expect.objectContaining(effort("high"))] } });
      h.reply({ jsonrpc: "2.0", method: "session/update", params: {
        sessionId, update: { sessionUpdate: "config_option_update", configOptions: fixedOptions }
      } });
      expect(h.responses.at(-1)).toMatchObject({ params: {
        update: { configOptions: [...fixedOptions, expect.objectContaining(effort("high"))] }
      } });
      h.send({ jsonrpc: "2.0", id: 5, method: "session/set_config_option", params: write("high") });
      expect(h.responses.at(-1)).toMatchObject({ id: 5,
        result: { configOptions: [...fixedOptions, expect.objectContaining(effort("high"))] } });
      expect(h.requests.at(-1)).toMatchObject({ id: 4 });
      await h.roundTrip(6, "session/set_config_option", { sessionId, configId: "model", value: gemini }, {
        configOptions: geminiOptions
      });
      await h.roundTrip(7, "session/set_config_option", write("low"), { configOptions: geminiOptions });
      expect(h.requests.at(-1)).toMatchObject({ id: 7, params: write("low") });
      await h.roundTrip(8, "session/resume", { sessionId, cwd: process.cwd(), mcpServers: [] }, { configOptions: fixedOptions });
      await h.roundTrip(9, "session/close", { sessionId }, {});
      await h.roundTrip(10, "session/set_config_option", write("medium"), { configOptions: geminiOptions });
      expect(h.requests.at(-1)).toMatchObject({ id: 10 });
    } finally { await h.close(); }
  });

  it("does not virtualize non-Paseo, unoffered, unknown or native-effort models", () => {
    const state = new FixedModelEffort();
    const fixed = fixedModels[0];
    const options = { configOptions: [model(fixed)] };
    state.observeClient({ clientInfo: { name: "Other" } });
    expect(state.present("s", options)).toBe(options);
    state.observeClient({ clientInfo: { name: "Paseo" } });
    expect(state.present("s", options)).not.toBe(options);
    expect(state.apply("s", { configId: "thinking_level", value: "max" })).toBeUndefined();
    expect(state.apply("elsewhere", { configId: "thinking_level", value: "high" })).toBeUndefined();
    for (const configOptions of [[model(fixed, [gemini])], [model("future-claude", ["future-claude"])], [model(fixed), native]]) {
      const snapshot = { configOptions };
      expect(state.present("s", snapshot)).toBe(snapshot);
      expect(state.apply("s", { configId: "thinking_level", value: "high" })).toBeUndefined();
    }
  });
});
