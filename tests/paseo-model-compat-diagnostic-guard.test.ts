import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const compatModule = path.join(repositoryRoot, "assets/official-kernel-compat/rc01/paseo_model_compat.py");

const script = String.raw`
import asyncio
import importlib.util
import os
import sys
import types

class AgentMessageChunk:
  session_update = "agent_message_chunk"

  def __init__(self, text):
    self.text = text

class ToolCallProgress:
  session_update = "tool_call_update"

  def __init__(self, tool_call_id):
    self.tool_call_id = tool_call_id

acp = types.ModuleType("acp")
schema = types.ModuleType("acp.schema")
schema.AgentMessageChunk = AgentMessageChunk
schema.ToolCallProgress = ToolCallProgress
agent = types.ModuleType("acp.agent")
connection = types.ModuleType("acp.agent.connection")

class AgentSideConnection:
  calls = []

  async def session_update(self, session_id=None, update=None, **kwargs):
    AgentSideConnection.calls.append((session_id, update))
    return "sent"

connection.AgentSideConnection = AgentSideConnection
agent.connection = connection
acp.schema = schema
acp.agent = agent
sys.modules["acp"] = acp
sys.modules["acp.schema"] = schema
sys.modules["acp.agent"] = agent
sys.modules["acp.agent.connection"] = connection

spec = importlib.util.spec_from_file_location(
  "paseo_model_compat", sys.argv[1]
)
module = importlib.util.module_from_spec(spec)
sys.modules["paseo_model_compat"] = module
spec.loader.exec_module(module)

SERVER_PATH = (
  "/opt/x/google3/cloud/developer_experience/antigravity_extensions/"
  "acp_server/server.py"
)
TARGET = module._TERMINAL_DIAGNOSTIC_SEND_LINE
assert TARGET > 8


def compile_server(filename, update_expression, *, yield_first):
  lines = [
    "import asyncio",
    "async def prompt(client, update, factory):",
    "    try:",
    "        raise factory()",
    "    except Exception:",
  ]
  if yield_first:
    lines.append("        await asyncio.sleep(0)")
  used = len(lines) + 1
  assert TARGET > used
  lines.extend([""] * (TARGET - used))
  lines.append(
    "        return await client.session_update("
    "session_id='session-a', update=" + update_expression + ")"
  )
  lines.extend([
    "async def cancel(client, update, factory):",
    "    try:",
    "        raise factory()",
    "    except Exception:",
    "        return await client.session_update("
    "session_id='session-a', update=update)",
    "async def stream(client, update):",
    "    return await client.session_update("
    "session_id='session-b', update=update)",
    "async def failure_send(client, update):",
    "    return await prompt(client, update, AntigravityConnectionError)",
    "async def cancel_send(client, update):",
    "    return await cancel(client, update, AntigravityCancelledError)",
    "async def other_send(client, update):",
    "    return await prompt(client, update, ValueError)",
  ])
  namespace = {
    "AntigravityConnectionError": type("AntigravityConnectionError", (Exception,), {}),
    "AntigravityCancelledError": type("AntigravityCancelledError", (Exception,), {}),
  }
  exec(compile("\n".join(lines) + "\n", filename, "exec"), namespace)
  assert namespace["prompt"].__code__.co_name == "prompt"
  return namespace


server = compile_server(SERVER_PATH, "update", yield_first=False)
slow_server = compile_server(SERVER_PATH, "update", yield_first=True)
foreign_server = compile_server(SERVER_PATH.replace("server.py", "other.py"), "update", yield_first=False)
tool_server = compile_server(SERVER_PATH, "update", yield_first=False)

client = AgentSideConnection()
assert module._diagnostic_guard_installed is True

# The same real chunk object must survive every non-terminal send verbatim.
partial_chunk = AgentMessageChunk("AUDIT_NORMAL_PARTIAL_57c8")
assert "AUDIT_PRIVATE_SENTINEL_57c8" not in partial_chunk.text


async def run():
  # Terminal catch at the pinned callsite: dropped.
  assert await server["failure_send"](client, partial_chunk) is None
  assert AgentSideConnection.calls == []

  # A different exception, a different callsite, and a foreign server.py are
  # never suppressed even though they run inside an exception handler.
  assert await server["other_send"](client, partial_chunk) == "sent"
  assert await server["cancel_send"](client, partial_chunk) == "sent"
  assert await foreign_server["failure_send"](client, partial_chunk) == "sent"
  assert [call[1] for call in AgentSideConnection.calls] == [
    partial_chunk, partial_chunk, partial_chunk,
  ]

  # A non-chunk update at the pinned callsite still goes through.
  tool_update = ToolCallProgress("tool-1")
  assert await tool_server["failure_send"](client, tool_update) == "sent"
  assert AgentSideConnection.calls[-1][1] is tool_update

  # Identification is source based, never text based: model text that looks
  # exactly like the terminal diagnostic still reaches the client when it is
  # sent from a non-terminal callsite.
  lookalike = AgentMessageChunk(
    "Antigravity SDK error processing prompt for session session-a"
  )
  assert await server["stream"](client, lookalike) == "sent"
  assert AgentSideConnection.calls[-1][1] is lookalike

  # Concurrent sessions/tasks: one task's terminal catch must not swallow
  # another task's streamed model text.
  before = len(AgentSideConnection.calls)
  results = await asyncio.gather(
    slow_server["failure_send"](client, partial_chunk),
    server["stream"](client, partial_chunk),
    server["stream"](client, partial_chunk),
  )
  assert results == [None, "sent", "sent"]
  assert [call[1] for call in AgentSideConnection.calls[before:]] == [
    partial_chunk, partial_chunk,
  ]

  # The next failing turn is still suppressed, and the following turn is not.
  assert await server["failure_send"](client, partial_chunk) is None
  assert await server["stream"](client, partial_chunk) == "sent"
  assert len(AgentSideConnection.calls) == before + 3

asyncio.run(run())
print("ok")
`;

describe("pinned compatibility terminal diagnostic guard", () => {
  it("drops only the official terminal-catch chunk and preserves every other update", () => {
    const result = spawnSync("python3", ["-B", "-c", script, compatModule], {
      encoding: "utf8",
      timeout: 30_000
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });
});
