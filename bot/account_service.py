"""Account data export and deletion (pre-launch privacy controls)."""

from __future__ import annotations

import logging
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from bot.auth_service import verify_password
from bot.billing_service import ensure_subscription, ensure_usage, list_payment_history, usage_snapshot
from bot.config import ROOT
from bot.models import User
from bot.platform_config import is_admin_email
from bot.server_bot import is_running, stop_bot
from bot.user_credentials import delete_credentials, has_credentials
from bot.user_openai import delete_openai_key, has_openai_key

logger = logging.getLogger(__name__)


def export_user_data(db: Session, user: User) -> dict[str, Any]:
    sub = ensure_subscription(db, user.id)
    usage = ensure_usage(db, user.id)
    return {
        "ok": True,
        "exportedAt": datetime.now(timezone.utc).isoformat(),
        "user": {
            "id": user.id,
            "email": user.email,
            "isActive": bool(user.is_active),
            "emailVerifiedAt": user.email_verified_at.isoformat() if user.email_verified_at else None,
            "termsAcceptedAt": user.terms_accepted_at.isoformat() if user.terms_accepted_at else None,
            "createdAt": user.created_at.isoformat() if user.created_at else None,
            "isAdmin": is_admin_email(user.email),
        },
        "subscription": {
            "plan": sub.plan,
            "status": sub.status,
            "cancelAtPeriodEnd": bool(sub.cancel_at_period_end),
            "currentPeriodEnd": sub.current_period_end.isoformat() if sub.current_period_end else None,
            "hasBillingKey": bool((sub.toss_billing_key_encrypted or "").strip()),
        },
        "usage": {
            "weekStart": usage.week_start,
            "botSecondsUsed": int(usage.bot_seconds_used or 0),
            "gptCallsUsed": int(usage.gpt_calls_used or 0),
        },
        "usageSnapshot": usage_snapshot(db, user.id, running=is_running(user.id)),
        "payments": list_payment_history(db, user.id, limit=100),
        "credentials": {
            "binanceSaved": has_credentials(db, user.id),
            "openaiSaved": has_openai_key(db, user.id),
        },
        "note": "API 비밀키·비밀번호 해시·토스 빌링키 원문은 포함되지 않습니다.",
    }


def delete_user_account(db: Session, user: User, password: str) -> dict[str, Any]:
    if not verify_password(password, user.password_hash):
        raise ValueError("비밀번호가 올바르지 않습니다.")
    if is_admin_email(user.email):
        raise ValueError("관리자 계정은 콘솔에서 ADMIN_EMAILS를 제거한 뒤 삭제하세요.")

    user_id = user.id
    email = user.email

    if is_running(user_id):
        try:
            stop_bot(user_id)
        except Exception:  # noqa: BLE001
            logger.exception("stop_bot failed during account delete user=%s", user_id)

    try:
        delete_credentials(db, user_id)
    except Exception:  # noqa: BLE001
        logger.exception("delete_credentials failed user=%s", user_id)
    try:
        delete_openai_key(db, user_id)
    except Exception:  # noqa: BLE001
        logger.exception("delete_openai_key failed user=%s", user_id)

    bot_home = Path(ROOT) / "data" / "bots" / str(user_id)
    if bot_home.is_dir():
        try:
            shutil.rmtree(bot_home, ignore_errors=True)
        except Exception:  # noqa: BLE001
            logger.exception("bot home cleanup failed user=%s", user_id)

    db.delete(user)
    db.commit()
    logger.info("Account deleted user_id=%s email=%s", user_id, email)
    return {"ok": True, "message": "계정이 삭제되었습니다.", "deletedUserId": user_id}
