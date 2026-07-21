#!/usr/bin/env bash
# Backup Orbinex DB + critical secrets metadata (not the secrets themselves in git).
# Usage (on VPS):
#   bash deploy/backup.sh
#   bash deploy/backup.sh /var/backups/orbinex
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$ROOT/data/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/orbinex-$STAMP"
mkdir -p "$OUT"

cd "$ROOT"

# Load DATABASE_URL if present
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env" || true
  set +a
fi

DB_URL="${DATABASE_URL:-}"
if [[ -z "$DB_URL" ]]; then
  DB_URL="sqlite:///$ROOT/data/cryptocharts.db"
fi

echo "==> Backup dir: $OUT"

if [[ "$DB_URL" == sqlite* ]]; then
  DB_PATH="${DB_URL#sqlite:///}"
  if [[ ! -f "$DB_PATH" ]]; then
    echo "SQLite DB not found: $DB_PATH" >&2
    exit 1
  fi
  cp -a "$DB_PATH" "$OUT/cryptocharts.db"
  echo "Copied SQLite: $DB_PATH"
elif [[ "$DB_URL" == postgresql* ]] || [[ "$DB_URL" == postgres* ]]; then
  if ! command -v pg_dump >/dev/null 2>&1; then
    echo "pg_dump not found — install postgresql-client" >&2
    exit 1
  fi
  pg_dump "$DB_URL" --no-owner --format=custom -f "$OUT/cryptocharts.dump"
  echo "pg_dump OK"
else
  echo "Unsupported DATABASE_URL scheme: $DB_URL" >&2
  exit 1
fi

# Strategy / bot state (no secrets)
if [[ -d "$ROOT/data/bots" ]]; then
  tar -C "$ROOT/data" -czf "$OUT/bots.tgz" bots
  echo "Packed data/bots"
fi

# Record which secret keys exist (values NOT copied)
{
  echo "backup_at=$STAMP"
  echo "host=$(hostname 2>/dev/null || echo unknown)"
  echo "database_url_scheme=${DB_URL%%:*}"
  for key in JWT_SECRET MASTER_ENCRYPTION_KEY TOSS_SECRET_KEY OPENAI_API_KEY SMTP_PASSWORD; do
    if grep -qE "^${key}=" "$ROOT/.env" 2>/dev/null; then
      echo "${key}=SET"
    else
      echo "${key}=MISSING"
    fi
  done
} > "$OUT/secrets-checklist.txt"

# Keep last 14 backups
ls -1dt "$DEST"/orbinex-* 2>/dev/null | tail -n +15 | xargs -r rm -rf

echo "==> Done: $OUT"
echo "Keep MASTER_ENCRYPTION_KEY / JWT_SECRET / .env offline separately — losing them bricks encrypted API keys."
