"""Billing API — Toss Payments billing-key subscribe / cancel + usage."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from bot.auth_routes import get_current_user
from bot.billing_service import (
    apply_toss_webhook_event,
    cancel_subscription,
    confirm_billing_auth,
    list_payment_history,
    prepare_billing_auth,
    purchase_gpt_pack,
    resume_subscription,
    usage_snapshot,
)
from bot.db import get_db
from bot.models import User
from bot.platform_config import (
    auth_required,
    billing_configured,
    billing_enforce,
    free_bot_seconds_per_week,
    free_gpt_calls_per_week,
    free_max_strategy_slots,
    free_recommended_strategies_allowed,
    free_web_research_allowed,
    gpt_pack_amount_krw,
    gpt_pack_calls,
    pro_gpt_calls_per_week,
    pro_max_strategy_slots,
    toss_client_key,
    toss_pro_amount_krw,
    toss_pro_annual_amount_krw,
    toss_webhook_secret,
)
from bot.rate_limit import RateLimiter, client_ip
from bot.server_bot import is_running

router = APIRouter(prefix="/api/billing", tags=["billing"])

_billing_limiter = RateLimiter(max_calls=20, window_seconds=3600)


class ConfirmBody(BaseModel):
    authKey: str = Field(min_length=1, max_length=400)
    customerKey: str = Field(min_length=2, max_length=300)
    product: Literal["month", "year", "monthly", "annual", "yearly"] | None = "month"


class PrepareBody(BaseModel):
    product: Literal["month", "year", "monthly", "annual", "yearly"] | None = "month"


class CancelBody(BaseModel):
    immediate: bool = False


def _limits_payload() -> dict[str, Any]:
    return {
        "freeBotHoursPerWeek": round(free_bot_seconds_per_week() / 3600, 2),
        "freeGptCallsPerWeek": free_gpt_calls_per_week(),
        "proGptCallsPerWeek": pro_gpt_calls_per_week(),
        "freeMaxStrategySlots": free_max_strategy_slots(),
        "proMaxStrategySlots": pro_max_strategy_slots(),
        "freeWebResearch": free_web_research_allowed(),
        "freeRecommendedStrategies": free_recommended_strategies_allowed(),
        "monthlyAmountKrw": toss_pro_amount_krw(),
        "annualAmountKrw": toss_pro_annual_amount_krw(),
        "gptPackAmountKrw": gpt_pack_amount_krw(),
        "gptPackCalls": gpt_pack_calls(),
    }


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
        "limits": _limits_payload(),
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
        "monthlyAmountKrw": toss_pro_amount_krw(),
        "annualAmountKrw": toss_pro_annual_amount_krw(),
        "limits": _limits_payload(),
    }


@router.post("/prepare")
def billing_prepare(
    body: PrepareBody = PrepareBody(),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Return Toss clientKey + customerKey for requestBillingAuth."""
    return prepare_billing_auth(db, user, interval=body.product or "month")


@router.post("/confirm")
def billing_confirm(
    body: ConfirmBody,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Exchange authKey → billingKey, charge first period, activate Pro."""
    ip = client_ip(request)
    allowed, retry_after = _billing_limiter.check(f"billing-confirm:{ip}:{user.id}")
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"결제 시도가 너무 많습니다. {retry_after}초 후에 다시 시도해 주세요.",
            headers={"Retry-After": str(retry_after)},
        )
    from bot.activity_log import log_user_activity

    result = confirm_billing_auth(
        db,
        user,
        body.authKey,
        body.customerKey,
        interval=body.product or "month",
    )
    log_user_activity(
        db,
        user_id=user.id,
        action="subscribe",
        detail=f"pro {body.product or 'month'}",
        ip=ip,
    )
    return result


@router.post("/gpt-pack")
def billing_gpt_pack(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """One-time GPT call pack charged to the saved billing key."""
    ip = client_ip(request)
    allowed, retry_after = _billing_limiter.check(f"billing-gpt-pack:{ip}:{user.id}")
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"결제 시도가 너무 많습니다. {retry_after}초 후에 다시 시도해 주세요.",
            headers={"Retry-After": str(retry_after)},
        )
    from bot.activity_log import log_user_activity

    result = purchase_gpt_pack(db, user)
    log_user_activity(
        db,
        user_id=user.id,
        action="gpt_pack",
        detail=str(result.get("addedCalls") or ""),
        ip=ip,
    )
    return result


@router.post("/cancel")
def billing_cancel(
    body: CancelBody,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    from bot.activity_log import log_user_activity

    result = cancel_subscription(db, user, immediate=body.immediate)
    log_user_activity(
        db,
        user_id=user.id,
        action="cancel_subscription",
        detail="immediate" if body.immediate else "period_end",
    )
    return result


@router.post("/resume")
def billing_resume(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    from bot.activity_log import log_user_activity

    result = resume_subscription(db, user)
    log_user_activity(db, user_id=user.id, action="resume_subscription", detail="")
    return result


@router.get("/history")
def billing_history(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    return {"ok": True, "payments": list_payment_history(db, user.id)}


@router.post("/webhook/toss")
async def billing_toss_webhook(
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    """Toss dashboard webhook — public path; secret required when billing is live."""
    secret = toss_webhook_secret()
    if billing_configured() and auth_required() and not secret:
        raise HTTPException(
            status_code=503,
            detail="TOSS_WEBHOOK_SECRET가 필요합니다. 결제 웹훅을 활성화하기 전에 설정하세요.",
        )
    if secret:
        got = (request.headers.get("X-Orbinex-Webhook-Secret") or "").strip()
        if got != secret:
            raise HTTPException(status_code=401, detail="webhook secret mismatch")
    try:
        payload = await request.json()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail="invalid JSON body") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="webhook body must be an object")
    return apply_toss_webhook_event(db, payload)
