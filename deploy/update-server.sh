#!/bin/bash
# Fix "Not Found" / 404 on /api/bot/* — pull latest code, kill stale processes, restart.
#
# Run on VPS (SSH as root, or a user with sudo):
#   cd /root/crypto-charts
#   git pull
#   bash deploy/update-server.sh
#
# If you prefer sudo (non-root user):
#   cd ~/crypto-charts
#   git pull
#   sudo bash deploy/update-server.sh
#
# Do NOT use "./deploy/update-server.sh" unless you ran:
#   chmod +x deploy/update-server.sh
# Otherwise you get: Permission denied
#
# Quick fallback (no script):
#   cd /root/crypto-charts && git pull && sudo systemctl restart crypto-web
#
# Success: curl shows "apiVersion": 2 and /api/bot/status returns JSON (not 404).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
echo "==> CryptoCharts update-server"
echo "    Root: $ROOT"

if [ "$(id -u)" -ne 0 ]; then
  echo "==> Need root. Run: sudo bash $0"
  exit 1
fi

echo "==> git pull (hard reset to origin/main)"
git fetch origin
git reset --hard origin/main

echo "==> Stop old processes on ports 8000 / 8765"
systemctl stop crypto-web 2>/dev/null || true
for port in 8000 8765; do
  if command -v fuser >/dev/null; then
    fuser -k "${port}/tcp" 2>/dev/null || true
  fi
done
sleep 1

if ! command -v python3 >/dev/null; then
  apt-get update
  apt-get install -y python3 python3-venv python3-pip curl
fi

if [ ! -d .venv ]; then
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -q -r requirements.txt

echo "==> Alembic migrate"
if alembic upgrade head; then
  echo "    migrations OK"
else
  echo "    WARN: alembic failed — check DATABASE_URL / models"
fi

if ! command -v node >/dev/null; then
  echo "==> Installing Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "    node: $(node -v)"

# Update the bot's isolated strategy snapshot. If the new js/ code fails
# validation the sync exits non-zero and the bot keeps its previous
# known-good snapshot — the web update still proceeds.
echo "==> Sync bot strategy snapshot (validated)"
if node bot-js/sync-strategy.js; then
  echo "    snapshot OK"
else
  echo "    WARN: strategy validation failed — bot keeps previous snapshot"
fi

# Restart the bot service if it is installed so it picks up the new snapshot.
if systemctl list-unit-files crypto-bot.service --no-legend 2>/dev/null | grep -q crypto-bot; then
  echo "==> Restart crypto-bot"
  systemctl restart crypto-bot || echo "    WARN: crypto-bot restart failed"
fi

if [ ! -f .env ]; then
  cp .env.example .env
fi
grep -q '^LISTEN_HOST=' .env 2>/dev/null || echo 'LISTEN_HOST=0.0.0.0' >> .env
# Keep login sessions from expiring so Binance/GPT APIs stay usable after save.
if grep -qE '^ACCESS_TOKEN_EXPIRE_MINUTES=' .env 2>/dev/null; then
  sed -i 's/^ACCESS_TOKEN_EXPIRE_MINUTES=.*/ACCESS_TOKEN_EXPIRE_MINUTES=0/' .env
else
  echo 'ACCESS_TOKEN_EXPIRE_MINUTES=0' >> .env
fi
grep -qE '^JWT_SECRET=.+' .env 2>/dev/null || true

# Refresh systemd unit (stops mangling .env via EnvironmentFile)
if [ -f deploy/crypto-web.service ]; then
  echo "==> Install crypto-web.service"
  cp deploy/crypto-web.service /etc/systemd/system/crypto-web.service
  systemctl daemon-reload
fi

echo "==> Install systemd unit (paths -> $ROOT)"
sed "s|/root/crypto-charts|$ROOT|g" deploy/crypto-web.service > /etc/systemd/system/crypto-web.service
systemctl daemon-reload
systemctl enable crypto-web
systemctl start crypto-web
sleep 3

echo ""
echo "==> Verify API"
HEALTH=$(curl -sf "http://127.0.0.1:8000/api/health" || echo "FAIL")
echo "$HEALTH"

if echo "$HEALTH" | grep -q '"apiVersion": 2'; then
  echo "OK: API version 2"
else
  echo "ERROR: apiVersion 2 not found — API still old or not running"
  journalctl -u crypto-web -n 40 --no-pager
  exit 1
fi

BOT=$(curl -sf "http://127.0.0.1:8000/api/bot/status" || echo "FAIL")
echo "$BOT"
if echo "$BOT" | grep -q '"ok"'; then
  echo "OK: /api/bot/status works"
else
  echo "ERROR: /api/bot/status still 404"
  exit 1
fi

PUBLIC=$(curl -s --max-time 3 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
ORIGIN=$(grep -E '^APP_ORIGIN=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
echo ""
if echo "$ORIGIN" | grep -qi '^https://'; then
  echo "==> Done. Open: ${ORIGIN}/trading.html"
else
  echo "==> Done. Open: http://${PUBLIC}:8765/trading.html"
  echo "    HTTPS (Phase 2-E): sudo bash deploy/setup-https.sh your.domain.com you@email.com"
fi
echo "    Then Ctrl+F5 refresh and start bot."
