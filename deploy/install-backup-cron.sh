#!/usr/bin/env bash
# Install daily Orbinex backup cron (03:15 UTC).
#   sudo bash deploy/install-backup-cron.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-/var/backups/orbinex}"
mkdir -p "$DEST"

CRON_FILE="/etc/cron.d/orbinex-backup"
cat >"$CRON_FILE" <<EOF
# Orbinex daily backup — DB + data/bots
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
15 3 * * * root cd $ROOT && /bin/bash $ROOT/deploy/backup.sh $DEST >>$ROOT/data/backup.log 2>&1
EOF
chmod 644 "$CRON_FILE"

# ensure log dir
mkdir -p "$ROOT/data"
touch "$ROOT/data/backup.log"

echo "Installed $CRON_FILE"
echo "Manual run: bash $ROOT/deploy/backup.sh $DEST"
