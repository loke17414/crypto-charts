"""Harden production .env for multi-user SaaS (idempotent).

- AUTH_REQUIRED=true
- APP_ORIGIN https if still *
- Comment SMTP_* / SMTP2_* when RESEND_API_KEY is set
- Ensure EMAIL_REQUIRE_VERIFICATION=true when Resend present
- Ensure JWT_SECRET / MASTER_ENCRYPTION_KEY exist (generate if missing)
- Note MAX_CONCURRENT_BOTS default

Usage:
  .venv/bin/python -m bot.harden_env
  .venv/bin/python -m bot.harden_env --dry-run
"""

from __future__ import annotations

import argparse
import secrets
from pathlib import Path

from cryptography.fernet import Fernet
from dotenv import load_dotenv

from bot.config import ROOT

ENV_PATH = ROOT / ".env"


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Harden Orbinex .env for production")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--origin", default="", help="Force APP_ORIGIN (e.g. https://orbinex.net)")
    return p.parse_args()


def _has_key(lines: list[str], key: str) -> bool:
    for line in lines:
        if line.startswith(f"{key}=") and not line.strip().startswith("#"):
            val = line.split("=", 1)[1].strip().strip('"').strip("'")
            if val:
                return True
    return False


def _get(lines: list[str], key: str) -> str:
    for line in lines:
        if line.startswith(f"{key}=") and not line.strip().startswith("#"):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def _set(lines: list[str], key: str, value: str) -> list[str]:
    out: list[str] = []
    found = False
    for line in lines:
        if line.startswith(f"{key}=") or line.startswith(f"#{key}="):
            if not found:
                out.append(f"{key}={value}")
                found = True
            # drop duplicates
        else:
            out.append(line)
    if not found:
        if out and out[-1].strip():
            out.append("")
        out.append(f"{key}={value}")
    return out


def _comment_prefixes(lines: list[str], prefixes: tuple[str, ...]) -> list[str]:
    out: list[str] = []
    for line in lines:
        stripped = line.lstrip()
        if stripped.startswith("#") or not stripped:
            out.append(line)
            continue
        key = stripped.split("=", 1)[0]
        if any(key == p or key.startswith(p) for p in prefixes):
            out.append("# " + line if not line.startswith("#") else line)
        else:
            out.append(line)
    return out


def main() -> int:
    args = _parse_args()
    if not ENV_PATH.is_file():
        print(f"ERROR: missing {ENV_PATH}")
        return 1

    lines = ENV_PATH.read_text(encoding="utf-8").splitlines()
    changes: list[str] = []

    if _get(lines, "AUTH_REQUIRED").lower() not in ("1", "true", "yes"):
        lines = _set(lines, "AUTH_REQUIRED", "true")
        changes.append("AUTH_REQUIRED=true")

    origin = args.origin.strip() or _get(lines, "APP_ORIGIN")
    if not origin or origin == "*":
        origin = args.origin.strip() or "https://orbinex.net"
        lines = _set(lines, "APP_ORIGIN", origin)
        changes.append(f"APP_ORIGIN={origin}")

    if not _has_key(lines, "JWT_SECRET"):
        secret = secrets.token_hex(32)
        lines = _set(lines, "JWT_SECRET", secret)
        changes.append("JWT_SECRET=<generated>")

    if not _has_key(lines, "MASTER_ENCRYPTION_KEY"):
        key = Fernet.generate_key().decode()
        lines = _set(lines, "MASTER_ENCRYPTION_KEY", key)
        changes.append("MASTER_ENCRYPTION_KEY=<generated>")

    has_resend = _has_key(lines, "RESEND_API_KEY")
    if has_resend:
        before = list(lines)
        lines = _comment_prefixes(
            lines,
            (
                "SMTP_HOST",
                "SMTP_PORT",
                "SMTP_USER",
                "SMTP_PASSWORD",
                "SMTP_FROM",
                "SMTP_USE_TLS",
                "SMTP_PROVIDER",
                "SMTP2_HOST",
                "SMTP2_PORT",
                "SMTP2_USER",
                "SMTP2_PASSWORD",
                "SMTP2_FROM",
                "SMTP2_USE_TLS",
            ),
        )
        if lines != before:
            changes.append("commented SMTP_* / SMTP2_* (Resend-only)")
        if _get(lines, "EMAIL_REQUIRE_VERIFICATION").lower() not in ("1", "true", "yes"):
            lines = _set(lines, "EMAIL_REQUIRE_VERIFICATION", "true")
            changes.append("EMAIL_REQUIRE_VERIFICATION=true")
        if not _has_key(lines, "RESEND_FROM"):
            lines = _set(lines, "RESEND_FROM", "Orbinex <noreply@orbinex.net>")
            changes.append("RESEND_FROM=Orbinex <noreply@orbinex.net>")

    if not _has_key(lines, "MAX_CONCURRENT_BOTS"):
        lines = _set(lines, "MAX_CONCURRENT_BOTS", "50")
        changes.append("MAX_CONCURRENT_BOTS=50")

    if not _has_key(lines, "BILLING_ENFORCE"):
        lines = _set(lines, "BILLING_ENFORCE", "true")
        changes.append("BILLING_ENFORCE=true")

    if not changes:
        print("No changes needed — .env already hardened")
        return 0

    print("Changes:")
    for c in changes:
        print(f"  - {c}")

    if args.dry_run:
        print("dry-run: not written")
        return 0

    ENV_PATH.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    load_dotenv(ENV_PATH, override=True)
    print(f"Wrote {ENV_PATH}")
    print("Keep a private offline copy of JWT_SECRET and MASTER_ENCRYPTION_KEY.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
