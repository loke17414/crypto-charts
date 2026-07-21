"""Billing API — Toss Payments billing-key subscribe / cancel + usage."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from bot.auth_routes import get_current_user
from bot.billing_service import (
    cancel_subscription,
    confirm_billing_auth,
    list_payment_history,
    prepare_billing_auth,
    resume_subscription,
    usage_snapshot,
)
from bot.db import get_db
from bot.models import User
from bot.platform_config import (
    billing_configured,
    billing_enforce,
    free_bot_seconds_per_week,
    free_gpt_calls_per_week,
    free_max_strategy_slots,
    free_recommended_strategies_allowed,
    free_web_research_allowed,
    pro_max_strategy_slots,
    toss_client_key,
    toss_pro_amount_krw,
)
from bot.rate_limit import RateLimiter, client_ip
from bot.server_bot import is_running

router = APIRouter(prefix="/api/billing", tags=["billing"])

_billing_limiter = RateLimiter(max_calls=20, window_seconds=3600)


class ConfirmBody(BaseModel):
    authKey: str = Field(min_length=1, max_length=400)
    customerKey: str = Field(min_length=2, max_length=300)


class CancelBody(BaseModel):
    immediate: bool = False


@router.get("/me")
def billing_me(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    running = is_running(user.id)
    snap = usage_snapshot(db, user.id, running=running)
    return {
        "ok": True,
        **snap,
        "limits": {
            "freeBotHoursPerWeek": round(free_bot_seconds_per_week() / 3600, 2),
            "freeGptCallsPerWeek": free_gpt_calls_per_week(),
            "freeMaxStrategySlots": free_max_strategy_slots(),
            "proMaxStrategySlots": pro_max_strategy_slots(),
            "freeWebResearch": free_web_research_allowed(),
            "freeRecommendedStrategies": free_recommended_strategies_allowed(),
        },
    }


@router.get("/status")
def billing_status() -> dict[str, Any]:
    return {
        "ok": True,
        "provider": "toss",
        "paymentsConfigured": billing_configured(),
        "enforce": billing_enforce(),
        "clientKey": toss_client_key() or None,
        "amountKrw": toss_pro_amount_krw(),
        "limits": {
            "freeBotHoursPerWeek": round(free_bot_seconds_per_week() / 3600, 2),
            "freeGptCallsPerWeek": free_gpt_calls_per_week(),
            "freeMaxStrategySlots": free_max_strategy_slots(),
            "proMaxStrategySlots": pro_max_strategy_slots(),
            "freeWebResearch": free_web_research_allowed(),
            "freeRecommendedStrategies": free_recommended_strategies_allowed(),
        },
    }


@router.post("/prepare")
def billing_prepare(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Return Toss clientKey + customerKey for requestBillingAuth."""
    return prepare_billing_auth(db, user)


@router.post("/confirm")
def billing_confirm(
    body: ConfirmBody,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Exchange authKey → billingKey, charge first month, activate Pro."""
    ip = client_ip(request)
    allowed, retry_after = _billing_limiter.check(f"billing-confirm:{ip}:{user.id}")
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"결제 시도가 너무 많습니다. {retry_after}초 후에 다시 시도해 주세요.",
            headers={"Retry-After": str(retry_after)},
        )
    return confirm_billing_auth(db, user, body.authKey, body.customerKey)


@router.post("/cancel")
def billing_cancel(
    body: CancelBody | None = None,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    immediate = bool(body.immediate) if body else False
    return cancel_subscription(db, user, immediate=immediate)


@router.post("/resume")
def billing_resume(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Undo cancel-at-period-end while the paid period remains."""
    return resume_subscription(db, user)


@router.get("/history")
def billing_history(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    rows = list_payment_history(db, user.id, limit=50)
    return {"ok": True, "count": len(rows), "payments": rows}
