"""Admin / developer panel API — ADMIN_EMAILS whitelist only."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from bot.auth_routes import get_current_user
from bot.billing_service import ensure_subscription, ensure_usage, is_pro, mark_bot_stopped
from bot.db import get_db
from bot.email_service import smtp_configured
from bot.models import Subscription, UsageQuota, User
from bot.platform_config import (
    admin_emails,
    billing_configured,
    billing_enforce,
    free_bot_seconds_per_week,
    free_gpt_calls_per_week,
    free_max_strategy_slots,
    free_recommended_strategies_allowed,
    free_web_research_allowed,
    is_admin_email,
    max_concurrent_bots,
    pro_max_strategy_slots,
    resend_api_key,
    toss_pro_amount_krw,
)
from bot.server_bot import _count_running, is_running, stop_bot

router = APIRouter(prefix="/api/admin", tags=["admin"])


def require_admin(user: User = Depends(get_current_user)) -> User:
    if not is_admin_email(user.email):
        raise HTTPException(status_code=403, detail="관리자 권한이 없습니다.")
    return user


class SetActiveBody(BaseModel):
    active: bool


class SetPlanBody(BaseModel):
    plan: str = Field(pattern="^(free|pro)$")


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _user_row(db: Session, user: User) -> dict[str, Any]:
    sub = ensure_subscription(db, user.id)
    usage = ensure_usage(db, user.id)
    pro = is_pro(sub)
    manual_pro = bool(
        pro and not (sub.toss_billing_key_encrypted or "").strip()
    )
    return {
        "id": user.id,
        "email": user.email,
        "isActive": bool(user.is_active),
        "emailVerified": user.email_verified_at is not None,
        "createdAt": user.created_at.isoformat() if user.created_at else None,
        "plan": "pro" if pro else "free",
        "subscriptionStatus": sub.status,
        "manualPro": manual_pro,
        "cancelAtPeriodEnd": bool(sub.cancel_at_period_end),
        "currentPeriodEnd": sub.current_period_end.isoformat() if sub.current_period_end else None,
        "botRunning": is_running(user.id),
        "botHoursUsed": round(int(usage.bot_seconds_used or 0) / 3600, 2),
        "gptCallsUsed": int(usage.gpt_calls_used or 0),
        "weekStart": usage.week_start,
        "isAdmin": is_admin_email(user.email),
    }


@router.get("/me")
def admin_me(admin: User = Depends(require_admin)) -> dict[str, Any]:
    return {
        "ok": True,
        "admin": True,
        "email": admin.email,
        "adminEmailsConfigured": len(admin_emails()),
    }


@router.get("/overview")
def admin_overview(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    total = db.query(func.count(User.id)).scalar() or 0
    verified = (
        db.query(func.count(User.id)).filter(User.email_verified_at.isnot(None)).scalar() or 0
    )
    active = db.query(func.count(User.id)).filter(User.is_active.is_(True)).scalar() or 0
    pro_n = (
        db.query(func.count(Subscription.id))
        .filter(Subscription.plan == "pro", Subscription.status.in_(("active", "past_due")))
        .scalar()
        or 0
    )
    return {
        "ok": True,
        "usersTotal": int(total),
        "usersVerified": int(verified),
        "usersActive": int(active),
        "usersUnverified": int(total) - int(verified),
        "proSubscribers": int(pro_n),
        "botsRunning": int(_count_running()),
        "maxConcurrentBots": max_concurrent_bots(),
        "mailConfigured": smtp_configured(),
        "resendConfigured": bool(resend_api_key()),
        "paymentsConfigured": billing_configured(),
        "billingEnforce": billing_enforce(),
        "openaiConfigured": bool(os.getenv("OPENAI_API_KEY", "").strip()),
    }


@router.get("/users")
def admin_users(
    q: str = Query(default="", max_length=200),
    limit: int = Query(default=100, ge=1, le=500),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    query = db.query(User).order_by(User.id.desc())
    term = (q or "").strip()
    if term:
        like = f"%{term}%"
        if term.isdigit():
            query = query.filter(or_(User.email.ilike(like), User.id == int(term)))
        else:
            query = query.filter(User.email.ilike(like))
    rows = query.limit(limit).all()
    return {
        "ok": True,
        "count": len(rows),
        "users": [_user_row(db, u) for u in rows],
    }


@router.get("/users/{user_id}")
def admin_user_detail(
    user_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = db.query(User).filter(User.id == user_id).one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다.")
    return {"ok": True, "user": _user_row(db, user)}


@router.post("/users/{user_id}/verify-email")
def admin_verify_email(
    user_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = db.query(User).filter(User.id == user_id).one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다.")
    user.email_verified_at = _utcnow()
    db.commit()
    return {"ok": True, "user": _user_row(db, user), "message": "이메일 인증을 완료 처리했습니다."}


@router.post("/users/{user_id}/set-active")
def admin_set_active(
    user_id: int,
    body: SetActiveBody,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = db.query(User).filter(User.id == user_id).one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다.")
    if user.id == admin.id and not body.active:
        raise HTTPException(status_code=400, detail="본인 계정은 비활성화할 수 없습니다.")
    user.is_active = bool(body.active)
    db.commit()
    if not user.is_active and is_running(user.id):
        stop_bot(user.id)
        mark_bot_stopped(db, user.id)
    return {"ok": True, "user": _user_row(db, user)}


@router.post("/users/{user_id}/set-plan")
def admin_set_plan(
    user_id: int,
    body: SetPlanBody,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = db.query(User).filter(User.id == user_id).one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다.")
    sub = ensure_subscription(db, user.id)
    plan = body.plan.lower().strip()
    if plan == "pro":
        sub.plan = "pro"
        sub.status = "active"
        sub.cancel_at_period_end = False
        # Manual grant — no Toss billing key required
        if not sub.current_period_end or sub.current_period_end < _utcnow():
            sub.current_period_end = _utcnow() + timedelta(days=365)
        message = "수동 Pro를 부여했습니다 (결제키 없음 · 운영용)."
    else:
        sub.plan = "free"
        sub.status = "canceled"
        sub.cancel_at_period_end = False
        sub.current_period_end = None
        message = "Free로 내렸습니다."
    db.commit()
    return {"ok": True, "user": _user_row(db, user), "message": message}


@router.post("/users/{user_id}/reset-quota")
def admin_reset_quota(
    user_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = db.query(User).filter(User.id == user_id).one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다.")
    usage = ensure_usage(db, user.id)
    usage.bot_seconds_used = 0
    usage.gpt_calls_used = 0
    # Keep session start if bot still running — flush baseline to now
    if usage.bot_session_started_at is not None:
        usage.bot_session_started_at = _utcnow()
    db.commit()
    return {"ok": True, "user": _user_row(db, user), "message": "주간 쿼터를 리셋했습니다."}


@router.post("/users/{user_id}/stop-bot")
def admin_stop_bot(
    user_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = db.query(User).filter(User.id == user_id).one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다.")
    result = stop_bot(user.id)
    mark_bot_stopped(db, user.id)
    return {
        "ok": True,
        "user": _user_row(db, user),
        "bot": result,
        "message": "봇을 정지했습니다." if result.get("ok") else result.get("message", "정지 요청 완료"),
    }


@router.get("/settings")
def admin_settings(admin: User = Depends(require_admin)) -> dict[str, Any]:
    return {
        "ok": True,
        "note": "한도·키는 서버 .env에서 변경 후 crypto-web 재시작이 필요합니다.",
        "limits": {
            "freeBotHoursPerWeek": round(free_bot_seconds_per_week() / 3600, 2),
            "freeGptCallsPerWeek": free_gpt_calls_per_week(),
            "freeMaxStrategySlots": free_max_strategy_slots(),
            "proMaxStrategySlots": pro_max_strategy_slots(),
            "freeWebResearch": free_web_research_allowed(),
            "freeRecommendedStrategies": free_recommended_strategies_allowed(),
            "maxConcurrentBots": max_concurrent_bots(),
            "proAmountKrw": toss_pro_amount_krw(),
        },
        "flags": {
            "billingEnforce": billing_enforce(),
            "mailConfigured": smtp_configured(),
            "resendConfigured": bool(resend_api_key()),
            "paymentsConfigured": billing_configured(),
            "openaiConfigured": bool(os.getenv("OPENAI_API_KEY", "").strip()),
            "adminEmailsCount": len(admin_emails()),
        },
    }
