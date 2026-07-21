"""Fill only missing/empty .env keys. Never overwrites non-empty values.

Usage:
  python -m bot.fill_missing_env              # prompt for required empties
  python -m bot.fill_missing_env --defaults   # write safe defaults, skip secrets
  python -m bot.fill_missing_env --set KEY=VAL [KEY=VAL ...]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from bot.platform_config import ENV_PATH

# key -> (default or None if must ask, required_now, help)
KEYS: list[tuple[str, str | None, bool, str]] = [
    ("AUTH_REQUIRED", "true", True, "login required"),
    ("ADMIN_EMAILS", None, True, "admin emails (comma-separated)"),
    ("ACCESS_TOKEN_EXPIRE_MINUTES", "10080", True, "JWT TTL minutes (10080=7d)"),
    ("APP_ORIGIN", "https://orbinex.net", True, "site origin / CORS"),
    ("LISTEN_HOST", "127.0.0.1", True, "127.0.0.1 behind nginx"),
    ("BILLING_ENFORCE", "true", True, "enforce free quotas"),
    ("EMAIL_REQUIRE_VERIFICATION", "true", True, "require email verify"),
    ("SUPPORT_EMAIL", "support@orbinex.net", True, "support inbox"),
    ("RESEND_API_KEY", None, True, "Resend API key"),
    ("RESEND_FROM", "Orbinex <auth@orbinex.net>", True, "From header"),
    ("JWT_SECRET", None, False, "auto-generated if empty"),
    ("DATABASE_URL", None, False, "Postgres URL; empty=SQLite"),
    ("TOSS_CLIENT_KEY", None, False, "optional later"),
    ("TOSS_SECRET_KEY", None, False, "optional later"),
    ("BUSINESS_NAME", None, False, "optional later"),
    ("BUSINESS_REPRESENTATIVE", None, False, "optional later"),
    ("BUSINESS_REGISTRATION_NUMBER", None, False, "optional later"),
    ("BUSINESS_ADDRESS", None, False, "optional later"),
]


def _parse_env(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in text.splitlines():
        raw = line.strip()
        if not raw or raw.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        out[k.strip()] = v.strip()
    return out


def _is_set(val: str | None) -> bool:
    if val is None:
        return False
    return bool(val.strip().strip('"').strip("'"))


def _quote(val: str) -> str:
    if any(ch in val for ch in (' ', '#', '"', "'", "<", ">")):
        esc = val.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{esc}"'
    return val


def upsert_keys(path: Path, updates: dict[str, str]) -> list[str]:
    """Add or fill empty keys only. Returns list of changed keys."""
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    lines = text.splitlines()
    existing = _parse_env(text)
    changed: list[str] = []
    remaining = dict(updates)

    new_lines: list[str] = []
    for line in lines:
        raw = line.strip()
        if not raw or raw.startswith("#") or "=" not in line:
            new_lines.append(line)
            continue
        k, _, cur = line.partition("=")
        key = k.strip()
        if key in remaining and not _is_set(cur):
            new_lines.append(f"{key}={_quote(remaining.pop(key))}")
            changed.append(key)
        else:
            if key in remaining and _is_set(cur):
                remaining.pop(key, None)
            new_lines.append(line)

    if remaining:
        if new_lines and new_lines[-1].strip():
            new_lines.append("")
        new_lines.append("# --- Pre-launch SaaS (auto-added; fill empties) ---")
        for key, val in remaining.items():
            new_lines.append(f"{key}={_quote(val)}")
            changed.append(key)

    path.write_text("\n".join(new_lines).rstrip() + "\n", encoding="utf-8")
    return changed


def status() -> None:
    text = ENV_PATH.read_text(encoding="utf-8") if ENV_PATH.exists() else ""
    existing = _parse_env(text)
    print(f".env: {ENV_PATH}")
    for key, default, required, help_text in KEYS:
        cur = existing.get(key)
        if _is_set(cur):
            mark = "OK"
        elif key in existing:
            mark = "EMPTY"
        else:
            mark = "ABSENT"
        req = "need" if required else "opt"
        print(f"  [{mark:6}] ({req}) {key} - {help_text}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Fill missing .env keys only")
    p.add_argument("--defaults", action="store_true", help="Write safe defaults; leave secrets empty")
    p.add_argument("--set", nargs="*", default=[], metavar="KEY=VAL", help="Set specific empty keys")
    p.add_argument("--status", action="store_true", help="Show missing/ok only")
    p.add_argument("--prompt", action="store_true", help="Interactively ask for required empties")
    args = p.parse_args(argv)

    if not ENV_PATH.exists():
        ENV_PATH.write_text("# Orbinex .env\n", encoding="utf-8")

    if args.status or (not args.defaults and not args.set and not args.prompt):
        status()
        if not args.status and not args.defaults and not args.set and not args.prompt:
            print("\nNext:")
            print("  python -m bot.fill_missing_env --defaults")
            print("  python -m bot.fill_missing_env --prompt")
            print('  python -m bot.fill_missing_env --set ADMIN_EMAILS=you@mail.com RESEND_API_KEY=re_xxx')
        return 0

    existing = _parse_env(ENV_PATH.read_text(encoding="utf-8"))
    updates: dict[str, str] = {}

    if args.defaults:
        for key, default, _req, _help in KEYS:
            if _is_set(existing.get(key)):
                continue
            if default is not None:
                updates[key] = default
            elif key not in existing:
                updates[key] = ""

    for item in args.set:
        if "=" not in item:
            print(f"Skip invalid --set {item}", file=sys.stderr)
            continue
        k, _, v = item.partition("=")
        k, v = k.strip(), v.strip()
        if _is_set(existing.get(k)):
            print(f"Skip {k} (already set)")
            continue
        updates[k] = v

    if args.prompt:
        for key, default, required, help_text in KEYS:
            if not required:
                continue
            if _is_set(existing.get(key)) or _is_set(updates.get(key)):
                continue
            hint = f" [{default}]" if default else ""
            try:
                ans = input(f"{key}{hint} — {help_text}: ").strip()
            except EOFError:
                print("\nAborted (no TTY). Use --set KEY=VAL instead.")
                return 1
            if not ans and default is not None:
                ans = default
            if ans:
                updates[key] = ans
            elif key not in existing:
                updates[key] = ""

    if not updates:
        print("Nothing to change (required keys already set, or no --set values).")
        status()
        return 0

    changed = upsert_keys(ENV_PATH, updates)
    print("Updated:", ", ".join(changed) if changed else "(none)")
    status()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
