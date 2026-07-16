"""Binance USDT-M Futures REST API client."""

from __future__ import annotations

import hashlib
import hmac
import logging
import math
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
                    "tick_size": float(
                        filters.get("PRICE_FILTER", {"tickSize": "0.1"})["tickSize"]
                    ),
                    "min_price": float(
                        filters.get("PRICE_FILTER", {}).get("minPrice", 0) or 0
                    ),
                    "max_price": float(
                        filters.get("PRICE_FILTER", {}).get("maxPrice", 0) or 0
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

    @staticmethod
    def _round_trigger(value: float, step: float, *, up: bool) -> float:
        if step <= 0:
            return value
        precision = max(0, len(str(step).rstrip("0").split(".")[-1]) if "." in str(step) else 0)
        steps = value / step
        rounded = (math.ceil(steps) if up else math.floor(steps)) * step
        return round(rounded, precision)

    def get_mark_price(self) -> float | None:
        data = self._request("GET", "/fapi/v1/premiumIndex", {"symbol": self.config.symbol})
        mark = float(data.get("markPrice", 0))
        return mark if mark > 0 else None

    def _format_trigger_price(self, price: float, position_side: str, order_type: str) -> str:
        filters = self.get_symbol_filters()
        tick = filters["tick_size"]
        is_stop = order_type == "STOP_MARKET"
        if position_side == "LONG":
            rounded = self._round_trigger(price, tick, up=not is_stop)
        else:
            rounded = self._round_trigger(price, tick, up=is_stop)
        return f"{rounded:.8f}".rstrip("0").rstrip(".")

    def _validate_trigger(
        self,
        position_side: str,
        order_type: str,
        trigger: float,
        entry_price: float,
        mark_price: float | None,
    ) -> None:
        is_stop = order_type == "STOP_MARKET"
        if position_side == "LONG":
            if is_stop:
                if trigger >= entry_price:
                    raise ValueError(
                        f"SL ${trigger:g} must be below entry ${entry_price:g}"
                    )
                if mark_price is not None and trigger >= mark_price:
                    raise ValueError(
                        f"SL ${trigger:g} at/above mark ${mark_price:g} (즉시 체결)"
                    )
            elif trigger <= entry_price:
                raise ValueError(f"TP ${trigger:g} must be above entry ${entry_price:g}")
            elif mark_price is not None and trigger <= mark_price:
                raise ValueError(
                    f"TP ${trigger:g} at/below mark ${mark_price:g} (즉시 체결)"
                )
        else:
            if is_stop:
                if trigger <= entry_price:
                    raise ValueError(
                        f"SL ${trigger:g} must be above entry ${entry_price:g}"
                    )
                if mark_price is not None and trigger <= mark_price:
                    raise ValueError(
                        f"SL ${trigger:g} at/below mark ${mark_price:g} (즉시 체결)"
                    )
            elif trigger >= entry_price:
                raise ValueError(f"TP ${trigger:g} must be below entry ${entry_price:g}")
            elif mark_price is not None and trigger >= mark_price:
                raise ValueError(
                    f"TP ${trigger:g} at/above mark ${mark_price:g} (즉시 체결)"
                )

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

    def _format_price(self, price: float) -> str:
        filters = self.get_symbol_filters()
        rounded = self._round_step(price, filters["tick_size"])
        return f"{rounded:.8f}".rstrip("0").rstrip(".")

    # Conditional orders (STOP_MARKET / TAKE_PROFIT_MARKET) moved to the Algo
    # Order API on 2025-12-09; /fapi/v1/order now rejects them with error -4120.
    def _place_conditional(self, position_side: str, order_type: str, trigger_price: float) -> dict[str, Any]:
        filters = self.get_symbol_filters()
        formatted = self._format_trigger_price(trigger_price, position_side, order_type)
        min_price = filters.get("min_price") or 0
        max_price = filters.get("max_price") or 0
        if float(formatted) <= 0 or (min_price and float(formatted) < min_price):
            raise ValueError(
                f"{order_type} 트리거 가격 ${formatted}이(가) 최소가격 ${min_price} 미만입니다 — SL/TP 설정을 확인하세요"
            )
        if max_price and float(formatted) > max_price:
            raise ValueError(
                f"{order_type} 트리거 가격 ${formatted}이(가) 최대가격 ${max_price} 초과입니다 — SL/TP 설정을 확인하세요"
            )

        side = "SELL" if position_side == "LONG" else "BUY"
        logger.info("Placing %s %s @ trigger $%s (%s)", order_type, self.config.symbol, formatted, side)
        return self._request(
            "POST",
            "/fapi/v1/algoOrder",
            {
                "algoType": "CONDITIONAL",
                "symbol": self.config.symbol,
                "side": side,
                "type": order_type,
                "triggerPrice": formatted,
                "closePosition": "true",
                "workingType": "MARK_PRICE",
            },
            signed=True,
        )

    def place_stop_market(self, position_side: str, stop_price: float) -> dict[str, Any]:
        """Exchange-side stop loss that closes the whole position when touched."""
        return self._place_conditional(position_side, "STOP_MARKET", stop_price)

    def place_take_profit_market(self, position_side: str, take_profit_price: float) -> dict[str, Any]:
        """Exchange-side take profit that closes the whole position when touched."""
        return self._place_conditional(position_side, "TAKE_PROFIT_MARKET", take_profit_price)

    def get_open_algo_orders(self) -> list[dict[str, Any]]:
        data = self._request(
            "GET",
            "/fapi/v1/openAlgoOrders",
            {"symbol": self.config.symbol},
            signed=True,
        )
        if isinstance(data, dict):
            return data.get("orders") or data.get("algoOrders") or []
        return data or []

    def cancel_all_orders(self) -> None:
        """Cancel open algo (conditional) orders; also clear legacy open orders."""
        try:
            self._request(
                "DELETE",
                "/fapi/v1/algoOpenOrders",
                {"symbol": self.config.symbol},
                signed=True,
            )
        except requests.RequestException as exc:
            logger.warning("Cancel algo open orders failed: %s", exc)
        try:
            self._request(
                "DELETE",
                "/fapi/v1/allOpenOrders",
                {"symbol": self.config.symbol},
                signed=True,
            )
        except requests.RequestException as exc:
            logger.debug("Cancel legacy open orders failed: %s", exc)

    def get_sl_tp_orders(self) -> dict[str, float | None]:
        """Return current exchange-side SL/TP trigger prices, if any."""
        result: dict[str, float | None] = {"stop_price": None, "take_profit_price": None}
        try:
            orders = self.get_open_algo_orders()
        except requests.RequestException:
            return result
        for order in orders:
            otype = order.get("type") or order.get("origType") or order.get("orderType")
            trigger = float(order.get("triggerPrice") or order.get("stopPrice") or 0)
            if trigger <= 0:
                continue
            if otype == "STOP_MARKET":
                result["stop_price"] = trigger
            elif otype == "TAKE_PROFIT_MARKET":
                result["take_profit_price"] = trigger
        return result

    def set_sl_tp(
        self,
        position_side: str,
        stop_price: float | None,
        take_profit_price: float | None,
        *,
        entry_price: float | None = None,
    ) -> dict[str, float | None]:
        """Replace exchange-side SL/TP orders (cancel existing, place new).

        Places each leg independently so a bad SL doesn't block the TP (and
        vice versa); raises with the collected errors after trying both.
        """
        mark_price: float | None = None
        try:
            mark_price = self.get_mark_price()
        except requests.RequestException:
            mark_price = None

        self.cancel_all_orders()
        errors: list[str] = []
        if stop_price and stop_price > 0:
            try:
                if entry_price is not None:
                    self._validate_trigger(
                        position_side, "STOP_MARKET", stop_price, entry_price, mark_price
                    )
                self.place_stop_market(position_side, stop_price)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"SL: {exc}")
        if take_profit_price and take_profit_price > 0:
            try:
                if entry_price is not None:
                    self._validate_trigger(
                        position_side,
                        "TAKE_PROFIT_MARKET",
                        take_profit_price,
                        entry_price,
                        mark_price,
                    )
                self.place_take_profit_market(position_side, take_profit_price)
            except Exception as exc:  # noqa: BLE001
                errors.append(f"TP: {exc}")
        result = self.get_sl_tp_orders()
        if errors:
            raise ValueError(" · ".join(errors))
        return result
