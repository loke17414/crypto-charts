"""Platform settings for multi-user SaaS (Phase 2-A)."""

from __future__ import annotations

import logging
import os
import secrets
from pathlib import Path

from dotenv import load_dotenv

from bot.config import ROOT

# .env is source of truth. override=True so systemd EnvironmentFile cannot leave
# mangled/empty SMTP_* values that block python-dotenv (override=False) from fixing them.
load_dotenv(ROOT / ".env", override=True)

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
    # Gmail/Naver app passwords are often pasted with spaces; systemd may leave quotes.
    return (
        os.getenv("SMTP_PASSWORD", "")
        .strip()
        .strip('"')
        .strip("'")
        .replace(" ", "")
        .replace("\r", "")
    )


def smtp_from_email() -> str:
    return os.getenv("SMTP_FROM", "").strip().strip('"').strip("'") or smtp_user()


def smtp_use_tls() -> bool:
    return os.getenv("SMTP_USE_TLS", "true").lower() in ("1", "true", "yes")


def _smtp_from_usable(from_email: str, user: str) -> str:
    """Prefer a real email address; drop broken display-only From (e.g. systemd ate <...>)."""
    from email.utils import parseaddr

    name, addr = parseaddr((from_email or "").strip().strip('"').strip("'"))
    if addr and "@" in addr:
        return addr
    if user and "@" in user:
        return user.strip().strip('"').strip("'")
    raw = (from_email or "").strip().strip('"').strip("'")
    if "@" in raw and "<" not in raw and ">" not in raw:
        return raw
    return ""


def _clean_secret(raw: str) -> str:
    return (raw or "").strip().strip('"').strip("'").replace(" ", "").replace("\r", "")


def _smtp_profile(
    *,
    name: str,
    host: str,
    port: int,
    user: str,
    password: str,
    from_email: str,
    use_tls: bool,
) -> dict[str, object] | None:
    host = (host or "").strip().strip('"').strip("'")
    user = (user or "").strip().strip('"').strip("'")
    from_addr = _smtp_from_usable(from_email, user)
    if not host or not from_addr:
        return None
    return {
        "name": name,
        "host": host,
        "port": port,
        "user": user or from_addr,
        "password": _clean_secret(password),
        "from_email": from_addr,
        "use_tls": use_tls,
    }


def smtp_profiles() -> list[dict[str, object]]:
    """
    Primary SMTP_* plus optional secondary SMTP2_* (e.g. Gmail + Naver).
    Prefer Naver before Gmail when both exist — VPS IPs are often rejected by Google.
    """
    # Re-read .env each call so `nano .env` + restart isn't required for diagnose scripts;
    # cheap and avoids stale systemd-mangled values.
    load_dotenv(ENV_PATH, override=True)

    profiles: list[dict[str, object]] = []
    primary = _smtp_profile(
        name="primary",
        host=smtp_host(),
        port=smtp_port(),
        user=smtp_user(),
        password=smtp_password(),
        from_email=os.getenv("SMTP_FROM", "").strip(),
        use_tls=smtp_use_tls(),
    )
    if primary:
        profiles.append(primary)

    try:
        port2 = max(1, int(os.getenv("SMTP2_PORT", "587").strip()))
    except ValueError:
        port2 = 587
    secondary = _smtp_profile(
        name="secondary",
        host=os.getenv("SMTP2_HOST", "").strip(),
        port=port2,
        user=os.getenv("SMTP2_USER", "").strip(),
        password=os.getenv("SMTP2_PASSWORD", ""),
        from_email=os.getenv("SMTP2_FROM", "").strip(),
        use_tls=os.getenv("SMTP2_USE_TLS", "true").lower() in ("1", "true", "yes"),
    )
    if secondary:
        profiles.append(secondary)

    provider = os.getenv("SMTP_PROVIDER", "").strip().lower()
    if provider in ("gmail", "google"):
        profiles = [
            p
            for p in profiles
            if "gmail.com" in str(p.get("host") or "").lower()
            or "google.com" in str(p.get("host") or "").lower()
        ]
    elif provider in ("naver",):
        profiles = [p for p in profiles if "naver.com" in str(p.get("host") or "").lower()]

    def _rank(p: dict[str, object]) -> int:
        host = str(p.get("host") or "").lower()
        # Prefer Gmail — consumer Naver SMTP app passwords often fail from VPS.
        if "gmail.com" in host or "google.com" in host:
            return 0
        if "naver.com" in host:
            return 2
        return 1

    profiles.sort(key=_rank)
    return profiles


def smtp_configured() -> bool:
    return bool(smtp_profiles()) or bool(resend_api_key())


def resend_api_key() -> str:
    return os.getenv("RESEND_API_KEY", "").strip().strip('"').strip("'")


def resend_from_email() -> str:
    # Needs a verified domain sender in production, e.g. Orbinex <noreply@orbinex.net>
    return os.getenv("RESEND_FROM", "").strip() or "Orbinex <onboarding@resend.dev>"


def email_require_verification() -> bool:
    """
    Require verified email before login.
    Default: true when any mail provider is configured, else false (local/dev).
    """
    raw = os.getenv("EMAIL_REQUIRE_VERIFICATION", "").strip().lower()
    if raw in ("1", "true", "yes"):
        return True
    if raw in ("0", "false", "no"):
        return False
    return smtp_configured()
