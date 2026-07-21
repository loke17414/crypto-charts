"""Password hashing, JWT, email tokens, and auth helpers."""

from __future__ import annotations

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from typing import Any

import bcrypt
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from bot.email_service import send_reset_email, send_verify_email, smtp_configured
from bot.models import EmailToken, User
from bot.platform_config import (
    access_token_expire_minutes,
    email_require_verification,
    jwt_algorithm,
    jwt_secret,
)

PURPOSE_VERIFY = "verify"
PURPOSE_RESET = "reset"


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))


def create_access_token(*, user_id: int, email: str) -> tuple[str, int]:
    expires_minutes = access_token_expire_minutes()
    payload: dict[str, Any] = {
        "sub": str(user_id),
        "email": email,
    }
    if expires_minutes > 0:
        payload["exp"] = datetime.now(UTC) + timedelta(minutes=expires_minutes)
        expires_in = expires_minutes * 60
    else:
        expires_in = 0
    token = jwt.encode(payload, jwt_secret(), algorithm=jwt_algorithm())
    return token, expires_in


def decode_access_token(token: str) -> dict[str, Any]:
    try:
        payload = jwt.decode(
            token,
            jwt_secret(),
            algorithms=[jwt_algorithm()],
            options={"verify_exp": True},
        )
    except JWTError as exc:
        raise ValueError("Invalid or expired token") from exc
    sub = payload.get("sub")
    if not sub:
        raise ValueError("Invalid token payload")
    return payload


def get_user_by_email(db: Session, email: str) -> User | None:
    return db.query(User).filter(User.email == email.lower().strip()).one_or_none()


def get_user_by_id(db: Session, user_id: int) -> User | None:
    return db.query(User).filter(User.id == user_id).one_or_none()


def _hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _utcnow() -> datetime:
    return datetime.now(UTC)


def create_email_token(
    db: Session,
    user: User,
    *,
    purpose: str,
    hours: float,
) -> str:
    """Invalidate prior unused tokens of the same purpose; return raw token."""
    now = _utcnow()
    prior = (
        db.query(EmailToken)
        .filter(
            EmailToken.user_id == user.id,
            EmailToken.purpose == purpose,
            EmailToken.used_at.is_(None),
        )
        .all()
    )
    for row in prior:
        row.used_at = now
    raw = secrets.token_urlsafe(32)
    row = EmailToken(
        user_id=user.id,
        token_hash=_hash_token(raw),
        purpose=purpose,
        expires_at=now + timedelta(hours=hours),
    )
    db.add(row)
    db.commit()
    return raw


def consume_email_token(db: Session, raw: str, *, purpose: str) -> User:
    token_hash = _hash_token(raw.strip())
    row = (
        db.query(EmailToken)
        .filter(EmailToken.token_hash == token_hash, EmailToken.purpose == purpose)
        .one_or_none()
    )
    if not row or row.used_at is not None:
        raise ValueError("유효하지 않거나 이미 사용된 링크입니다.")
    expires = row.expires_at
    if expires.tzinfo is None:
        expires = expires.replace(tzinfo=UTC)
    if _utcnow() > expires:
        raise ValueError("링크가 만료되었습니다. 다시 요청해 주세요.")
    user = get_user_by_id(db, row.user_id)
    if not user or not user.is_active:
        raise ValueError("사용자를 찾을 수 없습니다.")
    row.used_at = _utcnow()
    db.commit()
    return user


def create_user(db: Session, email: str, password: str, *, accept_terms: bool) -> tuple[User, dict[str, Any]]:
    if not accept_terms:
        raise ValueError("이용약관·개인정보·위험고지에 동의해 주세요.")
    normalized = email.lower().strip()
    if get_user_by_email(db, normalized):
        raise ValueError("Email already registered")

    now = _utcnow()
    require_verify = email_require_verification() and smtp_configured()
    user = User(
        email=normalized,
        password_hash=hash_password(password),
        is_active=True,
        terms_accepted_at=now,
        email_verified_at=None if require_verify else now,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    meta: dict[str, Any] = {
        "emailVerificationRequired": require_verify,
        "emailSent": False,
        "smtpConfigured": smtp_configured(),
    }
    if require_verify:
        raw = create_email_token(db, user, purpose=PURPOSE_VERIFY, hours=24)
        try:
            meta["emailSent"] = send_verify_email(user.email, raw)
        except Exception:
            meta["emailSent"] = False
            meta["emailError"] = "인증 메일 발송에 실패했습니다. 잠시 후 재전송해 주세요."
    return user, meta


def authenticate_user(db: Session, email: str, password: str) -> User | None:
    user = get_user_by_email(db, email)
    if not user or not user.is_active:
        return None
    if not verify_password(password, user.password_hash):
        return None
    return user


def assert_email_verified_for_login(user: User) -> None:
    if not email_require_verification():
        return
    if not smtp_configured():
        return
    if user.email_verified_at is None:
        raise ValueError("이메일 인증이 필요합니다. 받은편지함의 인증 링크를 확인해 주세요.")


def verify_email_with_token(db: Session, raw: str) -> User:
    user = consume_email_token(db, raw, purpose=PURPOSE_VERIFY)
    user.email_verified_at = _utcnow()
    db.commit()
    db.refresh(user)
    return user


def resend_verification(db: Session, email: str) -> dict[str, Any]:
    user = get_user_by_email(db, email)
    # Always return ok to avoid email enumeration
    if not user or user.email_verified_at is not None:
        return {"ok": True, "message": "인증 메일을 보냈습니다. 받은편지함을 확인해 주세요."}
    if not smtp_configured():
        raise ValueError("이메일 발송이 설정되지 않았습니다. 관리자에게 문의하세요.")
    raw = create_email_token(db, user, purpose=PURPOSE_VERIFY, hours=24)
    send_verify_email(user.email, raw)
    return {"ok": True, "message": "인증 메일을 다시 보냈습니다."}


def request_password_reset(db: Session, email: str) -> dict[str, Any]:
    user = get_user_by_email(db, email)
    if not user:
        return {"ok": True, "message": "재설정 안내를 보냈습니다. 받은편지함을 확인해 주세요."}
    if not smtp_configured():
        raise ValueError("이메일 발송이 설정되지 않았습니다. 관리자에게 문의하세요.")
    raw = create_email_token(db, user, purpose=PURPOSE_RESET, hours=1)
    send_reset_email(user.email, raw)
    return {"ok": True, "message": "재설정 안내를 보냈습니다. 받은편지함을 확인해 주세요."}


def reset_password_with_token(db: Session, raw: str, new_password: str) -> User:
    if len(new_password) < 8:
        raise ValueError("비밀번호는 8자 이상이어야 합니다.")
    user = consume_email_token(db, raw, purpose=PURPOSE_RESET)
    user.password_hash = hash_password(new_password)
    db.commit()
    db.refresh(user)
    return user


def user_public_dict(user: User) -> dict[str, Any]:
    return {
        "id": user.id,
        "email": user.email,
        "emailVerified": user.email_verified_at is not None,
        "termsAccepted": user.terms_accepted_at is not None,
    }
