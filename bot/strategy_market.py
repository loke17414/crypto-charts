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


def _round(v: float | None, d: int = 2) -> float | None:
    if v is None:
        return None
    return round(v, d)


def _format_recent_candles(
    klines: list[list[Any]],
    count: int = 15,
) -> list[dict[str, Any]]:
    if not klines:
        return []
    slice_k = klines[-count:]
    start = len(klines) - len(slice_k)
    out: list[dict[str, Any]] = []
    for i, k in enumerate(slice_k):
        o, h, l, c = float(k[1]), float(k[2]), float(k[3]), float(k[4])
        vol = float(k[5])
        body = c - o
        rng = h - l
        body_pct = (body / rng * 100) if rng > 0 else 0.0
        out.append({
            "idx": start + i,
            "offset": i - len(slice_k) + 1,
            "time": int(k[0]) // 1000,
            "o": _round(o),
            "h": _round(h),
            "l": _round(l),
            "c": _round(c),
            "v": _round(vol, 0),
            "dir": "up" if c >= o else "down",
            "bodyPct": _round(body_pct, 1),
        })
    return out


def _is_fvg_filled(zone: dict[str, Any], highs: list[float], lows: list[float], from_idx: int) -> bool:
    for j in range(from_idx + 1, len(highs)):
        if zone["side"] == "bullish" and lows[j] <= zone["bottom"]:
            return True
        if zone["side"] == "bearish" and highs[j] >= zone["top"]:
            return True
    return False


def _detect_fvg_zones(
    highs: list[float],
    lows: list[float],
    lookback: int = 30,
) -> list[dict[str, Any]]:
    if len(highs) < 3:
        return []
    start = max(2, len(highs) - lookback)
    zones: list[dict[str, Any]] = []
    for i in range(start, len(highs)):
        h0, l0 = highs[i - 2], lows[i - 2]
        h2, l2 = highs[i], lows[i]
        if h0 < l2:
            zones.append({
                "side": "bullish",
                "top": l2,
                "bottom": h0,
                "mid": (l2 + h0) / 2,
                "formedAt": i,
                "size": l2 - h0,
            })
        if l0 > h2:
            zones.append({
                "side": "bearish",
                "top": l0,
                "bottom": h2,
                "mid": (l0 + h2) / 2,
                "formedAt": i,
                "size": l0 - h2,
            })
    for z in zones:
        z["top"] = _round(z["top"])
        z["bottom"] = _round(z["bottom"])
        z["mid"] = _round(z["mid"])
        z["size"] = _round(z["size"])
        z["filled"] = _is_fvg_filled(z, highs, lows, z["formedAt"])
    return zones


def _find_pivots(values: list[float | None], kind: str, left: int = 2, right: int = 2) -> list[dict[str, Any]]:
    pivots: list[dict[str, Any]] = []
    for i in range(left, len(values) - right):
        v = values[i]
        if v is None:
            continue
        ok = True
        for j in range(i - left, i + right + 1):
            if j == i:
                continue
            other = values[j]
            if other is None:
                ok = False
                break
            if kind == "low" and other <= v:
                ok = False
                break
            if kind == "high" and other >= v:
                ok = False
                break
        if ok:
            pivots.append({"index": i, "value": v})
    return pivots


def _detect_divergence(
    closes: list[float],
    rsi_vals: list[float | None],
    *,
    lookback: int = 40,
    pivot_bars: int = 2,
) -> dict[str, Any]:
    empty: dict[str, Any] = {
        "indicator": "rsi",
        "bullish": False,
        "bearish": False,
        "detail": None,
    }
    if len(closes) < lookback:
        return empty

    start = max(0, len(closes) - lookback)
    c_slice = closes[start:]
    r_slice = rsi_vals[start:]

    price_lows = _find_pivots(c_slice, "low", pivot_bars, pivot_bars)
    price_highs = _find_pivots(c_slice, "high", pivot_bars, pivot_bars)
    ind_lows = _find_pivots(r_slice, "low", pivot_bars, pivot_bars)
    ind_highs = _find_pivots(r_slice, "high", pivot_bars, pivot_bars)

    bullish = False
    bearish = False
    detail = None

    if len(price_lows) >= 2 and len(ind_lows) >= 2:
        p1, p2 = price_lows[-2], price_lows[-1]
        i1, i2 = ind_lows[-2], ind_lows[-1]
        if p2["value"] < p1["value"] and i2["value"] > i1["value"]:
            bullish = True
            detail = "RSI bullish divergence: price lower low, RSI higher low"

    if len(price_highs) >= 2 and len(ind_highs) >= 2:
        p1, p2 = price_highs[-2], price_highs[-1]
        i1, i2 = ind_highs[-2], ind_highs[-1]
        if p2["value"] > p1["value"] and i2["value"] < i1["value"]:
            bearish = True
            detail = "RSI bearish divergence: price higher high, RSI lower high"

    return {"indicator": "rsi", "bullish": bullish, "bearish": bearish, "detail": detail}


def _build_structure(
    klines: list[list[Any]],
    closes: list[float],
    highs: list[float],
    lows: list[float],
    rsi_vals: list[float | None],
    price: float,
) -> dict[str, Any]:
    fvgs = _detect_fvg_zones(highs, lows, 30)
    open_fvgs = [z for z in fvgs if not z["filled"]]
    price_in_zones = [
        z for z in open_fvgs
        if z["bottom"] is not None and z["top"] is not None and z["bottom"] <= price <= z["top"]
    ]
    rsi_div = _detect_divergence(closes, rsi_vals)
    return {
        "fvg": {
            "open": open_fvgs[-5:],
            "priceInZones": price_in_zones,
            "lastBullish": next((z for z in reversed(open_fvgs) if z["side"] == "bullish"), None),
            "lastBearish": next((z for z in reversed(open_fvgs) if z["side"] == "bearish"), None),
        },
        "divergence": {
            "rsi": {
                "bullish": rsi_div["bullish"],
                "bearish": rsi_div["bearish"],
                "detail": rsi_div["detail"],
            },
        },
    }


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

    if not ctx.get("recentCandles15"):
        ctx["recentCandles15"] = _format_recent_candles(klines, 15)
    if not ctx.get("structure"):
        ctx["structure"] = _build_structure(klines, closes, highs, lows, rsi_vals, price)

    return ctx
