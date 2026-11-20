"""Local-only request compatibility profile for the RC01 official kernel."""

from __future__ import annotations

from collections import deque
from datetime import datetime, timedelta
from decimal import Decimal
import hashlib
import json
import logging
import os
import re
import sys
import threading
import time
import weakref
from typing import Any, Deque, Dict, Iterator, Optional, Set, Tuple

SUPPORTED_NON_GEMINI_MODEL_IDS = frozenset(
    {
        "claude-sonnet-4-6",
        "claude-opus-4-6-thinking",
        "claude-opus-5-5-low",
        "claude-opus-5-5-medium",
        "claude-opus-5-5-high",
        "claude-sonnet-5-5-low",
        "claude-sonnet-5-5-medium",
        "claude-sonnet-5-5-high",
        "gpt-oss-120b-medium",
    }
)

_MAX_OUTPUT_TOKENS_BY_MODEL_ID = {
    "claude-sonnet-4-6": 64000,
    "claude-opus-4-6-thinking": 64000,
    "claude-opus-5-5-low": 128000,
    "claude-opus-5-5-medium": 128000,
    "claude-opus-5-5-high": 128000,
    "claude-sonnet-5-5-low": 128000,
    "claude-sonnet-5-5-medium": 128000,
    "claude-sonnet-5-5-high": 128000,
    "gpt-oss-120b-medium": 32768,
}
_GPT_OSS_MODEL_ID = "gpt-oss-120b-medium"

__all__ = [
    "SUPPORTED_NON_GEMINI_MODEL_IDS",
    "install_kernel_event_handler",
    "is_catalog_model",
    "register_step_observer",
    "transform_request",
]


def is_catalog_model(model_id: str) -> bool:
    """Return whether a raw catalog entry is supported by the local profile."""
    return isinstance(model_id, str) and (
        model_id.startswith("gemini") or model_id in SUPPORTED_NON_GEMINI_MODEL_IDS
    )


def transform_request(model_id: str, body: Dict[str, Any]) -> Dict[str, Any]:
    """Adapt a supported non-Gemini request in place and return the same body."""
    if not isinstance(model_id, str) or not isinstance(body, dict):
        return body
    maximum = _MAX_OUTPUT_TOKENS_BY_MODEL_ID.get(model_id)
    if maximum is None:
        return body

    _normalize_generation_config(body, maximum, model_id == _GPT_OSS_MODEL_ID)
    _normalize_tool_schemas(body)
    _normalize_tool_call_ids(body)
    return body


def _normalize_generation_config(body: Dict[str, Any], maximum: int, gpt_oss: bool) -> None:
    config = body.get("generationConfig")
    if not isinstance(config, dict):
        config = {}

    max_output_tokens = _clamp_max_output_tokens(config.get("maxOutputTokens"), maximum)
    if gpt_oss:
        body["generationConfig"] = {"maxOutputTokens": max_output_tokens}
        return

    config["maxOutputTokens"] = max_output_tokens
    body["generationConfig"] = config


def _clamp_max_output_tokens(value: Any, maximum: int) -> int:
    if isinstance(value, int) and not isinstance(value, bool) and value > 0:
        return min(value, maximum)
    return maximum


def _normalize_tool_schemas(body: Dict[str, Any]) -> None:
    for declaration in _function_declarations(body):
        if "parameters" in declaration:
            declaration["parameters"] = _strip_schema(declaration["parameters"])
            declaration.pop("parametersJsonSchema", None)
        elif "parametersJsonSchema" in declaration:
            declaration["parameters"] = _strip_schema(declaration.pop("parametersJsonSchema"))


def _function_declarations(body: Dict[str, Any]) -> Iterator[Dict[str, Any]]:
    tools = body.get("tools")
    if isinstance(tools, dict):
        tool_items = [tools]
    elif isinstance(tools, list):
        tool_items = tools
    else:
        return

    for tool in tool_items:
        if not isinstance(tool, dict):
            continue
        declarations = tool.get("functionDeclarations")
        if isinstance(declarations, dict):
            declarations = [declarations]
        if not isinstance(declarations, list):
            continue
        for declaration in declarations:
            if isinstance(declaration, dict):
                yield declaration


def _strip_schema(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _strip_schema(child) for key, child in value.items() if key != "$schema"}
    if isinstance(value, list):
        return [_strip_schema(child) for child in value]
    return value


def _normalize_tool_call_ids(body: Dict[str, Any]) -> None:
    parts = list(_history_parts(body))
    reserved_ids = {
        call_id
        for part in parts
        for call_id in [_existing_id(part.get("functionCall"))]
        if call_id is not None
    }
    pending_call_ids: Dict[str, Deque[str]] = {}
    next_generated_call = 1

    for part in parts:
        function_call = part.get("functionCall")
        if isinstance(function_call, dict):
            call_id = _existing_id(function_call)
            if call_id is None:
                call_id, next_generated_call = _next_generated_call_id(reserved_ids, next_generated_call)
                function_call["id"] = call_id
            pending_call_ids.setdefault(_function_name(function_call), deque()).append(call_id)

        function_response = part.get("functionResponse")
        if not isinstance(function_response, dict):
            continue
        pending_for_name = pending_call_ids.get(_function_name(function_response))
        if pending_for_name:
            function_response["id"] = pending_for_name.popleft()


def _history_parts(body: Dict[str, Any]) -> Iterator[Dict[str, Any]]:
    contents = body.get("contents")
    if not isinstance(contents, list):
        return

    for content in contents:
        if not isinstance(content, dict):
            continue
        parts = content.get("parts")
        if not isinstance(parts, list):
            continue
        for part in parts:
            if isinstance(part, dict):
                yield part


def _existing_id(payload: Any) -> Optional[str]:
    if not isinstance(payload, dict):
        return None
    value = payload.get("id")
    return value if isinstance(value, str) and value else None


def _function_name(payload: Dict[str, Any]) -> str:
    name = payload.get("name")
    return name if isinstance(name, str) else ""


def _next_generated_call_id(reserved_ids: Set[str], next_index: int) -> Tuple[str, int]:
    while True:
        candidate = f"acp-tool-{next_index}"
        next_index += 1
        if candidate not in reserved_ids:
            reserved_ids.add(candidate)
            return candidate, next_index


# Paseo kernel event channel. The compatibility module is already loaded inside
# the official kernel process; these helpers add only read-only observers that
# never alter kernel control flow.
_EVENT_ENV = "PASEO_AGY_ACP_KERNEL_EVENTS"
_EVENT_DIRECTORY_ENV = "PASEO_AGY_ACP_KERNEL_EVENT_DIR"
_EVENT_PREFIX = "PASEO_ACP_KERNEL_EVENT "
_MAX_EVENT_BYTES = 4096
_HARNESS_STDERR_TEMPLATE = "harness stderr: %s"
_SDK_TERMINAL_TEMPLATE = (
    "Antigravity SDK error processing prompt for session %s"
)
_CONNECTION_LOST_TEMPLATE = (
    "Agent connection lost for session %s after rebuild retry"
)
_REBUILD_FAILED_TEMPLATE = (
    "Failed to rebuild agent for session %s; connection unrecoverable"
)
_SDK_TERMINAL_CLASSES = frozenset(
    {
        "AntigravityExecutionError",
        "AntigravityConnectionError",
        "AntigravityValidationError",
    }
)

# PyPI's Go harness writes these decisions through klog. The pinned 1.5.0
# harness is the only source bound to this template: planner_generator.go:359
# logs one retry plan per line, and local_connection.py::_drain forwards each
# line through the stdlib logging record matched below.
_GO_DURATION_RE = re.compile(
    r"^(?:[0-9]+(?:\.[0-9]+)?(?:ns|us|\u00b5s|ms|s|m|h))+$"
)
_GO_DURATION_PART_RE = re.compile(
    r"([0-9]+(?:\.[0-9]+)?)(ns|us|\u00b5s|ms|s|m|h)"
)
_GO_DURATION_NANOSECONDS = {
    "ns": 1,
    "us": 1000,
    "\u00b5s": 1000,
    "ms": 1000000,
    "s": 1000000000,
    "m": 60000000000,
    "h": 3600000000000,
}
_MAX_RETRY_DELAY_MS = 86400000
_RETRY_LINE_RE = re.compile(
    r"^(?:ERROR: logging before google\.Init: )?"
    r"I(?P<month>[0-9]{2})(?P<day>[0-9]{2}) "
    r"(?P<hour>[0-9]{2}):(?P<minute>[0-9]{2}):(?P<second>[0-9]{2})\."
    r"(?P<microsecond>[0-9]{6})\s+[0-9]+ planner_generator\.go:359\] "
    r"Encountered retryable api error\. retrying in (?P<delay>[0-9A-Za-z.\u00b5]+)"
    r"\. Error(?= \(|: )"
)

_event_lock = threading.Lock()
_state_lock = threading.Lock()
_diagnostic_guard_lock = threading.Lock()
_diagnostic_guard_installed = False
_terminal_sequence = 0
_terminal_handler_installed = False
_sdk_observers_installed = False
_last_step_index: Dict[str, int] = {}
_line_context = threading.local()
_session_by_hook: "weakref.WeakKeyDictionary[Any, str]" = weakref.WeakKeyDictionary()


def _event_enabled() -> bool:
    return os.environ.get(_EVENT_ENV) == "1"


def _safe_session(value: Any) -> Optional[str]:
    if not isinstance(value, str) or not value or len(value) > 256:
        return None
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in value):
        return None
    return value


def _enum_name(value: Any) -> str:
    name = getattr(value, "name", None)
    if isinstance(name, str):
        return name.upper()
    return str(value).rsplit(".", 1)[-1].upper()


def _emit_event(payload: Dict[str, Any]) -> None:
    """Writes one namespaced progress event; never raises."""
    try:
        line = json.dumps(payload, separators=(",", ":"), sort_keys=True)
        if len(line.encode("utf-8")) > _MAX_EVENT_BYTES:
            return
        with _event_lock:
            sys.stderr.write(_EVENT_PREFIX + line + "\n")
            sys.stderr.flush()
    except Exception:
        pass


def _step_event_payload(step: Any) -> Optional[Dict[str, Any]]:
    """Returns a progress notice for an explicit HTTP error on the root trajectory."""
    session = _safe_session(getattr(step, "trajectory_id", ""))
    if session is None or getattr(step, "parent_trajectory_id", ""):
        return None

    status = _enum_name(getattr(step, "status", None))
    step_type = _enum_name(getattr(step, "type", None))
    if status == "ERROR" and _enum_name(getattr(step, "source", None)) == "SYSTEM":
        code_fields = ("http_code",)
    elif status == "DONE" and step_type == "ERROR_MESSAGE":
        code_fields = ("error_code", "http_code")
    elif status == "DONE" and step_type == "UNKNOWN":
        # RC01 maps error-only steps to UNKNOWN. Only this SDK class copies
        # http_code from the structured StepUpdate.error submessage.
        sdk = sys.modules.get("google.antigravity.connections.local.event_processor")
        if not isinstance(step, getattr(sdk, "LocalConnectionStep", ())):
            return None
        code_fields = ("http_code",)
    else:
        return None

    for field in code_fields:
        http_status = getattr(step, field, None)
        if isinstance(http_status, int) and 400 <= http_status <= 599:
            break
    else:
        return None
    step_index = getattr(step, "step_index", None)
    if (
        isinstance(step_index, bool)
        or not isinstance(step_index, int)
        or step_index < 0
    ):
        step_index = None
    if step_index is not None:
        with _state_lock:
            _last_step_index[session] = step_index
    payload: Dict[str, Any] = {
        "v": 1,
        "event": "backend_http_error",
        "session": session,
        "httpStatus": http_status,
        "emittedAt": int(time.time() * 1000),
    }
    if step_index is not None:
        payload["stepIndex"] = step_index
    return payload


def _parse_go_duration_ms(value: Any) -> Optional[int]:
    """Converts a Go time.Duration string to whole milliseconds."""
    if not isinstance(value, str) or not _GO_DURATION_RE.match(value):
        return None
    total_nanoseconds = Decimal(0)
    position = 0
    for part in _GO_DURATION_PART_RE.finditer(value):
        if part.start() != position:
            return None
        total_nanoseconds += (
            Decimal(part.group(1)) * _GO_DURATION_NANOSECONDS[part.group(2)]
        )
        position = part.end()
    if position != len(value):
        return None
    if total_nanoseconds <= 0:
        return None
    if total_nanoseconds > _MAX_RETRY_DELAY_MS * 1000000:
        return None
    milliseconds = int(total_nanoseconds / 1000000)
    return milliseconds if milliseconds > 0 else None


def _go_line_timestamp_ms(match: "re.Match[str]") -> Optional[int]:
    now = datetime.now()
    try:
        stamp = datetime(
            now.year,
            int(match.group("month")),
            int(match.group("day")),
            int(match.group("hour")),
            int(match.group("minute")),
            int(match.group("second")),
            int(match.group("microsecond")),
        )
    except ValueError:
        return None
    if stamp > now + timedelta(days=1):
        try:
            stamp = stamp.replace(year=now.year - 1)
        except ValueError:
            return None
    return int(stamp.timestamp() * 1000)


class _HarnessSource:
    """Binds one harness stderr stream to its session and active prompt."""

    def __init__(self, session: str, connection: Any):
        self.session = session
        self.connection = connection
        self._lock = threading.Lock()
        self._generation = 0
        self._started_at_ms: Optional[int] = None
        self._active = False

    def begin(self) -> int:
        with self._lock:
            self._generation += 1
            self._started_at_ms = int(time.time() * 1000)
            self._active = True
            return self._generation

    def generation(self) -> int:
        with self._lock:
            return self._generation

    def end(self, generation: int) -> None:
        with self._lock:
            if self._active and generation == self._generation:
                self._active = False
                self._started_at_ms = None

    def cancel(self) -> None:
        with self._lock:
            self._generation += 1
            self._active = False
            self._started_at_ms = None

    def accepts(self, line_timestamp_ms: Optional[int]) -> bool:
        with self._lock:
            # Strictly after the prompt was sent: a decision stamped in the same
            # millisecond as the new turn start is ambiguous, so fail closed.
            return (
                self._active
                and self._started_at_ms is not None
                and isinstance(line_timestamp_ms, int)
                and line_timestamp_ms > self._started_at_ms
            )


class _TaggedStderr:
    """Marks the reading thread so the logging handler sees the source."""

    def __init__(self, stream: Any, source: _HarnessSource):
        self._stream = stream
        self._source = source

    def __iter__(self):
        try:
            for raw_line in self._stream:
                _line_context.source = self._source
                yield raw_line
        finally:
            try:
                del _line_context.source
            except AttributeError:
                pass


def _session_for_hook(hook_runner: Any) -> Optional[str]:
    if hook_runner is None:
        return None
    try:
        return _session_by_hook.get(hook_runner)
    except Exception:
        return None


def _source_for_connection(connection: Any) -> Optional[_HarnessSource]:
    source = getattr(connection, "_paseo_harness_source", None)
    if isinstance(source, _HarnessSource):
        return source
    session = _session_for_hook(getattr(connection, "_hook_runner", None))
    if session is None:
        return None
    source = _HarnessSource(session, connection)
    try:
        connection._paseo_harness_source = source
    except Exception:
        return None
    return source


def _retry_line(line: Any) -> Optional[Tuple[int, Optional[int]]]:
    # The pinned template carries no trajectory id. A sub-trajectory retry is
    # therefore still the active session's harness retry; it never creates a
    # second session or leaks across connections.
    if not isinstance(line, str):
        return None
    match = _RETRY_LINE_RE.match(line)
    if match is None:
        return None
    timestamp_ms = _go_line_timestamp_ms(match)
    if timestamp_ms is None:
        return None
    delay = match.group("delay")
    if not _GO_DURATION_RE.match(delay):
        return None
    return timestamp_ms, _parse_go_duration_ms(delay)


def _retry_record(
    record: logging.LogRecord,
) -> Optional[Tuple[_HarnessSource, int, Optional[int]]]:
    """Matches only the pinned SDK harness-stderr record for this process."""
    if getattr(record, "filename", "") != "local_connection.py":
        return None
    if getattr(record, "funcName", "") != "_drain":
        return None
    if getattr(record, "msg", None) != _HARNESS_STDERR_TEMPLATE:
        return None
    args = getattr(record, "args", ())
    if not isinstance(args, (tuple, list)) or len(args) != 1:
        return None
    parsed = _retry_line(args[0])
    if parsed is None:
        return None
    source = getattr(_line_context, "source", None)
    if not isinstance(source, _HarnessSource):
        return None
    if not source.accepts(parsed[0]):
        return None
    return source, parsed[0], parsed[1]


def _terminal_record(record: logging.LogRecord) -> Optional[Tuple[str, str]]:
    """Matches only the ACP server's terminal exception log templates."""
    if getattr(record, "filename", "") != "server.py":
        return None
    if getattr(record, "funcName", "") != "prompt":
        return None
    message = getattr(record, "msg", None)
    if not isinstance(message, str):
        return None
    args = getattr(record, "args", ())
    if not isinstance(args, (tuple, list)) or len(args) != 1:
        return None
    session = _safe_session(args[0])
    if session is None:
        return None
    exc_info = getattr(record, "exc_info", None)
    if not isinstance(exc_info, tuple) or len(exc_info) != 3:
        return None
    error_class = getattr(exc_info[0], "__name__", "")
    if not isinstance(error_class, str) or not error_class:
        return None
    if message == _SDK_TERMINAL_TEMPLATE:
        return (session, error_class) if error_class in _SDK_TERMINAL_CLASSES else None
    if message == _CONNECTION_LOST_TEMPLATE:
        return (session, error_class) if error_class.startswith("ConnectionClosed") else None
    if message == _REBUILD_FAILED_TEMPLATE:
        return (session, error_class) if error_class == "RuntimeError" else None
    return None


# The pinned 1.5.0 server reports a terminal SDK failure by first sending one
# AgentMessageChunk built from the raw exception text (server.py::prompt, in
# the AntigravityExecutionError/AntigravityConnectionError/
# AntigravityValidationError handler) and then returning a normal response.
# That body is an internal diagnostic, not assistant output, and may quote the
# private upstream response. Drop only that exact send. server.py stays
# unpatched: the agent-side client connection's send method is wrapped once,
# and the guard requires the pinned callsite line plus an active terminal
# exception, so streamed model text, cancellation notices, and every other
# session or turn still pass through unchanged. The line is fixed by the pinned
# serverControl preimage hash; a new official profile must re-derive it.
_TERMINAL_DIAGNOSTIC_SEND_LINE = 5759


def _is_terminal_diagnostic_send(caller: Any) -> bool:
    """True only for the pinned official terminal-catch diagnostic chunk."""
    error = sys.exc_info()[1]
    if error is None or type(error).__name__ not in _SDK_TERMINAL_CLASSES:
        return False
    code = getattr(caller, "f_code", None)
    if code is None or code.co_name != "prompt":
        return False
    if os.path.basename(code.co_filename) != "server.py":
        return False
    return caller.f_lineno == _TERMINAL_DIAGNOSTIC_SEND_LINE


def _install_terminal_diagnostic_guard() -> bool:
    """Wraps the ACP client send method once; later calls are unchanged."""
    global _diagnostic_guard_installed
    with _diagnostic_guard_lock:
        if _diagnostic_guard_installed:
            return True
        try:
            from acp import schema  # pylint: disable=g-import-not-at-top
            from acp.agent.connection import (  # pylint: disable=g-import-not-at-top
                AgentSideConnection,
            )
        except Exception:
            return False
        original_send = getattr(AgentSideConnection, "session_update", None)
        if original_send is None:
            return False
        message_chunk_type = schema.AgentMessageChunk

        async def _paseo_session_update(
            self: Any, *args: Any, **kwargs: Any
        ) -> Any:
            update = kwargs.get("update")
            if update is None and len(args) >= 2:
                update = args[1]
            try:
                suppress = (
                    isinstance(update, message_chunk_type)
                    and _is_terminal_diagnostic_send(sys._getframe(1))
                )
            except Exception:
                suppress = False
            if suppress:
                return None
            return await original_send(self, *args, **kwargs)

        AgentSideConnection.session_update = _paseo_session_update
        _diagnostic_guard_installed = True
        return True


def _terminal_state_path(directory: str, session: str) -> str:
    digest = hashlib.sha256(session.encode("utf-8")).hexdigest()
    return os.path.join(directory, digest + ".json")


def _write_terminal_state(session: str, error_class: str) -> bool:
    """Writes the fenced terminal state before the ACP response is returned."""
    directory = os.environ.get(_EVENT_DIRECTORY_ENV)
    if not directory or not os.path.isdir(directory):
        return False
    global _terminal_sequence
    try:
        with _state_lock:
            _terminal_sequence += 1
            sequence = _terminal_sequence
            step_index = _last_step_index.get(session)
        payload: Dict[str, Any] = {
            "v": 1,
            "event": "turn_failed",
            "session": session,
            "errorClass": error_class,
            "sequence": sequence,
            "writtenAt": int(time.time() * 1000),
        }
        if step_index is not None:
            payload["stepIndex"] = step_index
        path = _terminal_state_path(directory, session)
        temporary = path + f".tmp.{os.getpid()}.{threading.get_ident()}"
        try:
            with open(temporary, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, separators=(",", ":"), sort_keys=True)
                handle.flush()
            os.replace(temporary, path)
            return True
        except Exception:
            try:
                os.unlink(temporary)
            except Exception:
                pass
            return False
    except Exception:
        return False


def _emit_retry(
    source: _HarnessSource, decision_ms: int, delay_ms: Optional[int]
) -> None:
    # emittedAt is the verified Go decision time, not the handler wall clock:
    # a record forwarded after the next prompt starts must still sort before it.
    payload: Dict[str, Any] = {
        "v": 1,
        "event": "model_retry_scheduled",
        "session": source.session,
        "emittedAt": decision_ms,
    }
    if delay_ms is not None:
        payload["delayMs"] = delay_ms
    _emit_event(payload)


class _KernelTerminalHandler(logging.Handler):
    """Observes kernel log records without changing their handling."""

    def emit(self, record: logging.LogRecord) -> None:
        try:
            retry = _retry_record(record)
            if retry is not None:
                _emit_retry(retry[0], retry[1], retry[2])
                return
            terminal = _terminal_record(record)
            if terminal is not None:
                _write_terminal_state(terminal[0], terminal[1])
        except Exception:
            pass


def _install_sdk_observers() -> None:
    """Wraps the pinned SDK connection methods with read-only turn markers."""
    global _sdk_observers_installed
    if _sdk_observers_installed:
        return
    try:
        from google.antigravity.connections.local.local_connection import (  # pylint: disable=g-import-not-at-top
            LocalConnection,
        )
    except Exception:
        return
    original_start = LocalConnection._start_stderr_reader
    original_send = LocalConnection.send
    original_receive_steps = LocalConnection.receive_steps
    original_cancel = LocalConnection.cancel
    original_disconnect = LocalConnection.disconnect

    def _paseo_start_stderr_reader(self: Any, stderr_stream: Any) -> Any:
        source = _source_for_connection(self)
        if source is not None:
            stderr_stream = _TaggedStderr(stderr_stream, source)
        return original_start(self, stderr_stream)

    async def _paseo_send(self: Any, prompt: Any, **kwargs: Any) -> Any:
        source = _source_for_connection(self)
        generation = source.begin() if source is not None else None
        try:
            return await original_send(self, prompt, **kwargs)
        except Exception:
            if source is not None and generation is not None:
                source.end(generation)
            raise

    async def _paseo_receive_steps(self: Any):
        source = _source_for_connection(self)
        generation = source.generation() if source is not None else None
        try:
            async for step in original_receive_steps(self):
                yield step
        finally:
            if source is not None and generation is not None:
                source.end(generation)

    async def _paseo_cancel(self: Any) -> Any:
        source = _source_for_connection(self)
        if source is not None:
            source.cancel()
        return await original_cancel(self)

    async def _paseo_disconnect(self: Any) -> Any:
        source = _source_for_connection(self)
        if source is not None:
            source.cancel()
        return await original_disconnect(self)

    LocalConnection._start_stderr_reader = _paseo_start_stderr_reader
    LocalConnection.send = _paseo_send
    LocalConnection.receive_steps = _paseo_receive_steps
    LocalConnection.cancel = _paseo_cancel
    LocalConnection.disconnect = _paseo_disconnect
    _sdk_observers_installed = True


def install_kernel_event_handler() -> bool:
    """Installs the log observers once when the connector opts in."""
    global _terminal_handler_installed
    if not _event_enabled():
        return False
    if _terminal_handler_installed:
        return True
    try:
        handler = _KernelTerminalHandler()
        handler.setLevel(logging.INFO)
        logging.getLogger().addHandler(handler)
        _terminal_handler_installed = True
        return True
    except Exception:
        return False


def register_step_observer(hook_runner: Any, conversation_id: Any = None) -> bool:
    """Registers the read-only observers for one active agent session."""
    if not _event_enabled():
        return False
    session = _safe_session(conversation_id)
    if hook_runner is not None and session is not None:
        try:
            _session_by_hook[hook_runner] = session
        except Exception:
            pass
    _install_sdk_observers()
    try:
        from google.antigravity.hooks import hooks as hooks_base  # pylint: disable=g-import-not-at-top
    except Exception:
        return False

    class _PaseoStepObserver(hooks_base._PostStepHook):  # pylint: disable=protected-access
        async def run(self, context: Any, data: Any) -> None:
            payload = _step_event_payload(data)
            if payload is not None:
                _emit_event(payload)

    try:
        hook_runner.register_hook(_PaseoStepObserver())
        return True
    except Exception:
        return False


_install_terminal_diagnostic_guard()
install_kernel_event_handler()
