"""CLI: test SMTP login/send using server .env (no secrets printed).

Usage on VPS:
  cd /root/crypto-charts
  source .venv/bin/activate
  python -m bot.smtp_diagnose
  python -m bot.smtp_diagnose --to you@example.com
"""

from __future__ import annotations

import argparse
import json
import sys

from bot.email_service import diagnose_smtp


def main() -> int:
    parser = argparse.ArgumentParser(description="Diagnose Orbinex SMTP settings")
    parser.add_argument("--to", help="Optional address to send a test message", default="")
    args = parser.parse_args()
    result = diagnose_smtp(to=args.to or None)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
