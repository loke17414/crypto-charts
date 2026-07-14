"""Manage the UI-identical Node bot (bot-js) as a server background process."""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from bot.config import ROOT

logger = logging.getLogger(__name__)

STATE_FILE = ROOT / "web-bot-state.json"
_bot_proc: subprocess.Popen | None = None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_state() -> dict[str, Any]:
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _write_state(payload: dict[str, Any]) -> None:
    STATE_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _node_executable() -> str | None:
    return shutil.which("node") or shutil.which("node.exe")


def is_running() -> bool:
    global _bot_proc
    return _bot_proc is not None and _bot_proc.poll() is None


def bot_status() -> dict[str, Any]:
    running = is_running()
    state = _read_state()
    return {
        "running": running,
        "pid": _bot_proc.pid if running and _bot_proc else state.get("pid"),
        "startedAt": state.get("startedAt"),
        "persisted": bool(state.get("shouldRun")),
    }


def save_strategy_json(payload: dict[str, Any]) -> Path:
    path = ROOT / "strategy.json"
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    logger.info("strategy.json updated for server bot")
    return path


def start_bot() -> dict[str, Any]:
    global _bot_proc

    if is_running():
        return {"ok": True, "running": True, "message": "봇이 이미 실행 중입니다.", **bot_status()}

    node = _node_executable()
    bot_script = ROOT / "bot-js" / "bot.js"
    if not node:
        raise RuntimeError("Node.js가 설치되어 있지 않습니다. VPS에서 node를 설치하세요.")
    if not bot_script.is_file():
        raise RuntimeError(f"bot-js/bot.js를 찾을 수 없습니다: {bot_script}")

    env = os.environ.copy()
    _bot_proc = subprocess.Popen(
        [node, str(bot_script)],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    _write_state({"shouldRun": True, "startedAt": _now_iso(), "pid": _bot_proc.pid})
    logger.info("Server bot started (pid=%s)", _bot_proc.pid)
    return {"ok": True, "running": True, "pid": _bot_proc.pid, "message": "서버 봇 시작 — 브라우저를 닫아도 계속 실행됩니다."}


def stop_bot() -> dict[str, Any]:
    global _bot_proc

    if is_running() and _bot_proc:
        _bot_proc.terminate()
        try:
            _bot_proc.wait(timeout=12)
        except subprocess.TimeoutExpired:
            _bot_proc.kill()
            _bot_proc.wait(timeout=5)
        logger.info("Server bot stopped")

    _bot_proc = None
    _write_state({"shouldRun": False, "stoppedAt": _now_iso()})
    return {"ok": True, "running": False, "message": "서버 봇 정지"}


def restore_bot_if_needed() -> None:
    state = _read_state()
    if not state.get("shouldRun"):
        return
    try:
        start_bot()
        logger.info("Restored server bot from web-bot-state.json")
    except Exception as exc:
        logger.warning("Could not restore server bot: %s", exc)
