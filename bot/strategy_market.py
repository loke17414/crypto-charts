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


_INTERVAL_MINUTES = {
    "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30,
    "1h": 60, "2h": 120, "4h": 240, "6h": 360, "12h": 720,
    "1d": 1440, "1w": 10080,
}


def _timeframe_info(interval: str) -> dict[str, Any]:
    minutes = _INTERVAL_MINUTES.get(interval)
    if not minutes:
        return {"interval": interval}
    per_hour = 60 / minutes
    per_day = 1440 / minutes
    return {
        "interval": interval,
        "minutesPerCandle": minutes,
        "candlesPerHour": round(per_hour, 2) if per_hour >= 1 else None,
        "candlesPerDay": round(per_day, 2) if per_day >= 1 else None,
        "note": (
            f"Chart is on {interval} candles. 1 hour = {round(per_hour) if per_hour >= 1 else '<1'} candles, "
            f"1 day = {round(per_day) if per_day >= 1 else '<1'} candles. "
            f"'last X hours' = X*{round(per_hour) if per_hour >= 1 else 1} candles."
        ),
    }


def _wick_shape_hint(body_pct: float, upper_wick_pct: float, lower_wick_pct: float) -> str:
    if lower_wick_pct >= 60 and body_pct <= 25:
        return "long_lower_wick"
    if upper_wick_pct >= 60 and body_pct <= 25:
        return "long_upper_wick"
    if body_pct >= 70:
        return "full_body"
    if upper_wick_pct >= 40 and lower_wick_pct < 20:
        return "upper_rejection"
    if lower_wick_pct >= 40 and upper_wick_pct < 20:
        return "lower_rejection"
    return "balanced"


def _candle_patterns_at(klines: list[list[Any]], index: int) -> list[str]:
    if index < 0 or index >= len(klines):
        return []
    o, h, l, c = (float(klines[index][j]) for j in (1, 2, 3, 4))
    rng = max(h - l, 1e-12)
    body = abs(c - o)
    upper = h - max(o, c)
    lower = min(o, c) - l
    body_pct = body / rng
    upper_pct = upper / rng
    lower_pct = lower / rng
    out: list[str] = []
    if c > o:
        out.append("bullish")
    if c < o:
        out.append("bearish")
    if body_pct <= 0.1:
        out.append("doji")
    if lower_pct >= 0.6 and body_pct <= 0.25:
        out.append("pin_bar_bull")
    if upper_pct >= 0.6 and body_pct <= 0.25:
        out.append("pin_bar_bear")
    if lower >= body * 2 and upper <= body * 0.5:
        out.append("hammer")
    if upper >= body * 2 and lower <= body * 0.5:
        out.append("shooting_star")
    if index >= 1:
        po, ph, pl, pc = (float(klines[index - 1][j]) for j in (1, 2, 3, 4))
        pbody = abs(pc - po)
        if pc < po and c > o and o <= pc and c >= po and body > pbody:
            out.append("engulfing_bull")
        if pc > po and c < o and o >= pc and c <= po and body > pbody:
            out.append("engulfing_bear")
    return out


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
        idx = start + i
        o, h, l, c = float(k[1]), float(k[2]), float(k[3]), float(k[4])
        vol = float(k[5])
        rng = max(h - l, 0.0)
        body_abs = abs(c - o)
        upper_wick = h - max(o, c)
        lower_wick = min(o, c) - l
        body_pct = (body_abs / rng * 100) if rng > 0 else 0.0
        upper_wick_pct = (upper_wick / rng * 100) if rng > 0 else 0.0
        lower_wick_pct = (lower_wick / rng * 100) if rng > 0 else 0.0
        out.append({
            "idx": idx,
            "offset": i - len(slice_k) + 1,
            "time": int(k[0]) // 1000,
            "o": _round(o),
            "h": _round(h),
            "l": _round(l),
            "c": _round(c),
            "v": _round(vol, 0),
            "dir": "up" if c >= o else "down",
            # Fractions of (high-low). bodyPct + upperWickPct + lowerWickPct ≈ 100.
            "bodyPct": _round(body_pct, 1),
            "upperWickPct": _round(upper_wick_pct, 1),
            "lowerWickPct": _round(lower_wick_pct, 1),
            "shape": _wick_shape_hint(body_pct, upper_wick_pct, lower_wick_pct),
            "patterns": _candle_patterns_at(klines, idx),
        })
    return out


_BULL_REVERSAL = {"engulfing_bull", "hammer", "pin_bar_bull", "marubozu_bull"}
_BEAR_REVERSAL = {"engulfing_bear", "shooting_star", "pin_bar_bear", "marubozu_bear", "inverted_hammer"}


def _near_level(price: float | None, level: float | None, tol_pct: float = 0.6) -> bool:
    if price is None or level is None or not level:
        return False
    return abs(price - level) / level * 100 <= tol_pct


def _analyze_trend_reversal(
    klines: list[list[Any]],
    swings: dict[str, Any],
    recent: list[dict[str, Any]],
    *,
    prior_bias: str,
) -> dict[str, Any]:
    if len(klines) < 5:
        return {
            "priorBias": prior_bias,
            "phase": "unclear",
            "signals": [],
            "latest": None,
            "note": "Need prior bias + against-trend candle or CHOCH for trend reversal.",
        }

    last_high = swings.get("lastSwingHigh")
    last_low = swings.get("lastSwingLow")
    high_px = last_high["price"] if isinstance(last_high, dict) else None
    low_px = last_low["price"] if isinstance(last_low, dict) else None
    o1, h1, l1, c1 = (float(klines[-1][j]) for j in (1, 2, 3, 4))
    _o0, _h0, _l0, c0 = (float(klines[-2][j]) for j in (1, 2, 3, 4))
    signals: list[dict[str, Any]] = []

    if prior_bias == "bullish" and low_px is not None and c0 >= low_px and c1 < low_px:
        signals.append({
            "side": "bearish",
            "kind": "choch_below_swing_low",
            "strength": "strong",
            "offset": 0,
            "level": _round(low_px),
            "patterns": recent[-1].get("patterns", []) if recent else [],
            "reason": "상승 추세 중 전저점 종가 이탈 → 구조 전환(CHOCH)",
        })
    if prior_bias == "bearish" and high_px is not None and c0 <= high_px and c1 > high_px:
        signals.append({
            "side": "bullish",
            "kind": "choch_above_swing_high",
            "strength": "strong",
            "offset": 0,
            "level": _round(high_px),
            "patterns": recent[-1].get("patterns", []) if recent else [],
            "reason": "하락 추세 중 전고점 종가 돌파 → 구조 전환(CHOCH)",
        })

    for bar in recent[-5:]:
        pats = set(bar.get("patterns") or [])
        shape = bar.get("shape")
        bull_pat = bool(pats & _BULL_REVERSAL) or shape in {"long_lower_wick", "lower_rejection"}
        bear_pat = bool(pats & _BEAR_REVERSAL) or shape in {"long_upper_wick", "upper_rejection"}
        at_low = _near_level(bar.get("l"), low_px) or _near_level(bar.get("c"), low_px)
        at_high = _near_level(bar.get("h"), high_px) or _near_level(bar.get("c"), high_px)
        if prior_bias == "bearish" and bull_pat:
            signals.append({
                "side": "bullish",
                "kind": "reversal_candle_at_swing_low" if at_low else "reversal_candle_against_downtrend",
                "strength": "medium" if at_low else "weak",
                "offset": bar.get("offset"),
                "patterns": list(pats),
                "shape": shape,
                "reason": (
                    "하락 추세 + 전저점 근처 상승 전환 캔들"
                    if at_low else "하락 추세에 역행하는 상승 전환 캔들"
                ),
            })
        if prior_bias == "bullish" and bear_pat:
            signals.append({
                "side": "bearish",
                "kind": "reversal_candle_at_swing_high" if at_high else "reversal_candle_against_uptrend",
                "strength": "medium" if at_high else "weak",
                "offset": bar.get("offset"),
                "patterns": list(pats),
                "shape": shape,
                "reason": (
                    "상승 추세 + 전고점 근처 하락 전환 캔들"
                    if at_high else "상승 추세에 역행하는 하락 전환 캔들"
                ),
            })

    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for s in signals:
        key = f"{s['side']}|{s['kind']}|{s.get('offset')}"
        if key in seen:
            continue
        seen.add(key)
        unique.append(s)

    has_strong = any(s.get("strength") == "strong" for s in unique)
    has_medium = any(s.get("strength") == "medium" for s in unique)
    if prior_bias == "sideways" and not unique:
        phase = "unclear"
    elif has_strong:
        phase = "structure_break"
    elif has_medium:
        phase = "potential_reversal"
    elif unique:
        phase = "early_warning"
    else:
        phase = "continuation"

    latest = recent[-1] if recent else None
    latest_pats = list(latest.get("patterns") or []) if latest else []
    against = False
    if prior_bias == "bullish":
        against = bool(set(latest_pats) & _BEAR_REVERSAL) or (latest or {}).get("shape") == "long_upper_wick"
    elif prior_bias == "bearish":
        against = bool(set(latest_pats) & _BULL_REVERSAL) or (latest or {}).get("shape") == "long_lower_wick"

    return {
        "priorBias": prior_bias,
        "phase": phase,
        "signals": unique[:6],
        "latest": {
            "offset": 0,
            "dir": latest.get("dir") if latest else None,
            "shape": latest.get("shape") if latest else None,
            "patterns": latest_pats,
            "againstTrend": against,
            "bodyPct": latest.get("bodyPct") if latest else None,
            "upperWickPct": latest.get("upperWickPct") if latest else None,
            "lowerWickPct": latest.get("lowerWickPct") if latest else None,
        } if latest else None,
        "swingContext": {
            "lastSwingHigh": last_high,
            "lastSwingLow": last_low,
            "nearSwingHigh": _near_level(h1, high_px) or _near_level(c1, high_px),
            "nearSwingLow": _near_level(l1, low_px) or _near_level(c1, low_px),
        },
        "note": (
            "phase: continuation|early_warning|potential_reversal|structure_break|unclear. "
            "추세전환 캔들 = priorBias 역행 engulfing/hammer/shooting/pin (스윙 고·저점 근처 이상적). "
            "CHOCH = 상승중 전저점 종가 이탈 또는 하락중 전고점 종가 돌파."
        ),
    }


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


def _detect_swings(
    highs: list[float],
    lows: list[float],
    *,
    pivot_bars: int = 5,
    lookback: int = 60,
    max_points: int = 4,
) -> dict[str, Any]:
    """Confirmed pivots only: pivot_bars candles on BOTH sides must be lower/higher."""
    n = len(highs)
    result: dict[str, Any] = {
        "pivotBars": pivot_bars,
        "recentHighs": [],
        "recentLows": [],
        "lastSwingHigh": None,
        "lastSwingLow": None,
    }
    if n < pivot_bars * 2 + 1:
        return result

    def is_pivot_high(i: int) -> bool:
        level = highs[i]
        return all(highs[j] < level for j in range(i - pivot_bars, i + pivot_bars + 1) if j != i)

    def is_pivot_low(i: int) -> bool:
        level = lows[i]
        return all(lows[j] > level for j in range(i - pivot_bars, i + pivot_bars + 1) if j != i)

    last_idx = n - 1
    search_end = last_idx - pivot_bars
    search_start = max(pivot_bars, last_idx - lookback)
    r_highs: list[dict[str, Any]] = []
    r_lows: list[dict[str, Any]] = []
    for i in range(search_end, search_start - 1, -1):
        if len(r_highs) < max_points and is_pivot_high(i):
            r_highs.append({"price": _round(highs[i]), "barsAgo": last_idx - i})
        if len(r_lows) < max_points and is_pivot_low(i):
            r_lows.append({"price": _round(lows[i]), "barsAgo": last_idx - i})
        if len(r_highs) >= max_points and len(r_lows) >= max_points:
            break

    result["recentHighs"] = r_highs
    result["recentLows"] = r_lows
    result["lastSwingHigh"] = r_highs[0] if r_highs else None
    result["lastSwingLow"] = r_lows[0] if r_lows else None
    return result


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
    swings = _detect_swings(highs, lows)
    last_high = swings.get("lastSwingHigh")
    last_low = swings.get("lastSwingLow")
    recent = _format_recent_candles(klines, 15)

    def _dist_pct(level: float | None) -> float | None:
        if level is None or not price:
            return None
        return round(((price - level) / level) * 100, 2)

    high_price = last_high["price"] if isinstance(last_high, dict) else None
    low_price = last_low["price"] if isinstance(last_low, dict) else None

    # Prior bias from confirmed swing structure (HH/HL vs LH/LL)
    prior_bias = "sideways"
    r_highs = swings.get("recentHighs") or []
    r_lows = swings.get("recentLows") or []
    if len(r_highs) >= 2 and len(r_lows) >= 2:
        hh = r_highs[0]["price"] > r_highs[1]["price"]
        hl = r_lows[0]["price"] > r_lows[1]["price"]
        lh = r_highs[0]["price"] < r_highs[1]["price"]
        ll = r_lows[0]["price"] < r_lows[1]["price"]
        if hh and hl:
            prior_bias = "bullish"
        elif lh and ll:
            prior_bias = "bearish"

    trend_reversal = _analyze_trend_reversal(
        klines, swings, recent, prior_bias=prior_bias,
    )

    return {
        "swings": {
            **swings,
            "note": (
                f"CONFIRMED swings only: needs {swings['pivotBars']} bars on BOTH sides. "
                "Never judge from one neighbor candle. Ignore recentHigh/recentLow range max/min."
            ),
            "priceVsLastHighPct": _dist_pct(high_price),
            "priceVsLastLowPct": _dist_pct(low_price),
            "relation": {
                "aboveLastHigh": (price > high_price) if high_price is not None else None,
                "belowLastLow": (price < low_price) if low_price is not None else None,
                "betweenSwings": (
                    high_price is not None
                    and low_price is not None
                    and low_price < price < high_price
                ),
            },
        },
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
        "trend": {
            "direction": prior_bias,
            "structure": (
                "uptrend" if prior_bias == "bullish"
                else "downtrend" if prior_bias == "bearish"
                else "range"
            ),
            "note": "Server-side swing structure bias (HH/HL). Prefer client structure.trend when present.",
        },
        "trendReversal": trend_reversal,
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
    elif isinstance(ctx.get("structure"), dict) and not ctx["structure"].get("trendReversal"):
        # Older clients may omit trendReversal — enrich from server klines.
        server_struct = _build_structure(klines, closes, highs, lows, rsi_vals, price)
        ctx["structure"]["trendReversal"] = server_struct.get("trendReversal")
        ctx["structure"].setdefault("trend", server_struct.get("trend"))
    if not ctx.get("timeframe"):
        ctx["timeframe"] = _timeframe_info(interval)

    return ctx
