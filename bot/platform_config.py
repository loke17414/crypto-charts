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
    """0 = never expire (default). Positive = minutes until JWT expires."""
    raw = os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "0").strip()
    try:
        return max(0, int(raw))
    except ValueError:
        return 0


def master_encryption_key() -> str:
    """Fernet key for encrypting per-user Binance secrets (Phase 2-B)."""
    return os.getenv("MASTER_ENCRYPTION_KEY", "").strip().strip('"').strip("'")


def app_origin() -> str:
    """Allowed CORS origin for production (Phase 2-E). Default * for local."""
    return os.getenv("APP_ORIGIN", "*").strip() or "*"


def cors_allow_origins() -> list[str]:
    """Parse APP_ORIGIN — comma-separated list, or ['*'] for local/dev."""
    raw = app_origin()
    if raw == "*":
        return ["*"]
    origins = [part.strip().rstrip("/") for part in raw.split(",") if part.strip()]
    return origins or ["*"]


def max_concurrent_bots() -> int:
    """Hard cap on simultaneous per-user Node bot processes (Phase 2-C)."""
    raw = os.getenv("MAX_CONCURRENT_BOTS", "50").strip()
    try:
        return max(1, min(500, int(raw)))
    except ValueError:
        return 50


def register_rate_limit() -> tuple[int, int]:
    """Max signup attempts per IP within window seconds. Default 5 / hour."""
    try:
        max_calls = max(1, int(os.getenv("REGISTER_RATE_LIMIT", "5").strip()))
    except ValueError:
        max_calls = 5
    try:
        window = max(60, int(os.getenv("REGISTER_RATE_WINDOW_SECONDS", "3600").strip()))
    except ValueError:
        window = 3600
    return max_calls, window


def toss_secret_key() -> str:
    return os.getenv("TOSS_SECRET_KEY", "").strip().strip('"').strip("'")


def toss_client_key() -> str:
    return os.getenv("TOSS_CLIENT_KEY", "").strip().strip('"').strip("'")


def toss_pro_amount_krw() -> int:
    """Monthly Pro price in KRW (Toss billing charge amount)."""
    try:
        return max(100, int(os.getenv("TOSS_PRO_AMOUNT_KRW", "29000").strip()))
    except ValueError:
        return 29000


def toss_pro_order_name() -> str:
    return os.getenv("TOSS_PRO_ORDER_NAME", "Orbinex Pro 월간 구독").strip() or "Orbinex Pro 월간 구독"


def billing_configured() -> bool:
    """True when Toss billing keys are set (client + secret)."""
    return bool(toss_secret_key() and toss_client_key())


def billing_enforce() -> bool:
    """
    Enforce free-tier quotas for logged-in users.
    Default: on when AUTH_REQUIRED=true, else off (local single-tenant).
    Override with BILLING_ENFORCE=true|false.
    """
    raw = os.getenv("BILLING_ENFORCE", "").strip().lower()
    if raw in ("1", "true", "yes"):
        return True
    if raw in ("0", "false", "no"):
        return False
    return auth_required()


def free_bot_seconds_per_week() -> int:
    """Free plan bot runtime per week. Default 48h."""
    try:
        hours = float(os.getenv("FREE_BOT_HOURS_PER_WEEK", "48").strip())
    except ValueError:
        hours = 48.0
    return max(0, int(hours * 3600))


def free_gpt_calls_per_week() -> int:
    try:
        return max(0, int(os.getenv("FREE_GPT_CALLS_PER_WEEK", "20").strip()))
    except ValueError:
        return 20


def billing_week_timezone() -> str:
    """IANA tz for weekly quota reset. Default Asia/Seoul."""
    return os.getenv("BILLING_WEEK_TIMEZONE", "Asia/Seoul").strip() or "Asia/Seoul"


def smtp_host() -> str:
    return os.getenv("SMTP_HOST", "").strip()


def smtp_port() -> int:
    try:
        return max(1, int(os.getenv("SMTP_PORT", "587").strip()))
    except ValueError:
        return 587


def smtp_user() -> str:
    return os.getenv("SMTP_USER", "").strip()


def smtp_password() -> str:
    return os.getenv("SMTP_PASSWORD", "").strip().strip('"').strip("'")


def smtp_from_email() -> str:
    return os.getenv("SMTP_FROM", "").strip() or smtp_user()


def smtp_use_tls() -> bool:
    return os.getenv("SMTP_USE_TLS", "true").lower() in ("1", "true", "yes")


def email_require_verification() -> bool:
    """
    Require verified email before login.
    Default: true when SMTP is configured, else false (local/dev).
    """
    raw = os.getenv("EMAIL_REQUIRE_VERIFICATION", "").strip().lower()
    if raw in ("1", "true", "yes"):
        return True
    if raw in ("0", "false", "no"):
        return False
    return bool(smtp_host() and smtp_from_email())
