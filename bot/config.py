"""Configuration for Binance USDT-M Futures auto-trading bot."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


def app_root() -> Path:
    """Project root in dev; folder containing the exe when frozen."""
    import sys

    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


ROOT = app_root()
load_dotenv(ROOT / ".env")


def _optional_float(key: str) -> float | None:
    value = os.getenv(key, "").strip()
    if not value or value.lower() in ("none", "null", "-"):
        return None
    return float(value)


@dataclass(frozen=True)
class BotConfig:
    api_key: str
    api_secret: str
    use_testnet: bool
    symbol: str
    interval: str
    leverage: int
    margin_type: str
    risk_per_trade_pct: float
    max_account_loss_pct: float
    allow_short: bool
    rsi_period: int
    rsi_oversold: float
    rsi_overbought: float
    use_rsi_entry_filter: bool
    rsi_long_min: float | None
    rsi_short_max: float | None
    ema_fast: int
    ema_slow: int
    use_macd: bool
    macd_fast: int
    macd_slow: int
    macd_signal: int
    use_macd_line_filter: bool
    macd_long_min: float | None
    macd_short_max: float | None
    use_swing_levels: bool
    swing_pivot_bars: int
    swing_lookback: int
    swing_near_pct: float
    swing_mode: str
    use_swing_stop_loss: bool
    swing_stop_buffer_pct: float
    stop_loss_pct: float
    take_profit_pct: float
    poll_seconds: int
    dry_run: bool

    @classmethod
    def from_env(cls) -> BotConfig:
        use_testnet = os.getenv("BINANCE_TESTNET", "true").lower() in ("1", "true", "yes")
        dry_run = os.getenv("DRY_RUN", "false").lower() in ("1", "true", "yes")

        api_key = os.getenv("BINANCE_API_KEY", "").strip()
        api_secret = os.getenv("BINANCE_API_SECRET", "").strip()

        if not dry_run and (not api_key or not api_secret):
            raise ValueError(
                "BINANCE_API_KEY and BINANCE_API_SECRET are required. "
                "Copy .env.example to .env and fill in your keys, or set DRY_RUN=true."
            )

        margin_type = os.getenv("MARGIN_TYPE", "ISOLATED").upper()
        if margin_type not in ("ISOLATED", "CROSSED"):
            raise ValueError("MARGIN_TYPE must be ISOLATED or CROSSED")

        leverage = int(os.getenv("LEVERAGE", "5"))
        if not 1 <= leverage <= 125:
            raise ValueError("LEVERAGE must be between 1 and 125")

        return cls(
            api_key=api_key,
            api_secret=api_secret,
            use_testnet=use_testnet,
            symbol=os.getenv("SYMBOL", "BTCUSDT").upper(),
            interval=os.getenv("INTERVAL", "1h"),
            leverage=leverage,
            margin_type=margin_type,
            risk_per_trade_pct=float(os.getenv("RISK_PER_TRADE_PCT", "1.0")),
            max_account_loss_pct=float(os.getenv("MAX_ACCOUNT_LOSS_PCT", "5.0")),
            allow_short=os.getenv("ALLOW_SHORT", "true").lower() in ("1", "true", "yes"),
            rsi_period=int(os.getenv("RSI_PERIOD", "14")),
            rsi_oversold=float(os.getenv("RSI_OVERSOLD", "25")),
            rsi_overbought=float(os.getenv("RSI_OVERBOUGHT", "70")),
            use_rsi_entry_filter=os.getenv("USE_RSI_ENTRY_FILTER", "false").lower() in ("1", "true", "yes"),
            rsi_long_min=_optional_float("RSI_LONG_MIN"),
            rsi_short_max=_optional_float("RSI_SHORT_MAX"),
            ema_fast=int(os.getenv("EMA_FAST", "12")),
            ema_slow=int(os.getenv("EMA_SLOW", "26")),
            use_macd=os.getenv("USE_MACD", "true").lower() in ("1", "true", "yes"),
            macd_fast=int(os.getenv("MACD_FAST", "12")),
            macd_slow=int(os.getenv("MACD_SLOW", "26")),
            macd_signal=int(os.getenv("MACD_SIGNAL", "9")),
            use_macd_line_filter=os.getenv("USE_MACD_LINE_FILTER", "false").lower() in ("1", "true", "yes"),
            macd_long_min=_optional_float("MACD_LONG_MIN"),
            macd_short_max=_optional_float("MACD_SHORT_MAX"),
            use_swing_levels=os.getenv("USE_SWING_LEVELS", "false").lower() in ("1", "true", "yes"),
            swing_pivot_bars=int(os.getenv("SWING_PIVOT_BARS", "5")),
            swing_lookback=int(os.getenv("SWING_LOOKBACK", "50")),
            swing_near_pct=float(os.getenv("SWING_NEAR_PCT", "0.5")),
            swing_mode=os.getenv("SWING_MODE", "bounce").lower(),
            use_swing_stop_loss=os.getenv("USE_SWING_STOP_LOSS", "false").lower() in ("1", "true", "yes"),
            swing_stop_buffer_pct=float(os.getenv("SWING_STOP_BUFFER_PCT", "0.2")),
            stop_loss_pct=float(os.getenv("STOP_LOSS_PCT", "1.5")),
            take_profit_pct=float(os.getenv("TAKE_PROFIT_PCT", "3.0")),
            poll_seconds=int(os.getenv("POLL_SECONDS", "60")),
            dry_run=dry_run,
        )

    @property
    def base_url(self) -> str:
        if self.use_testnet:
            return "https://testnet.binancefuture.com"
        return "https://fapi.binance.com"

    @classmethod
    def from_credentials(
        cls,
        api_key: str,
        api_secret: str,
        *,
        use_testnet: bool = True,
        symbol: str = "BTCUSDT",
        leverage: int = 5,
        margin_type: str = "ISOLATED",
    ) -> BotConfig:
        return cls(
            api_key=api_key.strip(),
            api_secret=api_secret.strip(),
            use_testnet=use_testnet,
            symbol=symbol.upper(),
            interval="1h",
            leverage=leverage,
            margin_type=margin_type.upper(),
            risk_per_trade_pct=1.0,
            max_account_loss_pct=5.0,
            allow_short=True,
            rsi_period=14,
            rsi_oversold=25,
            rsi_overbought=70,
            use_rsi_entry_filter=False,
            rsi_long_min=None,
            rsi_short_max=None,
            ema_fast=12,
            ema_slow=26,
            use_macd=True,
            macd_fast=12,
            macd_slow=26,
            macd_signal=9,
            use_macd_line_filter=False,
            macd_long_min=None,
            macd_short_max=None,
            use_swing_levels=False,
            swing_pivot_bars=5,
            swing_lookback=50,
            swing_near_pct=0.5,
            swing_mode="bounce",
            use_swing_stop_loss=False,
            swing_stop_buffer_pct=0.2,
            stop_loss_pct=1.5,
            take_profit_pct=3.0,
            poll_seconds=60,
            dry_run=False,
        )

    def with_trading_params(
        self,
        *,
        leverage: int | None = None,
        margin_type: str | None = None,
        symbol: str | None = None,
    ) -> BotConfig:
        return BotConfig(
            api_key=self.api_key,
            api_secret=self.api_secret,
            use_testnet=self.use_testnet,
            symbol=(symbol or self.symbol).upper(),
            interval=self.interval,
            leverage=leverage if leverage is not None else self.leverage,
            margin_type=(margin_type or self.margin_type).upper(),
            risk_per_trade_pct=self.risk_per_trade_pct,
            max_account_loss_pct=self.max_account_loss_pct,
            allow_short=self.allow_short,
            rsi_period=self.rsi_period,
            rsi_oversold=self.rsi_oversold,
            rsi_overbought=self.rsi_overbought,
            use_rsi_entry_filter=self.use_rsi_entry_filter,
            rsi_long_min=self.rsi_long_min,
            rsi_short_max=self.rsi_short_max,
            ema_fast=self.ema_fast,
            ema_slow=self.ema_slow,
            use_macd=self.use_macd,
            macd_fast=self.macd_fast,
            macd_slow=self.macd_slow,
            macd_signal=self.macd_signal,
            use_macd_line_filter=self.use_macd_line_filter,
            macd_long_min=self.macd_long_min,
            macd_short_max=self.macd_short_max,
            use_swing_levels=self.use_swing_levels,
            swing_pivot_bars=self.swing_pivot_bars,
            swing_lookback=self.swing_lookback,
            swing_near_pct=self.swing_near_pct,
            swing_mode=self.swing_mode,
            use_swing_stop_loss=self.use_swing_stop_loss,
            swing_stop_buffer_pct=self.swing_stop_buffer_pct,
            stop_loss_pct=self.stop_loss_pct,
            take_profit_pct=self.take_profit_pct,
            poll_seconds=self.poll_seconds,
            dry_run=self.dry_run,
        )
