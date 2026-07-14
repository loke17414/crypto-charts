#!/bin/bash
# Run CryptoCharts web UI + API on the VPS (Method 2 — browser access like local).
# Usage (on the server, from repo root):
#   chmod +x deploy/deploy-web.sh
#   ./deploy/deploy-web.sh
#
# Before first run:
#   1) Vultr Firewall: allow inbound TCP 8765 and 8000
#   2) Stop the headless Docker bot if running (same account — do not run both):
#        docker stop crypto-bot 2>/dev/null || true
#   3) Copy .env with BINANCE keys (or create from .env.example)
#
# Then open in your PC browser:
#   http://<SERVER_IP>:8765/trading.html

set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

echo "==> CryptoCharts remote web (LISTEN_HOST=0.0.0.0)"
echo "    Root: $ROOT"

if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx crypto-bot; then
  echo "==> Stopping headless docker bot (crypto-bot) — web UI replaces it."
  docker stop crypto-bot || true
fi

if ! command -v python3 >/dev/null; then
  echo "==> Installing Python..."
  apt-get update
  apt-get install -y python3 python3-venv python3-pip
fi

if [ ! -d .venv ]; then
  echo "==> Creating venv..."
  python3 -m venv .venv
fi
# shellcheck disable=SC1091
source .venv/bin/activate
pip install -q -r requirements.txt

if [ ! -f .env ]; then
  echo "==> No .env — copying .env.example (edit BINANCE_API_KEY / SECRET before trading)."
  cp .env.example .env
fi

export LISTEN_HOST=0.0.0.0

echo ""
echo "==> Starting web + API (Ctrl+C to stop)"
echo "    Open: http://$(curl -s ifconfig.me 2>/dev/null || echo '<SERVER_IP>'):8765/trading.html"
echo ""

exec python launch.py
