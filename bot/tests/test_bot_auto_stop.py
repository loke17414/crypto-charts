# -*- coding: utf-8 -*-
"""Verify server-bot auto-stop persists shouldRun=false and skips restore."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from bot import server_bot  # noqa: E402


def test_bot_status_heals_should_run_when_auto_stopped(tmp_path, monkeypatch) -> None:
    home = tmp_path / "bots" / "7"
    home.mkdir(parents=True)
    state_path = home / "web-bot-state.json"
    state_path.write_text(
        json.dumps({
            "shouldRun": True,
            "autoStopped": True,
            "stopReason": "자동 정지 — 1회 청산 완료",
            "pid": 99999,
        }),
        encoding="utf-8",
    )

    monkeypatch.setattr(server_bot, "bot_home", lambda user_id: home)
    monkeypatch.setattr(server_bot, "state_file", lambda user_id: state_path)
    monkeypatch.setattr(server_bot, "tail_bot_logs", lambda n=20, user_id=None: [])
    monkeypatch.setattr(server_bot, "_entry_gate_status", lambda user_id=None: None)
    monkeypatch.setattr(server_bot, "is_running", lambda user_id=None: False)

    st = server_bot.bot_status(7)
    assert st["running"] is False
    assert st["autoStopped"] is True
    assert st["stopReason"] == "자동 정지 — 1회 청산 완료"
    assert st["message"] == "자동 정지 — 1회 청산 완료"
    assert st["persisted"] is False

    saved = json.loads(state_path.read_text(encoding="utf-8"))
    assert saved["shouldRun"] is False


def test_restore_skips_auto_stopped(tmp_path, monkeypatch) -> None:
    home = tmp_path / "bots" / "9"
    home.mkdir(parents=True)
    state_path = home / "web-bot-state.json"
    state_path.write_text(
        json.dumps({
            "shouldRun": True,
            "autoStopped": True,
            "stopReason": "자동 정지 — 5분 경과",
            "liveTrading": True,
        }),
        encoding="utf-8",
    )

    monkeypatch.setattr(server_bot, "DATA_DIR", tmp_path)
    monkeypatch.setattr(server_bot, "_persisted_bot_keys", lambda: [9])
    monkeypatch.setattr(server_bot, "bot_home", lambda user_id: home)
    monkeypatch.setattr(server_bot, "state_file", lambda user_id: state_path)

    started = []

    def fake_start(**kwargs):
        started.append(kwargs)
        return {"ok": True}

    monkeypatch.setattr(server_bot, "start_bot", fake_start)
    server_bot.restore_bot_if_needed()
    assert started == []
    saved = json.loads(state_path.read_text(encoding="utf-8"))
    assert saved["shouldRun"] is False


def test_bot_js_request_stop_writes_state_and_exits(tmp_path) -> None:
    """Simulate the Node requestStop persistence contract without spawning Node."""
    # Contract mirrored from bot-js/bot.js requestStop():
    state_path = tmp_path / "web-bot-state.json"
    state_path.write_text(json.dumps({"shouldRun": True, "pid": 1}), encoding="utf-8")
    prev = json.loads(state_path.read_text(encoding="utf-8"))
    next_state = {
        **prev,
        "shouldRun": False,
        "autoStopped": True,
        "stopReason": "자동 정지 — 2회 청산 완료",
        "closedTrades": 2,
        "botStopMode": "trades",
        "botStopValue": 2,
    }
    state_path.write_text(json.dumps(next_state, indent=2), encoding="utf-8")
    saved = json.loads(state_path.read_text(encoding="utf-8"))
    assert saved["shouldRun"] is False
    assert saved["autoStopped"] is True
    assert "자동 정지" in saved["stopReason"]

    src = (ROOT / "bot-js" / "bot.js").read_text(encoding="utf-8")
    assert "function requestStop(reason)" in src
    assert "shouldRun: false" in src
    assert "process.exit(0)" in src
    assert "Skip restore" not in src  # Python-side
    assert "autoStopped: true" in src
