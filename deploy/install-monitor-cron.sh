#!/usr/bin/env bash
# Install Orbinex monitor every 5 minutes.
#   sudo bash deploy/install-monitor-cron.sh
# Optional in .env:
#   ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/...
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRON_FILE="/etc/cron.d/orbinex-monitor"

cat >"$CRON_FILE" <<EOF
# Orbinex health monitor
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
*/5 * * * * root cd $ROOT && /bin/bash $ROOT/deploy/monitor.sh --quiet >>$ROOT/data/monitor.log 2>&1
EOF
chmod 644 "$CRON_FILE"
mkdir -p "$ROOT/data"
touch "$ROOT/data/monitor.log"

echo "Installed $CRON_FILE"
echo "Manual run: bash $ROOT/deploy/monitor.sh"
echo "Set ALERT_WEBHOOK_URL in .env for Discord/Slack alerts"
