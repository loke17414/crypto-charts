"""Manage the UI-identical Node bot (bot-js) as a server background process."""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import time
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
    override = os.environ.get("NODE_BIN", "").strip()
    if override and Path(override).is_file():
        return override

    found = shutil.which("node") or shutil.which("node.exe")
    if found:
        return found

    for candidate in (
        "/usr/bin/node",
        "/usr/local/bin/node",
        "/snap/bin/node",
        os.path.expanduser("~/.nvm/current/bin/node"),
    ):
        if candidate and Path(candidate).is_file():
            return candidate
    return None


def bot_diagnostics() -> dict[str, Any]:
    node = _node_executable()
    bot_script = ROOT / "bot-js" / "bot.js"
    version = None
    if node:
        try:
            version = subprocess.check_output([node, "-v"], text=True, timeout=5).strip()
        except (subprocess.SubprocessError, OSError):
            version = None
    return {
        "nodeFound": bool(node),
        "nodePath": node,
        "nodeVersion": version,
        "botScriptPath": str(bot_script),
        "botScriptExists": bot_script.is_file(),
    }


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
        diag = bot_diagnostics()
        raise RuntimeError(
            "Node.js가 설치되어 있지 않거나 PATH에서 찾을 수 없습니다. "
            "VPS에서 `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -` 후 "
            "`sudo apt install -y nodejs` 를 실행하고 crypto-web을 재시작하세요. "
            f"(진단: {diag})"
        )
    if not bot_script.is_file():
        raise RuntimeError(
            f"bot-js/bot.js를 찾을 수 없습니다: {bot_script}. "
            "프로젝트 루트에서 git pull 후 systemctl restart crypto-web 하세요."
        )

    env = os.environ.copy()
    env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    _bot_proc = subprocess.Popen(
        [node, str(bot_script)],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    time.sleep(0.8)
    if _bot_proc.poll() is not None:
        output = ""
        if _bot_proc.stdout:
            output = _bot_proc.stdout.read(2000)
        _bot_proc = None
        raise RuntimeError(f"봇 프로세스가 바로 종료됨: {output.strip() or '출력 없음'}")
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
