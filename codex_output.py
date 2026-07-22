#!/usr/bin/env python3
"""Extract assistant text from ``codex exec --json`` output.

Codex writes JSONL transport events, not the assistant message verbatim.  Keep
that transport boundary explicit: known agent-message envelopes are decoded,
plain non-JSON output remains a legacy fallback, and valid-but-unknown JSONL
fails closed instead of being mistaken for report HTML.
"""

from __future__ import annotations

import json
import sys
from typing import Any


_AGENT_MESSAGE_TYPES = {"agent_message", "agentMessage"}
_COMPLETED_EVENT_TYPES = {"item.completed", "item_completed"}


def _content_text(value: Any) -> str:
    """Normalize string or text-block content without accepting tool output."""
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return ""

    parts: list[str] = []
    for block in value:
        if not isinstance(block, dict):
            continue
        if block.get("type") not in ("text", "output_text"):
            continue
        text = block.get("text")
        if isinstance(text, str):
            parts.append(text)
    return "".join(parts)


def _message_text(item: Any) -> str:
    if not isinstance(item, dict) or item.get("type") not in _AGENT_MESSAGE_TYPES:
        return ""
    for key in ("text", "content", "message"):
        text = _content_text(item.get(key))
        if text:
            return text
    return ""


def extract_codex_agent_text(raw: str) -> str:
    """Return decoded assistant text, or ``""`` for unknown JSONL events.

    Supported envelopes:
      * current: ``item.completed`` with ``item.type=agent_message`` + ``text``
      * legacy: a top-level ``agent_message`` event
      * legacy: an ``agent_message`` nested under ``msg``

    Multiple completed message items are joined in stream order. If there are
    no parseable JSON objects at all, ``raw`` is returned for compatibility
    with old/plain-text Codex output. Once JSON transport is detected, however,
    raw fallback is unsafe: escaped HTML inside an unknown event must never be
    scanned as if it were the report body.
    """
    parts: list[str] = []
    saw_json_transport = False

    for raw_line in raw.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except (TypeError, ValueError):
            continue
        if not isinstance(event, dict):
            continue

        saw_json_transport = True
        event_type = event.get("type")
        candidates: list[Any] = []
        if event_type in _COMPLETED_EVENT_TYPES:
            candidates.append(event.get("item"))
        elif event_type in _AGENT_MESSAGE_TYPES:
            candidates.append(event)

        # Older Codex builds wrapped the semantic event in ``msg``.
        msg = event.get("msg")
        if isinstance(msg, dict) and msg.get("type") in _AGENT_MESSAGE_TYPES:
            candidates.append(msg)

        for candidate in candidates:
            text = _message_text(candidate)
            if text:
                parts.append(text)

    if parts:
        return "".join(parts)
    return "" if saw_json_transport else raw


def main() -> int:
    sys.stdout.write(extract_codex_agent_text(sys.stdin.read()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
