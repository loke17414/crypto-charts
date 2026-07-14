"""Binance USDT-M Futures REST API client."""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
from typing import Any
from urllib.parse import urlencode

import requests

from bot.config import BotConfig

logger = logging.getLogger(__name__)


class BinanceFuturesClient:
    def __init__(self, config: BotConfig) -> None:
        self.config = config
        self.session = requests.Session()
        self.session.headers.update({"X-MBX-APIKEY": config.api_key})
        self._filters: dict[str, Any] | None = None

    def _sign(self, params: dict[str, Any]) -> dict[str, Any]:
        params = {**params, "timestamp": int(time.time() * 1000)}
        query = urlencode(params)
        signature = hmac.new(
            self.config.api_secret.encode(),
            query.encode(),
            hashlib.sha256,
        ).hexdigest()
        params["signature"] = signature
        return params

    def _request(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None = None,
        signed: bool = False,
    ) -> Any:
        params = params or {}
        if signed:
            params = self._sign(params)

        url = f"{self.config.base_url}{path}"
        response = self.session.request(method, url, params=params, timeout=15)

        if not response.ok:
            try:
                err = response.json()
                msg = err.get("msg", response.text)
            except ValueError:
                msg = response.text
            raise requests.HTTPError(f"{response.status_code} {msg}", response=response)

        data = response.json()
        return data

    def ping(self) -> bool:
        try:
            self._request("GET", "/fapi/v1/ping")
            return True
        except requests.RequestException as exc:
            logger.error("Binance Futures ping failed: %s", exc)
            return False

    def get_klines(self, limit: int = 200) -> list[list[Any]]:
        return self._request(
            "GET",
            "/fapi/v1/klines",
            {
                "symbol": self.config.symbol,
                "interval": self.config.interval,
                "limit": limit,
            },
        )

    def get_ticker_price(self) -> float:
        data = self._request("GET", "/fapi/v1/ticker/price", {"symbol": self.config.symbol})
        return float(data["price"])

    def get_total_equity(self) -> float:
        balances = self._request("GET", "/fapi/v2/balance", signed=True)
        for b in balances:
            if b["asset"] == "USDT":
                return float(b["balance"])
        return 0.0

    def get_usdt_balance(self) -> float:
        balances = self._request("GET", "/fapi/v2/balance", signed=True)
        for b in balances:
            if b["asset"] == "USDT":
                return float(b["availableBalance"])
        return 0.0

    def get_position(self) -> dict[str, float] | None:
        positions = self._request("GET", "/fapi/v2/positionRisk", signed=True)
        for p in positions:
            if p["symbol"] != self.config.symbol:
                continue
            amt = float(p["positionAmt"])
            if abs(amt) < 1e-8:
                return None
            return {
                "side": "LONG" if amt > 0 else "SHORT",
                "quantity": abs(amt),
                "entry_price": float(p["entryPrice"]),
                "unrealized_pnl": float(p["unRealizedProfit"]),
                "leverage": int(float(p["leverage"])),
            }
        return None

    def setup_leverage_and_margin(self) -> None:
        if self.config.dry_run:
            return

        try:
            self._request(
                "POST",
                "/fapi/v1/marginType",
                {"symbol": self.config.symbol, "marginType": self.config.margin_type},
                signed=True,
            )
            logger.info("Margin type set to %s", self.config.margin_type)
        except requests.HTTPError as exc:
            if "No need to change margin type" not in str(exc):
                raise

        result = self._request(
            "POST",
            "/fapi/v1/leverage",
            {"symbol": self.config.symbol, "leverage": self.config.leverage},
            signed=True,
        )
        logger.info("Leverage set to %sx", result.get("leverage", self.config.leverage))

    def get_symbol_filters(self) -> dict[str, Any]:
        if self._filters:
            return self._filters

        info = self._request("GET", "/fapi/v1/exchangeInfo")
        for symbol_info in info["symbols"]:
            if symbol_info["symbol"] == self.config.symbol:
                filters = {f["filterType"]: f for f in symbol_info["filters"]}
                self._filters = {
                    "step_size": float(filters["LOT_SIZE"]["stepSize"]),
                    "min_qty": float(filters["LOT_SIZE"]["minQty"]),
                    "min_notional": float(
                        filters.get("MIN_NOTIONAL", {"notional": "5"})["notional"]
                    ),
                }
                return self._filters
        raise ValueError(f"Symbol {self.config.symbol} not found")

    @staticmethod
    def _round_step(value: float, step: float) -> float:
        if step <= 0:
            return value
        precision = max(0, len(str(step).rstrip("0").split(".")[-1]) if "." in str(step) else 0)
        rounded = (value // step) * step
        return round(rounded, precision)

    def calc_quantity(self, notional_usdt: float, price: float) -> float:
        filters = self.get_symbol_filters()
        qty = self._round_step(notional_usdt / price, filters["step_size"])
        if qty < filters["min_qty"]:
            raise ValueError(f"Quantity {qty} below minimum {filters['min_qty']}")
        if qty * price < filters["min_notional"]:
            raise ValueError(f"Notional ${qty * price:.2f} below minimum ${filters['min_notional']}")
        return qty

    def market_order(self, side: str, quantity: float, reduce_only: bool = False) -> dict[str, Any]:
        filters = self.get_symbol_filters()
        qty = self._round_step(quantity, filters["step_size"])

        params: dict[str, Any] = {
            "symbol": self.config.symbol,
            "side": side,
            "type": "MARKET",
            "quantity": f"{qty:.8f}".rstrip("0").rstrip("."),
        }
        if reduce_only:
            params["reduceOnly"] = "true"

        return self._request("POST", "/fapi/v1/order", params, signed=True)

    def open_long(self, quantity: float) -> dict[str, Any]:
        return self.market_order("BUY", quantity)

    def open_short(self, quantity: float) -> dict[str, Any]:
        return self.market_order("SELL", quantity)

    def close_long(self, quantity: float) -> dict[str, Any]:
        return self.market_order("SELL", quantity, reduce_only=True)

    def close_short(self, quantity: float) -> dict[str, Any]:
        return self.market_order("BUY", quantity, reduce_only=True)
