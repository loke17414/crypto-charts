"""Toss Payments billing-key subscriptions + free-tier weekly quotas."""

from __future__ import annotations

import base64
import logging
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import requests
from fastapi import HTTPException
from sqlalchemy.orm import Session

from bot.crypto_vault import decrypt_secret, encrypt_secret
from bot.models import Subscription, UsageQuota, User
from bot.platform_config import (
    app_origin,
    billing_configured,
    billing_enforce,
    billing_week_timezone,
    free_bot_seconds_per_week,
    free_gpt_calls_per_week,
    toss_client_key,
    toss_pro_amount_krw,
    toss_pro_order_name,
    toss_secret_key,
)

logger = logging.getLogger(__name__)

TOSS_API = "https://api.tosspayments.com"
PRO_STATUSES = frozenset({"active", "past_due"})


def _tz() -> ZoneInfo:
    try:
        return ZoneInfo(billing_week_timezone())
    except Exception:  # noqa: BLE001
        return ZoneInfo("Asia/Seoul")


def current_week_start() -> str:
    now = datetime.now(_tz())
    monday = now.date() - timedelta(days=now.weekday())
    return monday.isoformat()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def ensure_subscription(db: Session, user_id: int) -> Subscription:
    row = db.query(Subscription).filter(Subscription.user_id == user_id).one_or_none()
    if row:
        return row
    row = Subscription(
        user_id=user_id,
        plan="free",
        status="inactive",
        cancel_at_period_end=False,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def ensure_usage(db: Session, user_id: int) -> UsageQuota:
    row = db.query(UsageQuota).filter(UsageQuota.user_id == user_id).one_or_none()
    week = current_week_start()
    if not row:
        row = UsageQuota(
            user_id=user_id,
            week_start=week,
            bot_seconds_used=0,
            gpt_calls_used=0,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return row
    if row.week_start != week:
        row.week_start = week
        row.bot_seconds_used = 0
        row.gpt_calls_used = 0
        row.bot_session_started_at = None
        db.commit()
        db.refresh(row)
    return row


def is_pro(sub: Subscription | None) -> bool:
    if not sub:
        return False
    return sub.plan == "pro" and sub.status in PRO_STATUSES


def flush_bot_runtime(db: Session, user_id: int) -> UsageQuota:
    usage = ensure_usage(db, user_id)
    started = usage.bot_session_started_at
    if not started:
        return usage
    if started.tzinfo is None:
        started = started.replace(tzinfo=timezone.utc)
    elapsed = max(0, int((_utcnow() - started).total_seconds()))
    if elapsed > 0:
        usage.bot_seconds_used = int(usage.bot_seconds_used or 0) + elapsed
    usage.bot_session_started_at = _utcnow()
    db.commit()
    db.refresh(usage)
    return usage


def mark_bot_started(db: Session, user_id: int) -> None:
    flush_bot_runtime(db, user_id)
    usage = ensure_usage(db, user_id)
    usage.bot_session_started_at = _utcnow()
    db.commit()


def mark_bot_stopped(db: Session, user_id: int) -> None:
    usage = ensure_usage(db, user_id)
    started = usage.bot_session_started_at
    if started:
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        elapsed = max(0, int((_utcnow() - started).total_seconds()))
        usage.bot_seconds_used = int(usage.bot_seconds_used or 0) + elapsed
    usage.bot_session_started_at = None
    db.commit()


def _expire_if_needed(db: Session, sub: Subscription) -> Subscription:
    """Downgrade Pro when period ended and cancel was requested (or renew failed)."""
    if not is_pro(sub) or not sub.current_period_end:
        return sub
    end = sub.current_period_end
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    if _utcnow() < end:
        return sub
    if sub.cancel_at_period_end or not sub.toss_billing_key_encrypted:
        sub.plan = "free"
        sub.status = "canceled" if sub.cancel_at_period_end else "inactive"
        sub.cancel_at_period_end = False
        db.commit()
        db.refresh(sub)
    return sub


def usage_snapshot(db: Session, user_id: int, *, running: bool = False) -> dict[str, Any]:
    sub = ensure_subscription(db, user_id)
    try_renew_if_due(db, user_id)
    sub = ensure_subscription(db, user_id)
    sub = _expire_if_needed(db, sub)

    if running:
        usage = flush_bot_runtime(db, user_id)
    else:
        usage = ensure_usage(db, user_id)

    pro = is_pro(sub)
    bot_limit = free_bot_seconds_per_week()
    gpt_limit = free_gpt_calls_per_week()
    bot_used = int(usage.bot_seconds_used or 0)
    gpt_used = int(usage.gpt_calls_used or 0)

    return {
        "plan": "pro" if pro else "free",
        "status": sub.status,
        "pro": pro,
        "paymentsConfigured": billing_configured(),
        "provider": "toss",
        "enforce": billing_enforce(),
        "cancelAtPeriodEnd": bool(sub.cancel_at_period_end),
        "currentPeriodEnd": sub.current_period_end.isoformat() if sub.current_period_end else None,
        "amountKrw": toss_pro_amount_krw(),
        "weekStart": usage.week_start,
        "bot": {
            "secondsUsed": bot_used,
            "secondsLimit": None if pro else bot_limit,
            "hoursUsed": round(bot_used / 3600, 2),
            "hoursLimit": None if pro else round(bot_limit / 3600, 2),
            "remainingSeconds": None if pro else max(0, bot_limit - bot_used),
        },
        "gpt": {
            "callsUsed": gpt_used,
            "callsLimit": None if pro else gpt_limit,
            "remaining": None if pro else max(0, gpt_limit - gpt_used),
            "modelNote": "Free: gpt-4o-mini only" if not pro else "Pro: hybrid routing",
        },
    }


def assert_can_start_bot(db: Session, user: User | None) -> None:
    if user is None or not billing_enforce():
        return
    sub = _expire_if_needed(db, ensure_subscription(db, user.id))
    if is_pro(sub):
        return
    usage = flush_bot_runtime(db, user.id)
    limit = free_bot_seconds_per_week()
    used = int(usage.bot_seconds_used or 0)
    if used >= limit:
        raise HTTPException(
            status_code=402,
            detail=(
                f"무료 플랜 주간 봇 가동 시간({round(limit / 3600)}시간)을 모두 사용했습니다. "
                "Pro로 업그레이드하거나 다음 주까지 기다려 주세요."
            ),
        )


def assert_can_use_gpt(db: Session, user: User | None) -> None:
    if user is None or not billing_enforce():
        return
    sub = _expire_if_needed(db, ensure_subscription(db, user.id))
    if is_pro(sub):
        return
    usage = ensure_usage(db, user.id)
    limit = free_gpt_calls_per_week()
    used = int(usage.gpt_calls_used or 0)
    if used >= limit:
        raise HTTPException(
            status_code=402,
            detail=(
                f"무료 플랜 주간 GPT 한도({limit}회)를 모두 사용했습니다. "
                "Pro로 업그레이드하거나 다음 주까지 기다려 주세요."
            ),
        )


def record_gpt_call(db: Session, user_id: int) -> None:
    if not billing_enforce():
        return
    sub = ensure_subscription(db, user_id)
    if is_pro(sub):
        return
    usage = ensure_usage(db, user_id)
    usage.gpt_calls_used = int(usage.gpt_calls_used or 0) + 1
    db.commit()


def should_force_stop_bot(db: Session, user_id: int) -> bool:
    if not billing_enforce():
        return False
    sub = ensure_subscription(db, user_id)
    if is_pro(sub):
        return False
    usage = flush_bot_runtime(db, user_id)
    return int(usage.bot_seconds_used or 0) >= free_bot_seconds_per_week()


def _toss_auth_header() -> dict[str, str]:
    secret = toss_secret_key()
    if not secret:
        raise HTTPException(status_code=503, detail="TOSS_SECRET_KEY가 설정되지 않았습니다.")
    token = base64.b64encode(f"{secret}:".encode("utf-8")).decode("ascii")
    return {
        "Authorization": f"Basic {token}",
        "Content-Type": "application/json",
    }


def _toss_request(method: str, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    url = f"{TOSS_API}{path}"
    try:
        res = requests.request(
            method,
            url,
            headers=_toss_auth_header(),
            json=payload,
            timeout=65,
        )
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"토스페이먼츠 연결 실패: {exc}") from exc
    try:
        data = res.json()
    except ValueError:
        data = {"message": res.text}
    if not res.ok:
        msg = data.get("message") or data.get("code") or res.text
        logger.warning("Toss API error %s %s: %s", method, path, data)
        raise HTTPException(status_code=400, detail=f"토스페이먼츠: {msg}")
    return data if isinstance(data, dict) else {"raw": data}


def _origin() -> str:
    origin = app_origin().rstrip("/")
    if origin == "*" or not origin.startswith("http"):
        return "http://127.0.0.1:8765"
    return origin


def ensure_customer_key(db: Session, user: User) -> str:
    sub = ensure_subscription(db, user.id)
    if sub.toss_customer_key:
        return sub.toss_customer_key
    # Must not be guessable (Toss requirement)
    key = f"orb_{uuid.uuid4().hex}"
    sub.toss_customer_key = key
    db.commit()
    return key


def prepare_billing_auth(db: Session, user: User) -> dict[str, Any]:
    if not billing_configured():
        raise HTTPException(
            status_code=503,
            detail="결제가 아직 설정되지 않았습니다. TOSS_CLIENT_KEY / TOSS_SECRET_KEY를 설정하세요.",
        )
    customer_key = ensure_customer_key(db, user)
    origin = _origin()
    return {
        "ok": True,
        "provider": "toss",
        "clientKey": toss_client_key(),
        "customerKey": customer_key,
        "customerEmail": user.email,
        "customerName": user.email.split("@")[0][:50] or "Orbinex",
        "amountKrw": toss_pro_amount_krw(),
        "orderName": toss_pro_order_name(),
        "successUrl": f"{origin}/billing.html?billing=success",
        "failUrl": f"{origin}/billing.html?billing=fail",
    }


def _activate_pro(db: Session, sub: Subscription, *, months: int = 1) -> None:
    sub.plan = "pro"
    sub.status = "active"
    sub.cancel_at_period_end = False
    sub.current_period_end = _utcnow() + timedelta(days=30 * months)
    db.commit()


def _charge_billing_key(
    db: Session,
    user: User,
    sub: Subscription,
    billing_key: str,
) -> dict[str, Any]:
    order_id = f"orb-pro-{user.id}-{uuid.uuid4().hex[:16]}"
    amount = toss_pro_amount_krw()
    payment = _toss_request(
        "POST",
        f"/v1/billing/{billing_key}",
        {
            "customerKey": sub.toss_customer_key,
            "amount": amount,
            "orderId": order_id,
            "orderName": toss_pro_order_name(),
            "customerEmail": user.email,
            "customerName": user.email.split("@")[0][:50] or "Orbinex",
        },
    )
    _activate_pro(db, sub)
    logger.info(
        "Toss charge OK user=%s order=%s amount=%s",
        user.id,
        order_id,
        amount,
    )
    return payment


def confirm_billing_auth(db: Session, user: User, auth_key: str, customer_key: str) -> dict[str, Any]:
    if not billing_configured():
        raise HTTPException(status_code=503, detail="결제가 아직 설정되지 않았습니다.")
    auth_key = (auth_key or "").strip()
    customer_key = (customer_key or "").strip()
    if not auth_key or not customer_key:
        raise HTTPException(status_code=400, detail="authKey와 customerKey가 필요합니다.")

    sub = ensure_subscription(db, user.id)
    if sub.toss_customer_key and sub.toss_customer_key != customer_key:
        raise HTTPException(status_code=400, detail="customerKey가 계정과 일치하지 않습니다.")
    if not sub.toss_customer_key:
        sub.toss_customer_key = customer_key
        db.commit()

    issued = _toss_request(
        "POST",
        "/v1/billing/authorizations/issue",
        {"authKey": auth_key, "customerKey": customer_key},
    )
    billing_key = issued.get("billingKey")
    if not billing_key:
        raise HTTPException(status_code=502, detail="빌링키 발급에 실패했습니다.")

    sub.toss_billing_key_encrypted = encrypt_secret(billing_key)
    db.commit()

    payment = _charge_billing_key(db, user, sub, billing_key)
    return {
        "ok": True,
        "plan": "pro",
        "status": "active",
        "paymentKey": payment.get("paymentKey"),
        "orderId": payment.get("orderId"),
        "totalAmount": payment.get("totalAmount"),
        "currentPeriodEnd": sub.current_period_end.isoformat() if sub.current_period_end else None,
        "card": issued.get("card") or issued.get("cardNumber"),
    }


def try_renew_if_due(db: Session, user_id: int) -> bool:
    """Charge again when period ended and subscription should continue."""
    if not billing_configured():
        return False
    sub = ensure_subscription(db, user_id)
    if sub.plan != "pro" or not sub.current_period_end:
        return False
    end = sub.current_period_end
    if end.tzinfo is None:
        end = end.replace(tzinfo=timezone.utc)
    if _utcnow() < end:
        return False
    if sub.cancel_at_period_end:
        sub.plan = "free"
        sub.status = "canceled"
        sub.cancel_at_period_end = False
        db.commit()
        return False
    if not sub.toss_billing_key_encrypted or not sub.toss_customer_key:
        sub.plan = "free"
        sub.status = "inactive"
        db.commit()
        return False

    user = db.query(User).filter(User.id == user_id).one_or_none()
    if not user:
        return False
    try:
        billing_key = decrypt_secret(sub.toss_billing_key_encrypted)
        _charge_billing_key(db, user, sub, billing_key)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("Renewal failed user=%s: %s", user_id, exc)
        sub.status = "past_due"
        # Keep pro briefly; expire on next check if still past end + past_due long
        # Soft: downgrade immediately on failed renew
        sub.plan = "free"
        db.commit()
        return False


def cancel_subscription(db: Session, user: User, *, immediate: bool = False) -> dict[str, Any]:
    sub = ensure_subscription(db, user.id)
    if not is_pro(sub):
        raise HTTPException(status_code=400, detail="활성 Pro 구독이 없습니다.")

    if immediate:
        billing_key = None
        if sub.toss_billing_key_encrypted:
            try:
                billing_key = decrypt_secret(sub.toss_billing_key_encrypted)
            except ValueError:
                billing_key = None
        if billing_key:
            try:
                _toss_request("DELETE", f"/v1/billing/{billing_key}", {"billingKey": billing_key})
            except HTTPException:
                logger.warning("Toss billing key delete failed user=%s", user.id)
        sub.plan = "free"
        sub.status = "canceled"
        sub.cancel_at_period_end = False
        sub.toss_billing_key_encrypted = None
        sub.current_period_end = _utcnow()
        db.commit()
        return {"ok": True, "plan": "free", "status": "canceled", "immediate": True}

    sub.cancel_at_period_end = True
    db.commit()
    return {
        "ok": True,
        "plan": "pro",
        "status": sub.status,
        "cancelAtPeriodEnd": True,
        "currentPeriodEnd": sub.current_period_end.isoformat() if sub.current_period_end else None,
        "message": "기간 종료 후 Free로 전환됩니다. 그동안 Pro를 계속 사용할 수 있습니다.",
    }
