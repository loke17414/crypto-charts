"""Platform settings for multi-user SaaS (Phase 2-A)."""

from __future__ import annotations

import logging
import os
import secrets
from pathlib import Path
from typing import Any

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


def admin_emails() -> set[str]:
    """Comma-separated admin emails (case-insensitive). Empty = no admins."""
    raw = os.getenv("ADMIN_EMAILS", "").strip()
    if not raw:
        return set()
    return {part.strip().lower() for part in raw.split(",") if part.strip()}


def is_admin_email(email: str | None) -> bool:
    if not email:
        return False
    return email.strip().lower() in admin_emails()


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
    """Minutes until JWT expires. 0 = never expire (dev only).

    Production default recommendation: 10080 (7 days).
    """
    raw = os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "10080").strip()
    try:
        return max(0, int(raw))
    except ValueError:
        return 10080


def support_email() -> str:
    return os.getenv("SUPPORT_EMAIL", "support@orbinex.net").strip() or "support@orbinex.net"


def business_profile() -> dict[str, str]:
    """KR business identity shown on legal/footer pages (전자상거래법 표시정보)."""
    return {
        "name": os.getenv("BUSINESS_NAME", "오비넥스").strip() or "오비넥스",
        "representative": os.getenv("BUSINESS_REPRESENTATIVE", "이동건").strip() or "이동건",
        "registrationNumber": (
            os.getenv("BUSINESS_REGISTRATION_NUMBER", "203-25-55373").strip() or "203-25-55373"
        ),
        "address": (
            os.getenv("BUSINESS_ADDRESS", "경기 군포시 산본천로33 701동703호").strip()
            or "경기 군포시 산본천로33 701동703호"
        ),
        "phone": os.getenv("BUSINESS_PHONE", "010-3142-1916").strip() or "010-3142-1916",
        "supportEmail": support_email(),
    }


def master_encryption_key() -> str:
    """Fernet key for encrypting per-user Binance secrets (Phase 2-B)."""
    return os.getenv("MASTER_ENCRYPTION_KEY", "").strip().strip('"').strip("'")


def app_origin() -> str:
    """Allowed CORS origin for production (Phase 2-E). Default * for local."""
    return os.getenv("APP_ORIGIN", "*").strip() or "*"


def cors_allow_origins() -> list[str]:
    """Parse APP_ORIGIN — comma-separated list, or ['*'] for local/dev.

    Also allows common www / admin subdomain variants so Cloudflare host
    aliases do not break browser login (CORS).
    """
    raw = app_origin()
    if raw == "*":
        return ["*"]
    origins: list[str] = []
    seen: set[str] = set()
    for part in raw.split(","):
        origin = part.strip().rstrip("/")
        if not origin or origin in seen:
            continue
        seen.add(origin)
        origins.append(origin)
        # https://orbinex.net → www + admin
        if origin.startswith("https://") and "://" in origin:
            host = origin.split("://", 1)[1]
            if host.startswith("www."):
                apex = f"https://{host[4:]}"
                if apex not in seen:
                    seen.add(apex)
                    origins.append(apex)
            else:
                www = f"https://www.{host}"
                admin = f"https://admin.{host}"
                for extra in (www, admin):
                    if extra not in seen:
                        seen.add(extra)
                        origins.append(extra)
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


def toss_pro_annual_amount_krw() -> int:
    """Annual Pro price in KRW (default = 10× monthly = ₩290,000)."""
    try:
        return max(100, int(os.getenv("TOSS_PRO_ANNUAL_AMOUNT_KRW", "290000").strip()))
    except ValueError:
        return 290000


def toss_pro_order_name() -> str:
    return os.getenv("TOSS_PRO_ORDER_NAME", "Orbinex Pro Monthly").strip() or "Orbinex Pro Monthly"


def toss_pro_annual_order_name() -> str:
    return (
        os.getenv("TOSS_PRO_ANNUAL_ORDER_NAME", "Orbinex Pro Annual").strip()
        or "Orbinex Pro Annual"
    )


def gpt_pack_amount_krw() -> int:
    """One-time GPT add-on pack price (Pro only)."""
    try:
        return max(100, int(os.getenv("GPT_PACK_AMOUNT_KRW", "5000").strip()))
    except ValueError:
        return 5000


def gpt_pack_calls() -> int:
    """Extra GPT calls granted by one pack (does not reset weekly)."""
    try:
        return max(1, int(os.getenv("GPT_PACK_CALLS", "50").strip()))
    except ValueError:
        return 50


def gpt_pack_order_name() -> str:
    return os.getenv("GPT_PACK_ORDER_NAME", "Orbinex GPT Pack").strip() or "Orbinex GPT Pack"


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


def live_trading_enabled() -> bool:
    """Global kill switch for real exchange orders (server bot live mode). Default true."""
    raw = os.getenv("LIVE_TRADING_ENABLED", "true").strip().lower()
    return raw not in ("0", "false", "no", "off")


def toss_webhook_secret() -> str:
    """Optional shared secret; if set, webhook must send X-Orbinex-Webhook-Secret."""
    return os.getenv("TOSS_WEBHOOK_SECRET", "").strip().strip('"').strip("'")


def free_bot_seconds_per_week() -> int:
    """Free plan bot runtime per week. Default 24h."""
    try:
        hours = float(os.getenv("FREE_BOT_HOURS_PER_WEEK", "24").strip())
    except ValueError:
        hours = 24.0
    return max(0, int(hours * 3600))


def free_gpt_calls_per_week() -> int:
    """Free plan GPT calls per week. Default 5 (mini only)."""
    try:
        return max(0, int(os.getenv("FREE_GPT_CALLS_PER_WEEK", "5").strip()))
    except ValueError:
        return 5


def pro_gpt_calls_per_week() -> int:
    """Pro plan GPT calls per week. Default 50 (hybrid). 0 = unlimited (not recommended)."""
    try:
        return max(0, int(os.getenv("PRO_GPT_CALLS_PER_WEEK", "50").strip()))
    except ValueError:
        return 50


def free_max_strategy_slots() -> int:
    """Free plan max entry-condition slots. Default 1 (multi-slot is Pro)."""
    try:
        return max(1, int(os.getenv("FREE_MAX_STRATEGY_SLOTS", "1").strip()))
    except ValueError:
        return 1


def pro_max_strategy_slots() -> int:
    """Pro plan max entry-condition slots. Default 6."""
    try:
        return max(1, int(os.getenv("PRO_MAX_STRATEGY_SLOTS", "6").strip()))
    except ValueError:
        return 6


def free_web_research_allowed() -> bool:
    """Whether Free may use web strategy research. Default false (Pro feature)."""
    raw = os.getenv("FREE_WEB_RESEARCH", "").strip().lower()
    if raw in ("1", "true", "yes"):
        return True
    if raw in ("0", "false", "no"):
        return False
    return False


def free_recommended_strategies_allowed() -> bool:
    """Whether Free may use AI recommended strategies. Default false (Pro feature)."""
    raw = os.getenv("FREE_RECOMMENDED_STRATEGIES", "").strip().lower()
    if raw in ("1", "true", "yes"):
        return True
    if raw in ("0", "false", "no"):
        return False
    return False


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
    # Prefer a replyable local-part (auth@ / hello@). noreply@ often lands in spam.
    return os.getenv("RESEND_FROM", "").strip() or "Orbinex <auth@orbinex.net>"


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


# Keys admins may edit from the console (no secrets).
ADMIN_EDITABLE_SETTINGS: dict[str, dict[str, Any]] = {
    "FREE_BOT_HOURS_PER_WEEK": {"type": "float", "label": "Free 주간 봇 시간", "min": 0, "max": 168},
    "FREE_GPT_CALLS_PER_WEEK": {"type": "int", "label": "Free 주간 AI 호출", "min": 0, "max": 10000},
    "PRO_GPT_CALLS_PER_WEEK": {"type": "int", "label": "Pro 주간 AI 호출", "min": 0, "max": 100000},
    "FREE_MAX_STRATEGY_SLOTS": {"type": "int", "label": "Free 전략 슬롯", "min": 1, "max": 20},
    "PRO_MAX_STRATEGY_SLOTS": {"type": "int", "label": "Pro 전략 슬롯", "min": 1, "max": 20},
    "FREE_WEB_RESEARCH": {"type": "bool", "label": "Free 웹 리서치"},
    "FREE_RECOMMENDED_STRATEGIES": {"type": "bool", "label": "Free 추천 전략"},
    "MAX_CONCURRENT_BOTS": {"type": "int", "label": "동시 봇 한도", "min": 1, "max": 500},
    "TOSS_PRO_AMOUNT_KRW": {"type": "int", "label": "Pro 월 요금(원)", "min": 100, "max": 10_000_000},
    "TOSS_PRO_ANNUAL_AMOUNT_KRW": {"type": "int", "label": "Pro 연 요금(원)", "min": 100, "max": 100_000_000},
    "GPT_PACK_AMOUNT_KRW": {"type": "int", "label": "AI 팩 요금(원)", "min": 100, "max": 10_000_000},
    "GPT_PACK_CALLS": {"type": "int", "label": "AI 팩 호출 수", "min": 1, "max": 100000},
    "BILLING_ENFORCE": {"type": "bool", "label": "쿼터 강제"},
    "LIVE_TRADING_ENABLED": {"type": "bool", "label": "실거래 허용"},
    "EMAIL_REQUIRE_VERIFICATION": {"type": "bool", "label": "이메일 인증 필수"},
    "SUPPORT_EMAIL": {"type": "str", "label": "고객센터 이메일", "max": 200},
    "BUSINESS_NAME": {"type": "str", "label": "상호명", "max": 120},
    "BUSINESS_REPRESENTATIVE": {"type": "str", "label": "대표자", "max": 80},
    "BUSINESS_REGISTRATION_NUMBER": {"type": "str", "label": "사업자등록번호", "max": 40},
    "BUSINESS_ADDRESS": {"type": "str", "label": "사업장주소", "max": 200},
    "BUSINESS_PHONE": {"type": "str", "label": "연락처", "max": 40},
    "OPENAI_MODEL": {"type": "str", "label": "OpenAI 모델", "max": 80},
    "OPENAI_ENABLED": {"type": "bool", "label": "OpenAI 사용"},
    "OPENAI_MAX_CHAT_PER_HOUR": {"type": "int", "label": "시간당 채팅 상한", "min": 1, "max": 10000},
}


def upsert_env_values(updates: dict[str, str]) -> list[str]:
    """Write key=value pairs into .env and reload into process env. Returns changed keys."""
    if not updates:
        return []
    lines: list[str] = []
    if ENV_PATH.exists():
        lines = ENV_PATH.read_text(encoding="utf-8").splitlines()
    changed: list[str] = []
    remaining = dict(updates)
    out: list[str] = []
    for line in lines:
        raw = line.strip()
        if not raw or raw.startswith("#") or "=" not in line:
            out.append(line)
            continue
        key, _, _old = line.partition("=")
        key = key.strip()
        if key in remaining:
            val = remaining.pop(key)
            out.append(f"{key}={val}")
            os.environ[key] = val
            changed.append(key)
        else:
            out.append(line)
    for key, val in remaining.items():
        if out and out[-1].strip():
            out.append("")
        out.append(f"{key}={val}")
        os.environ[key] = val
        changed.append(key)
    ENV_PATH.parent.mkdir(parents=True, exist_ok=True)
    ENV_PATH.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
    load_dotenv(ENV_PATH, override=True)
    return changed


def current_editable_settings() -> list[dict[str, Any]]:
    """Current values for admin-editable knobs."""
    rows: list[dict[str, Any]] = []
    for key, meta in ADMIN_EDITABLE_SETTINGS.items():
        raw = os.getenv(key, "").strip().strip('"').strip("'")
        typ = meta["type"]
        if typ == "bool":
            if raw == "":
                # Fallbacks matching helpers
                if key == "BILLING_ENFORCE":
                    value: Any = billing_enforce()
                elif key == "LIVE_TRADING_ENABLED":
                    value = live_trading_enabled()
                elif key == "EMAIL_REQUIRE_VERIFICATION":
                    value = email_require_verification()
                elif key == "OPENAI_ENABLED":
                    value = True
                elif key == "FREE_WEB_RESEARCH":
                    value = free_web_research_allowed()
                elif key == "FREE_RECOMMENDED_STRATEGIES":
                    value = free_recommended_strategies_allowed()
                else:
                    value = False
            else:
                value = raw.lower() in ("1", "true", "yes")
        elif typ == "int":
            try:
                value = int(float(raw)) if raw else None
            except ValueError:
                value = None
        elif typ == "float":
            try:
                value = float(raw) if raw else None
            except ValueError:
                value = None
        else:
            value = raw or None
        # Prefer live helper values when env empty for numeric limits
        if value is None and key == "FREE_BOT_HOURS_PER_WEEK":
            value = round(free_bot_seconds_per_week() / 3600, 2)
        elif value is None and key == "FREE_GPT_CALLS_PER_WEEK":
            value = free_gpt_calls_per_week()
        elif value is None and key == "PRO_GPT_CALLS_PER_WEEK":
            value = pro_gpt_calls_per_week()
        elif value is None and key == "FREE_MAX_STRATEGY_SLOTS":
            value = free_max_strategy_slots()
        elif value is None and key == "PRO_MAX_STRATEGY_SLOTS":
            value = pro_max_strategy_slots()
        elif value is None and key == "MAX_CONCURRENT_BOTS":
            value = max_concurrent_bots()
        elif value is None and key == "TOSS_PRO_AMOUNT_KRW":
            value = toss_pro_amount_krw()
        elif value is None and key == "TOSS_PRO_ANNUAL_AMOUNT_KRW":
            value = toss_pro_annual_amount_krw()
        elif value is None and key == "GPT_PACK_AMOUNT_KRW":
            value = gpt_pack_amount_krw()
        elif value is None and key == "GPT_PACK_CALLS":
            value = gpt_pack_calls()
        elif value is None and key == "OPENAI_MODEL":
            value = os.getenv("OPENAI_MODEL", "gpt-4o-mini") or "gpt-4o-mini"
        elif value is None and key == "OPENAI_MAX_CHAT_PER_HOUR":
            try:
                value = int(os.getenv("OPENAI_MAX_CHAT_PER_HOUR", "40") or 40)
            except ValueError:
                value = 40
        elif value is None and key.startswith("BUSINESS_"):
            profile = business_profile()
            mapping = {
                "BUSINESS_NAME": "name",
                "BUSINESS_REPRESENTATIVE": "representative",
                "BUSINESS_REGISTRATION_NUMBER": "registrationNumber",
                "BUSINESS_ADDRESS": "address",
                "BUSINESS_PHONE": "phone",
            }
            value = profile.get(mapping.get(key, ""), "")
        elif value is None and key == "SUPPORT_EMAIL":
            value = support_email()
        elif value is None and key == "FREE_WEB_RESEARCH":
            value = free_web_research_allowed()
        elif value is None and key == "FREE_RECOMMENDED_STRATEGIES":
            value = free_recommended_strategies_allowed()
        rows.append(
            {
                "key": key,
                "label": meta.get("label") or key,
                "type": typ,
                "value": value,
                "min": meta.get("min"),
                "max": meta.get("max"),
            }
        )
    return rows
