"""Manage UI-identical Node bots (bot-js) — one subprocess per user (Phase 2-C)."""

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
from bot.platform_config import DATA_DIR, max_concurrent_bots

logger = logging.getLogger(__name__)

# Legacy single-tenant key (AUTH_REQUIRED=false / .env mode)
LEGACY_BOT_KEY = 0

# user_id → running Popen (0 = legacy)
_bots: dict[int, subprocess.Popen] = {}


def bot_key(user_id: int | None) -> int:
    return int(user_id) if user_id is not None else LEGACY_BOT_KEY


def bot_home(user_id: int | None) -> Path:
    """Per-user working directory for strategy / gate / state / logs."""
    key = bot_key(user_id)
    path = DATA_DIR / "bots" / str(key)
    path.mkdir(parents=True, exist_ok=True)
    (path / "logs").mkdir(parents=True, exist_ok=True)
    return path


def state_file(user_id: int | None) -> Path:
    return bot_home(user_id) / "web-bot-state.json"


def entry_gate_file(user_id: int | None) -> Path:
    return bot_home(user_id) / "bot-entry-gate.json"


def strategy_file(user_id: int | None) -> Path:
    return bot_home(user_id) / "strategy.json"


# Back-compat alias used by older imports (legacy path only).
ENTRY_GATE_FILE = ROOT / "bot-entry-gate.json"


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


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _read_state(user_id: int | None) -> dict[str, Any]:
    path = state_file(user_id)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def _write_state(user_id: int | None, payload: dict[str, Any]) -> None:
    state_file(user_id).write_text(json.dumps(payload, indent=2), encoding="utf-8")


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
        "maxConcurrentBots": max_concurrent_bots(),
        "runningBots": sum(1 for k in list(_bots) if is_running(k)),
    }


def is_running(user_id: int | None = None) -> bool:
    key = bot_key(user_id)
    proc = _bots.get(key)
    if proc is None:
        return False
    if proc.poll() is not None:
        _bots.pop(key, None)
        return False
    return True


def _bot_trading_flags(user_id: int | None, state: dict[str, Any] | None = None) -> dict[str, Any]:
    state = state or _read_state(user_id)
    env_dry = _env_bool("DRY_RUN", False)
    live_trading = state.get("liveTrading")
    if live_trading is None:
        live_trading = not env_dry
    effective_dry = not live_trading if is_running(user_id) else env_dry
    return {
        "dryRun": effective_dry,
        "liveTrading": bool(live_trading),
        "testnet": _env_bool("BINANCE_TESTNET", True),
    }


def _entry_gate_status(user_id: int | None) -> dict[str, Any] | None:
    path = entry_gate_file(user_id)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return {
        "pausedUntil": int(data.get("pausedUntil") or 0),
        "reason": data.get("reason"),
        "active": int(data.get("pausedUntil") or 0) > int(time.time() * 1000),
    }


def bot_status(user_id: int | None = None) -> dict[str, Any]:
    key = bot_key(user_id)
    running = is_running(key)
    state = _read_state(key)
    flags = _bot_trading_flags(key, state)
    proc = _bots.get(key)
    return {
        "running": running,
        "userId": None if key == LEGACY_BOT_KEY else key,
        "pid": proc.pid if running and proc else state.get("pid"),
        "startedAt": state.get("startedAt"),
        "persisted": bool(state.get("shouldRun")),
        "recentLogs": tail_bot_logs(20, user_id=key),
        "entryGate": _entry_gate_status(key),
        "botHome": str(bot_home(key)),
        **flags,
    }


def tail_bot_logs(n: int = 8, *, user_id: int | None = None) -> list[str]:
    log_dir = bot_home(user_id) / "logs"
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
    user_id: int | None = None,
    manual: bool = True,
    interval: str = "15m",
    bar_time: int | None = None,
    blocked_signal: str | None = None,
) -> dict[str, Any]:
    """Pause server-bot re-entry after manual/UI close until the current bar ends."""
    seconds_map = {"1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}
    interval_sec = seconds_map.get(interval, 900)
    now_ms = int(time.time() * 1000)
    min_pause_ms = 90_000  # never reopen within 90s of a manual close
    if manual and bar_time:
        bar_end_ms = (int(bar_time) + interval_sec) * 1000
        paused_until = min(max(now_ms + min_pause_ms, bar_end_ms), now_ms + 15 * 60_000)
    else:
        paused_until = min(
            max(now_ms + min_pause_ms, now_ms + interval_sec * 1000),
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
    path = entry_gate_file(user_id)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    logger.info("Bot entry paused until %s (user=%s, manual=%s)", paused_until, bot_key(user_id), manual)
    return payload


def clear_expired_entry_gate(user_id: int | None = None) -> None:
    path = entry_gate_file(user_id)
    if not path.exists():
        return
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        path.unlink(missing_ok=True)
        return
    paused_until = int(data.get("pausedUntil") or 0)
    if paused_until <= int(time.time() * 1000):
        path.unlink(missing_ok=True)


def clear_entry_gate(user_id: int | None = None) -> None:
    clear_expired_entry_gate(user_id)
    entry_gate_file(user_id).unlink(missing_ok=True)


def _strategy_interval(user_id: int | None = None) -> str:
    path = strategy_file(user_id)
    if not path.exists() and bot_key(user_id) == LEGACY_BOT_KEY:
        path = ROOT / "strategy.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return str(data.get("interval") or "15m")
    except (OSError, json.JSONDecodeError, TypeError):
        return "15m"


def save_strategy_json(payload: dict[str, Any], user_id: int | None = None) -> Path:
    path = strategy_file(user_id)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    logger.info("strategy.json updated for user=%s → %s", bot_key(user_id), path)
    return path


def _count_running() -> int:
    return sum(1 for k in list(_bots) if is_running(k))


def start_bot(
    *,
    user_id: int | None = None,
    live_trading: bool = True,
    api_key: str | None = None,
    api_secret: str | None = None,
    use_testnet: bool | None = None,
) -> dict[str, Any]:
    key = bot_key(user_id)

    if is_running(key):
        clear_expired_entry_gate(key)
        return {"ok": True, "running": True, "message": "봇이 이미 실행 중입니다.", **bot_status(key)}

    if _count_running() >= max_concurrent_bots():
        raise RuntimeError(
            f"서버 봇 동시 실행 한도({max_concurrent_bots()})에 도달했습니다. "
            "MAX_CONCURRENT_BOTS를 올리거나 다른 사용자 봇을 정지하세요."
        )

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

    home = bot_home(key)
    clear_expired_entry_gate(key)
    # Fresh start — drop stale pause for this user only.
    entry_gate_file(key).unlink(missing_ok=True)

    env = os.environ.copy()
    env.setdefault("PATH", "/usr/local/bin:/usr/bin:/bin")
    if live_trading:
        env["DRY_RUN"] = "false"
    else:
        env.setdefault("DRY_RUN", "true")

    from bot.credentials import load_binance_credentials

    if api_key and api_secret:
        env["BINANCE_API_KEY"] = api_key
        env["BINANCE_API_SECRET"] = api_secret
    elif key == LEGACY_BOT_KEY:
        creds = load_binance_credentials()
        if creds:
            env["BINANCE_API_KEY"] = creds[0]
            env["BINANCE_API_SECRET"] = creds[1]
    else:
        # Per-user start must supply vault keys — never fall back to shared .env.
        raise RuntimeError("사용자 API 키가 없습니다. 먼저 Binance 키를 연결하세요.")

    if use_testnet is not None:
        env["BINANCE_TESTNET"] = "true" if use_testnet else "false"
    else:
        env.setdefault("BINANCE_TESTNET", "true")

    env["BOT_HOME"] = str(home)
    env["STRATEGY_FILE"] = str(strategy_file(key))

    proc = subprocess.Popen(
        [node, str(bot_script)],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
    )
    time.sleep(0.8)
    if proc.poll() is not None:
        output = ""
        if proc.stdout:
            output = proc.stdout.read(2000)
        raise RuntimeError(f"봇 프로세스가 바로 종료됨: {output.strip() or '출력 없음'}")

    _bots[key] = proc
    _write_state(
        key,
        {
            "shouldRun": True,
            "liveTrading": live_trading,
            "startedAt": _now_iso(),
            "pid": proc.pid,
            "userId": None if key == LEGACY_BOT_KEY else key,
        },
    )
    logger.info("Server bot started (user=%s, pid=%s, live_trading=%s)", key, proc.pid, live_trading)
    mode = "테스트넷 실거래" if live_trading else "DRY_RUN 시뮬레이션"
    return {
        "ok": True,
        "running": True,
        "pid": proc.pid,
        "userId": None if key == LEGACY_BOT_KEY else key,
        "liveTrading": live_trading,
        "dryRun": not live_trading,
        "message": f"서버 봇 시작 ({mode}) — 브라우저를 닫아도 계속 실행됩니다.",
    }


def stop_bot(user_id: int | None = None) -> dict[str, Any]:
    key = bot_key(user_id)
    proc = _bots.get(key)

    if is_running(key) and proc:
        proc.terminate()
        try:
            proc.wait(timeout=12)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        logger.info("Server bot stopped (user=%s)", key)

    _bots.pop(key, None)
    prev = _read_state(key)
    _write_state(
        key,
        {
            "shouldRun": False,
            "stoppedAt": _now_iso(),
            "liveTrading": prev.get("liveTrading"),
            "userId": None if key == LEGACY_BOT_KEY else key,
        },
    )
    return {"ok": True, "running": False, "userId": None if key == LEGACY_BOT_KEY else key, "message": "서버 봇 정지"}


def stop_all_bots() -> None:
    for key in list(_bots.keys()):
        try:
            stop_bot(key)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to stop bot user=%s: %s", key, exc)


def _migrate_legacy_root_state() -> None:
    """Move pre-2-C root web-bot-state.json into data/bots/0/ once."""
    legacy_root = ROOT / "web-bot-state.json"
    dest = state_file(LEGACY_BOT_KEY)
    if not legacy_root.exists() or dest.exists():
        return
    try:
        data = json.loads(legacy_root.read_text(encoding="utf-8"))
        _write_state(LEGACY_BOT_KEY, data)
        # Copy strategy / gate if present
        for name in ("strategy.json", "bot-entry-gate.json", "bot-js-state.json"):
            src = ROOT / name
            if src.exists() and not (bot_home(LEGACY_BOT_KEY) / name).exists():
                shutil.copy2(src, bot_home(LEGACY_BOT_KEY) / name)
        logger.info("Migrated legacy web-bot-state.json → %s", dest)
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("Legacy bot state migration skipped: %s", exc)


def _persisted_bot_keys() -> list[int]:
    _migrate_legacy_root_state()
    keys: list[int] = []
    bots_root = DATA_DIR / "bots"
    if not bots_root.is_dir():
        return keys
    for child in bots_root.iterdir():
        if not child.is_dir():
            continue
        try:
            key = int(child.name)
        except ValueError:
            continue
        state = _read_state(key)
        if state.get("shouldRun"):
            keys.append(key)
    return keys


def restore_bot_if_needed() -> None:
    """Restart bots marked shouldRun, loading per-user vault keys when available."""
    keys = _persisted_bot_keys()
    if not keys:
        return

    from bot.db import SessionLocal
    from bot.user_credentials import load_credentials

    for key in keys:
        state = _read_state(key)
        live = bool(state.get("liveTrading", True))
        try:
            clear_expired_entry_gate(key)
            if key == LEGACY_BOT_KEY:
                start_bot(user_id=LEGACY_BOT_KEY, live_trading=live)
            else:
                db = SessionLocal()
                try:
                    creds = load_credentials(db, key)
                finally:
                    db.close()
                if not creds:
                    logger.warning("Skip restore bot user=%s — no credentials in vault", key)
                    _write_state(key, {**state, "shouldRun": False, "stoppedAt": _now_iso()})
                    continue
                api_key, api_secret, use_testnet = creds
                start_bot(
                    user_id=key,
                    live_trading=live,
                    api_key=api_key,
                    api_secret=api_secret,
                    use_testnet=use_testnet,
                )
            logger.info("Restored server bot user=%s", key)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not restore server bot user=%s: %s", key, exc)
