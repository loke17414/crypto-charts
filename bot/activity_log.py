"""Per-user activity log for admin observability."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from bot.models import UserActivityLog

logger = logging.getLogger(__name__)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def log_user_activity(
    db: Session,
    *,
    user_id: int | None,
    action: str,
    detail: str = "",
    ip: str | None = None,
    commit: bool = True,
) -> None:
    """Best-effort write — never raise to callers."""
    if user_id is None:
        return
    try:
        row = UserActivityLog(
            user_id=int(user_id),
            action=(action or "event")[:64],
            detail=(detail or "")[:500],
            ip=(ip or "")[:64] if ip else None,
            created_at=_utcnow(),
        )
        db.add(row)
        if commit:
            db.commit()
    except Exception:  # noqa: BLE001
        logger.exception("Failed to write user activity user=%s action=%s", user_id, action)
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass


def list_user_activity(
    db: Session,
    user_id: int,
    *,
    limit: int = 100,
) -> list[dict[str, Any]]:
    rows = (
        db.query(UserActivityLog)
        .filter(UserActivityLog.user_id == user_id)
        .order_by(UserActivityLog.id.desc())
        .limit(max(1, min(500, limit)))
        .all()
    )
    return [_row_dict(r) for r in rows]


def list_recent_activity(
    db: Session,
    *,
    limit: int = 100,
    user_id: int | None = None,
    action: str | None = None,
) -> list[dict[str, Any]]:
    q = db.query(UserActivityLog)
    if user_id is not None:
        q = q.filter(UserActivityLog.user_id == int(user_id))
    if action:
        q = q.filter(UserActivityLog.action == action.strip()[:64])
    rows = q.order_by(UserActivityLog.id.desc()).limit(max(1, min(500, limit))).all()
    return [_row_dict(r) for r in rows]


def _row_dict(r: UserActivityLog) -> dict[str, Any]:
    return {
        "id": r.id,
        "userId": r.user_id,
        "action": r.action,
        "detail": r.detail or "",
        "ip": r.ip,
        "createdAt": r.created_at.isoformat() if r.created_at else None,
    }
