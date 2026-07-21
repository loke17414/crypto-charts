"""Cron entrypoint: renew or expire due Pro subscriptions.

Usage:
  cd /root/crypto-charts && .venv/bin/python -m bot.renew_subscriptions
"""

from __future__ import annotations

import json
import logging
import sys

from bot.billing_service import renew_due_subscriptions
from bot.db import SessionLocal, init_db

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("renew")


def main() -> int:
    init_db()
    db = SessionLocal()
    try:
        result = renew_due_subscriptions(db)
        print(json.dumps(result, ensure_ascii=False))
        logger.info("renew result: %s", result)
        return 0
    except Exception:
        logger.exception("renew_due_subscriptions failed")
        return 1
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
