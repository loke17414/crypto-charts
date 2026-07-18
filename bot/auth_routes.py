"""Auth API routes — register, login, me."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from bot.auth_service import authenticate_user, create_access_token, create_user, decode_access_token
from bot.db import get_db
from bot.models import User
from bot.platform_config import auth_required

router = APIRouter(prefix="/api/auth", tags=["auth"])


class RegisterBody(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class LoginBody(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


def _user_payload(user: User) -> dict[str, Any]:
    return {"id": user.id, "email": user.email}


def _user_from_authorization(authorization: str | None, db: Session) -> User:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Login required")
    token = authorization[7:].strip()
    try:
        payload = decode_access_token(token)
        user_id = int(payload["sub"])
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired token") from exc
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
    """Return logged-in user, or None when AUTH_REQUIRED=false and no token."""
    if not authorization or not authorization.startswith("Bearer "):
        if auth_required():
            raise HTTPException(status_code=401, detail="Login required")
        return None
    return _user_from_authorization(authorization, db)


def peek_optional_user(
    authorization: str | None = Header(default=None, alias="Authorization"),
    db: Session = Depends(get_db),
) -> User | None:
    """Like get_optional_user but never 401 — for public endpoints (e.g. /api/health)."""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    try:
        return _user_from_authorization(authorization, db)
    except HTTPException:
        return None


@router.post("/register")
def register(body: RegisterBody, db: Session = Depends(get_db)) -> dict[str, Any]:
    try:
        user = create_user(db, body.email, body.password)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    token, expires_in = create_access_token(user_id=user.id, email=user.email)
    return {
        "ok": True,
        "access_token": token,
        "token_type": "bearer",
        "expires_in": expires_in,
        "user": _user_payload(user),
    }


@router.post("/login")
def login(body: LoginBody, db: Session = Depends(get_db)) -> dict[str, Any]:
    user = authenticate_user(db, body.email, body.password)
    if not user:
        raise HTTPException(status_code=401, detail="Invalid email or password")
    token, expires_in = create_access_token(user_id=user.id, email=user.email)
    return {
        "ok": True,
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
    from bot.user_credentials import has_credentials

    return {
        "ok": True,
        "user": _user_payload(user),
        "authRequired": auth_required(),
        "credentialsSaved": has_credentials(db, user.id),
    }
