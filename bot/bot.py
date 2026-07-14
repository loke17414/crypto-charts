"""Main Binance USDT-M Futures auto-trading bot."""

from __future__ import annotations

import json
import logging
import signal
import sys
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone

from bot.config import BotConfig, ROOT
from bot.exchange import BinanceFuturesClient
from bot.risk import calc_trade_margin, is_account_loss_limit_hit
from bot.swing_levels import calc_stop_from_klines
from bot.strategy import EmaRsiStrategy, PositionSide, Signal

logger = logging.getLogger(__name__)

STATE_FILE = ROOT / "bot-state.json"


@dataclass
class Position:
    side: str
    entry_price: float
    quantity: float
    margin_usdt: float
    entry_time: str
    stop_price: float | None = None
    take_profit_price: float | None = None


class FuturesTradingBot:
    def __init__(self, config: BotConfig) -> None:
        self.config = config
        self.client = BinanceFuturesClient(config)
        self.strategy = EmaRsiStrategy(config)
        self.running = True
        self.position: Position | None = None
        self.session_start_equity: float = 0.0
        self.dry_cash: float = 10_000.0

    def get_total_equity(self, price: float = 0) -> float:
        if self.config.dry_run:
            equity = self.dry_cash
            if self.position and price:
                pos = self.position
                if pos.side == "LONG":
                    upnl = (price - pos.entry_price) * pos.quantity
                else:
                    upnl = (pos.entry_price - price) * pos.quantity
                equity += pos.margin_usdt + upnl
            return equity
        return self.client.get_total_equity()

    def calc_trade_margin_usdt(self, price: float) -> float:
        equity = self.get_total_equity(price)
        return calc_trade_margin(
            equity,
            risk_per_trade_pct=self.config.risk_per_trade_pct,
            leverage=self.config.leverage,
            stop_loss_pct=self.config.stop_loss_pct,
        )

    def check_account_loss_limit(self, price: float) -> bool:
        if self.session_start_equity <= 0:
            return False
        equity = self.get_total_equity(price)
        if is_account_loss_limit_hit(
            equity,
            self.session_start_equity,
            self.config.max_account_loss_pct,
        ):
            logger.warning(
                "Account loss limit hit (equity $%.2f, start $%.2f, max -%.1f%%)",
                equity,
                self.session_start_equity,
                self.config.max_account_loss_pct,
            )
            return True
        return False

    def load_state(self) -> None:
        if not STATE_FILE.exists():
            return
        try:
            data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
            if data.get("symbol") == self.config.symbol and data.get("position"):
                self.position = Position(**data["position"])
                logger.info("Restored local state: %s", self.position)
        except (json.JSONDecodeError, TypeError, KeyError) as exc:
            logger.warning("Could not load state: %s", exc)

    def sync_position_from_exchange(self) -> None:
        if self.config.dry_run:
            return

        live = self.client.get_position()
        if live and not self.position:
            self.position = Position(
                side=live["side"],
                entry_price=live["entry_price"],
                quantity=live["quantity"],
                margin_usdt=live["quantity"] * live["entry_price"] / live["leverage"],
                entry_time=datetime.now(timezone.utc).isoformat(),
            )
            logger.info("Synced position from exchange: %s", self.position)
        elif not live and self.position:
            logger.info("Exchange has no position; clearing local state")
            self.position = None
            self.save_state()

    def save_state(self) -> None:
        payload = {
            "symbol": self.config.symbol,
            "leverage": self.config.leverage,
            "position": asdict(self.position) if self.position else None,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        STATE_FILE.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    def get_available_margin(self) -> float:
        if self.config.dry_run:
            return self.dry_cash
        return self.client.get_usdt_balance()

    def current_notional(self, price: float) -> float:
        if not self.position:
            return 0.0
        return self.position.quantity * price

    def calc_order_quantity(self, price: float, margin: float) -> float:
        notional = margin * self.config.leverage
        available = self.get_available_margin()
        max_notional = available * self.config.leverage
        notional = min(notional, max_notional)

        if notional < 5:
            raise ValueError(f"Notional too small (${notional:.2f})")

        if self.config.dry_run:
            return round(notional / price, 3)

        return self.client.calc_quantity(notional, price)

    def calc_entry_stop_price(self, side: PositionSide, klines: list[list]) -> float | None:
        if not self.config.use_swing_stop_loss:
            return None
        return calc_stop_from_klines(
            klines,
            side.value,
            pivot_bars=self.config.swing_pivot_bars,
            lookback=self.config.swing_lookback,
            buffer_pct=self.config.swing_stop_buffer_pct,
        )

    def open_position(
        self,
        side: PositionSide,
        price: float,
        klines: list[list] | None = None,
        entry_levels=None,
    ) -> None:
        if side != PositionSide.LONG and side != PositionSide.SHORT:
            return
        if self.position:
            logger.debug("Position already open — skip entry")
            return
        if self.check_account_loss_limit(price):
            self.running = False
            return

        margin_needed = self.calc_trade_margin_usdt(price)
        available = self.get_available_margin()

        if available < margin_needed:
            logger.warning("Insufficient margin (available $%.2f, need $%.2f)", available, margin_needed)
            return

        qty = self.calc_order_quantity(price, margin_needed)
        margin = qty * price / self.config.leverage
        stop_price = entry_levels.stop_price if entry_levels else None
        take_profit_price = entry_levels.take_profit_price if entry_levels else None

        risk_note = f" | risk {self.config.risk_per_trade_pct}% of equity"
        if stop_price is not None:
            risk_note += f" | SL ${stop_price:.2f}"
        if take_profit_price is not None:
            risk_note += f" | TP ${take_profit_price:.2f}"

        if self.config.dry_run:
            logger.info(
                "[DRY RUN] OPEN %s %.6f @ $%.2f | margin $%.2f | %dx%s",
                side.value, qty, price, margin, self.config.leverage, risk_note,
            )
            self.dry_cash -= margin
            self.position = Position(
                side=side.value,
                entry_price=price,
                quantity=qty,
                margin_usdt=margin,
                entry_time=datetime.now(timezone.utc).isoformat(),
                stop_price=stop_price,
                take_profit_price=take_profit_price,
            )
            self.save_state()
            return

        if side == PositionSide.LONG:
            self.client.open_long(qty)
        else:
            self.client.open_short(qty)

        live = self.client.get_position()
        if live:
            avg_price = live["entry_price"]
            qty = live["quantity"]
        else:
            avg_price = price
        self.position = Position(
            side=side.value,
            entry_price=avg_price,
            quantity=qty,
            margin_usdt=qty * avg_price / self.config.leverage,
            entry_time=datetime.now(timezone.utc).isoformat(),
            stop_price=stop_price,
            take_profit_price=take_profit_price,
        )
        self.save_state()
        logger.info(
            "OPEN %s %.6f @ $%.2f | margin $%.2f | %dx",
            side.value, qty, avg_price, self.position.margin_usdt, self.config.leverage,
        )

    def close_position(self, price: float, reason: str) -> None:
        if not self.position:
            logger.info("No position to close")
            return

        side = PositionSide(self.position.side)
        entry = self.position.entry_price
        qty = self.position.quantity

        if side == PositionSide.LONG:
            pnl_pct = ((price - entry) / entry) * 100 * self.config.leverage
        else:
            pnl_pct = ((entry - price) / entry) * 100 * self.config.leverage

        if self.config.dry_run:
            logger.info(
                "[DRY RUN] CLOSE %s %.6f @ $%.2f | ROE %+.2f%% — %s",
                side.value, qty, price, pnl_pct, reason,
            )
            pnl = (price - entry) * qty if side == PositionSide.LONG else (entry - price) * qty
            self.dry_cash += self.position.margin_usdt + pnl
            self.position = None
            self.save_state()
            return

        if side == PositionSide.LONG:
            self.client.close_long(qty)
        else:
            self.client.close_short(qty)

        logger.info(
            "CLOSE %s %.6f @ $%.2f | ROE %+.2f%% — %s",
            side.value, qty, price, pnl_pct, reason,
        )
        self.position = None
        self.save_state()

    def tick(self) -> None:
        klines = self.client.get_klines(limit=200)
        last = klines[-1]
        price = float(last[4])
        # High/low of the currently forming candle capture any wick that touched
        # the stop/take-profit since the previous poll, so fast intrabar moves are
        # not missed the way a close-only check would miss them.
        bar_high = float(last[2])
        bar_low = float(last[3])
        current_side = PositionSide(self.position.side) if self.position else None

        if self.position:
            exit_signal = self.strategy.check_exit_bar(
                current_side,
                self.position.entry_price,
                bar_high,
                bar_low,
                stop_price=self.position.stop_price,
                take_profit_price=self.position.take_profit_price,
            )
            if exit_signal:
                self.close_position(exit_signal.exit_price or price, exit_signal.reason)
                return

        result = self.strategy.analyze(klines, current_side)
        snap = result.snapshot

        if snap:
            pos_label = f" | {current_side.value}" if current_side else ""
            logger.info(
                "Price $%.2f | RSI %.1f%s | %s",
                snap.price,
                snap.rsi,
                pos_label,
                result.reason,
            )

        if result.signal in (Signal.LONG, Signal.SHORT) and not self.position:
            side = PositionSide.LONG if result.signal == Signal.LONG else PositionSide.SHORT
            if side == PositionSide.SHORT and not self.config.allow_short:
                return
            self.open_position(side, price, klines, result.entry_levels)

    def run(self) -> None:
        mode = "DRY RUN" if self.config.dry_run else ("TESTNET" if self.config.use_testnet else "LIVE")
        logger.info(
            "Starting Futures bot [%s] %s %s | %dx %s | risk %.1f%%/trade | poll %ds",
            mode,
            self.config.symbol,
            self.config.interval,
            self.config.leverage,
            self.config.margin_type,
            self.config.risk_per_trade_pct,
            self.config.poll_seconds,
        )

        if not self.config.dry_run:
            if not self.client.ping():
                logger.error("Cannot connect to Binance Futures API")
                sys.exit(1)
            self.client.setup_leverage_and_margin()

        self.load_state()
        self.sync_position_from_exchange()

        self.session_start_equity = self.get_total_equity()
        balance = self.get_available_margin()
        pos_info = f"{self.position.side} {self.position.quantity:.6f} @ ${self.position.entry_price:.2f}" if self.position else "none"
        logger.info(
            "Equity $%.2f | Available $%.2f | Position: %s",
            self.session_start_equity,
            balance,
            pos_info,
        )

        while self.running:
            try:
                self.tick()
            except Exception:
                logger.exception("Error during tick")
            time.sleep(self.config.poll_seconds)

    def stop(self, *_args) -> None:
        logger.info("Shutting down...")
        self.running = False


def setup_logging() -> None:
    log_dir = ROOT / "logs"
    log_dir.mkdir(exist_ok=True)
    log_file = log_dir / f"bot-{datetime.now().strftime('%Y%m%d')}.log"

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[
            logging.StreamHandler(sys.stdout),
            logging.FileHandler(log_file, encoding="utf-8"),
        ],
    )


def main() -> None:
    setup_logging()
    config = BotConfig.from_env()
    bot = FuturesTradingBot(config)

    signal.signal(signal.SIGINT, bot.stop)
    if hasattr(signal, "SIGTERM"):
        signal.signal(signal.SIGTERM, bot.stop)

    bot.run()


if __name__ == "__main__":
    main()
