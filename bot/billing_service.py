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
from bot.models import PaymentRecord, Subscription, UsageQuota, User
from bot.platform_config import (
    app_origin,
    billing_configured,
    billing_enforce,
    billing_week_timezone,
    free_bot_seconds_per_week,
    free_gpt_calls_per_week,
    free_max_strategy_slots,
    free_recommended_strategies_allowed,
    free_web_research_allowed,
    gpt_pack_amount_krw,
    gpt_pack_calls,
    gpt_pack_order_name,
    pro_gpt_calls_per_week,
    pro_max_strategy_slots,
    toss_client_key,
    toss_pro_amount_krw,
    toss_pro_annual_amount_krw,
    toss_pro_annual_order_name,
    toss_pro_order_name,
    toss_secret_key,
)

logger = logging.getLogger(__name__)

TOSS_API = "https://api.tosspayments.com"
PRO_STATUSES = frozenset({"active", "past_due"})


def _tz() -> ZoneInfo | timezone:
    """Billing week timezone. Falls back to fixed UTC+9 if tzdata is missing."""
    name = billing_week_timezone() or "Asia/Seoul"
    try:
        return ZoneInfo(name)
    except Exception:  # noqa: BLE001
        try:
            return ZoneInfo("Asia/Seoul")
        except Exception:  # noqa: BLE001
            logger.warning("tzdata missing — using fixed UTC+9 for billing week (%s)", name)
            return timezone(timedelta(hours=9))


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
        # Keep session clock if bot is still running across the week boundary so
        # new-week usage accrues from the cutover instead of dropping the run.
        was_running = row.bot_session_started_at is not None
        row.week_start = week
        row.bot_seconds_used = 0
        row.gpt_calls_used = 0
        row.bot_session_started_at = _utcnow() if was_running else None
        db.commit()
        db.refresh(row)
    return row


def is_pro(sub: Subscription | None) -> bool:
    if not sub:
        return False
    return sub.plan == "pro" and sub.status in PRO_STATUSES


def _normalize_interval(raw: str | None) -> str:
    value = (raw or "month").strip().lower()
    return "year" if value in {"year", "annual", "yearly"} else "month"


def _pro_amount_and_name(interval: str) -> tuple[int, str]:
    if _normalize_interval(interval) == "year":
        return toss_pro_annual_amount_krw(), toss_pro_annual_order_name()
    return toss_pro_amount_krw(), toss_pro_order_name()


def _period_delta(interval: str) -> timedelta:
    return timedelta(days=365) if _normalize_interval(interval) == "year" else timedelta(days=30)


def gpt_weekly_limit(*, pro: bool) -> int:
    return pro_gpt_calls_per_week() if pro else free_gpt_calls_per_week()


def gpt_remaining_calls(usage: UsageQuota, *, pro: bool) -> int:
    limit = gpt_weekly_limit(pro=pro)
    used = int(usage.gpt_calls_used or 0)
    weekly_rem = max(0, limit - used) if limit > 0 else 10**9
    bonus = max(0, int(getattr(usage, "gpt_bonus_calls", 0) or 0))
    if limit <= 0:
        return weekly_rem + bonus
    return weekly_rem + bonus


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
    gpt_limit = gpt_weekly_limit(pro=pro)
    bot_used = int(usage.bot_seconds_used or 0)
    gpt_used = int(usage.gpt_calls_used or 0)
    gpt_bonus = max(0, int(getattr(usage, "gpt_bonus_calls", 0) or 0))
    gpt_remaining = gpt_remaining_calls(usage, pro=pro)
    max_slots = pro_max_strategy_slots() if pro else free_max_strategy_slots()
    web_research = True if pro else free_web_research_allowed()
    recommended = True if pro else free_recommended_strategies_allowed()
    interval = _normalize_interval(getattr(sub, "billing_interval", None) or "month")
    amount, _order = _pro_amount_and_name(interval)

    payment_failed = str(sub.status or "") == "past_due"
    status_message = ""
    if payment_failed:
        status_message = (
            "최근 구독 갱신 결제에 실패해 Free로 전환되었습니다. "
            "요금제에서 결제 수단을 확인한 뒤 Pro를 다시 구독해 주세요."
        )
    elif pro and sub.cancel_at_period_end:
        status_message = "해지 예약됨 — 기간 종료 후 Free로 전환됩니다."

    return {
        "plan": "pro" if pro else "free",
        "status": sub.status,
        "pro": pro,
        "paymentFailed": payment_failed,
        "statusMessage": status_message,
        "paymentsConfigured": billing_configured(),
        "provider": "toss",
        "enforce": billing_enforce(),
        "cancelAtPeriodEnd": bool(sub.cancel_at_period_end),
        "billingInterval": interval,
        "currentPeriodEnd": sub.current_period_end.isoformat() if sub.current_period_end else None,
        "amountKrw": amount if pro else toss_pro_amount_krw(),
        "monthlyAmountKrw": toss_pro_amount_krw(),
        "annualAmountKrw": toss_pro_annual_amount_krw(),
        "gptPackAmountKrw": gpt_pack_amount_krw(),
        "gptPackCalls": gpt_pack_calls(),
        "weekStart": usage.week_start,
        "bot": {
            "secondsUsed": bot_used,
            "secondsLimit": None if pro else bot_limit,
            "hoursUsed": round(bot_used / 3600, 2),
            "hoursLimit": None if pro else round(bot_limit / 3600, 2),
            "remainingSeconds": None if pro else max(0, bot_limit - bot_used),
            "remainingHours": None if pro else round(max(0, bot_limit - bot_used) / 3600, 2),
        },
        "gpt": {
            "callsUsed": gpt_used,
            "callsLimit": None if gpt_limit <= 0 else gpt_limit,
            "bonusRemaining": gpt_bonus,
            "remaining": None if gpt_limit <= 0 and not gpt_bonus else gpt_remaining,
            "modelNote": "Free: gpt-4o-mini only" if not pro else "Pro: hybrid · 주간 한도 + 추가팩",
        },
        "features": {
            "maxStrategySlots": max_slots,
            "webResearch": web_research,
            "recommendedStrategies": recommended,
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
    pro = is_pro(sub)
    usage = ensure_usage(db, user.id)
    remaining = gpt_remaining_calls(usage, pro=pro)
    limit = gpt_weekly_limit(pro=pro)
    if remaining > 0:
        return
    if pro:
        raise HTTPException(
            status_code=402,
            detail=(
                f"Pro 주간 AI 한도({limit}회)와 추가 팩을 모두 사용했습니다. "
                f"요금제에서 AI 추가 팩(+{gpt_pack_calls()}회 · "
                f"{gpt_pack_amount_krw():,}원)을 구매하거나 다음 주 월요일까지 기다려 주세요."
            ),
        )
    raise HTTPException(
        status_code=402,
        detail=(
            f"무료 플랜 주간 AI 한도({limit}회)를 모두 사용했습니다. "
            "Pro로 업그레이드하거나 다음 주 월요일까지 기다려 주세요."
        ),
    )


def record_gpt_call(db: Session, user_id: int, *, reason: str = "") -> None:
    if not billing_enforce():
        return
    sub = ensure_subscription(db, user_id)
    pro = is_pro(sub)
    usage = ensure_usage(db, user_id)
    limit = gpt_weekly_limit(pro=pro)
    used = int(usage.gpt_calls_used or 0)
    if limit <= 0 or used < limit:
        usage.gpt_calls_used = used + 1
    else:
        bonus = max(0, int(getattr(usage, "gpt_bonus_calls", 0) or 0))
        usage.gpt_bonus_calls = max(0, bonus - 1)
    db.commit()
    try:
        from bot.activity_log import log_user_activity

        log_user_activity(
            db,
            user_id=user_id,
            action="ai_call",
            detail=(reason or ("pro" if pro else "free"))[:200],
        )
    except Exception:  # noqa: BLE001
        pass


def should_force_stop_bot(db: Session, user_id: int) -> bool:
    if not billing_enforce():
        return False
    sub = ensure_subscription(db, user_id)
    if is_pro(sub):
        return False
    usage = flush_bot_runtime(db, user_id)
    return int(usage.bot_seconds_used or 0) >= free_bot_seconds_per_week()


def enforce_running_bot_quotas() -> int:
    """Stop free-tier bots that exceeded weekly hours (server-side watchdog)."""
    if not billing_enforce():
        return 0
    from bot.db import SessionLocal
    from bot.server_bot import list_running_user_ids, stop_bot

    stopped = 0
    db = SessionLocal()
    try:
        for uid in list_running_user_ids():
            try:
                if should_force_stop_bot(db, uid):
                    mark_bot_stopped(db, uid)
                    stop_bot(uid)
                    stopped += 1
                    try:
                        from bot.activity_log import log_user_activity

                        log_user_activity(
                            db,
                            user_id=uid,
                            action="bot_stop",
                            detail="quota_watchdog",
                        )
                    except Exception:  # noqa: BLE001
                        pass
                    logger.info("Quota watchdog stopped bot user=%s", uid)
            except Exception:  # noqa: BLE001
                logger.exception("Quota watchdog failed user=%s", uid)
    finally:
        db.close()
    return stopped


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


def prepare_billing_auth(db: Session, user: User, *, interval: str = "month") -> dict[str, Any]:
    if not billing_configured():
        raise HTTPException(
            status_code=503,
            detail="결제가 아직 설정되지 않았습니다. TOSS_CLIENT_KEY / TOSS_SECRET_KEY를 설정하세요.",
        )
    # Annual checkout disabled for now — always month.
    product = "month"
    _ = interval
    amount, order_name = _pro_amount_and_name(product)
    customer_key = ensure_customer_key(db, user)
    origin = _origin()
    return {
        "ok": True,
        "provider": "toss",
        "clientKey": toss_client_key(),
        "customerKey": customer_key,
        "customerEmail": user.email,
        "customerName": user.email.split("@")[0][:50] or "Orbinex",
        "interval": product,
        "amountKrw": amount,
        "orderName": order_name,
        "monthlyAmountKrw": toss_pro_amount_krw(),
        "annualAmountKrw": toss_pro_annual_amount_krw(),
        "successUrl": f"{origin}/billing.html?billing=success&product={product}",
        "failUrl": f"{origin}/billing.html?billing=fail&product={product}",
    }


def _activate_pro(db: Session, sub: Subscription, *, interval: str = "month") -> None:
    product = _normalize_interval(interval)
    sub.plan = "pro"
    sub.status = "active"
    sub.cancel_at_period_end = False
    sub.billing_interval = product
    sub.current_period_end = _utcnow() + _period_delta(product)
    db.commit()


def _record_payment(
    db: Session,
    *,
    user_id: int,
    order_id: str,
    payment: dict[str, Any],
    amount: int,
    kind: str,
) -> PaymentRecord:
    method = None
    card = payment.get("card")
    if isinstance(card, dict):
        method = str(card.get("company") or card.get("number") or "card")[:64]
    elif payment.get("method"):
        method = str(payment.get("method"))[:64]
    row = PaymentRecord(
        user_id=user_id,
        order_id=order_id,
        payment_key=(str(payment.get("paymentKey"))[:200] if payment.get("paymentKey") else None),
        amount=int(payment.get("totalAmount") or amount),
        currency=str(payment.get("currency") or "KRW")[:8],
        status="paid",
        kind=kind,
        method=method,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def clear_stored_billing_key(
    db: Session,
    sub: Subscription,
    *,
    delete_remote: bool = False,
) -> None:
    """Drop local (and optionally Toss) billing key so renew cannot charge again."""
    if delete_remote and sub.toss_billing_key_encrypted:
        try:
            billing_key = decrypt_secret(sub.toss_billing_key_encrypted)
            _toss_request("DELETE", f"/v1/billing/{billing_key}", {"billingKey": billing_key})
        except Exception:  # noqa: BLE001
            logger.warning("Toss billing key delete failed user=%s", sub.user_id)
    sub.toss_billing_key_encrypted = None
    db.commit()


def _reverse_payment_entitlements(db: Session, row: PaymentRecord, *, full_cancel: bool) -> None:
    """Undo Pro / GPT pack grants after a successful Toss cancel."""
    if not full_cancel:
        return
    kind = (row.kind or "").strip().lower()
    if kind in {"subscribe", "renew"}:
        sub = ensure_subscription(db, row.user_id)
        if is_pro(sub) or sub.plan == "pro":
            sub.plan = "free"
            sub.status = "canceled"
            sub.cancel_at_period_end = False
            sub.current_period_end = _utcnow()
            sub.toss_billing_key_encrypted = None
            db.commit()
    elif kind == "gpt_pack":
        usage = ensure_usage(db, row.user_id)
        usage.gpt_bonus_calls = max(
            0,
            int(getattr(usage, "gpt_bonus_calls", 0) or 0) - gpt_pack_calls(),
        )
        db.commit()


def cancel_toss_payment(
    db: Session,
    *,
    payment_key: str,
    reason: str,
    cancel_amount: int | None = None,
    actor_user_id: int | None = None,
    expected_user_id: int | None = None,
    reverse_entitlements: bool = True,
) -> dict[str, Any]:
    """Cancel/refund a Toss payment by paymentKey and update local ledger."""
    key = (payment_key or "").strip()
    if not key:
        raise HTTPException(status_code=400, detail="paymentKey가 필요합니다.")

    row = (
        db.query(PaymentRecord)
        .filter(PaymentRecord.payment_key == key)
        .order_by(PaymentRecord.id.desc())
        .first()
    )
    if expected_user_id is not None:
        if row is None or int(row.user_id) != int(expected_user_id):
            raise HTTPException(status_code=404, detail="해당 사용자의 결제 기록이 없습니다.")
    if not billing_configured():
        raise HTTPException(status_code=503, detail="결제가 아직 설정되지 않았습니다.")

    reason_s = (reason or "고객 요청 환불").strip()[:200] or "고객 요청 환불"
    payload: dict[str, Any] = {"cancelReason": reason_s}
    if cancel_amount is not None:
        payload["cancelAmount"] = int(cancel_amount)

    data = _toss_request("POST", f"/v1/payments/{key}/cancel", payload)
    toss_status = str(data.get("status") or "").strip().upper()
    if toss_status == "PARTIAL_CANCELED":
        mapped = "partial_canceled"
    elif toss_status == "CANCELED":
        mapped = "canceled"
    else:
        mapped = "canceled" if cancel_amount is None else "partial_canceled"

    full_cancel = cancel_amount is None
    if row is not None and cancel_amount is not None:
        full_cancel = int(cancel_amount) >= int(row.amount or 0)

    if row is not None:
        row.status = mapped[:32]
        db.commit()
        db.refresh(row)
        if reverse_entitlements:
            _reverse_payment_entitlements(db, row, full_cancel=full_cancel)

    logger.info(
        "Toss payment canceled key=%s amount=%s actor=%s status=%s",
        key[:12],
        cancel_amount,
        actor_user_id,
        mapped,
    )
    return {
        "ok": True,
        "paymentKey": key,
        "status": mapped,
        "toss": {
            "status": data.get("status"),
            "cancels": data.get("cancels"),
            "totalAmount": data.get("totalAmount"),
        },
        "localRecordId": row.id if row else None,
        "entitlementsReversed": bool(reverse_entitlements and full_cancel and row is not None),
    }


def apply_toss_webhook_event(db: Session, payload: dict[str, Any]) -> dict[str, Any]:
    """Idempotent ledger update from Toss webhook JSON."""
    event = str(payload.get("eventType") or payload.get("type") or "").strip()
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    if not isinstance(data, dict):
        data = {}

    payment_key = str(data.get("paymentKey") or "").strip() or None
    order_id = str(data.get("orderId") or "").strip() or None
    status_raw = str(data.get("status") or "").strip().upper()

    row: PaymentRecord | None = None
    if payment_key:
        row = (
            db.query(PaymentRecord)
            .filter(PaymentRecord.payment_key == payment_key)
            .order_by(PaymentRecord.id.desc())
            .first()
        )
    if row is None and order_id:
        row = (
            db.query(PaymentRecord)
            .filter(PaymentRecord.order_id == order_id)
            .order_by(PaymentRecord.id.desc())
            .first()
        )

    mapped = None
    if status_raw == "DONE":
        mapped = "paid"
    elif status_raw == "CANCELED":
        mapped = "canceled"
    elif status_raw in {"PARTIAL_CANCELED", "EXPIRED", "ABORTED", "WAITING_FOR_DEPOSIT"}:
        mapped = status_raw.lower()
    elif status_raw:
        mapped = status_raw.lower()[:32]

    changed = False
    if row is not None and mapped and row.status != mapped:
        row.status = mapped[:32]
        if payment_key and not row.payment_key:
            row.payment_key = payment_key[:200]
        db.commit()
        changed = True

    # Failed renewals already downgrade in try_renew_if_due; webhook is ledger sync.
    return {
        "ok": True,
        "eventType": event or None,
        "paymentKey": payment_key,
        "orderId": order_id,
        "status": mapped or status_raw or None,
        "matched": row is not None,
        "updated": changed,
        "recordId": row.id if row else None,
    }


def list_payment_history(db: Session, user_id: int, *, limit: int = 50) -> list[dict[str, Any]]:
    rows = (
        db.query(PaymentRecord)
        .filter(PaymentRecord.user_id == user_id)
        .order_by(PaymentRecord.id.desc())
        .limit(max(1, min(200, limit)))
        .all()
    )
    return [
        {
            "id": r.id,
            "orderId": r.order_id,
            "paymentKey": r.payment_key,
            "amount": r.amount,
            "currency": r.currency,
            "status": r.status,
            "kind": r.kind,
            "method": r.method,
            "createdAt": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


def _charge_billing_key(
    db: Session,
    user: User,
    sub: Subscription,
    billing_key: str,
    *,
    kind: str = "subscribe",
    interval: str | None = None,
) -> dict[str, Any]:
    product = _normalize_interval(interval or getattr(sub, "billing_interval", None) or "month")
    amount, order_name = _pro_amount_and_name(product)
    order_id = f"orb-pro-{user.id}-{uuid.uuid4().hex[:16]}"
    payment = _toss_request(
        "POST",
        f"/v1/billing/{billing_key}",
        {
            "customerKey": sub.toss_customer_key,
            "amount": amount,
            "orderId": order_id,
            "orderName": order_name,
            "customerEmail": user.email,
            "customerName": user.email.split("@")[0][:50] or "Orbinex",
        },
    )
    _activate_pro(db, sub, interval=product)
    try:
        _record_payment(
            db,
            user_id=user.id,
            order_id=str(payment.get("orderId") or order_id),
            payment=payment if isinstance(payment, dict) else {},
            amount=amount,
            kind=kind,
        )
    except Exception:  # noqa: BLE001
        logger.exception("Failed to persist payment record user=%s order=%s", user.id, order_id)
    logger.info(
        "Toss charge OK user=%s order=%s amount=%s kind=%s interval=%s",
        user.id,
        order_id,
        amount,
        kind,
        product,
    )
    return payment


def confirm_billing_auth(
    db: Session,
    user: User,
    auth_key: str,
    customer_key: str,
    *,
    interval: str = "month",
) -> dict[str, Any]:
    if not billing_configured():
        raise HTTPException(status_code=503, detail="결제가 아직 설정되지 않았습니다.")
    auth_key = (auth_key or "").strip()
    customer_key = (customer_key or "").strip()
    if not auth_key or not customer_key:
        raise HTTPException(status_code=400, detail="authKey와 customerKey가 필요합니다.")
    # Annual checkout disabled for now — always month.
    product = "month"
    _ = interval

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

    payment = _charge_billing_key(db, user, sub, billing_key, kind="subscribe", interval=product)
    return {
        "ok": True,
        "plan": "pro",
        "status": "active",
        "billingInterval": product,
        "paymentKey": payment.get("paymentKey"),
        "orderId": payment.get("orderId"),
        "totalAmount": payment.get("totalAmount"),
        "currentPeriodEnd": sub.current_period_end.isoformat() if sub.current_period_end else None,
        "card": issued.get("card") or issued.get("cardNumber"),
    }


def purchase_gpt_pack(db: Session, user: User) -> dict[str, Any]:
    """Charge billing key for a one-time AI call pack (Pro subscribers only)."""
    if not billing_configured():
        raise HTTPException(status_code=503, detail="결제가 아직 설정되지 않았습니다.")
    sub = _expire_if_needed(db, ensure_subscription(db, user.id))
    if not is_pro(sub):
        raise HTTPException(status_code=402, detail="AI 추가 팩은 Pro 구독 중일 때만 구매할 수 있습니다.")
    if not sub.toss_billing_key_encrypted or not sub.toss_customer_key:
        raise HTTPException(
            status_code=400,
            detail="등록된 결제 수단이 없습니다. Pro를 카드 구독으로 이용 중이어야 합니다.",
        )

    billing_key = decrypt_secret(sub.toss_billing_key_encrypted)
    amount = gpt_pack_amount_krw()
    calls = gpt_pack_calls()
    order_id = f"orb-gpt-{user.id}-{uuid.uuid4().hex[:16]}"
    payment = _toss_request(
        "POST",
        f"/v1/billing/{billing_key}",
        {
            "customerKey": sub.toss_customer_key,
            "amount": amount,
            "orderId": order_id,
            "orderName": gpt_pack_order_name(),
            "customerEmail": user.email,
            "customerName": user.email.split("@")[0][:50] or "Orbinex",
        },
    )
    usage = ensure_usage(db, user.id)
    usage.gpt_bonus_calls = max(0, int(getattr(usage, "gpt_bonus_calls", 0) or 0)) + calls
    db.commit()
    try:
        _record_payment(
            db,
            user_id=user.id,
            order_id=str(payment.get("orderId") or order_id),
            payment=payment if isinstance(payment, dict) else {},
            amount=amount,
            kind="gpt_pack",
        )
    except Exception:  # noqa: BLE001
        logger.exception("Failed to persist AI pack payment user=%s", user.id)
    return {
        "ok": True,
        "addedCalls": calls,
        "bonusRemaining": int(usage.gpt_bonus_calls or 0),
        "amountKrw": amount,
        "paymentKey": payment.get("paymentKey"),
        "orderId": payment.get("orderId"),
        "message": f"AI 추가 팩 +{calls}회가 적용되었습니다.",
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
        _charge_billing_key(db, user, sub, billing_key, kind="renew")
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("Renewal failed user=%s: %s", user_id, exc)
        sub.status = "past_due"
        # Soft: downgrade immediately on failed renew
        sub.plan = "free"
        db.commit()
        return False


def renew_due_subscriptions(db: Session) -> dict[str, Any]:
    """Cron entry: renew or expire all Pro periods that are past due."""
    now = _utcnow()
    rows = (
        db.query(Subscription)
        .filter(
            Subscription.plan == "pro",
            Subscription.current_period_end.isnot(None),
            Subscription.current_period_end <= now,
        )
        .all()
    )
    renewed = 0
    expired = 0
    failed = 0
    for sub in rows:
        before_plan = sub.plan
        before_status = sub.status
        ok = try_renew_if_due(db, sub.user_id)
        db.refresh(sub)
        if ok:
            renewed += 1
        elif sub.plan != "pro" or sub.status != before_status or before_plan != sub.plan:
            expired += 1
        else:
            failed += 1
    return {
        "ok": True,
        "checked": len(rows),
        "renewed": renewed,
        "expired": expired,
        "failed": failed,
    }


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


def resume_subscription(db: Session, user: User) -> dict[str, Any]:
    """Undo period-end cancellation while Pro period is still active."""
    sub = ensure_subscription(db, user.id)
    if not is_pro(sub):
        raise HTTPException(status_code=400, detail="활성 Pro 구독이 없습니다.")
    if not sub.cancel_at_period_end:
        return {
            "ok": True,
            "plan": "pro",
            "status": sub.status,
            "cancelAtPeriodEnd": False,
            "currentPeriodEnd": sub.current_period_end.isoformat() if sub.current_period_end else None,
            "message": "이미 해지 예약이 없습니다.",
        }
    end = sub.current_period_end
    if end is not None:
        if end.tzinfo is None:
            end = end.replace(tzinfo=timezone.utc)
        if _utcnow() >= end:
            raise HTTPException(
                status_code=400,
                detail="이용 기간이 이미 끝났습니다. 다시 Pro를 구독해 주세요.",
            )
    sub.cancel_at_period_end = False
    if sub.status not in PRO_STATUSES:
        sub.status = "active"
    db.commit()
    return {
        "ok": True,
        "plan": "pro",
        "status": sub.status,
        "cancelAtPeriodEnd": False,
        "currentPeriodEnd": sub.current_period_end.isoformat() if sub.current_period_end else None,
        "message": "해지 예약을 취소했습니다. 구독이 계속됩니다.",
    }
