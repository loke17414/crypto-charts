#!/usr/bin/env bash
# One-shot production baseline for ~2000 future users (do-now items).
#
#   cd /root/crypto-charts && git pull
#   sudo bash deploy/bootstrap-production.sh
#   sudo bash deploy/bootstrap-production.sh --migrate-sqlite
#   sudo bash deploy/bootstrap-production.sh --origin https://orbinex.net
#
# Does:
#   1) PostgreSQL + DATABASE_URL
#   2) Harden .env (AUTH, secrets, Resend-only SMTP comment)
#   3) Daily backup cron
#   4) 5-minute monitor cron
#   5) Restart crypto-web + health check
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MIGRATE_ARGS=()
ORIGIN=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --migrate-sqlite) MIGRATE_ARGS+=(--migrate-sqlite); shift ;;
    --origin) ORIGIN="${2:-}"; shift 2 ;;
    --origin=*) ORIGIN="${1#--origin=}"; shift ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Need root. Run: sudo bash $0" >&2
  exit 1
fi

if [[ ! -f "$ROOT/.env" ]]; then
  echo "Missing .env — copy from .env.example and fill RESEND/TOSS/OPENAI first" >&2
  exit 1
fi

echo "======== 1) PostgreSQL ========"
bash "$ROOT/deploy/setup-postgres.sh" "${MIGRATE_ARGS[@]+"${MIGRATE_ARGS[@]}"}"

# PG15+ schema grants
DB_USER="${ORBINEX_DB_USER:-orbinex}"
DB_NAME="${ORBINEX_DB_NAME:-orbinex}"
sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" <<SQL || true
GRANT ALL ON SCHEMA public TO ${DB_USER};
ALTER SCHEMA public OWNER TO ${DB_USER};
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${DB_USER};
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${DB_USER};
SQL

echo "======== 2) Harden .env ========"
# shellcheck disable=SC1091
source "$ROOT/.venv/bin/activate"
HARDEN_ARGS=()
if [[ -n "$ORIGIN" ]]; then
  HARDEN_ARGS+=(--origin "$ORIGIN")
fi
python -m bot.harden_env "${HARDEN_ARGS[@]+"${HARDEN_ARGS[@]}"}"

echo "======== 3) Backup cron ========"
bash "$ROOT/deploy/install-backup-cron.sh" /var/backups/orbinex
bash "$ROOT/deploy/backup.sh" /var/backups/orbinex || echo "WARN: first backup failed (continue)"

echo "======== 4) Monitor cron ========"
bash "$ROOT/deploy/install-monitor-cron.sh"

echo "======== 4b) Renew cron ========"
bash "$ROOT/deploy/install-renew-cron.sh"

echo "======== 5) Restart web ========"
if [[ -f /etc/systemd/system/crypto-web.service ]] || systemctl list-unit-files | grep -q crypto-web; then
  systemctl daemon-reload || true
  systemctl restart crypto-web
  sleep 2
  systemctl is-active crypto-web && echo "crypto-web active"
else
  echo "WARN: crypto-web.service not installed — start via deploy/update-server.sh"
fi

echo "======== 6) Health ========"
bash "$ROOT/deploy/monitor.sh" || true
curl -sf http://127.0.0.1:8000/api/health | head -c 400 || echo "health FAIL"
echo

echo "======== Done ========"
echo "Next (manual):"
echo "  - Confirm RESEND_API_KEY + RESEND_FROM (Verified domain)"
echo "  - Confirm TOSS_* + OPENAI_API_KEY"
echo "  - Optional: ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/..."
echo "  - Offline copy of JWT_SECRET + MASTER_ENCRYPTION_KEY"
echo "  - Keep MAX_CONCURRENT_BOTS=50 until VPS sized for more"
