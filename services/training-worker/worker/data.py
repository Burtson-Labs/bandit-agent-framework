"""Canonical examples (CONTRACT.md) → chat-template input. Pure Python; no GPU imports.

Qwen3's own chat template (and Ollama's / vLLM's Hermes parser) expect:
  assistant tool calls  → ``<tool_call>{"name": ..., "arguments": {...}}</tool_call>``
  tool results          → a user turn wrapping ``<tool_response>…</tool_response>``
  thinking              → ``reasoning_content`` (rendered as ``<think>…</think>``)
so the conversion is: arguments as objects, ``reasoning`` → ``reasoning_content``, and nothing
host-specific (``bandit-*`` fences were stripped by the collector; re-checked here).
"""
from __future__ import annotations

import json
import re
from typing import Any, Iterable

FENCE = re.compile(r"`{3,}bandit-[a-z-]+[\s\S]*?`{3,}\n?")
TEMPLATE_LEAKS = ("</start_of_turn>", "<start_of_turn>", "<|im_end|>", "<|im_start|>", "<|endoftext|>")


def clean_assistant_text(text: str | None) -> str:
    text = FENCE.sub("", text or "")
    for leak in TEMPLATE_LEAKS:
        text = text.replace(leak, "")
    return text.strip()


def arguments_object(raw: Any) -> dict:
    if isinstance(raw, dict):
        return raw
    try:
        value = json.loads(raw or "{}")
    except (TypeError, json.JSONDecodeError):
        return {"_raw": str(raw)}
    return value if isinstance(value, dict) else {"value": value}


def to_chat(example: dict) -> tuple[list[dict], list[dict] | None]:
    """(messages, tools) ready for ``tokenizer.apply_chat_template(messages, tools=tools)``."""
    out: list[dict] = []
    for message in example["messages"]:
        role = message["role"]
        if role == "assistant":
            entry: dict[str, Any] = {"role": "assistant", "content": clean_assistant_text(message.get("content"))}
            if message.get("reasoning"):
                entry["reasoning_content"] = str(message["reasoning"]).strip()
            calls = []
            for call in message.get("tool_calls") or []:
                fn = call.get("function") or {}
                calls.append({"type": "function", "function": {"name": fn["name"], "arguments": arguments_object(fn.get("arguments"))}})
            if calls:
                entry["tool_calls"] = calls
            out.append(entry)
        elif role == "tool":
            out.append({"role": "tool", "content": str(message.get("content") or ""), "name": message.get("name")})
        else:
            out.append({"role": role, "content": str(message.get("content") or "")})
    # A trailing non-assistant turn teaches nothing: trim it.
    while out and out[-1]["role"] != "assistant":
        out.pop()
    tools = example.get("tools") or None
    return out, tools


def load_jsonl(lines: Iterable[str | bytes]) -> list[dict]:
    rows = []
    for line in lines:
        line = line.decode() if isinstance(line, bytes) else line
        if line.strip():
            rows.append(json.loads(line))
    return rows


def smoke_examples(n: int = 24) -> list[dict]:
    """A tiny synthetic trainset for ``--smoke`` when no trainset is given (pipeline check only)."""
    rows = []
    for i in range(n):
        rows.append({
            "id": f"smoke_{i}", "source": "smoke", "status": "completed",
            "tools": [{"type": "function", "function": {"name": "read_file", "description": "Read a file from the workspace",
                                                         "parameters": {"type": "object", "properties": {"path": {"type": "string"}},
                                                                        "required": ["path"]}}}],
            "messages": [
                {"role": "system", "content": "You are Bandit, a local coding agent."},
                {"role": "user", "content": f"What does src/file{i}.ts export?"},
                {"role": "assistant", "content": "", "tool_calls": [{"id": "c1", "type": "function",
                                                                        "function": {"name": "read_file", "arguments": json.dumps({"path": f"src/file{i}.ts"})}}]},
                {"role": "tool", "tool_call_id": "c1", "name": "read_file", "content": f"export const value{i} = {i};"},
                {"role": "assistant", "content": f"It exports `value{i}`, a constant equal to {i}."},
            ],
            "scrub": {"version": "scrub-v1", "dropped": False},
        })
    return rows


# Where assistant output starts/stops in each family's template (loss masking).
RESPONSE_MARKERS = {
    "qwen3": {"instruction": "<|im_start|>user\n", "response": "<|im_start|>assistant\n"},
    "gpt-oss": {"instruction": "<|start|>user<|message|>", "response": "<|start|>assistant"},
}
