#!/bin/bash
# Phase 2-E — nginx + Let's Encrypt HTTPS for CryptoCharts
#
# Prerequisites:
#   1) Domain A/AAAA record → this VPS public IP
#   2) Firewall/security group: allow TCP 80 and 443
#   3) App code present (git pull); script starts/restarts crypto-web
#
# Usage (on VPS as root):
#   cd /root/crypto-charts
#   git pull
#   sudo bash deploy/setup-https.sh your.domain.com you@email.com
#
# After success open: https://your.domain.com/trading.html

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"

if [ -z "$DOMAIN" ] || [ -z "$EMAIL" ]; then
  echo "Usage: sudo bash deploy/setup-https.sh <domain> <email>"
  echo "  example: sudo bash deploy/setup-https.sh trade.example.com admin@example.com"
  exit 1
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "Need root. Run: sudo bash $0 $DOMAIN $EMAIL"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
CONF_SRC="$ROOT/deploy/nginx-cryptocharts.conf.template"
CONF_DST="/etc/nginx/sites-available/cryptocharts"
CONF_LINK="/etc/nginx/sites-enabled/cryptocharts"

echo "==> CryptoCharts HTTPS setup"
echo "    Domain: $DOMAIN"
echo "    Email:  $EMAIL"
echo "    Root:   $ROOT"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y nginx certbot

mkdir -p /var/www/certbot

# Bind app to localhost so 8000/8765 are not exposed publicly
if [ ! -f .env ]; then
  cp .env.example .env
fi
if grep -qE '^LISTEN_HOST=' .env; then
  sed -i 's/^LISTEN_HOST=.*/LISTEN_HOST=127.0.0.1/' .env
else
  echo 'LISTEN_HOST=127.0.0.1' >> .env
fi
if grep -qE '^APP_ORIGIN=' .env; then
  sed -i "s|^APP_ORIGIN=.*|APP_ORIGIN=https://${DOMAIN}|" .env
else
  echo "APP_ORIGIN=https://${DOMAIN}" >> .env
fi

# Install / refresh systemd unit (LISTEN_HOST from .env only)
sed "s|/root/crypto-charts|$ROOT|g" "$ROOT/deploy/crypto-web.service" > /etc/systemd/system/crypto-web.service
systemctl daemon-reload
systemctl enable crypto-web
systemctl restart crypto-web
sleep 2

# HTTP-only nginx for ACME challenge + temporary proxy
cat > "$CONF_DST" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

rm -f /etc/nginx/sites-enabled/default
ln -sfn "$CONF_DST" "$CONF_LINK"
nginx -t
systemctl enable nginx
systemctl restart nginx

echo "==> Requesting Let's Encrypt certificate (webroot)..."
certbot certonly \
  --webroot \
  -w /var/www/certbot \
  -d "$DOMAIN" \
  --non-interactive \
  --agree-tos \
  --email "$EMAIL" \
  --keep-until-expiring

if [ ! -d "/etc/letsencrypt/live/${DOMAIN}" ]; then
  echo "ERROR: certificate not found for ${DOMAIN}"
  echo "Check DNS A record and that ports 80/443 reach this VPS."
  exit 1
fi

# Recommended TLS options from certbot package (if missing, create minimal)
if [ ! -f /etc/letsencrypt/options-ssl-nginx.conf ]; then
  cat > /etc/letsencrypt/options-ssl-nginx.conf <<'SSL'
ssl_session_cache shared:le_nginx_SSL:10m;
ssl_session_timeout 1440m;
ssl_session_tickets off;
ssl_protocols TLSv1.2 TLSv1.3;
ssl_prefer_server_ciphers off;
SSL
fi
if [ ! -f /etc/letsencrypt/ssl-dhparams.pem ]; then
  echo "==> Generating dhparams (one-time, may take a minute)..."
  openssl dhparam -out /etc/letsencrypt/ssl-dhparams.pem 2048
fi

sed "s/__DOMAIN__/${DOMAIN}/g" "$CONF_SRC" > "$CONF_DST"
nginx -t
systemctl reload nginx
systemctl restart crypto-web
sleep 2

# Auto-renew timer
systemctl enable certbot.timer 2>/dev/null || true
systemctl start certbot.timer 2>/dev/null || true

echo ""
echo "==> Verify"
echo -n "    local API: "
curl -sf "http://127.0.0.1:8000/api/health" >/dev/null && echo OK || echo FAIL
echo -n "    https page: "
curl -sfI "https://${DOMAIN}/trading.html" | head -n 1 || echo FAIL
echo -n "    https API:  "
curl -sf "https://${DOMAIN}/api/health" >/dev/null && echo OK || echo FAIL
echo ""
echo "==> Done"
echo "    Open:  https://${DOMAIN}/trading.html"
echo "    CORS:  APP_ORIGIN=https://${DOMAIN}"
echo "    Bind:  LISTEN_HOST=127.0.0.1"
echo "    Renew: systemctl status certbot.timer"
echo ""
echo "Firewall: allow 80/443. Public 8000/8765 can be closed."
