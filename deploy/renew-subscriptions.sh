#!/usr/bin/env bash
# Renew / expire due Pro subscriptions (Toss billing key).
#   bash deploy/renew-subscriptions.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ -x "$ROOT/.venv/bin/python" ]]; then
  PY="$ROOT/.venv/bin/python"
else
  PY=python3
fi
exec "$PY" -m bot.renew_subscriptions
