"""Auth API routes — register, login, me, email verify, password reset."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from bot.auth_service import (
    assert_email_verified_for_login,
    authenticate_user,
    create_access_token,
    create_user,
    decode_access_token,
    request_password_reset,
    resend_verification,
    reset_password_with_token,
    user_public_dict,
    verify_email_with_token,
)
from bot.db import get_db
from bot.email_service import smtp_configured
from bot.models import User
from bot.platform_config import auth_required, email_require_verification, register_rate_limit
from bot.rate_limit import RateLimiter, client_ip

router = APIRouter(prefix="/api/auth", tags=["auth"])

_reg_max, _reg_window = register_rate_limit()
_register_limiter = RateLimiter(max_calls=_reg_max, window_seconds=_reg_window)
_login_limiter = RateLimiter(max_calls=max(10, _reg_max * 4), window_seconds=_reg_window)
_email_limiter = RateLimiter(max_calls=5, window_seconds=3600)


class RegisterBody(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    accept_terms: bool = False


class LoginBody(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class EmailBody(BaseModel):
    email: EmailStr


class TokenBody(BaseModel):
    token: str = Field(min_length=10, max_length=200)


class ResetPasswordBody(BaseModel):
    token: str = Field(min_length=10, max_length=200)
    password: str = Field(min_length=8, max_length=128)


def _user_payload(user: User) -> dict[str, Any]:
    return user_public_dict(user)


def _user_from_authorization(authorization: str | None, db: Session) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="로그인이 필요합니다. 다시 로그인해 주세요.")
    token = authorization[7:].strip()
    try:
        payload = decode_access_token(token)
        user_id = int(payload["sub"])
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(
            status_code=401,
            detail="로그인 세션이 만료되었거나 유효하지 않습니다. 다시 로그인해 주세요.",
        ) from exc
    user = db.query(User).filter(User.id == user_id, User.is_active.is_(True)).one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")
    return user


def get_current_user(
    authorization: str | None = Header(default=None, alias="Authorization"),
    db: Session = Depends(get_db),
) -> User:
    return _user_from_authorization(authorization, db)


def get_optional_user(
    authorization: str | None = Header(default=None, alias="Authorization"),
    db: Session = Depends(get_db),
) -> User | None:
    if not authorization or not authorization.startswith("Bearer "):
        if auth_required():
            raise HTTPException(status_code=401, detail="Login required")
        return None
    return _user_from_authorization(authorization, db)


def peek_optional_user(
    authorization: str | None = Header(default=None, alias="Authorization"),
    db: Session = Depends(get_db),
) -> User | None:
    if not authorization or not authorization.startswith("Bearer "):
        return None
    try:
        return _user_from_authorization(authorization, db)
    except HTTPException:
        return None


@router.post("/register")
def register(body: RegisterBody, request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    ip = client_ip(request)
    allowed, retry_after = _register_limiter.check(f"register:{ip}")
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"가입 시도가 너무 많습니다. {retry_after}초 후에 다시 시도해 주세요.",
            headers={"Retry-After": str(retry_after)},
        )
    try:
        user, meta = create_user(db, body.email, body.password, accept_terms=body.accept_terms)
    except ValueError as exc:
        msg = str(exc)
        # SMTP / mail delivery problems → 503 so the client shows a clear retry message
        if "SMTP" in msg or "인증 메일" in msg or "메일 발송" in msg:
            raise HTTPException(status_code=503, detail=msg) from exc
        raise HTTPException(status_code=400, detail=msg) from exc

    # If verification required, do not issue JWT until verified
    if meta.get("emailVerificationRequired"):
        if not meta.get("emailSent"):
            raise HTTPException(
                status_code=503,
                detail=meta.get("emailError")
                or "인증 메일 발송에 실패했습니다. SMTP 설정을 확인해 주세요.",
            )
        return {
            "ok": True,
            "needsVerification": True,
            "access_token": None,
            "token_type": "bearer",
            "expires_in": 0,
            "user": _user_payload(user),
            **meta,
            "message": "가입되었습니다. 이메일로 보낸 인증 링크를 확인해 주세요.",
        }

    token, expires_in = create_access_token(user_id=user.id, email=user.email)
    message = meta.get("warning") or "가입되었습니다."
    return {
        "ok": True,
        "needsVerification": False,
        "access_token": token,
        "token_type": "bearer",
        "expires_in": expires_in,
        "user": _user_payload(user),
        "message": message,
        **meta,
    }


@router.post("/login")
def login(body: LoginBody, request: Request, db: Session = Depends(get_db)) -> dict[str, Any]:
    ip = client_ip(request)
    allowed, retry_after = _login_limiter.check(f"login:{ip}")
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"로그인 시도가 너무 많습니다. {retry_after}초 후에 다시 시도해 주세요.",
            headers={"Retry-After": str(retry_after)},
        )
    try:
        user = authenticate_user(db, body.email, body.password)
    except Exception as exc:
        # Missing DB columns / schema drift used to surface as opaque 500 "API error 500".
        raise HTTPException(
            status_code=503,
            detail="로그인 서버 오류입니다. 잠시 후 다시 시도하거나 관리자에게 문의해 주세요.",
        ) from exc
    if not user:
        raise HTTPException(
            status_code=401,
            detail="이메일 또는 비밀번호가 올바르지 않습니다.",
        )
    try:
        assert_email_verified_for_login(user)
    except ValueError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    token, expires_in = create_access_token(user_id=user.id, email=user.email)
    return {
        "ok": True,
        "access_token": token,
        "token_type": "bearer",
        "expires_in": expires_in,
        "user": _user_payload(user),
    }



@router.post("/verify-email")
def verify_email(body: TokenBody, db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        user = verify_email_with_token(db, body.token)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    token, expires_in = create_access_token(user_id=user.id, email=user.email)
    return {
        "ok": True,
        "message": "이메일 인증이 완료되었습니다.",
        "access_token": token,
        "token_type": "bearer",
        "expires_in": expires_in,
        "user": _user_payload(user),
    }


@router.post("/resend-verification")
def resend_verification_route(
    body: EmailBody,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    ip = client_ip(request)
    allowed, retry_after = _email_limiter.check(f"resend:{ip}")
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"요청이 너무 많습니다. {retry_after}초 후에 다시 시도해 주세요.",
            headers={"Retry-After": str(retry_after)},
        )
    try:
        return resend_verification(db, body.email)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/forgot-password")
def forgot_password(
    body: EmailBody,
    request: Request,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    ip = client_ip(request)
    allowed, retry_after = _email_limiter.check(f"forgot:{ip}")
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"요청이 너무 많습니다. {retry_after}초 후에 다시 시도해 주세요.",
            headers={"Retry-After": str(retry_after)},
        )
    try:
        return request_password_reset(db, body.email)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/reset-password")
def reset_password(body: ResetPasswordBody, db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        user = reset_password_with_token(db, body.token, body.password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    token, expires_in = create_access_token(user_id=user.id, email=user.email)
    return {
        "ok": True,
        "message": "비밀번호가 변경되었습니다.",
        "access_token": token,
        "token_type": "bearer",
        "expires_in": expires_in,
        "user": _user_payload(user),
    }


@router.get("/me")
def me(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    from bot.user_credentials import has_credentials, load_credentials
    from bot.user_openai import has_openai_key

    saved = has_credentials(db, user.id)
    use_testnet = None
    if saved:
        creds = load_credentials(db, user.id)
        if creds:
            use_testnet = creds[2]

    return {
        "ok": True,
        "user": _user_payload(user),
        "authRequired": auth_required(),
        "emailRequireVerification": email_require_verification(),
        "smtpConfigured": smtp_configured(),
        "credentialsSaved": saved,
        "credentialsUseTestnet": use_testnet,
        "openaiKeySaved": has_openai_key(db, user.id),
    }
