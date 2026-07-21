"""Copy rows from local SQLite → DATABASE_URL Postgres (one-shot).

Usage on VPS (after setup-postgres.sh wrote DATABASE_URL):
  .venv/bin/python -m bot.migrate_sqlite_to_postgres

Does not delete the SQLite file. Safe to re-run only on empty Postgres tables.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.engine import Engine

from bot.config import ROOT

load_dotenv(ROOT / ".env", override=True)

# Order respects FKs (parents first).
TABLES = (
    "users",
    "exchange_credentials",
    "openai_credentials",
    "subscriptions",
    "usage_quotas",
    "email_tokens",
)


def _sqlite_url() -> str:
    override = os.getenv("SQLITE_SOURCE_URL", "").strip()
    if override:
        return override
    path = ROOT / "data" / "cryptocharts.db"
    if not path.is_file():
        raise FileNotFoundError(f"SQLite not found: {path}")
    return f"sqlite:///{path.as_posix()}"


def _pg_url() -> str:
    url = os.getenv("DATABASE_URL", "").strip()
    if not url.startswith(("postgresql://", "postgres://")):
        raise RuntimeError("DATABASE_URL must be postgresql://… before migrating")
    return url


def _table_count(eng: Engine, name: str) -> int:
    with eng.connect() as conn:
        return int(conn.execute(text(f'SELECT COUNT(*) FROM "{name}"')).scalar() or 0)


def main() -> int:
    src_url = _sqlite_url()
    dst_url = _pg_url()
    print(f"source: {src_url}")
    print(f"target: postgresql://…")

    src = create_engine(src_url)
    dst = create_engine(dst_url, pool_pre_ping=True)

    # Ensure Postgres schema exists
    from alembic.config import Config
    from alembic import command

    cfg = Config(str(ROOT / "alembic.ini"))
    cfg.set_main_option("sqlalchemy.url", dst_url)
    command.upgrade(cfg, "head")

    src_tables = set(inspect(src).get_table_names())
    dst_tables = set(inspect(dst).get_table_names())

    for table in TABLES:
        if table not in src_tables:
            print(f"skip {table} (not in sqlite)")
            continue
        if table not in dst_tables:
            print(f"skip {table} (not in postgres)", file=sys.stderr)
            continue
        dst_n = _table_count(dst, table)
        if dst_n > 0:
            print(f"skip {table} (postgres already has {dst_n} rows)")
            continue

        with src.connect() as sconn:
            rows = sconn.execute(text(f'SELECT * FROM "{table}"')).mappings().all()
        if not rows:
            print(f"ok {table}: 0 rows")
            continue

        cols = list(rows[0].keys())
        col_list = ", ".join(f'"{c}"' for c in cols)
        placeholders = ", ".join(f":{c}" for c in cols)
        insert_sql = text(f'INSERT INTO "{table}" ({col_list}) VALUES ({placeholders})')

        with dst.begin() as dconn:
            for row in rows:
                dconn.execute(insert_sql, dict(row))

        print(f"ok {table}: {len(rows)} rows")

    # Best-effort sequence sync for serial PKs
    with dst.begin() as dconn:
        for table in TABLES:
            if table not in dst_tables:
                continue
            try:
                dconn.execute(
                    text(
                        f"""
                        SELECT setval(
                          pg_get_serial_sequence('{table}', 'id'),
                          COALESCE((SELECT MAX(id) FROM {table}), 1),
                          true
                        )
                        """
                    )
                )
            except Exception:
                pass

    print("migrate complete")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
