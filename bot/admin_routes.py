"""Admin / developer panel API — ADMIN_EMAILS whitelist only."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from bot.activity_log import list_recent_activity, list_user_activity
from bot.auth_routes import get_current_user
from bot.auth_service import request_password_reset, resend_verification
from bot.billing_service import (
    cancel_subscription,
    cancel_toss_payment,
    clear_stored_billing_key,
    ensure_subscription,
    ensure_usage,
    is_pro,
    list_payment_history,
    mark_bot_stopped,
    usage_snapshot,
)
from bot.db import get_db
from bot.email_service import smtp_configured
from bot.models import AdminAuditLog, ExchangeCredential, Subscription, User
from bot.platform_config import (
    ADMIN_EDITABLE_SETTINGS,
    admin_emails,
    app_origin,
    auth_required,
    billing_configured,
    billing_enforce,
    business_profile,
    current_editable_settings,
    free_bot_seconds_per_week,
    free_gpt_calls_per_week,
    free_max_strategy_slots,
    free_recommended_strategies_allowed,
    free_web_research_allowed,
    gpt_pack_amount_krw,
    gpt_pack_calls,
    is_admin_email,
    live_trading_enabled,
    max_concurrent_bots,
    pro_gpt_calls_per_week,
    pro_max_strategy_slots,
    resend_api_key,
    support_email,
    toss_pro_amount_krw,
    toss_pro_annual_amount_krw,
    toss_webhook_secret,
    upsert_env_values,
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


class RefundPaymentBody(BaseModel):
    paymentKey: str = Field(min_length=4, max_length=200)
    reason: str = Field(default="관리자 환불", max_length=200)
    cancelAmount: int | None = Field(default=None, ge=1)


class PauseEntryBody(BaseModel):
    minutes: int = Field(default=15, ge=1, le=1440)


class UpdateSettingsBody(BaseModel):
    settings: dict[str, Any] = Field(default_factory=dict)


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
    # Snapshot first — may renew/expire the subscription before we read plan fields.
    snap = usage_snapshot(db, user.id, running=is_running(user.id))
    sub = ensure_subscription(db, user.id)
    usage = ensure_usage(db, user.id)
    pro = is_pro(sub)
    manual_pro = bool(pro and not (sub.toss_billing_key_encrypted or "").strip())
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


@router.get("/openai-calls")
def admin_openai_calls(
    limit: int = Query(default=50, ge=1, le=200),
    admin: User = Depends(require_admin),
) -> dict[str, Any]:
    """Recent OpenAI chat completions from this server (idle leak detector)."""
    from bot.strategy_ai import recent_openai_chat_calls

    _ = admin
    calls = recent_openai_chat_calls(limit)
    return {"ok": True, "count": len(calls), "calls": calls}


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
    # Always drop billing key so renew cron cannot surprise-charge after admin edits.
    clear_stored_billing_key(db, sub, delete_remote=billing_configured())
    sub = ensure_subscription(db, user.id)
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
    # Complimentary grant must not keep a Toss billing key (would auto-renew).
    clear_stored_billing_key(db, sub, delete_remote=billing_configured())
    sub = ensure_subscription(db, user.id)
    now = _utcnow()
    base = sub.current_period_end if sub.current_period_end and sub.current_period_end > now else now
    if base.tzinfo is None:
        base = base.replace(tzinfo=timezone.utc)
    sub.plan = "pro"
    sub.status = "active"
    sub.cancel_at_period_end = False
    if not getattr(sub, "billing_interval", None):
        sub.billing_interval = "month"
    sub.current_period_end = base + timedelta(days=body.days)
    db.commit()
    _audit(db, admin, "grant-pro", target_user_id=user.id, detail=f"+{body.days}d")
    return {
        "ok": True,
        "user": _user_row(db, user),
        "message": f"Pro +{body.days}일 (종료 {sub.current_period_end.isoformat()} · 결제키 제거)",
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


@router.get("/users/{user_id}/payments")
def admin_user_payments(
    user_id: int,
    limit: int = Query(default=30, ge=1, le=100),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _get_user_or_404(db, user_id)
    _ = admin
    return {"ok": True, "userId": user.id, "payments": list_payment_history(db, user.id, limit=limit)}


@router.post("/users/{user_id}/refund-payment")
def admin_refund_payment(
    user_id: int,
    body: RefundPaymentBody,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = _get_user_or_404(db, user_id)
    try:
        result = cancel_toss_payment(
            db,
            payment_key=body.paymentKey,
            reason=body.reason,
            cancel_amount=body.cancelAmount,
            actor_user_id=admin.id,
            expected_user_id=user.id,
            reverse_entitlements=True,
        )
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _audit(
        db,
        admin,
        "refund-payment",
        target_user_id=user.id,
        detail=f"{body.paymentKey[:16]}… {body.reason}"[:200],
    )
    msg = "토스 결제 취소/환불을 요청했습니다."
    if result.get("entitlementsReversed"):
        msg += " 관련 Pro/AI 팩 권한도 회수했습니다."
    return {"ok": True, "user": _user_row(db, user), **result, "message": msg}


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
    _ = admin
    profile = business_profile()
    return {
        "ok": True,
        "note": "아래 항목은 관리자 콘솔에서 저장하면 .env에 바로 반영됩니다. 시크릿 키는 표시·수정하지 않습니다.",
        "editable": current_editable_settings(),
        "limits": {
            "freeBotHoursPerWeek": round(free_bot_seconds_per_week() / 3600, 2),
            "freeGptCallsPerWeek": free_gpt_calls_per_week(),
            "proGptCallsPerWeek": pro_gpt_calls_per_week(),
            "freeMaxStrategySlots": free_max_strategy_slots(),
            "proMaxStrategySlots": pro_max_strategy_slots(),
            "freeWebResearch": free_web_research_allowed(),
            "freeRecommendedStrategies": free_recommended_strategies_allowed(),
            "maxConcurrentBots": max_concurrent_bots(),
            "proAmountKrw": toss_pro_amount_krw(),
            "proAnnualAmountKrw": toss_pro_annual_amount_krw(),
            "gptPackAmountKrw": gpt_pack_amount_krw(),
            "gptPackCalls": gpt_pack_calls(),
        },
        "flags": {
            "authRequired": auth_required(),
            "billingEnforce": billing_enforce(),
            "liveTradingEnabled": live_trading_enabled(),
            "mailConfigured": smtp_configured(),
            "resendConfigured": bool(resend_api_key()),
            "paymentsConfigured": billing_configured(),
            "tossWebhookSecretSet": bool(toss_webhook_secret()),
            "openaiConfigured": bool(os.getenv("OPENAI_API_KEY", "").strip()),
            "openaiModel": os.getenv("OPENAI_MODEL", "gpt-4o-mini") or "gpt-4o-mini",
            "adminEmailsCount": len(admin_emails()),
            "appOrigin": app_origin(),
            "supportEmail": support_email(),
        },
        "business": profile,
        "secrets": {
            "jwtSecretSet": bool(os.getenv("JWT_SECRET", "").strip()),
            "masterKeySet": bool(os.getenv("MASTER_ENCRYPTION_KEY", "").strip()),
            "tossClientKeySet": bool(os.getenv("TOSS_CLIENT_KEY", "").strip()),
            "tossSecretKeySet": bool(os.getenv("TOSS_SECRET_KEY", "").strip()),
            "tossWebhookSecretSet": bool(toss_webhook_secret()),
            "openaiKeySet": bool(os.getenv("OPENAI_API_KEY", "").strip()),
            "resendKeySet": bool(resend_api_key()),
            "databaseUrlSet": bool(os.getenv("DATABASE_URL", "").strip()),
        },
        "botDiagnostics": bot_diagnostics(),
    }


@router.patch("/settings")
def admin_update_settings(
    body: UpdateSettingsBody,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    incoming = body.settings or {}
    if not isinstance(incoming, dict) or not incoming:
        raise HTTPException(status_code=400, detail="변경할 설정이 없습니다.")

    updates: dict[str, str] = {}
    for key, raw_val in incoming.items():
        key_s = str(key).strip()
        meta = ADMIN_EDITABLE_SETTINGS.get(key_s)
        if not meta:
            raise HTTPException(status_code=400, detail=f"수정할 수 없는 설정입니다: {key_s}")
        typ = meta["type"]
        if typ == "bool":
            if isinstance(raw_val, bool):
                updates[key_s] = "true" if raw_val else "false"
            else:
                updates[key_s] = (
                    "true"
                    if str(raw_val).strip().lower() in {"1", "true", "yes", "on"}
                    else "false"
                )
        elif typ == "int":
            try:
                num = int(float(raw_val))
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=400, detail=f"{key_s} 정수 값이 필요합니다.") from exc
            lo, hi = meta.get("min"), meta.get("max")
            if lo is not None and num < int(lo):
                raise HTTPException(status_code=400, detail=f"{key_s} 최소 {lo}")
            if hi is not None and num > int(hi):
                raise HTTPException(status_code=400, detail=f"{key_s} 최대 {hi}")
            updates[key_s] = str(num)
        elif typ == "float":
            try:
                num_f = float(raw_val)
            except (TypeError, ValueError) as exc:
                raise HTTPException(status_code=400, detail=f"{key_s} 숫자 값이 필요합니다.") from exc
            lo, hi = meta.get("min"), meta.get("max")
            if lo is not None and num_f < float(lo):
                raise HTTPException(status_code=400, detail=f"{key_s} 최소 {lo}")
            if hi is not None and num_f > float(hi):
                raise HTTPException(status_code=400, detail=f"{key_s} 최대 {hi}")
            updates[key_s] = str(num_f)
        else:
            text = str(raw_val if raw_val is not None else "").strip()
            max_len = int(meta.get("max") or 200)
            if len(text) > max_len:
                raise HTTPException(status_code=400, detail=f"{key_s}는 {max_len}자 이하여야 합니다.")
            if key_s == "SUPPORT_EMAIL" and text and "@" not in text:
                raise HTTPException(status_code=400, detail="SUPPORT_EMAIL 형식이 올바르지 않습니다.")
            updates[key_s] = text

    try:
        changed = upsert_env_values(updates)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f".env 저장 실패: {exc}") from exc

    _audit(db, admin, "update-settings", detail=",".join(changed)[:200])
    return {
        "ok": True,
        "changed": changed,
        "message": f"{len(changed)}개 설정을 저장했습니다.",
        "editable": current_editable_settings(),
        "flags": {
            "billingEnforce": billing_enforce(),
            "liveTradingEnabled": live_trading_enabled(),
            "paymentsConfigured": billing_configured(),
        },
    }


@router.get("/activity")
def admin_activity(
    limit: int = Query(default=100, ge=1, le=500),
    userId: int | None = Query(default=None),
    action: str | None = Query(default=None),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _ = admin
    rows = list_recent_activity(db, limit=limit, user_id=userId, action=action)
    # Attach emails for table display
    ids = {int(r["userId"]) for r in rows if r.get("userId") is not None}
    email_map: dict[int, str] = {}
    if ids:
        for u in db.query(User).filter(User.id.in_(ids)).all():
            email_map[int(u.id)] = u.email
    for r in rows:
        r["email"] = email_map.get(int(r["userId"])) if r.get("userId") is not None else None
    return {"ok": True, "count": len(rows), "activity": rows}


@router.get("/users/{user_id}/activity")
def admin_user_activity(
    user_id: int,
    limit: int = Query(default=100, ge=1, le=500),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    _ = admin
    user = _get_user_or_404(db, user_id)
    activity = list_user_activity(db, user.id, limit=limit)
    # Also surface admin actions targeting this user
    audits = (
        db.query(AdminAuditLog)
        .filter(AdminAuditLog.target_user_id == user.id)
        .order_by(AdminAuditLog.id.desc())
        .limit(min(80, limit))
        .all()
    )
    admin_rows = [
        {
            "id": f"admin-{a.id}",
            "userId": user.id,
            "action": f"admin:{a.action}",
            "detail": (a.detail or "") + (f" · by {a.admin_email}" if a.admin_email else ""),
            "ip": None,
            "createdAt": a.created_at.isoformat() if a.created_at else None,
            "source": "admin_audit",
        }
        for a in audits
    ]
    payments = list_payment_history(db, user.id, limit=min(40, limit))
    pay_rows = [
        {
            "id": f"pay-{p['id']}",
            "userId": user.id,
            "action": f"payment:{p.get('kind') or 'charge'}",
            "detail": f"{p.get('amount')}{p.get('currency') or 'KRW'} · {p.get('status')} · {p.get('paymentKey') or p.get('orderId')}",
            "ip": None,
            "createdAt": p.get("createdAt"),
            "source": "payment",
        }
        for p in payments
    ]
    merged = activity + admin_rows + pay_rows
    merged.sort(key=lambda r: r.get("createdAt") or "", reverse=True)
    return {
        "ok": True,
        "userId": user.id,
        "email": user.email,
        "count": len(merged[:limit]),
        "activity": merged[:limit],
    }
