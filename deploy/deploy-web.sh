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
pip install -r requirements.txt

if [ ! -f .env ]; then
  echo "==> No .env — copying .env.example (add BINANCE keys before trading)."
  cp .env.example .env
fi

if ! grep -q '^LISTEN_HOST=' .env 2>/dev/null; then
  echo "LISTEN_HOST=0.0.0.0" >> .env
fi

if ! grep -qE '^OPENAI_API_KEY=.+' .env 2>/dev/null; then
  echo ""
  echo "==> OPENAI_API_KEY not set in .env (GPT strategy AI)"
  echo "    One-time setup — pick either:"
  echo "      nano .env   # add: OPENAI_API_KEY=sk-..."
  echo "    Or open trading.html → paste key once → '검증 후 저장' (writes server .env)"
  echo ""
fi

if ! command -v node >/dev/null; then
  echo "==> Installing Node.js (required for 24/7 server bot)..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if [ -f bot-js/package.json ] && [ ! -d bot-js/node_modules ]; then
  echo "==> Installing bot-js dependencies..."
  (cd bot-js && npm install --omit=dev)
fi

export LISTEN_HOST=0.0.0.0

echo ""
echo "==> Port check (8765 web, 8000 API)..."
ss -tlnp | grep -E ':8765|:8000' || true

echo ""
echo "==> Starting web + API (keep this window open; Ctrl+C to stop)"
PUBLIC_IP=$(curl -s --max-time 3 ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
echo "    Open: http://${PUBLIC_IP:-<SERVER_IP>}:8765/trading.html"
echo ""

exec python launch.py
