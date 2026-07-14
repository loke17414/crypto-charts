"""Local API server — proxies Binance Futures Testnet with user API keys."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from bot.config import BotConfig
from bot.credentials import clear_binance_credentials, credentials_configured, load_binance_credentials, persist_binance_credentials
from bot.exchange import BinanceFuturesClient
from bot.server_bot import bot_diagnostics, bot_status, restore_bot_if_needed, save_strategy_json, start_bot, stop_bot
from bot.strategy_ai import ai_available, configure_openai_api_key, interpret_strategy, test_openai_api_key
from bot.strategy_schema import StrategyInterpretRequest, StrategyInterpretResponse, StrategySettings

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


@dataclass
class Session:
    config: BotConfig
    client: BinanceFuturesClient


_session: Session | None = None


def _connect_session(api_key: str, api_secret: str) -> Session:
    config = BotConfig.from_credentials(api_key, api_secret, use_testnet=True)
    client = BinanceFuturesClient(config)
    if not client.ping():
        raise HTTPException(status_code=502, detail="Cannot reach Binance Futures Testnet")
    try:
        balance = client.get_usdt_balance()
    except Exception as exc:
        raise HTTPException(status_code=401, detail=f"Invalid API key: {exc}") from exc
    logger.info("Testnet connected — balance $%.2f USDT", balance)
    return Session(config=config, client=client)


def auto_connect_from_env() -> bool:
    global _session
    creds = load_binance_credentials()
    if not creds:
        return False
    api_key, api_secret = creds
    try:
        _session = _connect_session(api_key, api_secret)
    except HTTPException as exc:
        logger.warning("Auto-connect failed: %s", exc.detail)
        return False
    except Exception as exc:
        logger.warning("Auto-connect failed: %s", exc)
        return False
    logger.info("Auto-connected from .env")
    return True


@asynccontextmanager
async def lifespan(app: FastAPI):
    auto_connect_from_env()
    restore_bot_if_needed()
    yield
    stop_bot()


app = FastAPI(title="CryptoCharts Futures API", version="1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ConnectBody(BaseModel):
    api_key: str = Field(min_length=1)
    api_secret: str = Field(min_length=1)


class SetupBody(BaseModel):
    leverage: int = Field(ge=1, le=125, default=5)
    margin_type: str = "ISOLATED"
    symbol: str = "BTCUSDT"
    trade_margin_usdt: float = Field(gt=0, default=20)


class OpenBody(BaseModel):
    side: str = Field(pattern="^(LONG|SHORT)$")
    margin_usdt: float = Field(gt=0)
    leverage: int = Field(ge=1, le=125)
    price: float = Field(gt=0)


class StrategyConfigureBody(BaseModel):
    openai_api_key: str = Field(min_length=20, max_length=512)


class StrategyTestKeyBody(BaseModel):
    openai_api_key: str = Field(default="", max_length=512)


class StrategySyncBody(BaseModel):
    strategy: dict[str, Any]


class DisconnectBody(BaseModel):
    clear_saved_keys: bool = False


def _require_session() -> Session:
    if not _session:
        raise HTTPException(status_code=401, detail="API key not connected")
    return _session


@app.get("/api/health")
def health() -> dict[str, Any]:
    ai = ai_available()
    return {
        "ok": True,
        "apiVersion": 2,
        "connected": _session is not None,
        "credentialsSaved": credentials_configured(),
        "testnet": True,
        "strategyAi": ai,
        "bot": bot_status(),
        "botDiagnostics": bot_diagnostics(),
    }


@app.get("/api/strategy/ai-status")
def strategy_ai_status(verify: bool = False) -> dict[str, Any]:
    return {"ok": True, **ai_available(verify=verify)}


@app.post("/api/strategy/test-key")
def strategy_test_key(body: StrategyTestKeyBody | None = None) -> dict[str, Any]:
    try:
        candidate = (body.openai_api_key if body else "").strip()
        result = test_openai_api_key(candidate or None)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if not result["verified"]:
        raise HTTPException(status_code=400, detail=result["message"])

    return {"ok": True, **result}


@app.post("/api/strategy/configure")
def strategy_configure(body: StrategyConfigureBody) -> dict[str, Any]:
    try:
        status = configure_openai_api_key(body.openai_api_key)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f".env 저장 실패: {exc}") from exc

    return {
        "ok": True,
        **status,
        "message": status.get("message") or "OpenAI API 키가 저장되었습니다.",
    }


@app.post("/api/strategy/interpret")
def strategy_interpret(body: StrategyInterpretRequest) -> StrategyInterpretResponse:
    try:
        result = interpret_strategy(body.prompt, body.current_settings, [m.model_dump() for m in body.history])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("Strategy interpret failed")
        raise HTTPException(status_code=502, detail=f"전략 해석 실패: {exc}") from exc

    settings = StrategySettings.model_validate(result["settings"])
    return StrategyInterpretResponse(
        ok=True,
        settings=settings,
        summary=result["summary"],
        rules=result["rules"],
        patch=result.get("patch") or {},
        changed_fields=result.get("changed_fields") or [],
    )


@app.post("/api/connect")
def connect(body: ConnectBody) -> dict[str, Any]:
    global _session

    try:
        persist_binance_credentials(body.api_key, body.api_secret)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f".env 저장 실패: {exc}") from exc

    _session = _connect_session(body.api_key, body.api_secret)
    balance = _session.client.get_usdt_balance()

    return {
        "ok": True,
        "balance": balance,
        "testnet": True,
        "credentialsSaved": True,
        "message": "Binance Futures Testnet connected — 키가 서버 .env에 저장되었습니다.",
    }


@app.post("/api/reconnect")
def reconnect() -> dict[str, Any]:
    if not auto_connect_from_env():
        raise HTTPException(status_code=401, detail="No saved API keys — connect with key and secret first")
    balance = _session.client.get_usdt_balance()
    return {
        "ok": True,
        "balance": balance,
        "testnet": True,
        "credentialsSaved": True,
        "message": "Reconnected from saved .env credentials",
    }


@app.post("/api/disconnect")
def disconnect(body: DisconnectBody | None = None) -> dict[str, Any]:
    global _session
    stop_bot()
    _session = None
    if body and body.clear_saved_keys:
        clear_binance_credentials()
        logger.info("Testnet disconnected — saved keys removed")
        return {"ok": True, "credentialsSaved": False}
    logger.info("Testnet session cleared (saved keys kept)")
    return {"ok": True, "credentialsSaved": credentials_configured()}


@app.get("/api/status")
def status() -> dict[str, Any]:
    if not _session:
        return {"connected": False, "testnet": True}

    client = _session.client
    balance = client.get_usdt_balance()
    pos = client.get_position()

    result: dict[str, Any] = {
        "connected": True,
        "testnet": True,
        "balance": balance,
        "symbol": _session.config.symbol,
        "leverage": _session.config.leverage,
        "position": None,
    }

    if pos:
        result["position"] = {
            "side": pos["side"],
            "quantity": pos["quantity"],
            "entryPrice": pos["entry_price"],
            "unrealizedPnl": pos["unrealized_pnl"],
            "leverage": pos["leverage"],
        }

    return result


@app.post("/api/setup")
def setup(body: SetupBody) -> dict[str, Any]:
    global _session
    session = _require_session()

    config = session.config.with_trading_params(
        leverage=body.leverage,
        margin_type=body.margin_type,
        symbol=body.symbol,
    )
    client = BinanceFuturesClient(config)
    _session = Session(config=config, client=client)

    try:
        client.setup_leverage_and_margin()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {"ok": True, "leverage": config.leverage, "marginType": config.margin_type}


@app.post("/api/order/open")
def open_order(body: OpenBody) -> dict[str, Any]:
    global _session
    session = _require_session()

    config = session.config.with_trading_params(
        leverage=body.leverage,
    )
    client = BinanceFuturesClient(config)
    _session = Session(config=config, client=client)

    if client.get_position():
        raise HTTPException(status_code=400, detail="Position already open")

    notional = body.margin_usdt * body.leverage
    qty = client.calc_quantity(notional, body.price)

    try:
        client.setup_leverage_and_margin()
        if body.side == "LONG":
            client.open_long(qty)
        else:
            client.open_short(qty)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    pos = client.get_position()
    return {
        "ok": True,
        "side": body.side,
        "quantity": qty,
        "position": pos,
    }


@app.post("/api/order/close")
def close_order() -> dict[str, Any]:
    session = _require_session()
    client = session.client
    pos = client.get_position()

    if not pos:
        raise HTTPException(status_code=400, detail="No open position")

    try:
        if pos["side"] == "LONG":
            client.close_long(pos["quantity"])
        else:
            client.close_short(pos["quantity"])
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {"ok": True, "closed": pos["side"], "quantity": pos["quantity"]}


@app.post("/api/strategy/sync")
def strategy_sync(body: StrategySyncBody) -> dict[str, Any]:
    if not body.strategy:
        raise HTTPException(status_code=400, detail="strategy payload required")
    path = save_strategy_json(body.strategy)
    return {"ok": True, "path": str(path)}


@app.get("/api/bot/status")
def get_bot_status() -> dict[str, Any]:
    return {"ok": True, **bot_status()}


@app.post("/api/bot/start")
def bot_start() -> dict[str, Any]:
    if not _session:
        if not auto_connect_from_env():
            raise HTTPException(status_code=401, detail="API key not connected — connect testnet first")
    try:
        return start_bot()
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/bot/stop")
def bot_stop() -> dict[str, Any]:
    return stop_bot()


def main() -> None:
    uvicorn.run("bot.server:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    main()
