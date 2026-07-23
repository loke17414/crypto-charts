# -*- coding: utf-8 -*-
"""Verify market/algo orders attach positionSide only in hedge mode."""
from __future__ import annotations

import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from bot.exchange import BinanceFuturesClient  # noqa: E402


def _client() -> BinanceFuturesClient:
    cfg = MagicMock()
    cfg.api_key = "k"
    cfg.api_secret = "s"
    cfg.symbol = "BTCUSDT"
    cfg.base_url = "https://testnet.binancefuture.com"
    cfg.dry_run = False
    cfg.margin_type = "ISOLATED"
    cfg.leverage = 5
    c = BinanceFuturesClient(cfg)
    c._filters = {
        "step_size": 0.001,
        "min_qty": 0.001,
        "min_notional": 5.0,
        "tick_size": 0.1,
        "min_price": 0.1,
        "max_price": 1_000_000.0,
    }
    return c


def test_hedge_market_order_includes_position_side() -> None:
    c = _client()
    c._hedge_mode = True
    seen: dict[str, Any] = {}

    def fake_request(method, path, params=None, signed=False):
        seen["path"] = path
        seen["params"] = dict(params or {})
        return {"orderId": 1}

    c._request = fake_request  # type: ignore[method-assign]
    c.open_long(0.01)
    assert seen["path"] == "/fapi/v1/order"
    assert seen["params"]["side"] == "BUY"
    assert seen["params"]["positionSide"] == "LONG"
    assert "reduceOnly" not in seen["params"]

    c.open_short(0.01)
    assert seen["params"]["side"] == "SELL"
    assert seen["params"]["positionSide"] == "SHORT"

    c.close_long(0.01)
    assert seen["params"]["side"] == "SELL"
    assert seen["params"]["positionSide"] == "LONG"
    assert "reduceOnly" not in seen["params"]


def test_oneway_market_order_omits_position_side() -> None:
    c = _client()
    c._hedge_mode = False
    seen: dict[str, Any] = {}

    def fake_request(method, path, params=None, signed=False):
        seen["params"] = dict(params or {})
        return {"orderId": 1}

    c._request = fake_request  # type: ignore[method-assign]
    c.open_long(0.01)
    assert "positionSide" not in seen["params"]
    assert "reduceOnly" not in seen["params"]

    c.close_short(0.01)
    assert "positionSide" not in seen["params"]
    assert seen["params"]["reduceOnly"] == "true"


def test_hedge_conditional_includes_position_side() -> None:
    c = _client()
    c._hedge_mode = True
    seen: dict[str, Any] = {}

    def fake_request(method, path, params=None, signed=False):
        seen["path"] = path
        seen["params"] = dict(params or {})
        return {"algoId": 1}

    c._request = fake_request  # type: ignore[method-assign]
    c.place_stop_market("LONG", 60000.0)
    assert seen["path"] == "/fapi/v1/algoOrder"
    assert seen["params"]["positionSide"] == "LONG"
    assert seen["params"]["side"] == "SELL"


def test_get_hedge_mode_parses_dual_flag() -> None:
    c = _client()
    c._request = MagicMock(return_value={"dualSidePosition": True})  # type: ignore[method-assign]
    assert c.get_hedge_mode() is True
    c._hedge_mode = None
    c._request = MagicMock(return_value={"dualSidePosition": "false"})  # type: ignore[method-assign]
    assert c.get_hedge_mode() is False


def test_js_binance_open_long_sets_position_side_arg() -> None:
    """Smoke: JS openLong/openShort pass LONG/SHORT into marketOrder."""
    src = (ROOT / "bot-js" / "binance.js").read_text(encoding="utf-8")
    assert "openLong(qty) { return this.marketOrder('BUY', qty, false, 'LONG'); }" in src
    assert "openShort(qty) { return this.marketOrder('SELL', qty, false, 'SHORT'); }" in src
    assert "async getHedgeMode()" in src
    assert "params.positionSide" in src
