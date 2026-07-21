#!/usr/bin/env bash
# Install hourly subscription renew cron.
#   sudo bash deploy/install-renew-cron.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRON_FILE="/etc/cron.d/orbinex-renew"

cat >"$CRON_FILE" <<EOF
# Orbinex Pro renew / expire — every hour at :20
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
20 * * * * root cd $ROOT && /bin/bash $ROOT/deploy/renew-subscriptions.sh >>$ROOT/data/renew.log 2>&1
EOF
chmod 644 "$CRON_FILE"
mkdir -p "$ROOT/data"
touch "$ROOT/data/renew.log"

echo "Installed $CRON_FILE"
echo "Manual run: bash $ROOT/deploy/renew-subscriptions.sh"
