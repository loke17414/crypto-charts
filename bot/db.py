"""SQLAlchemy engine and session factory."""

from __future__ import annotations

import logging
from collections.abc import Generator
import os

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from bot.platform_config import database_url

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


def _make_engine() -> Engine:
    url = database_url()
    kwargs: dict = {"pool_pre_ping": True}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
    elif url.startswith("postgresql") or url.startswith("postgres"):
        # Modest pool for single uvicorn process; raise when adding workers.
        kwargs["pool_size"] = int(os.getenv("DB_POOL_SIZE", "5"))
        kwargs["max_overflow"] = int(os.getenv("DB_MAX_OVERFLOW", "10"))
    eng = create_engine(url, **kwargs)

    if url.startswith("sqlite"):

        @event.listens_for(eng, "connect")
        def _sqlite_fk(dbapi_conn, _connection_record) -> None:  # type: ignore[no-untyped-def]
            cursor = dbapi_conn.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    return eng


engine = _make_engine()
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _ensure_user_auth_columns() -> None:
    """
    create_all() does not ALTER existing tables. After email-auth deploy, login
    crashes with 500 if email_verified_at / terms_accepted_at are missing.
    """
    insp = inspect(engine)
    if "users" not in insp.get_table_names():
        return
    cols = {c["name"] for c in insp.get_columns("users")}
    dialect = engine.dialect.name
    ts_type = "TIMESTAMP WITH TIME ZONE" if dialect == "postgresql" else "DATETIME"
    added_verified = False
    with engine.begin() as conn:
        if "email_verified_at" not in cols:
            conn.execute(text(f"ALTER TABLE users ADD COLUMN email_verified_at {ts_type}"))
            added_verified = True
            logger.warning("Added missing column users.email_verified_at")
        if "terms_accepted_at" not in cols:
            conn.execute(text(f"ALTER TABLE users ADD COLUMN terms_accepted_at {ts_type}"))
            logger.warning("Added missing column users.terms_accepted_at")
        if added_verified:
            # Pre-migration accounts: treat as verified so SMTP enablement does not lock them out.
            conn.execute(
                text(
                    "UPDATE users SET email_verified_at = COALESCE(created_at, CURRENT_TIMESTAMP) "
                    "WHERE email_verified_at IS NULL"
                )
            )


def init_db() -> None:
    """Create tables if missing; patch columns Alembic may not have applied yet."""
    from bot import models  # noqa: F401

    Base.metadata.create_all(bind=engine)
    try:
        _ensure_user_auth_columns()
    except Exception:
        logger.exception("Failed to ensure user auth columns — login may fail until alembic upgrade")
