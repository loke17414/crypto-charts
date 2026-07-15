"""Market context for GPT strategy editing — recent klines + indicator snapshot."""

from __future__ import annotations

import logging
from typing import Any

import requests

from bot.indicators import ema, rsi

logger = logging.getLogger(__name__)

FUTURES_MAIN = "https://fapi.binance.com"
FUTURES_TESTNET = "https://testnet.binancefuture.com"


def fetch_klines(
    symbol: str = "BTCUSDT",
    interval: str = "1h",
    limit: int = 200,
    *,
    use_testnet: bool = False,
) -> list[list[Any]]:
    base = FUTURES_TESTNET if use_testnet else FUTURES_MAIN
    try:
        res = requests.get(
            f"{base}/fapi/v1/klines",
            params={"symbol": symbol.upper(), "interval": interval, "limit": limit},
            timeout=15,
        )
        res.raise_for_status()
        data = res.json()
        return data if isinstance(data, list) else []
    except requests.RequestException as exc:
        logger.warning("Kline fetch failed: %s", exc)
        return []


def _atr_pct(highs: list[float], lows: list[float], closes: list[float], period: int = 14) -> float | None:
    if len(closes) < period + 2:
        return None
    trs: list[float] = []
    for i in range(1, len(closes)):
        tr = max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        )
        trs.append(tr)
    if len(trs) < period:
        return None
    atr = sum(trs[-period:]) / period
    price = closes[-1]
    if price <= 0:
        return None
    return (atr / price) * 100


def build_market_context(
    *,
    symbol: str = "BTCUSDT",
    interval: str = "1h",
    client_context: dict[str, Any] | None = None,
    use_testnet: bool = False,
) -> dict[str, Any]:
    """Merge client chart snapshot with server-fetched klines for GPT."""
    ctx: dict[str, Any] = {
        "symbol": symbol.upper(),
        "interval": interval,
        "source": "server",
    }
    if client_context and isinstance(client_context, dict):
        ctx.update({k: v for k, v in client_context.items() if v is not None})
        ctx["source"] = "client+server"

    klines = fetch_klines(symbol, interval, limit=200, use_testnet=use_testnet)
    if not klines:
        return ctx

    closes = [float(k[4]) for k in klines]
    highs = [float(k[2]) for k in klines]
    lows = [float(k[3]) for k in klines]
    volumes = [float(k[5]) for k in klines]

    price = closes[-1]
    rsi_vals = rsi(closes, 14)
    rsi_now = rsi_vals[-1]
    ema12 = ema(closes, 12)
    ema26 = ema(closes, 26)

    lookback = min(24, len(closes) - 1)
    change_pct = ((price - closes[-1 - lookback]) / closes[-1 - lookback]) * 100 if lookback > 0 else 0.0

    last_n = min(20, len(closes))
    up_bars = sum(1 for i in range(-last_n, 0) if closes[i] > closes[i - 1])
    down_bars = last_n - up_bars

    trend = "sideways"
    if ema12[-1] is not None and ema26[-1] is not None:
        if ema12[-1] > ema26[-1] and change_pct > 0.5:
            trend = "bullish"
        elif ema12[-1] < ema26[-1] and change_pct < -0.5:
            trend = "bearish"

    high_recent = max(highs[-lookback:]) if lookback else highs[-1]
    low_recent = min(lows[-lookback:]) if lookback else lows[-1]
    range_pct = ((high_recent - low_recent) / price) * 100 if price else 0

    ctx.update({
        "candleCount": len(klines),
        "price": round(price, 2),
        f"change{lookback}BarsPct": round(change_pct, 2),
        "recentTrend": trend,
        "rsi14": round(rsi_now, 1) if rsi_now is not None else None,
        "ema12": round(ema12[-1], 2) if ema12[-1] is not None else None,
        "ema26": round(ema26[-1], 2) if ema26[-1] is not None else None,
        "atrPct": round(_atr_pct(highs, lows, closes) or 0, 2) or None,
        "rangePct": round(range_pct, 2),
        "last20Bars": {"up": up_bars, "down": down_bars},
        "avgVolume": round(sum(volumes[-20:]) / min(20, len(volumes)), 2),
        "highRecent": round(high_recent, 2),
        "lowRecent": round(low_recent, 2),
    })
    return ctx
