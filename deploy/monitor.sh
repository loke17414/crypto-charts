#!/usr/bin/env bash
# Minimal production health monitor for Orbinex.
# Checks: crypto-web, /api/health, disk free, bot process count.
# Optional alert: ALERT_WEBHOOK_URL in .env (Discord or Slack incoming webhook)
#
#   bash deploy/monitor.sh
#   bash deploy/monitor.sh --quiet
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
QUIET=0
[[ "${1:-}" == "--quiet" ]] && QUIET=1

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env" || true
  set +a
fi

ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
DISK_MIN_PCT_FREE="${MONITOR_DISK_MIN_PCT_FREE:-10}"
MAX_BOTS="${MAX_CONCURRENT_BOTS:-50}"
HEALTH_URL="${MONITOR_HEALTH_URL:-http://127.0.0.1:8000/api/health}"

FAILS=()
NOTES=()

ok() { NOTES+=("OK: $1"); }
fail() { FAILS+=("$1"); }

if systemctl is-active --quiet crypto-web 2>/dev/null; then
  ok "crypto-web active"
else
  fail "crypto-web is not active"
fi

if curl -sf --max-time 8 "$HEALTH_URL" >/dev/null 2>&1; then
  ok "health $HEALTH_URL"
else
  fail "health check failed ($HEALTH_URL)"
fi

USED_PCT="$(df -P "$ROOT" | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
FREE_PCT=$((100 - USED_PCT))
if [[ "$FREE_PCT" -lt "$DISK_MIN_PCT_FREE" ]]; then
  fail "disk free ${FREE_PCT}% < ${DISK_MIN_PCT_FREE}% on $ROOT"
else
  ok "disk free ${FREE_PCT}%"
fi

BOT_N="$(pgrep -af 'bot-js/bot.js' 2>/dev/null | grep -cv pgrep || true)"
BOT_N="$(echo "$BOT_N" | tr -d '[:space:]')"
[[ -z "$BOT_N" ]] && BOT_N=0
NOTES+=("bots_running=$BOT_N max=$MAX_BOTS")
if [[ "$BOT_N" -gt "$MAX_BOTS" ]]; then
  fail "bot processes $BOT_N exceed MAX_CONCURRENT_BOTS=$MAX_BOTS"
fi

if grep -qiE '^AUTH_REQUIRED=(true|1|yes)' "$ROOT/.env" 2>/dev/null; then
  if grep -qE '^OPENAI_API_KEY=.+' "$ROOT/.env" 2>/dev/null; then
    ok "OPENAI_API_KEY set"
  else
    fail "OPENAI_API_KEY missing while AUTH_REQUIRED=true"
  fi
  if grep -qE '^RESEND_API_KEY=.+' "$ROOT/.env" 2>/dev/null \
    || grep -qE '^SMTP_PASSWORD=.+' "$ROOT/.env" 2>/dev/null; then
    ok "mail provider configured"
  else
    fail "no RESEND_API_KEY / SMTP_PASSWORD — signup mail will fail"
  fi
fi

if [[ ${#FAILS[@]} -eq 0 ]]; then
  if [[ "$QUIET" -eq 0 ]]; then
    echo "OK orbinex monitor"
    printf '  %s\n' "${NOTES[@]}"
  fi
  exit 0
fi

MSG="Orbinex ALERT on $(hostname) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
BODY="$(printf '%s\n' "${FAILS[@]}")"
echo "$MSG" >&2
echo "$BODY" >&2

if [[ -n "$ALERT_WEBHOOK_URL" ]]; then
  export MSG BODY
  python3 - <<'PY' | curl -sf -X POST -H 'Content-Type: application/json' --data-binary @- "$ALERT_WEBHOOK_URL" >/dev/null || true
import json, os
text = os.environ["MSG"] + "\n" + os.environ["BODY"]
print(json.dumps({"content": text[:1800], "text": text[:1800]}))
PY
fi

exit 1
