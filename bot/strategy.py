"""RSI overbought / oversold strategy."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from bot.config import BotConfig
from bot.indicators import rsi


class Signal(str, Enum):
    LONG = "LONG"
    SHORT = "SHORT"
    CLOSE = "CLOSE"
    HOLD = "HOLD"


class PositionSide(str, Enum):
    LONG = "LONG"
    SHORT = "SHORT"


@dataclass
class MarketSnapshot:
    price: float
    rsi: float


@dataclass
class EntryLevels:
    stop_price: float
    take_profit_price: float
    stop_loss_pct: float
    take_profit_pct: float
    side: str


@dataclass
class StrategyResult:
    signal: Signal
    reason: str
    snapshot: MarketSnapshot | None = None
    entry_levels: EntryLevels | None = None
    exit_price: float | None = None


class RsiOverboughtOversoldStrategy:
    """Long on RSI oversold, short on RSI overbought, fixed % SL/TP."""

    def __init__(self, config: BotConfig) -> None:
        self.config = config

    def _min_bars(self) -> int:
        return self.config.rsi_period + 2

    def _calc_levels(self, side: PositionSide, entry: float) -> EntryLevels:
        sl = self.config.stop_loss_pct
        tp = self.config.take_profit_pct
        if side == PositionSide.LONG:
            return EntryLevels(
                stop_price=round(entry * (1 - sl / 100), 2),
                take_profit_price=round(entry * (1 + tp / 100), 2),
                stop_loss_pct=sl,
                take_profit_pct=tp,
                side=side.value,
            )
        return EntryLevels(
            stop_price=round(entry * (1 + sl / 100), 2),
            take_profit_price=round(entry * (1 - tp / 100), 2),
            stop_loss_pct=sl,
            take_profit_pct=tp,
            side=side.value,
        )

    def analyze(self, klines: list[list], current_side: PositionSide | None = None) -> StrategyResult:
        closes = [float(k[4]) for k in klines]
        if len(closes) < self._min_bars():
            return StrategyResult(Signal.HOLD, "Not enough candle data")

        rsi_series = rsi(closes, self.config.rsi_period)
        price = closes[-1]
        current_rsi = rsi_series[-1]
        oversold = self.config.rsi_oversold
        overbought = self.config.rsi_overbought

        snapshot = MarketSnapshot(price=price, rsi=current_rsi)
        sl = self.config.stop_loss_pct
        tp = self.config.take_profit_pct

        if current_side == PositionSide.LONG:
            return StrategyResult(Signal.HOLD, f"Long open — SL -{sl:g}% / TP +{tp:g}%", snapshot)

        if current_side == PositionSide.SHORT:
            return StrategyResult(Signal.HOLD, f"Short open — SL -{sl:g}% / TP +{tp:g}%", snapshot)

        if current_rsi is None:
            return StrategyResult(Signal.HOLD, "RSI not ready", snapshot)

        if current_rsi <= oversold:
            levels = self._calc_levels(PositionSide.LONG, price)
            return StrategyResult(
                Signal.LONG,
                (
                    f"Long — RSI {current_rsi:.1f} <= {oversold:g} (oversold) "
                    f"SL -{sl:g}% ${levels.stop_price:.0f} TP +{tp:g}% ${levels.take_profit_price:.0f}"
                ),
                snapshot,
                levels,
            )

        if self.config.allow_short and current_rsi >= overbought:
            levels = self._calc_levels(PositionSide.SHORT, price)
            return StrategyResult(
                Signal.SHORT,
                (
                    f"Short — RSI {current_rsi:.1f} >= {overbought:g} (overbought) "
                    f"SL -{sl:g}% ${levels.stop_price:.0f} TP +{tp:g}% ${levels.take_profit_price:.0f}"
                ),
                snapshot,
                levels,
            )

        return StrategyResult(
            Signal.HOLD,
            f"RSI {current_rsi:.1f} — waiting oversold (<={oversold:g}) / overbought (>={overbought:g})",
            snapshot,
        )

    def check_exit(
        self,
        side: PositionSide,
        entry_price: float,
        current_price: float,
        stop_price: float | None = None,
        take_profit_price: float | None = None,
    ) -> StrategyResult | None:
        sl = self.config.stop_loss_pct
        tp = self.config.take_profit_pct

        if side == PositionSide.LONG:
            stop = stop_price if stop_price is not None else entry_price * (1 - sl / 100)
            target = take_profit_price if take_profit_price is not None else entry_price * (1 + tp / 100)
            if current_price <= stop:
                return StrategyResult(Signal.CLOSE, f"Stop loss -{sl:g}% @ ${stop:.2f}")
            if current_price >= target:
                return StrategyResult(Signal.CLOSE, f"Take profit +{tp:g}% @ ${target:.2f}")
            return None

        if side == PositionSide.SHORT:
            stop = stop_price if stop_price is not None else entry_price * (1 + sl / 100)
            target = take_profit_price if take_profit_price is not None else entry_price * (1 - tp / 100)
            if current_price >= stop:
                return StrategyResult(Signal.CLOSE, f"Stop loss -{sl:g}% @ ${stop:.2f}")
            if current_price <= target:
                return StrategyResult(Signal.CLOSE, f"Take profit +{tp:g}% @ ${target:.2f}")

        return None

    def check_exit_bar(
        self,
        side: PositionSide,
        entry_price: float,
        high: float,
        low: float,
        stop_price: float | None = None,
        take_profit_price: float | None = None,
    ) -> StrategyResult | None:
        """Intrabar exit check using the candle's high/low (wick) rather than the
        close, so a fast touch of the stop/take-profit between polls is caught and
        the trade exits at the actual SL/TP level. If a single bar spans both
        levels we assume the stop is hit first (conservative)."""
        sl = self.config.stop_loss_pct
        tp = self.config.take_profit_pct

        if side == PositionSide.LONG:
            stop = stop_price if stop_price is not None else entry_price * (1 - sl / 100)
            target = take_profit_price if take_profit_price is not None else entry_price * (1 + tp / 100)
            if low <= stop:
                return StrategyResult(Signal.CLOSE, f"Stop loss -{sl:g}% @ ${stop:.2f}", exit_price=stop)
            if high >= target:
                return StrategyResult(Signal.CLOSE, f"Take profit +{tp:g}% @ ${target:.2f}", exit_price=target)
            return None

        if side == PositionSide.SHORT:
            stop = stop_price if stop_price is not None else entry_price * (1 + sl / 100)
            target = take_profit_price if take_profit_price is not None else entry_price * (1 - tp / 100)
            if high >= stop:
                return StrategyResult(Signal.CLOSE, f"Stop loss -{sl:g}% @ ${stop:.2f}", exit_price=stop)
            if low <= target:
                return StrategyResult(Signal.CLOSE, f"Take profit +{tp:g}% @ ${target:.2f}", exit_price=target)
            return None

        return None


MacdPullbackLongStrategy = RsiOverboughtOversoldStrategy
MacdCombinedStrategy = RsiOverboughtOversoldStrategy
MacdSignalCrossStrategy = RsiOverboughtOversoldStrategy
EmaRsiMacdStrategy = RsiOverboughtOversoldStrategy
EmaRsiStrategy = RsiOverboughtOversoldStrategy
