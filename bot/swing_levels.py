"""Swing high / low (pivot) level detection."""

from __future__ import annotations


def is_pivot_high(highs: list[float], index: int, pivot_bars: int) -> bool:
    if index < pivot_bars or index >= len(highs) - pivot_bars:
        return False
    level = highs[index]
    for j in range(index - pivot_bars, index + pivot_bars + 1):
        if j != index and highs[j] >= level:
            return False
    return True


def is_pivot_low(lows: list[float], index: int, pivot_bars: int) -> bool:
    if index < pivot_bars or index >= len(lows) - pivot_bars:
        return False
    level = lows[index]
    for j in range(index - pivot_bars, index + pivot_bars + 1):
        if j != index and lows[j] <= level:
            return False
    return True


def recent_swing_levels(
    highs: list[float],
    lows: list[float],
    end_index: int,
    *,
    pivot_bars: int,
    lookback: int,
) -> tuple[float | None, float | None]:
    """Most recent confirmed swing high and low before end_index."""
    start = max(pivot_bars, end_index - lookback)
    search_end = end_index - pivot_bars
    if search_end < start:
        return None, None

    swing_high: float | None = None
    swing_low: float | None = None

    for i in range(search_end, start - 1, -1):
        if swing_high is None and is_pivot_high(highs, i, pivot_bars):
            swing_high = highs[i]
        if swing_low is None and is_pivot_low(lows, i, pivot_bars):
            swing_low = lows[i]
        if swing_high is not None and swing_low is not None:
            break

    return swing_high, swing_low


def near_level(price: float, level: float | None, tolerance_pct: float) -> bool:
    if level is None or level <= 0:
        return False
    return abs(price - level) / level * 100 <= tolerance_pct


def above_level(price: float, level: float | None) -> bool:
    return level is not None and price > level


def below_level(price: float, level: float | None) -> bool:
    return level is not None and price < level


def calc_swing_stop_price(
    side: str,
    swing_high: float | None,
    swing_low: float | None,
    buffer_pct: float,
) -> float | None:
    """Long stop below swing low; short stop above swing high."""
    if side.upper() == "LONG" and swing_low is not None:
        return round(swing_low * (1 - buffer_pct / 100), 2)
    if side.upper() == "SHORT" and swing_high is not None:
        return round(swing_high * (1 + buffer_pct / 100), 2)
    return None


def calc_stop_from_klines(
    klines: list[list],
    side: str,
    *,
    pivot_bars: int,
    lookback: int,
    buffer_pct: float,
) -> float | None:
    highs = [float(k[2]) for k in klines]
    lows = [float(k[3]) for k in klines]
    end_index = len(klines) - 1
    swing_high, swing_low = recent_swing_levels(
        highs, lows, end_index, pivot_bars=pivot_bars, lookback=lookback,
    )
    return calc_swing_stop_price(side, swing_high, swing_low, buffer_pct)
