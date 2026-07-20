"""Local API server — proxies Binance Futures Testnet with user API keys."""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session as DbSession
from starlette.responses import JSONResponse

from bot.auth_routes import get_optional_user, peek_optional_user, router as auth_router
from bot.auth_service import decode_access_token
from bot.config import BotConfig
from bot.credentials import clear_binance_credentials, credentials_configured, load_binance_credentials, persist_binance_credentials
from bot.crypto_vault import vault_ready
from bot.db import get_db, init_db
from bot.exchange import BinanceFuturesClient
from bot.models import User
from bot.platform_config import auth_required, database_url
from bot.platform_network import binance_ip_whitelist_hint, get_outbound_ip, parse_binance_request_ip
from bot.user_credentials import delete_credentials, has_credentials, load_credentials, save_credentials
from bot.server_bot import (
    bot_diagnostics,
    bot_status,
    clear_entry_gate,
    is_running,
    pause_bot_entry,
    restore_bot_if_needed,
    save_strategy_json,
    start_bot,
    stop_all_bots,
    stop_bot,
    _strategy_interval,
)
from bot.strategy_ai import ai_available, configure_openai_api_key, interpret_strategy, test_openai_api_key
from bot.strategy_ai_memory import clear_memory, load_turns
from bot.strategy_schema import StrategyInterpretRequest, StrategyInterpretResponse, StrategySettings

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)


@dataclass
class TradingSession:
    config: BotConfig
    client: BinanceFuturesClient
    user_id: int | None = None  # None = legacy .env session


# user_id → session; LEGACY_SESSION_KEY for AUTH_REQUIRED=false /.env mode
LEGACY_SESSION_KEY = 0
_sessions: dict[int, TradingSession] = {}


def _use_testnet_flag() -> bool:
    return os.getenv("BINANCE_TESTNET", "true").lower() in ("1", "true", "yes")


def _session_key(user: User | None) -> int:
    return user.id if user is not None else LEGACY_SESSION_KEY


def _get_session(user: User | None) -> TradingSession | None:
    return _sessions.get(_session_key(user))


def _set_session(user: User | None, session: TradingSession) -> None:
    key = _session_key(user)
    session.user_id = user.id if user else None
    _sessions[key] = session


def _clear_session(user: User | None) -> None:
    _sessions.pop(_session_key(user), None)


def _any_session_connected() -> bool:
    return bool(_sessions)


def _connect_session(api_key: str, api_secret: str, *, use_testnet: bool | None = None) -> TradingSession:
    testnet = _use_testnet_flag() if use_testnet is None else use_testnet
    config = BotConfig.from_credentials(api_key, api_secret, use_testnet=testnet)
    client = BinanceFuturesClient(config)
    label = "Testnet" if testnet else "Mainnet"
    if not client.ping():
        raise HTTPException(
            status_code=502,
            detail=f"Cannot reach Binance Futures {label} — 네트워크 또는 Binance 장애",
        )
    try:
        balance = client.get_usdt_balance()
    except Exception as exc:
        msg = str(exc)
        req_ip = parse_binance_request_ip(msg)
        if "Invalid API-key, IP, or permissions" in msg or "-2015" in msg:
            hint = binance_ip_whitelist_hint(request_ip=req_ip, use_testnet=testnet)
            raise HTTPException(status_code=401, detail=hint) from exc
        label = "Testnet" if testnet else "Mainnet"
        raise HTTPException(status_code=401, detail=f"Invalid API key ({label}): {exc}") from exc
    logger.info("%s connected — balance $%.2f USDT", label, balance)
    return TradingSession(config=config, client=client)


def auto_connect_from_env() -> bool:
    creds = load_binance_credentials()
    if not creds:
        return False
    api_key, api_secret = creds
    try:
        session = _connect_session(api_key, api_secret)
        _set_session(None, session)
    except HTTPException as exc:
        logger.warning("Auto-connect failed: %s", exc.detail)
        return False
    except Exception as exc:
        logger.warning("Auto-connect failed: %s", exc)
        return False
    logger.info("Auto-connected from .env (legacy session)")
    return True


def require_trading_session(user: User | None = Depends(get_optional_user)) -> TradingSession:
    session = _get_session(user)
    if not session:
        raise HTTPException(status_code=401, detail="API key not connected")
    return session


@asynccontextmanager
async def lifespan(app: FastAPI):
    from bot.platform_config import access_token_expire_minutes

    init_db()
    logger.info("Database ready (%s)", database_url().split(":", 1)[0])
    openai_status = ai_available(verify=False)
    logger.info(
        "OpenAI key: %s",
        "saved" if openai_status.get("configured") else "not set",
    )
    expire_m = access_token_expire_minutes()
    logger.info(
        "Login token expiry: %s",
        "never (ACCESS_TOKEN_EXPIRE_MINUTES=0)" if expire_m == 0 else f"{expire_m} minutes",
    )
    if not auth_required():
        auto_connect_from_env()
    restore_bot_if_needed()
    yield
    stop_all_bots()


PUBLIC_API_PATHS = {
    "/api/health",
    "/api/auth/register",
    "/api/auth/login",
    "/api/platform/outbound-ip",
}


app = FastAPI(title="CryptoCharts Futures API", version="1.0", lifespan=lifespan)
app.include_router(auth_router)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    if not auth_required():
        return await call_next(request)
    if request.method == "OPTIONS":
        return await call_next(request)
    path = request.url.path
    if not path.startswith("/api/"):
        return await call_next(request)
    if path in PUBLIC_API_PATHS:
        return await call_next(request)
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return JSONResponse(status_code=401, content={"detail": "로그인이 필요합니다. 다시 로그인해 주세요."})
    try:
        decode_access_token(auth[7:].strip())
    except ValueError:
        return JSONResponse(
            status_code=401,
            content={"detail": "로그인 세션이 만료되었거나 유효하지 않습니다. 다시 로그인해 주세요."},
        )
    return await call_next(request)


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
    use_testnet: bool | None = None


class ReconnectBody(BaseModel):
    use_testnet: bool | None = None


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
    stop_price: float | None = Field(default=None, gt=0)
    take_profit_price: float | None = Field(default=None, gt=0)
    stop_loss_pct: float | None = Field(default=None, gt=0)
    take_profit_pct: float | None = Field(default=None, gt=0)
    use_stop_loss: bool = True


class SlTpBody(BaseModel):
    stop_price: float | None = Field(default=None, gt=0)
    take_profit_price: float | None = Field(default=None, gt=0)


class StrategyConfigureBody(BaseModel):
    openai_api_key: str = Field(min_length=20, max_length=512)


class StrategyTestKeyBody(BaseModel):
    openai_api_key: str = Field(default="", max_length=512)


class StrategySyncBody(BaseModel):
    strategy: dict[str, Any]


class BotStartBody(BaseModel):
    live_trading: bool = True


class CloseOrderBody(BaseModel):
    manual: bool = False
    bar_time: int | None = None
    blocked_signal: str | None = None


class DisconnectBody(BaseModel):
    clear_saved_keys: bool = False


def _levels_at_entry(
    side: str,
    entry_price: float,
    *,
    ref_price: float,
    stop_loss_pct: float | None,
    take_profit_pct: float | None,
    use_stop_loss: bool,
    stop_price: float | None,
    take_profit_price: float | None,
) -> tuple[float | None, float | None]:
    """Compute SL/TP trigger prices from actual fill price and % distances."""
    sl_pct = stop_loss_pct
    tp_pct = take_profit_pct
    if ref_price > 0:
        if sl_pct is None and stop_price is not None:
            sl_pct = (
                ((ref_price - stop_price) / ref_price) * 100
                if side == "LONG"
                else ((stop_price - ref_price) / ref_price) * 100
            )
        if tp_pct is None and take_profit_price is not None:
            tp_pct = (
                ((take_profit_price - ref_price) / ref_price) * 100
                if side == "LONG"
                else ((ref_price - take_profit_price) / ref_price) * 100
            )
    if side == "LONG":
        sl = entry_price * (1 - sl_pct / 100) if use_stop_loss and sl_pct and sl_pct > 0 else None
        tp = entry_price * (1 + tp_pct / 100) if tp_pct and tp_pct > 0 else None
    else:
        sl = entry_price * (1 + sl_pct / 100) if use_stop_loss and sl_pct and sl_pct > 0 else None
        tp = entry_price * (1 - tp_pct / 100) if tp_pct and tp_pct > 0 else None
    return sl, tp


def _shift_sl_tp_to_fill(
    side: str,
    ref_price: float,
    entry_price: float,
    stop_price: float | None,
    take_profit_price: float | None,
) -> tuple[float | None, float | None]:
    """Preserve $ risk/reward distances when fill price differs from signal price."""
    if abs(ref_price - entry_price) < ref_price * 1e-5:
        return stop_price, take_profit_price
    sl = stop_price
    tp = take_profit_price
    if side == "LONG":
        if sl is not None:
            sl = entry_price - (ref_price - sl)
        if tp is not None:
            tp = entry_price + (tp - ref_price)
    else:
        if sl is not None:
            sl = entry_price + (sl - ref_price)
        if tp is not None:
            tp = entry_price - (ref_price - tp)
    return sl, tp


@app.get("/api/health")
def health(
    user: User | None = Depends(peek_optional_user),
    db: DbSession = Depends(get_db),
) -> dict[str, Any]:
    from sqlalchemy import text

    from bot.db import engine

    ai = ai_available()
    db_ok = False
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
        db_ok = True
    except Exception as exc:
        logger.warning("Database health check failed: %s", exc)

    # Never leak another user's bot status on the public health endpoint.
    session_testnet: bool | None = None
    if user is not None:
        bot = bot_status(user.id)
        session = _get_session(user)
        connected = session is not None
        creds_saved = has_credentials(db, user.id)
        if session is not None:
            session_testnet = bool(session.config.use_testnet)
        elif creds_saved:
            try:
                creds = load_credentials(db, user.id)
                if creds:
                    session_testnet = bool(creds[2])
            except ValueError:
                session_testnet = None
    elif auth_required():
        bot = {"running": False, "persisted": False}
        connected = False
        creds_saved = False
    else:
        bot = bot_status(None)
        session = _get_session(None)
        connected = session is not None
        creds_saved = credentials_configured()
        if session is not None:
            session_testnet = bool(session.config.use_testnet)

    return {
        "ok": True,
        "apiVersion": 2,
        "authRequired": auth_required(),
        "connected": connected,
        "credentialsSaved": creds_saved,
        "vaultReady": vault_ready(),
        # env default (legacy) — UI must prefer sessionTestnet when present
        "testnet": _use_testnet_flag(),
        "sessionTestnet": session_testnet,
        "database": {
            "ok": db_ok,
            "driver": database_url().split(":", 1)[0],
        },
        "strategyAi": ai,
        "bot": bot,
        "botDiagnostics": bot_diagnostics(),
        "outboundIp": get_outbound_ip(),
    }


@app.get("/api/platform/outbound-ip")
def platform_outbound_ip() -> dict[str, Any]:
    ip = get_outbound_ip()
    return {
        "ok": True,
        "ip": ip,
        "hint": (
            "Binance API Management → Restrict access to trusted IPs → "
            "아래 IP를 추가하세요 (집/회사 IP가 아닌 이 서버 IP)."
            if ip
            else "PLATFORM_OUTBOUND_IP를 .env에 설정하거나 서버에서 인터넷 조회가 가능해야 합니다."
        ),
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
        result = interpret_strategy(
            body.prompt,
            body.current_settings,
            [m.model_dump() for m in body.history],
            symbol=body.symbol,
            interval=body.interval,
            market_context=body.market_context,
            backtest_snapshot=body.backtest_snapshot,
        )
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
        market_insight=result.get("market_insight") or "",
        backtest_insight=result.get("backtest_insight") or "",
        sources=result.get("sources") or [],
        chart_interval=result.get("chart_interval"),
    )


@app.get("/api/strategy/ai-history")
def strategy_ai_history() -> dict[str, Any]:
    turns = load_turns()
    return {"ok": True, "turns": turns, "count": len(turns)}


@app.post("/api/strategy/ai-history/clear")
def strategy_ai_history_clear() -> dict[str, Any]:
    clear_memory()
    return {"ok": True, "message": "서버 대화 기록이 초기화되었습니다."}


@app.post("/api/connect")
def connect(
    body: ConnectBody,
    user: User | None = Depends(get_optional_user),
    db: DbSession = Depends(get_db),
) -> dict[str, Any]:
    use_testnet = body.use_testnet if body.use_testnet is not None else _use_testnet_flag()
    try:
        session = _connect_session(body.api_key, body.api_secret, use_testnet=use_testnet)
    except HTTPException:
        raise

    if user is not None:
        try:
            save_credentials(db, user.id, body.api_key, body.api_secret, use_testnet=use_testnet)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"키 저장 실패: {exc}") from exc
        _set_session(user, session)
        env_label = "테스트넷" if use_testnet else "실거래"
        message = f"Binance {env_label} 연결됨 — 키가 계정에 암호화 저장되었습니다."
    else:
        try:
            persist_binance_credentials(body.api_key, body.api_secret)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f".env 저장 실패: {exc}") from exc
        _set_session(None, session)
        message = "Binance 연결됨 — 키가 서버 .env에 저장되었습니다 (레거시)."

    balance = session.client.get_usdt_balance()
    return {
        "ok": True,
        "balance": balance,
        "testnet": use_testnet,
        "credentialsSaved": True,
        "perUser": user is not None,
        "message": message,
    }


@app.post("/api/reconnect")
def reconnect(
    body: ReconnectBody | None = None,
    user: User | None = Depends(get_optional_user),
    db: DbSession = Depends(get_db),
) -> dict[str, Any]:
    if user is not None:
        try:
            creds = load_credentials(db, user.id)
        except ValueError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        if not creds:
            raise HTTPException(status_code=401, detail="No saved API keys — connect with key and secret first")
        api_key, api_secret, use_testnet = creds
        if body and body.use_testnet is not None and body.use_testnet != use_testnet:
            use_testnet = body.use_testnet
            save_credentials(db, user.id, api_key, api_secret, use_testnet=use_testnet)
        session = _connect_session(api_key, api_secret, use_testnet=use_testnet)
        _set_session(user, session)
        balance = session.client.get_usdt_balance()
        return {
            "ok": True,
            "balance": balance,
            "testnet": use_testnet,
            "credentialsSaved": True,
            "perUser": True,
            "message": "Reconnected from encrypted account credentials",
        }

    if not auto_connect_from_env():
        raise HTTPException(status_code=401, detail="No saved API keys — connect with key and secret first")
    session = _get_session(None)
    assert session is not None
    balance = session.client.get_usdt_balance()
    return {
        "ok": True,
        "balance": balance,
        "testnet": session.config.use_testnet,
        "credentialsSaved": True,
        "perUser": False,
        "message": "Reconnected from saved .env credentials",
    }


@app.post("/api/disconnect")
def disconnect(
    body: DisconnectBody | None = None,
    user: User | None = Depends(get_optional_user),
    db: DbSession = Depends(get_db),
) -> dict[str, Any]:
    # Stop only this user's bot (legacy: the single shared bot).
    stop_bot(user.id if user is not None else None)
    _clear_session(user)
    if body and body.clear_saved_keys:
        if user is not None:
            delete_credentials(db, user.id)
            logger.info("User %s credentials removed from DB", user.id)
            return {"ok": True, "credentialsSaved": False, "perUser": True}
        clear_binance_credentials()
        logger.info("Legacy .env keys removed")
        return {"ok": True, "credentialsSaved": False, "perUser": False}
    saved = has_credentials(db, user.id) if user is not None else credentials_configured()
    logger.info("Session cleared (saved keys kept)")
    return {"ok": True, "credentialsSaved": saved, "perUser": user is not None}


@app.get("/api/status")
def status(user: User | None = Depends(get_optional_user)) -> dict[str, Any]:
    session = _get_session(user)
    if not session:
        return {"connected": False, "testnet": _use_testnet_flag(), "perUser": user is not None}

    client = session.client
    balance = client.get_usdt_balance()
    wallet_balance = client.get_account_equity()
    pos = client.get_position()

    result: dict[str, Any] = {
        "connected": True,
        "testnet": session.config.use_testnet,
        "perUser": user is not None,
        "balance": balance,
        "walletBalance": wallet_balance,
        "symbol": session.config.symbol,
        "leverage": session.config.leverage,
        "position": None,
    }

    if pos:
        sl_tp = client.get_sl_tp_orders()
        result["position"] = {
            "side": pos["side"],
            "quantity": pos["quantity"],
            "entryPrice": pos["entry_price"],
            "unrealizedPnl": pos["unrealized_pnl"],
            "leverage": pos["leverage"],
            "stopPrice": sl_tp["stop_price"],
            "takeProfitPrice": sl_tp["take_profit_price"],
        }

    return result


@app.post("/api/setup")
def setup(
    body: SetupBody,
    user: User | None = Depends(get_optional_user),
    session: TradingSession = Depends(require_trading_session),
) -> dict[str, Any]:
    config = session.config.with_trading_params(
        leverage=body.leverage,
        margin_type=body.margin_type,
        symbol=body.symbol,
    )
    client = BinanceFuturesClient(config)
    _set_session(user, TradingSession(config=config, client=client))

    try:
        client.setup_leverage_and_margin()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {"ok": True, "leverage": config.leverage, "marginType": config.margin_type}


@app.post("/api/order/open")
def open_order(
    body: OpenBody,
    user: User | None = Depends(get_optional_user),
    session: TradingSession = Depends(require_trading_session),
) -> dict[str, Any]:
    config = session.config.with_trading_params(
        leverage=body.leverage,
    )
    client = BinanceFuturesClient(config)
    _set_session(user, TradingSession(config=config, client=client))

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

    # Recompute SL/TP from actual fill price + % distances (not the signal candle).
    sl_tp: dict[str, Any] = {"stop_price": None, "take_profit_price": None}
    pos = client.get_position()
    entry_price = float(pos["entry_price"]) if pos else body.price
    stop_price, take_profit_price = _levels_at_entry(
        body.side,
        entry_price,
        ref_price=body.price,
        stop_loss_pct=body.stop_loss_pct,
        take_profit_pct=body.take_profit_pct,
        use_stop_loss=body.use_stop_loss,
        stop_price=body.stop_price,
        take_profit_price=body.take_profit_price,
    )
    if stop_price or take_profit_price:
        logger.info(
            "SL/TP at entry $%.2f — SL %s · TP %s",
            entry_price,
            f"${stop_price:.2f}" if stop_price else "없음",
            f"${take_profit_price:.2f}" if take_profit_price else "없음",
        )
    if stop_price or take_profit_price:
        try:
            sl_tp = client.set_sl_tp(
                body.side,
                stop_price,
                take_profit_price,
                entry_price=entry_price,
            )
        except Exception as exc:  # noqa: BLE001
            logger.error("SL/TP order failed after open — rolling back entry: %s", exc)
            rollback_error: str | None = None
            try:
                client.cancel_all_orders()
                pos = client.get_position()
                if pos:
                    if pos["side"] == "LONG":
                        client.close_long(pos["quantity"])
                    else:
                        client.close_short(pos["quantity"])
            except Exception as rb:  # noqa: BLE001
                rollback_error = str(rb)
                logger.error("Rollback close failed: %s", rb)
            detail = f"SL/TP 주문 실패로 진입을 자동 취소했습니다: {exc}"
            if rollback_error:
                detail += f" — 자동 청산도 실패했습니다. 포지션을 직접 확인하세요: {rollback_error}"
            raise HTTPException(status_code=400, detail=detail) from exc

    pos = client.get_position()
    return {
        "ok": True,
        "side": body.side,
        "quantity": qty,
        "position": pos,
        "stopPrice": sl_tp["stop_price"],
        "takeProfitPrice": sl_tp["take_profit_price"],
    }


@app.post("/api/order/sltp")
def set_sl_tp_order(
    body: SlTpBody,
    session: TradingSession = Depends(require_trading_session),
) -> dict[str, Any]:
    client = session.client
    pos = client.get_position()

    if not pos:
        raise HTTPException(status_code=400, detail="No open position")
    if not body.stop_price and not body.take_profit_price:
        raise HTTPException(status_code=400, detail="stop_price or take_profit_price required")

    try:
        sl_tp = client.set_sl_tp(
            pos["side"],
            body.stop_price,
            body.take_profit_price,
            entry_price=float(pos["entry_price"]),
        )
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {
        "ok": True,
        "side": pos["side"],
        "stopPrice": sl_tp["stop_price"],
        "takeProfitPrice": sl_tp["take_profit_price"],
    }


@app.post("/api/order/close")
def close_order(
    body: CloseOrderBody = CloseOrderBody(),
    session: TradingSession = Depends(require_trading_session),
) -> dict[str, Any]:
    client = session.client
    pos = client.get_position()
    uid = session.user_id

    if not pos:
        raise HTTPException(status_code=400, detail="No open position")

    # Pause BEFORE closing on the exchange. Otherwise the headless bot can see
    # a flat account + live entry signal and reopen in the same tick window.
    if is_running(uid) and body.manual:
        pause_bot_entry(
            user_id=uid,
            manual=True,
            interval=_strategy_interval(uid),
            bar_time=body.bar_time,
            blocked_signal=body.blocked_signal or pos["side"],
        )

    try:
        if pos["side"] == "LONG":
            client.close_long(pos["quantity"])
        else:
            client.close_short(pos["quantity"])
    except Exception as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Drop leftover SL/TP trigger orders so they can't fire on the next position.
    try:
        client.cancel_all_orders()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Failed to cancel open orders after close: %s", exc)

    return {"ok": True, "closed": pos["side"], "quantity": pos["quantity"]}


@app.post("/api/strategy/sync")
def strategy_sync(
    body: StrategySyncBody,
    user: User | None = Depends(get_optional_user),
) -> dict[str, Any]:
    if not body.strategy:
        raise HTTPException(status_code=400, detail="strategy payload required")
    path = save_strategy_json(body.strategy, user_id=user.id if user else None)
    return {"ok": True, "path": str(path), "userId": user.id if user else None}


@app.post("/api/bot/pause-entry")
def bot_pause_entry(user: User | None = Depends(get_optional_user)) -> dict[str, Any]:
    uid = user.id if user else None
    if not is_running(uid):
        return {"ok": True, "running": False, "message": "서버 봇이 실행 중이 아닙니다."}
    gate = pause_bot_entry(user_id=uid, manual=True, interval=_strategy_interval(uid))
    return {"ok": True, "running": True, "gate": gate}


@app.post("/api/bot/clear-entry-pause")
def bot_clear_entry_pause(user: User | None = Depends(get_optional_user)) -> dict[str, Any]:
    clear_entry_gate(user.id if user else None)
    return {"ok": True, "message": "진입 일시정지 해제"}


@app.get("/api/bot/status")
def get_bot_status(user: User | None = Depends(get_optional_user)) -> dict[str, Any]:
    return {"ok": True, **bot_status(user.id if user else None)}


@app.post("/api/bot/start")
def bot_start(
    body: BotStartBody | None = None,
    user: User | None = Depends(get_optional_user),
    db: DbSession = Depends(get_db),
) -> dict[str, Any]:
    session = _get_session(user)
    if not session:
        if user is not None:
            try:
                creds = load_credentials(db, user.id)
            except ValueError as exc:
                raise HTTPException(status_code=500, detail=str(exc)) from exc
            if not creds:
                raise HTTPException(status_code=401, detail="API key not connected — connect first")
            api_key, api_secret, use_testnet = creds
            session = _connect_session(api_key, api_secret, use_testnet=use_testnet)
            _set_session(user, session)
        elif not auto_connect_from_env():
            raise HTTPException(status_code=401, detail="API key not connected — connect first")
        else:
            session = _get_session(None)
    assert session is not None
    live = body.live_trading if body else True
    uid = user.id if user is not None else None
    try:
        if user is not None:
            return start_bot(
                user_id=uid,
                live_trading=live,
                api_key=session.config.api_key,
                api_secret=session.config.api_secret,
                use_testnet=session.config.use_testnet,
            )
        return start_bot(user_id=None, live_trading=live)
    except RuntimeError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc


@app.post("/api/bot/stop")
def bot_stop(user: User | None = Depends(get_optional_user)) -> dict[str, Any]:
    return stop_bot(user.id if user else None)


def main() -> None:
    uvicorn.run("bot.server:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":
    main()
