"""Local-only request compatibility profile for the RC01 official kernel."""

from __future__ import annotations

from collections import deque
from typing import Any, Deque, Dict, Iterator, Optional, Set, Tuple

SUPPORTED_NON_GEMINI_MODEL_IDS = frozenset(
    {
        "claude-sonnet-4-6",
        "claude-opus-4-6-thinking",
        "gpt-oss-120b-medium",
    }
)

_MAX_OUTPUT_TOKENS_BY_MODEL_ID = {
    "claude-sonnet-4-6": 64000,
    "claude-opus-4-6-thinking": 64000,
    "gpt-oss-120b-medium": 32768,
}
_GPT_OSS_MODEL_ID = "gpt-oss-120b-medium"

__all__ = [
    "SUPPORTED_NON_GEMINI_MODEL_IDS",
    "is_catalog_model",
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
