#!/usr/bin/env bash
# Standalone admin console at https://admin.<domain>
# Prerequisites: main site HTTPS already set up (deploy/setup-https.sh).
# DNS: A/AAAA record for admin.<domain> → this server.
#
# Usage (on VPS):
#   sudo bash deploy/setup-admin-subdomain.sh orbinex.net you@email.com

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF_SRC="$ROOT/deploy/nginx-admin.conf.template"
CONF_DST="/etc/nginx/sites-available/orbinex-admin"
ENV_FILE="$ROOT/.env"

if [[ -z "$DOMAIN" || -z "$EMAIL" ]]; then
  echo "Usage: sudo bash deploy/setup-admin-subdomain.sh <domain> <email>"
  echo "  e.g. sudo bash deploy/setup-admin-subdomain.sh orbinex.net admin@orbinex.net"
  exit 1
fi

ADMIN_HOST="admin.${DOMAIN}"

if [[ ! -f "$CONF_SRC" ]]; then
  echo "Missing template: $CONF_SRC"
  exit 1
fi

echo "==> Admin console subdomain: ${ADMIN_HOST}"

# Cert (standalone or webroot — prefer webroot if main nginx already listens 80)
mkdir -p /var/www/certbot
if [[ ! -d "/etc/letsencrypt/live/${ADMIN_HOST}" ]]; then
  echo "==> Requesting certificate for ${ADMIN_HOST}"
  # Temporarily allow HTTP challenge via a minimal server if needed
  certbot certonly --webroot -w /var/www/certbot \
    -d "${ADMIN_HOST}" \
    --email "${EMAIL}" \
    --agree-tos \
    --non-interactive \
    || certbot certonly --nginx \
      -d "${ADMIN_HOST}" \
      --email "${EMAIL}" \
      --agree-tos \
      --non-interactive
fi

sed "s/__DOMAIN__/${DOMAIN}/g" "$CONF_SRC" > "$CONF_DST"
ln -sfn "$CONF_DST" /etc/nginx/sites-enabled/orbinex-admin

nginx -t
systemctl reload nginx

# CORS: include admin origin alongside main APP_ORIGIN
if [[ -f "$ENV_FILE" ]]; then
  CURRENT="$(grep -E '^APP_ORIGIN=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' || true)"
  WANT_MAIN="https://${DOMAIN}"
  WANT_ADMIN="https://${ADMIN_HOST}"
  if [[ -z "$CURRENT" || "$CURRENT" == "*" ]]; then
    NEW_ORIGIN="${WANT_MAIN},${WANT_ADMIN}"
  elif [[ "$CURRENT" == *"${WANT_ADMIN}"* ]]; then
    NEW_ORIGIN="$CURRENT"
  else
    NEW_ORIGIN="${CURRENT},${WANT_ADMIN}"
  fi
  if grep -qE '^APP_ORIGIN=' "$ENV_FILE"; then
    sed -i "s|^APP_ORIGIN=.*|APP_ORIGIN=${NEW_ORIGIN}|" "$ENV_FILE"
  else
    echo "APP_ORIGIN=${NEW_ORIGIN}" >> "$ENV_FILE"
  fi
  echo "==> APP_ORIGIN=${NEW_ORIGIN}"
  systemctl restart crypto-api 2>/dev/null || systemctl restart cryptocharts-api 2>/dev/null || true
fi

echo ""
echo "==> Done"
echo "    Open:  https://${ADMIN_HOST}/"
echo "    Also:  https://${DOMAIN}/admin-site/  (path-based, no DNS needed)"
echo "    .env:  ADMIN_EMAILS=your@email.com"
echo ""
