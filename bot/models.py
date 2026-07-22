"""Database models for the multi-user platform (Phase 2-A+)."""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from bot.db import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    terms_accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    credentials: Mapped[ExchangeCredential | None] = relationship(
        "ExchangeCredential", back_populates="user", uselist=False
    )
    openai_credential: Mapped["OpenAiCredential | None"] = relationship(
        "OpenAiCredential", back_populates="user", uselist=False
    )
    subscription: Mapped["Subscription | None"] = relationship(
        "Subscription", back_populates="user", uselist=False
    )
    usage_quota: Mapped["UsageQuota | None"] = relationship(
        "UsageQuota", back_populates="user", uselist=False
    )
    email_tokens: Mapped[list["EmailToken"]] = relationship(
        "EmailToken", back_populates="user", cascade="all, delete-orphan"
    )


class ExchangeCredential(Base):
    """Encrypted Binance keys per user (Phase 2-B — table ready in 2-A)."""

    __tablename__ = "exchange_credentials"
    __table_args__ = (UniqueConstraint("user_id", name="uq_exchange_credentials_user"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    api_key_encrypted: Mapped[str] = mapped_column(Text, nullable=False)
    api_secret_encrypted: Mapped[str] = mapped_column(Text, nullable=False)
    use_testnet: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    user: Mapped[User] = relationship("User", back_populates="credentials")


class OpenAiCredential(Base):
    """Encrypted OpenAI API key per user — never shared across accounts."""

    __tablename__ = "openai_credentials"
    __table_args__ = (UniqueConstraint("user_id", name="uq_openai_credentials_user"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    api_key_encrypted: Mapped[str] = mapped_column(Text, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    user: Mapped[User] = relationship("User", back_populates="openai_credential")


class Subscription(Base):
    """Toss Payments billing-key subscription (free by default)."""

    __tablename__ = "subscriptions"
    __table_args__ = (UniqueConstraint("user_id", name="uq_subscriptions_user"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    plan: Mapped[str] = mapped_column(String(32), default="free", nullable=False)  # free | pro
    status: Mapped[str] = mapped_column(String(32), default="inactive", nullable=False)
    toss_customer_key: Mapped[str | None] = mapped_column(String(255), nullable=True, index=True)
    toss_billing_key_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    cancel_at_period_end: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # month | year — controls renew amount and period length
    billing_interval: Mapped[str] = mapped_column(String(16), default="month", nullable=False)
    current_period_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    user: Mapped[User] = relationship("User", back_populates="subscription")


class UsageQuota(Base):
    """Weekly free-tier counters (bot runtime + GPT calls)."""

    __tablename__ = "usage_quotas"
    __table_args__ = (UniqueConstraint("user_id", name="uq_usage_quotas_user"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    week_start: Mapped[str] = mapped_column(String(32), nullable=False, default="")  # YYYY-MM-DD
    bot_seconds_used: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    gpt_calls_used: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Purchased add-on GPT calls (not reset on weekly rollover)
    gpt_bonus_calls: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    bot_session_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    user: Mapped[User] = relationship("User", back_populates="usage_quota")


class EmailToken(Base):
    """One-time tokens for email verification and password reset."""

    __tablename__ = "email_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    token_hash: Mapped[str] = mapped_column(String(128), unique=True, index=True, nullable=False)
    purpose: Mapped[str] = mapped_column(String(32), nullable=False)  # verify | reset
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    user: Mapped[User] = relationship("User", back_populates="email_tokens")


class PaymentRecord(Base):
    """Toss charge ledger for subscribe / renew (receipts for users + ops)."""

    __tablename__ = "payment_records"
    __table_args__ = (UniqueConstraint("order_id", name="uq_payment_records_order_id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    order_id: Mapped[str] = mapped_column(String(128), nullable=False)
    payment_key: Mapped[str | None] = mapped_column(String(200), nullable=True)
    amount: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    currency: Mapped[str] = mapped_column(String(8), nullable=False, default="KRW")
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="paid")
    kind: Mapped[str] = mapped_column(String(32), nullable=False, default="subscribe")  # subscribe|renew
    method: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class AdminAuditLog(Base):
    """Durable admin action log (survives restarts)."""

    __tablename__ = "admin_audit_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    admin_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    admin_email: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    action: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    target_user_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    detail: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False, index=True
    )
