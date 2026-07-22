#!/usr/bin/env bash
# Pre-launch production checks for Orbinex VPS.
#   bash deploy/launch-checklist.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
ENVF="$ROOT/.env"
FAIL=0

ok() { echo "OK  $1"; }
bad() { echo "FAIL $1"; FAIL=1; }

[[ -f "$ENVF" ]] || { echo "Missing .env"; exit 1; }

has() { grep -qE "^$1=.+" "$ENVF" 2>/dev/null; }
val() { grep -E "^$1=" "$ENVF" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'"; }

has AUTH_REQUIRED && [[ "$(val AUTH_REQUIRED | tr '[:upper:]' '[:lower:]')" =~ ^(true|1|yes)$ ]] && ok "AUTH_REQUIRED" || bad "AUTH_REQUIRED=true"
has BILLING_ENFORCE && [[ "$(val BILLING_ENFORCE | tr '[:upper:]' '[:lower:]')" =~ ^(true|1|yes)$ ]] && ok "BILLING_ENFORCE" || bad "BILLING_ENFORCE=true"
has JWT_SECRET && [[ "$(val JWT_SECRET | wc -c)" -gt 20 ]] && ok "JWT_SECRET" || bad "JWT_SECRET length"
has MASTER_ENCRYPTION_KEY && ok "MASTER_ENCRYPTION_KEY" || bad "MASTER_ENCRYPTION_KEY"
has DATABASE_URL && ok "DATABASE_URL" || bad "DATABASE_URL"
has APP_ORIGIN && [[ "$(val APP_ORIGIN)" == https://* ]] && ok "APP_ORIGIN https" || bad "APP_ORIGIN=https://..."
has TOSS_SECRET_KEY && has TOSS_CLIENT_KEY && ok "TOSS keys" || bad "TOSS_CLIENT_KEY / TOSS_SECRET_KEY"
has TOSS_WEBHOOK_SECRET && [[ "$(val TOSS_WEBHOOK_SECRET | wc -c)" -gt 8 ]] && ok "TOSS_WEBHOOK_SECRET" || bad "TOSS_WEBHOOK_SECRET"
# LIVE_TRADING_ENABLED unset defaults to true; explicit false is an intentional halt.
live="$(val LIVE_TRADING_ENABLED 2>/dev/null | tr '[:upper:]' '[:lower:]')"
if [[ -z "$live" || "$live" =~ ^(true|1|yes)$ ]]; then ok "LIVE_TRADING_ENABLED on"; else ok "LIVE_TRADING_ENABLED=$live (halt)"; fi
has OPENAI_API_KEY && ok "OPENAI_API_KEY" || bad "OPENAI_API_KEY"
has ADMIN_EMAILS && ok "ADMIN_EMAILS" || bad "ADMIN_EMAILS"
has SUPPORT_EMAIL && ok "SUPPORT_EMAIL" || bad "SUPPORT_EMAIL"
has BUSINESS_NAME && ok "BUSINESS_NAME" || bad "BUSINESS_NAME (legal footer)"
has BUSINESS_REPRESENTATIVE && ok "BUSINESS_REPRESENTATIVE" || bad "BUSINESS_REPRESENTATIVE"
has BUSINESS_REGISTRATION_NUMBER && ok "BUSINESS_REGISTRATION_NUMBER" || bad "BUSINESS_REGISTRATION_NUMBER"
has BUSINESS_ADDRESS && ok "BUSINESS_ADDRESS" || bad "BUSINESS_ADDRESS"
has BUSINESS_PHONE && ok "BUSINESS_PHONE" || bad "BUSINESS_PHONE"

model="$(val OPENAI_MODEL || true)"
[[ -z "$model" || "$model" == *mini* ]] && ok "OPENAI_MODEL mini-safe" || bad "OPENAI_MODEL should be gpt-4o-mini"

if systemctl is-active --quiet crypto-web 2>/dev/null; then ok "crypto-web active"; else bad "crypto-web not active"; fi
if crontab -l 2>/dev/null | grep -q renew_subscriptions; then ok "renew cron"; else bad "renew cron missing (deploy/install-renew-cron.sh)"; fi
if crontab -l 2>/dev/null | grep -q backup.sh; then ok "backup cron"; else bad "backup cron missing"; fi

curl -sf --max-time 8 "http://127.0.0.1:8000/api/health" >/dev/null && ok "local /api/health" || bad "local /api/health"

echo
if [[ "$FAIL" -eq 0 ]]; then
  echo "Launch checklist PASSED"
  exit 0
fi
echo "Launch checklist FAILED — fix items above before taking paid users"
exit 1
