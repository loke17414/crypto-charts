"""Platform settings for multi-user SaaS (Phase 2-A)."""

from __future__ import annotations

import logging
import os
import secrets
from pathlib import Path

from dotenv import load_dotenv

from bot.config import ROOT

load_dotenv(ROOT / ".env", override=False)

logger = logging.getLogger(__name__)

DATA_DIR = ROOT / "data"
DEFAULT_DB_PATH = DATA_DIR / "cryptocharts.db"
ENV_PATH = ROOT / ".env"


def database_url() -> str:
    explicit = os.getenv("DATABASE_URL", "").strip()
    if explicit:
        return explicit
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return f"sqlite:///{DEFAULT_DB_PATH.as_posix()}"


def auth_required() -> bool:
    return os.getenv("AUTH_REQUIRED", "false").lower() in ("1", "true", "yes")


def _persist_jwt_secret(secret: str) -> None:
    """Keep JWT_SECRET stable across restarts so existing logins stay valid."""
    lines: list[str] = []
    if ENV_PATH.exists():
        lines = ENV_PATH.read_text(encoding="utf-8").splitlines()
    updated: list[str] = []
    found = False
    for line in lines:
        if line.startswith("JWT_SECRET="):
            updated.append(f'JWT_SECRET="{secret}"')
            found = True
        else:
            updated.append(line)
    if not found:
        if updated and updated[-1].strip():
            updated.append("")
        updated.append(f'JWT_SECRET="{secret}"')
    ENV_PATH.write_text("\n".join(updated).rstrip() + "\n", encoding="utf-8")
    load_dotenv(ENV_PATH, override=True)
    os.environ["JWT_SECRET"] = secret
    logger.warning("JWT_SECRET was empty — generated and saved to .env (re-login once if sessions were invalid)")


def jwt_secret() -> str:
    secret = os.getenv("JWT_SECRET", "").strip().strip('"').strip("'")
    if secret:
        return secret
    if auth_required():
        generated = secrets.token_hex(32)
        try:
            _persist_jwt_secret(generated)
        except OSError:
            os.environ["JWT_SECRET"] = generated
            logger.error("JWT_SECRET could not be saved to .env — logins will break on restart")
        return generated
    return "dev-insecure-jwt-secret-change-me"


def jwt_algorithm() -> str:
    return os.getenv("JWT_ALGORITHM", "HS256")


def access_token_expire_minutes() -> int:
    raw = os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "1440").strip()
    try:
        return max(5, int(raw))
    except ValueError:
        return 1440


def master_encryption_key() -> str:
    """Fernet key for encrypting per-user Binance secrets (Phase 2-B)."""
    return os.getenv("MASTER_ENCRYPTION_KEY", "").strip().strip('"').strip("'")


def app_origin() -> str:
    """Allowed CORS origin for production (Phase 2-E). Default * for local."""
    return os.getenv("APP_ORIGIN", "*").strip() or "*"


def max_concurrent_bots() -> int:
    """Hard cap on simultaneous per-user Node bot processes (Phase 2-C)."""
    raw = os.getenv("MAX_CONCURRENT_BOTS", "50").strip()
    try:
        return max(1, min(500, int(raw)))
    except ValueError:
        return 50
