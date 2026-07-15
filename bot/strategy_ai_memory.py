"""Persist GPT strategy conversation on the server (survives browser close)."""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from bot.config import ROOT

MEMORY_FILE = ROOT / "strategy-ai-memory.json"
MAX_TURNS = 30


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_raw() -> dict[str, Any]:
    if not MEMORY_FILE.exists():
        return {"turns": [], "updatedAt": None}
    try:
        data = json.loads(MEMORY_FILE.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except (json.JSONDecodeError, OSError):
        pass
    return {"turns": [], "updatedAt": None}


def _write_raw(data: dict[str, Any]) -> None:
    data["updatedAt"] = _now_iso()
    MEMORY_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_turns() -> list[dict[str, Any]]:
    turns = _read_raw().get("turns") or []
    if not isinstance(turns, list):
        return []
    return turns[-MAX_TURNS:]


def clear_memory() -> None:
    _write_raw({"turns": []})


def append_turn(
    *,
    role: str,
    content: str,
    meta: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    text = str(content or "").strip()
    if not text or role not in {"user", "assistant"}:
        return load_turns()

    entry: dict[str, Any] = {
        "role": role,
        "content": text[:2000],
        "at": _now_iso(),
    }
    if meta and isinstance(meta, dict):
        entry["meta"] = meta

    data = _read_raw()
    turns = data.get("turns") or []
    if not isinstance(turns, list):
        turns = []
    turns.append(entry)
    data["turns"] = turns[-MAX_TURNS:]
    _write_raw(data)
    return data["turns"]


def merge_histories(
    client_history: list[dict[str, Any]] | None,
    server_turns: list[dict[str, Any]] | None = None,
) -> list[dict[str, str]]:
    """Merge client + server turns into OpenAI message list (newest wins on duplicates)."""
    server_turns = server_turns if server_turns is not None else load_turns()
    combined: list[dict[str, Any]] = []

    for item in (server_turns or []) + (client_history or []):
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = str(item.get("content") or "").strip()
        if role not in {"user", "assistant"} or not content:
            continue
        combined.append({"role": role, "content": content, "meta": item.get("meta")})

    # Drop adjacent duplicate user messages (same text)
    deduped: list[dict[str, Any]] = []
    for item in combined:
        if deduped and deduped[-1]["role"] == item["role"] == "user" and deduped[-1]["content"] == item["content"]:
            continue
        deduped.append(item)

    out: list[dict[str, str]] = []
    for item in deduped[-20:]:
        text = item["content"]
        meta = item.get("meta")
        if item["role"] == "assistant" and isinstance(meta, dict) and meta:
            extras = []
            changed = meta.get("changed_fields") or meta.get("changedFields")
            if changed:
                extras.append(f"변경 필드: {', '.join(changed)}")
            bt = meta.get("backtest")
            if isinstance(bt, dict) and bt.get("trades"):
                extras.append(
                    f"백테스트: {bt.get('trades')}회 · 승률 {bt.get('winRate', 0):.1f}% · "
                    f"누적 {bt.get('totalPnlPct', 0):+.2f}%"
                )
            if extras:
                text = f"{text}\n[{'; '.join(extras)}]"
        out.append({"role": item["role"], "content": text[:2000]})
    return out
