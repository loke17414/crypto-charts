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
ENTRY_GATE_FILE = ROOT / "bot-entry-gate.json"
_bot_proc: subprocess.Popen | None = None


def _env_bool(name: str, default: bool = False) -> bool:
    val = os.getenv(name, "").strip().lower()
    if val:
        return val in ("1", "true", "yes")
    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, _, raw = stripped.partition("=")
            if key.strip() != name:
                continue
            cleaned = raw.strip().strip('"').strip("'").lower()
            return cleaned in ("1", "true", "yes")
    return default


def _bot_trading_flags(state: dict[str, Any] | None = None) -> dict[str, Any]:
    state = state or _read_state()
    env_dry = _env_bool("DRY_RUN", False)
    live_trading = state.get("liveTrading")
    if live_trading is None:
        live_trading = not env_dry
    effective_dry = not live_trading if is_running() else env_dry
    return {
        "dryRun": effective_dry,
        "liveTrading": bool(live_trading),
        "testnet": _env_bool("BINANCE_TESTNET", True),
    }


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


def _entry_gate_status() -> dict[str, Any] | None:
    """Read-only view of the entry pause gate for status displays."""
    if not ENTRY_GATE_FILE.exists():
        return None
    try:
        data = json.loads(ENTRY_GATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return {
        "pausedUntil": int(data.get("pausedUntil") or 0),
        "reason": data.get("reason"),
        "active": int(data.get("pausedUntil") or 0) > int(time.time() * 1000),
    }


def bot_status() -> dict[str, Any]:
    running = is_running()
    state = _read_state()
    flags = _bot_trading_flags(state)
    return {
        "running": running,
        "pid": _bot_proc.pid if running and _bot_proc else state.get("pid"),
        "startedAt": state.get("startedAt"),
        "persisted": bool(state.get("shouldRun")),
        "recentLogs": tail_bot_logs(8),
        "entryGate": _entry_gate_status(),
        **flags,
    }


def tail_bot_logs(n: int = 8) -> list[str]:
    log_dir = ROOT / "logs"
    if not log_dir.is_dir():
        return []
    files = sorted(log_dir.glob("bot-js-*.log"), reverse=True)
    if not files:
        return []
    try:
        lines = files[0].read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    return lines[-max(1, n) :]


def pause_bot_entry(
    *,
    manual: bool = True,
    interval: str = "15m",
    bar_time: int | None = None,
    blocked_signal: str | None = None,
) -> dict[str, Any]:
    """Pause server-bot re-entry after manual/UI close until the current bar ends."""
    seconds_map = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}
    interval_sec = seconds_map.get(interval, 900)
    now_ms = int(time.time() * 1000)
    if manual and bar_time:
        bar_end_ms = (int(bar_time) + interval_sec) * 1000
        paused_until = min(max(now_ms + 30_000, bar_end_ms), now_ms + 15 * 60_000)
    else:
        paused_until = min(
            max(now_ms + 30_000, now_ms + interval_sec * 1000),
            now_ms + 15 * 60_000,
        )
    payload: dict[str, Any] = {
        "pausedUntil": paused_until,
        "reason": "manual_close" if manual else "external_close",
        "updatedAt": _now_iso(),
    }
    if manual:
        if bar_time is not None:
            payload["blockedBarTime"] = int(bar_time)
        if blocked_signal in ("LONG", "SHORT"):
            payload["blockedSignal"] = blocked_signal
    ENTRY_GATE_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    logger.info("Bot entry paused until %s (manual=%s)", paused_until, manual)
    return payload


def clear_expired_entry_gate() -> None:
    if not ENTRY_GATE_FILE.exists():
        return
    try:
        data = json.loads(ENTRY_GATE_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        ENTRY_GATE_FILE.unlink(missing_ok=True)
        return
    paused_until = int(data.get("pausedUntil") or 0)
    if paused_until <= int(time.time() * 1000):
        ENTRY_GATE_FILE.unlink(missing_ok=True)


def _strategy_interval() -> str:
    path = ROOT / "strategy.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return str(data.get("interval") or "15m")
    except (OSError, json.JSONDecodeError, TypeError):
        return "15m"


def save_strategy_json(payload: dict[str, Any]) -> Path:
    path = ROOT / "strategy.json"
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    logger.info("strategy.json updated for server bot")
    return path


def start_bot(*, live_trading: bool = True) -> dict[str, Any]:
    global _bot_proc

    if is_running():
        clear_expired_entry_gate()
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

    clear_expired_entry_gate()
    # Fresh start — drop stale pause (e.g. status-poll repeatedly extended pausedUntil).
    ENTRY_GATE_FILE.unlink(missing_ok=True)

    env = os.environ.copy()
    env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    if live_trading:
        env["DRY_RUN"] = "false"
    else:
        env.setdefault("DRY_RUN", "true")
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
    _write_state({
        "shouldRun": True,
        "liveTrading": live_trading,
        "startedAt": _now_iso(),
        "pid": _bot_proc.pid,
    })
    logger.info("Server bot started (pid=%s, live_trading=%s)", _bot_proc.pid, live_trading)
    mode = "테스트넷 실거래" if live_trading else "DRY_RUN 시뮬레이션"
    return {
        "ok": True,
        "running": True,
        "pid": _bot_proc.pid,
        "liveTrading": live_trading,
        "dryRun": not live_trading,
        "message": f"서버 봇 시작 ({mode}) — 브라우저를 닫아도 계속 실행됩니다.",
    }


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
        clear_expired_entry_gate()
        start_bot(live_trading=bool(state.get("liveTrading", True)))
        logger.info("Restored server bot from web-bot-state.json")
    except Exception as exc:
        logger.warning("Could not restore server bot: %s", exc)
