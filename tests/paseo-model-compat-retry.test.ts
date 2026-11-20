import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const compatModule = path.join(repositoryRoot, "assets/official-kernel-compat/rc01/paseo_model_compat.py");

const script = String.raw`
import contextlib
import hashlib
import importlib.util
import io
import json
import logging
import os
import shutil
import sys
import tempfile
import threading
import time
from pathlib import Path

compat_path = Path(sys.argv[1])
state_dir = tempfile.mkdtemp(prefix="paseo-retry-state-")
os.environ["PASEO_AGY_ACP_KERNEL_EVENTS"] = "1"
os.environ["PASEO_AGY_ACP_KERNEL_EVENT_DIR"] = state_dir

spec = importlib.util.spec_from_file_location("paseo_model_compat", compat_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

PREFIX = module._EVENT_PREFIX
logging.getLogger().setLevel(logging.INFO)
handler = module._KernelTerminalHandler()
handler.setLevel(logging.INFO)

def go_line_at_ms(epoch_ms, delay="4s", error="Error 502, Message: Bad Gateway token=SECRET https://internal.example"):
  when = epoch_ms / 1000.0
  stamp = time.strftime("%m%d %H:%M:%S", time.localtime(when)) + (".%06d" % ((epoch_ms % 1000) * 1000))
  return (
    "ERROR: logging before google.Init: I"
    + stamp
    + "      98 planner_generator.go:359] Encountered retryable api error. retrying in "
    + delay
    + ". Error (The model is currently unreachable.): "
    + error
  )

def line_after(source, offset=5, delay="4s"):
  return go_line_at_ms(source._started_at_ms + offset, delay)

def record(line, *, pathname="/opt/x/local_connection.py", func="_drain", msg="harness stderr: %s", args=None):
  return logging.LogRecord(
    "root", logging.INFO, pathname, 553, msg, (line,) if args is None else args, None, func
  )

def emit(rec, current_handler=None):
  captured = io.StringIO()
  with contextlib.redirect_stderr(captured):
    (current_handler or handler).emit(rec)
  output = captured.getvalue()
  if not output:
    return None
  assert output.startswith(PREFIX), output
  return json.loads(output[len(PREFIX):].strip())

assert module._parse_go_duration_ms("4s") == 4000
assert module._parse_go_duration_ms("5.923546325s") == 5923
assert module._parse_go_duration_ms("1m30s") == 90000
assert module._parse_go_duration_ms("1h") == 3600000
assert module._parse_go_duration_ms("0s") is None
assert module._parse_go_duration_ms("86400001ms") is None
assert module._parse_go_duration_ms("1d") is None

source = module._HarnessSource("session-a", object())
generation = source.begin()
module._line_context.source = source

payload = emit(record(line_after(source)))
assert payload["event"] == "model_retry_scheduled"
assert payload["session"] == "session-a"
assert payload["delayMs"] == 4000
assert payload["emittedAt"] == source._started_at_ms + 5
assert set(payload) <= {"v", "event", "session", "delayMs", "emittedAt"}
serialized = json.dumps(payload)
assert "SECRET" not in serialized
assert "internal.example" not in serialized
assert "Bad Gateway" not in serialized

assert emit(record(line_after(source), func="_drain_other")) is None
assert emit(record(line_after(source), pathname="/opt/x/server.py")) is None
assert emit(record(line_after(source), msg="harness stderr: %r")) is None
assert emit(record("assistant says " + line_after(source))) is None
assert emit(record(line_after(source).replace("planner_generator.go:359", "planner_generator.go:360"))) is None
assert emit(record(line_after(source).replace("retryable api error", "retryable api failure"))) is None
assert emit(record(line_after(source, delay="4x"))) is None

# A record read while the old turn is active can still be emitted late (the
# stderr thread is independent of the stdout response). Carry the verified Go
# decision time so the next turn's start can reject it deterministically.
old_line = line_after(source, 5)
old_decision_ms = source._started_at_ms + 5
source.end(generation)
generation = source.begin()
with source._lock:
  source._started_at_ms = old_decision_ms + 1
assert emit(record(old_line)) is None
assert emit(record(go_line_at_ms(old_decision_ms + 1))) is None
assert emit(record(go_line_at_ms(old_decision_ms + 2))) is not None

cancelled_line = go_line_at_ms(old_decision_ms + 100)
source.cancel()
assert emit(record(cancelled_line)) is None
generation = source.begin()

source_b = module._HarnessSource("session-b", object())
source_b.begin()
module._line_context.source = source_b
payload_b = emit(record(line_after(source_b)))
assert payload_b["session"] == "session-b"
module._line_context.source = source
assert emit(record(line_after(source)))["session"] == "session-a"

# Concurrent harness stderr threads must not borrow a global last session.
thread_results = {}
def drain_in_thread(name, src, line):
  class Stream:
    def __iter__(self):
      yield line.encode()
  for raw in module._TaggedStderr(Stream(), src):
    parsed = module._retry_record(record(raw.decode()))
    thread_results[name] = parsed[0].session if parsed else None
  assert not hasattr(module._line_context, "source")

threads = []
for name, src in (("a", source), ("b", source_b)):
  thread = threading.Thread(target=drain_in_thread, args=(name, src, line_after(src)))
  threads.append(thread)
  thread.start()
for thread in threads:
  thread.join()
assert thread_results == {"a": "session-a", "b": "session-b"}

# The real SDK path is a stdlib logging call from local_connection.py::_drain
# on the harness-stderr thread.
sdk_stderr = {}
exec(compile(
  "import logging\ndef _drain(line):\n  logging.info(\"harness stderr: %s\", line)\n",
  "/opt/x/local_connection.py",
  "exec",
), sdk_stderr)
captured = io.StringIO()
with contextlib.redirect_stderr(captured):
  sdk_stderr["_drain"](line_after(source))
logged = captured.getvalue()
assert logged.startswith(PREFIX), logged
logged_payload = json.loads(logged[len(PREFIX):].strip())
assert logged_payload["session"] == "session-a"
assert logged_payload["emittedAt"] == source._started_at_ms + 5

class AntigravityExecutionError(Exception):
  pass

terminal = logging.LogRecord(
  "root",
  logging.ERROR,
  "/opt/x/server.py",
  5737,
  "Antigravity SDK error processing prompt for session %s",
  ("session-a",),
  (AntigravityExecutionError, AntigravityExecutionError("Bearer SECRET https://internal.example"), None),
  "prompt",
)
handler.emit(terminal)
terminal_path = os.path.join(state_dir, hashlib.sha256(b"session-a").hexdigest() + ".json")
assert os.path.exists(terminal_path)
with open(terminal_path, encoding="utf-8") as state_file:
  state_text = state_file.read()
state = json.loads(state_text)
assert state["event"] == "turn_failed"
assert state["session"] == "session-a"
assert state["errorClass"] == "AntigravityExecutionError"
assert "SECRET" not in state_text
assert "internal.example" not in state_text
os.unlink(terminal_path)

forged_terminal = logging.LogRecord(
  "root",
  logging.ERROR,
  "/opt/x/local_connection.py",
  553,
  "Antigravity SDK error processing prompt for session %s",
  ("session-a",),
  (AntigravityExecutionError, AntigravityExecutionError("x"), None),
  "prompt",
)
handler.emit(forged_terminal)
assert not os.path.exists(terminal_path)

shutil.rmtree(state_dir)
print("ok")
`;

describe("pinned compatibility retry observer", () => {
  it("binds native harness stderr records to the active session and drops forged or stale lines", () => {
    const result = spawnSync("python3", ["-B", "-c", script, compatModule], {
      encoding: "utf8",
      timeout: 30_000
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("ok");
  });
});
