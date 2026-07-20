"""Persist GPT strategy conversation per user (or legacy global file)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from bot.config import ROOT

LEGACY_MEMORY_FILE = ROOT / "strategy-ai-memory.json"
MAX_TURNS = 30


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _memory_path(user_id: int | None) -> Path:
    if user_id is None:
        return LEGACY_MEMORY_FILE
    path = ROOT / "data" / "bots" / str(user_id) / "strategy-ai-memory.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _read_raw(user_id: int | None = None) -> dict[str, Any]:
    path = _memory_path(user_id)
    if not path.exists():
        return {"turns": [], "updatedAt": None}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, OSError):
        pass
    return {"turns": [], "updatedAt": None}


def _write_raw(data: dict[str, Any], user_id: int | None = None) -> None:
    data["updatedAt"] = _now_iso()
    path = _memory_path(user_id)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_turns(user_id: int | None = None) -> list[dict[str, Any]]:
    turns = _read_raw(user_id).get("turns") or []
    if not isinstance(turns, list):
        return []
    return turns[-MAX_TURNS:]


def clear_memory(user_id: int | None = None) -> None:
    _write_raw({"turns": []}, user_id)


def append_turn(
    *,
    role: str,
    content: str,
    meta: dict[str, Any] | None = None,
    user_id: int | None = None,
) -> list[dict[str, Any]]:
    text = str(content or "").strip()
    if not text or role not in {"user", "assistant"}:
        return load_turns(user_id)

    entry: dict[str, Any] = {
        "role": role,
        "content": text[:2000],
        "at": _now_iso(),
    }
    if meta and isinstance(meta, dict):
        entry["meta"] = meta

    data = _read_raw(user_id)
    turns = data.get("turns") or []
    if not isinstance(turns, list):
        turns = []
    turns.append(entry)
    data["turns"] = turns[-MAX_TURNS:]
    _write_raw(data, user_id)
    return data["turns"]


def merge_histories(
    client_history: list[dict[str, Any]] | None,
    server_turns: list[dict[str, Any]] | None = None,
    *,
    user_id: int | None = None,
) -> list[dict[str, str]]:
    """Merge client + server turns into OpenAI message list (newest wins on duplicates)."""
    server_turns = server_turns if server_turns is not None else load_turns(user_id)
    combined: list[dict[str, Any]] = []

    for item in (server_turns or []) + (client_history or []):
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = str(item.get("content") or "").strip()
        if role not in {"user", "assistant"} or not content:
            continue
        combined.append({"role": role, "content": content, "meta": item.get("meta")})

    deduped: list[dict[str, Any]] = []
    for item in combined:
        if (
            deduped
            and deduped[-1]["role"] == item["role"] == "user"
            and deduped[-1]["content"] == item["content"]
        ):
            continue
        deduped.append(item)

    out: list[dict[str, str]] = []
    for item in deduped[-MAX_TURNS:]:
        out.append({"role": item["role"], "content": item["content"]})
    return out
