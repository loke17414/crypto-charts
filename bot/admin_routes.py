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
from bot.auth_service import request_password_reset, resend_verification
from bot.billing_service import (
    cancel_subscription,
    ensure_subscription,
    ensure_usage,
    is_pro,
    mark_bot_stopped,
    usage_snapshot,
)
from bot.db import get_db
from bot.email_service import smtp_configured
from bot.models import AdminAuditLog, ExchangeCredential, Subscription, User
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
from bot.server_bot import (
    bot_diagnostics,
    bot_status,
    clear_entry_gate,
    is_running,
    list_bot_fleet,
    load_strategy_json,
    pause_bot_entry,
    stop_all_bots,
    stop_bot,
    tail_bot_logs,
    _count_running,
)
from bot.user_credentials import delete_credentials
from bot.user_openai import delete_openai_key, has_openai_key

router = APIRouter(prefix="/api/admin", tags=["admin"])


def require_admin(user: User = Depends(get_current_user)) -> User:
    if not is_admin_email(user.email):
        raise HTTPException(status_code=403, detail="관리자 권한이 없습니다.")
    return user


class SetActiveBody(BaseModel):
    active: bool


class SetPlanBody(BaseModel):
    plan: str = Field(pattern="^(free|pro)$")
    days: int | None = Field(default=None, ge=1, le=3650)


class GrantProBody(BaseModel):
    days: int = Field(default=30, ge=1, le=3650)


class SetQuotaBody(BaseModel):
    botHoursUsed: float | None = Field(default=None, ge=0, le=10000)
    gptCallsUsed: int | None = Field(default=None, ge=0, le=1_000_000)


class CancelSubBody(BaseModel):
    immediate: bool = False


class PauseEntryBody(BaseModel):
    minutes: int = Field(default=15, ge=1, le=1440)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _audit(
    db: Session,
    admin: User,
    action: str,
    *,
    target_user_id: int | None = None,
    detail: str = "",
) -> None:
    db.add(
        AdminAuditLog(
            admin_id=admin.id,
            admin_email=admin.email,
            action=action[:64],
            target_user_id=target_user_id,
            detail=(detail or "")[:500],
        )
    )
    db.commit()


def _get_user_or_404(db: Session, user_id: int) -> User:
    user = db.query(User).filter(User.id == user_id).one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="사용자를 찾을 수 없습니다.")
    return user


def _cred_meta(db: Session, user_id: int) -> dict[str, Any]:
    row = (
        db.query(ExchangeCredential)
        .filter(ExchangeCredential.user_id == user_id)
        .one_or_none()
    )
    return {
        "hasBinanceKeys": row is not None,
        "binanceTestnet": bool(row.use_testnet) if row else None,
        "binanceUpdatedAt": row.updated_at.isoformat() if row and row.updated_at else None,
        "hasOpenAiKey": has_openai_key(db, user_id),
    }


def _strategy_summary(user_id: int) -> dict[str, Any]:
    data = load_strategy_json(user_id)
    if not data:
        return {"exists": False}
    secret_keys = {"apiKey", "apiSecret", "secret", "password", "token", "authorization"}
    safe = {k: v for k, v in data.items() if k not in secret_keys}
    slots = safe.get("slots") or safe.get("strategies") or safe.get("items")
    slot_count = len(slots) if isinstance(slots, list) else None
    return {
        "exists": True,
        "symbol": safe.get("symbol") or safe.get("pair") or safe.get("market"),
        "interval": safe.get("interval") or safe.get("timeframe"),
        "slotCount": slot_count,
        "keys": list(safe.keys())[:40],
        "strategy": safe,
    }


def _user_row(db: Session, user: User) -> dict[str, Any]:
    sub = ensure_subscription(db, user.id)
    usage = ensure_usage(db, user.id)
    pro = is_pro(sub)
    manual_pro = bool(pro and not (sub.toss_billing_key_encrypted or "").strip())
    snap = usage_snapshot(db, user.id, running=is_running(user.id))
    meta = _cred_meta(db, user.id)
    return {
        "id": user.id,
        "email": user.email,
        "isActive": bool(user.is_active),
        "emailVerified": user.email_verified_at is not None,
        "termsAccepted": user.terms_accepted_at is not None,
        "createdAt": user.created_at.isoformat() if user.created_at else None,
        "plan": "pro" if pro else "free",
        "subscriptionStatus": sub.status,
        "manualPro": manual_pro,
        "hasBillingKey": bool((sub.toss_billing_key_encrypted or "").strip()),
        "cancelAtPeriodEnd": bool(sub.cancel_at_period_end),
        "currentPeriodEnd": sub.current_period_end.isoformat() if sub.current_period_end else None,
        "botRunning": is_running(user.id),
        "botHoursUsed": round(int(usage.bot_seconds_used or 0) / 3600, 2),
        "gptCallsUsed": int(usage.gpt_calls_used or 0),
        "botHoursRemaining": (snap.get("bot") or {}).get("remainingHours"),
        "gptRemaining": (snap.get("gpt") or {}).get("remaining"),
        "weekStart": usage.week_start,
        "isAdmin": is_admin_email(user.email),
        **meta,
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
    now = _utcnow()
    signups_7d = (
        db.query(func.count(User.id)).filter(User.created_at >= now - timedelta(days=7)).scalar()
        or 0
    )
    signups_30d = (
        db.query(func.count(User.id)).filter(User.created_at >= now - timedelta(days=30)).scalar()
        or 0
    )
    with_keys = db.query(func.count(ExchangeCredential.id)).scalar() or 0
    diag = bot_diagnostics()
    return {
        "ok": True,
        "usersTotal": int(total),
        "usersVerified": int(verified),
        "usersActive": int(active),
        "usersUnverified": int(total) - int(verified),
        "proSubscribers": int(pro_n),
        "signups7d": int(signups_7d),
        "signups30d": int(signups_30d),
        "usersWithBinanceKeys": int(with_keys),
        "botsRunning": int(_count_running()),
        "maxConcurrentBots": max_concurrent_bots(),
        "mailConfigured": smtp_configured(),
        "resendConfigured": bool(resend_api_key()),
        "paymentsConfigured": billing_configured(),
        "billingEnforce": billing_enforce(),
        "openaiConfigured": bool(os.getenv("OPENAI_API_KEY", "").strip()),
        "botDiagnostics": diag,
    }


@router.get("/audit")
def admin_audit(
    limit: int = Query(default=80, ge=1, le=300),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    rows = (
        db.query(AdminAuditLog)
        .order_by(AdminAuditLog.id.desc())
        .limit(limit)
        .all()
    )
    actions = [
        {
            "at": r.created_at.isoformat() if r.created_at else None,
            "adminId": r.admin_id,
            "adminEmail": r.admin_email,
            "action": r.action,
            "targetUserId": r.target_user_id,
            "detail": r.detail,
        }
        for r in rows
    ]
    return {"ok": True, "count": len(actions), "actions": actions}


@router.get("/users")
def admin_users(
    q: str = Query(default="", max_length=200),
    plan: str = Query(default="all", pattern="^(all|free|pro)$"),
    active: str = Query(default="all", pattern="^(all|true|false)$"),
    verified: str = Query(default="all", pattern="^(all|true|false)$"),
    bot: str = Query(default="all", pattern="^(all|running|stopped)$"),
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
    if active == "true":
        query = query.filter(User.is_active.is_(True))
    elif active == "false":
        query = query.filter(User.is_active.is_(False))
    if verified == "true":
        query = query.filter(User.email_verified_at.isnot(None))
    elif verified == "false":
        query = query.filter(User.email_verified_at.is_(None))

    # Over-fetch when plan/bot filters need post-processing
    fetch_limit = limit if plan == "all" and bot == "all" else min(500, max(limit * 3, 150))
    rows = query.limit(fetch_limit).all()
    users = [_user_row(db, u) for u in rows]
    if plan in ("free", "pro"):
        users = [u for u in users if u["plan"] == plan]
    if bot == "running":
        users = [u for u in users if u["botRunning"]]
    elif bot == "stopped":
        users = [u for u in users if not u["botRunning"]]
    users = users[:limit]
    return {"ok": True, "count": len(users), "users": users}


@router.get("/users/{user_id}")
def admin_user_detail(
    user_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _get_user_or_404(db, user_id)
    status = bot_status(user.id)
    return {
        "ok": True,
        "user": _user_row(db, user),
        "usage": usage_snapshot(db, user.id, running=bool(status.get("running"))),
        "bot": status,
        "strategy": _strategy_summary(user.id),
        "recentLogs": tail_bot_logs(40, user_id=user.id),
    }


@router.post("/users/{user_id}/verify-email")
def admin_verify_email(
    user_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _get_user_or_404(db, user_id)
    user.email_verified_at = _utcnow()
    db.commit()
    _audit(db, admin, "verify-email", target_user_id=user.id)
    return {"ok": True, "user": _user_row(db, user), "message": "이메일 인증을 완료 처리했습니다."}


@router.post("/users/{user_id}/resend-verify")
def admin_resend_verify(
    user_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _get_user_or_404(db, user_id)
    try:
        result = resend_verification(db, user.email)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _audit(db, admin, "resend-verify", target_user_id=user.id)
    return {"ok": True, "user": _user_row(db, user), **result}


@router.post("/users/{user_id}/send-password-reset")
def admin_send_password_reset(
    user_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _get_user_or_404(db, user_id)
    try:
        result = request_password_reset(db, user.email)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _audit(db, admin, "send-password-reset", target_user_id=user.id)
    return {"ok": True, "user": _user_row(db, user), **result}


@router.post("/users/{user_id}/set-active")
def admin_set_active(
    user_id: int,
    body: SetActiveBody,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _get_user_or_404(db, user_id)
    if user.id == admin.id and not body.active:
        raise HTTPException(status_code=400, detail="본인 계정은 비활성화할 수 없습니다.")
    user.is_active = bool(body.active)
    db.commit()
    if not user.is_active and is_running(user.id):
        stop_bot(user.id)
        mark_bot_stopped(db, user.id)
    _audit(db, admin, "set-active", target_user_id=user.id, detail=str(body.active))
    return {"ok": True, "user": _user_row(db, user)}


@router.post("/users/{user_id}/set-plan")
def admin_set_plan(
    user_id: int,
    body: SetPlanBody,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _get_user_or_404(db, user_id)
    sub = ensure_subscription(db, user.id)
    plan = body.plan.lower().strip()
    days = body.days or 365
    if plan == "pro":
        sub.plan = "pro"
        sub.status = "active"
        sub.cancel_at_period_end = False
        sub.current_period_end = _utcnow() + timedelta(days=days)
        message = f"수동 Pro {days}일 부여 (결제키 없음 · 운영용)."
    else:
        sub.plan = "free"
        sub.status = "canceled"
        sub.cancel_at_period_end = False
        sub.current_period_end = None
        message = "Free로 내렸습니다."
    db.commit()
    _audit(db, admin, "set-plan", target_user_id=user.id, detail=f"{plan}:{days if plan == 'pro' else 0}")
    return {"ok": True, "user": _user_row(db, user), "message": message}


@router.post("/users/{user_id}/grant-pro")
def admin_grant_pro(
    user_id: int,
    body: GrantProBody,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _get_user_or_404(db, user_id)
    sub = ensure_subscription(db, user.id)
    now = _utcnow()
    base = sub.current_period_end if sub.current_period_end and sub.current_period_end > now else now
    if base.tzinfo is None:
        base = base.replace(tzinfo=timezone.utc)
    sub.plan = "pro"
    sub.status = "active"
    sub.cancel_at_period_end = False
    sub.current_period_end = base + timedelta(days=body.days)
    db.commit()
    _audit(db, admin, "grant-pro", target_user_id=user.id, detail=f"+{body.days}d")
    return {
        "ok": True,
        "user": _user_row(db, user),
        "message": f"Pro +{body.days}일 (종료 {sub.current_period_end.isoformat()})",
    }


@router.post("/users/{user_id}/cancel-subscription")
def admin_cancel_subscription(
    user_id: int,
    body: CancelSubBody,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _get_user_or_404(db, user_id)
    try:
        result = cancel_subscription(db, user, immediate=body.immediate)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _audit(
        db,
        admin,
        "cancel-subscription",
        target_user_id=user.id,
        detail="immediate" if body.immediate else "period-end",
    )
    return {"ok": True, "user": _user_row(db, user), **result}


@router.post("/users/{user_id}/reset-quota")
def admin_reset_quota(
    user_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _get_user_or_404(db, user_id)
    usage = ensure_usage(db, user.id)
    usage.bot_seconds_used = 0
    usage.gpt_calls_used = 0
    if usage.bot_session_started_at is not None:
        usage.bot_session_started_at = _utcnow()
    db.commit()
    _audit(db, admin, "reset-quota", target_user_id=user.id)
    return {"ok": True, "user": _user_row(db, user), "message": "주간 쿼터를 리셋했습니다."}


@router.post("/users/{user_id}/set-quota")
def admin_set_quota(
    user_id: int,
    body: SetQuotaBody,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _get_user_or_404(db, user_id)
    if body.botHoursUsed is None and body.gptCallsUsed is None:
        raise HTTPException(status_code=400, detail="botHoursUsed 또는 gptCallsUsed가 필요합니다.")
    usage = ensure_usage(db, user.id)
    parts: list[str] = []
    if body.botHoursUsed is not None:
        usage.bot_seconds_used = int(round(body.botHoursUsed * 3600))
        parts.append(f"bot={body.botHoursUsed}h")
    if body.gptCallsUsed is not None:
        usage.gpt_calls_used = int(body.gptCallsUsed)
        parts.append(f"gpt={body.gptCallsUsed}")
    if usage.bot_session_started_at is not None:
        usage.bot_session_started_at = _utcnow()
    db.commit()
    _audit(db, admin, "set-quota", target_user_id=user.id, detail=",".join(parts))
    return {"ok": True, "user": _user_row(db, user), "message": "쿼터를 수정했습니다."}


@router.post("/users/{user_id}/stop-bot")
def admin_stop_bot(
    user_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _get_user_or_404(db, user_id)
    result = stop_bot(user.id)
    mark_bot_stopped(db, user.id)
    _audit(db, admin, "stop-bot", target_user_id=user.id)
    return {
        "ok": True,
        "user": _user_row(db, user),
        "bot": result,
        "message": "봇을 정지했습니다." if result.get("ok") else result.get("message", "정지 요청 완료"),
    }


@router.post("/users/{user_id}/clear-entry-gate")
def admin_clear_entry_gate(
    user_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _get_user_or_404(db, user_id)
    clear_entry_gate(user.id)
    _audit(db, admin, "clear-entry-gate", target_user_id=user.id)
    return {"ok": True, "user": _user_row(db, user), "bot": bot_status(user.id), "message": "진입 게이트를 해제했습니다."}


@router.post("/users/{user_id}/pause-entry")
def admin_pause_entry(
    user_id: int,
    body: PauseEntryBody,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _get_user_or_404(db, user_id)
    # reuse pause helper with approximate interval
    interval = "15m" if body.minutes <= 15 else ("1h" if body.minutes <= 60 else "4h")
    gate = pause_bot_entry(user_id=user.id, manual=True, interval=interval)
    _audit(db, admin, "pause-entry", target_user_id=user.id, detail=f"{body.minutes}m")
    return {
        "ok": True,
        "user": _user_row(db, user),
        "entryGate": gate,
        "message": f"진입을 약 {body.minutes}분 일시 중지했습니다.",
    }


@router.post("/users/{user_id}/delete-binance-keys")
def admin_delete_binance_keys(
    user_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _get_user_or_404(db, user_id)
    if is_running(user.id):
        stop_bot(user.id)
        mark_bot_stopped(db, user.id)
    deleted = delete_credentials(db, user.id)
    _audit(db, admin, "delete-binance-keys", target_user_id=user.id, detail=str(deleted))
    return {
        "ok": True,
        "user": _user_row(db, user),
        "deleted": deleted,
        "message": "바이낸스 키를 삭제했습니다." if deleted else "저장된 바이낸스 키가 없습니다.",
    }


@router.post("/users/{user_id}/delete-openai-key")
def admin_delete_openai_key(
    user_id: int,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _get_user_or_404(db, user_id)
    deleted = delete_openai_key(db, user.id)
    _audit(db, admin, "delete-openai-key", target_user_id=user.id, detail=str(deleted))
    return {
        "ok": True,
        "user": _user_row(db, user),
        "deleted": deleted,
        "message": "OpenAI 키를 삭제했습니다." if deleted else "저장된 OpenAI 키가 없습니다.",
    }


@router.get("/bots")
def admin_bots(admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> dict[str, Any]:
    fleet = list_bot_fleet()
    enriched = []
    for row in fleet:
        uid = row.get("userId")
        email = None
        if uid:
            user = db.query(User).filter(User.id == uid).one_or_none()
            email = user.email if user else None
        enriched.append({**row, "email": email})
    return {
        "ok": True,
        "count": len(enriched),
        "bots": enriched,
        "diagnostics": bot_diagnostics(),
    }


@router.post("/bots/stop-all")
def admin_stop_all_bots(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    before = list_bot_fleet()
    stop_all_bots()
    for row in before:
        uid = row.get("userId")
        if uid:
            mark_bot_stopped(db, int(uid))
    _audit(db, admin, "stop-all-bots", detail=f"targets={len(before)}")
    return {
        "ok": True,
        "stopped": len(before),
        "bots": list_bot_fleet(),
        "message": f"{len(before)}개 봇 정지 요청을 보냈습니다.",
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
        "botDiagnostics": bot_diagnostics(),
    }
