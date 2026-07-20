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

if [ -z "$DOMAIN" ]; then
  echo "Usage: sudo bash deploy/setup-https.sh <domain> [email|none]"
  echo "  example: sudo bash deploy/setup-https.sh orbinex.net you@gmail.com"
  echo "  no email: sudo bash deploy/setup-https.sh orbinex.net none"
  echo ""
  echo "Tip: use a normal mailbox (Gmail/Naver). Custom domain emails often fail"
  echo "     ACME registration if MX DNS is missing (invalidEmail)."
  exit 1
fi

# "none" / empty → register without email (certificate still works)
USE_EMAIL=1
if [ -z "$EMAIL" ] || [ "$EMAIL" = "none" ] || [ "$EMAIL" = "-" ]; then
  USE_EMAIL=0
  EMAIL=""
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

echo "==> Orbinex HTTPS setup"
echo "    Domain: $DOMAIN"
if [ "$USE_EMAIL" -eq 1 ]; then
  echo "    Email:  $EMAIL"
else
  echo "    Email:  (none — --register-unsafely-without-email)"
fi
echo "    Root:   $ROOT"

# Preflight: domain must resolve to THIS VPS (not Cloudflare proxy IPs)
echo "==> DNS preflight"
VPS_IP="$(curl -4 -sf --max-time 5 ifconfig.me 2>/dev/null || curl -4 -sf --max-time 5 icanhazip.com 2>/dev/null || true)"
VPS_IP="$(echo "$VPS_IP" | tr -d '[:space:]')"
RESOLVED="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ')"
if [ -z "$RESOLVED" ]; then
  RESOLVED="$(dig +short A "$DOMAIN" 2>/dev/null | grep -E '^[0-9.]+$' | tr '\n' ' ')"
fi
echo "    VPS public IPv4: ${VPS_IP:-unknown}"
echo "    ${DOMAIN} A records: ${RESOLVED:-none}"

if [ -n "$VPS_IP" ] && [ -n "$RESOLVED" ]; then
  if ! echo " $RESOLVED " | grep -q " ${VPS_IP} "; then
    echo ""
    echo "ERROR: ${DOMAIN} does not point to this VPS (${VPS_IP})."
    echo "Let's Encrypt challenge fails when DNS goes to Cloudflare proxy (orange cloud)"
    echo "or another CDN IP (e.g. 104.21.x / 172.67.x)."
    echo ""
    echo "Fix in Cloudflare DNS:"
    echo "  1) A record @  → ${VPS_IP}"
    echo "  2) Proxy status → DNS only (grey cloud), NOT Proxied (orange)"
    echo "  3) Wait 1–5 minutes, then re-run this script"
    echo ""
    echo "Optional www: A www → ${VPS_IP} (also grey cloud)"
    exit 1
  fi
fi
echo "    DNS OK (domain points at this VPS)"

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y nginx certbot dnsutils curl

# Open host firewall if ufw is active (Vultr cloud firewall is separate)
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -qi 'Status: active'; then
  echo "==> ufw: allow 80/443"
  ufw allow 80/tcp >/dev/null || true
  ufw allow 443/tcp >/dev/null || true
fi

mkdir -p /var/www/certbot/.well-known/acme-challenge

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

# Prove ACME path works before calling Let's Encrypt
echo ok-preflight > /var/www/certbot/.well-known/acme-challenge/preflight
PREFLIGHT="$(curl -sf --max-time 3 "http://127.0.0.1/.well-known/acme-challenge/preflight" -H "Host: ${DOMAIN}" || true)"
if [ "$PREFLIGHT" != "ok-preflight" ]; then
  echo "ERROR: nginx is not serving ACME files on port 80 (localhost)."
  echo "Run: sudo bash deploy/diagnose-https.sh ${DOMAIN}"
  exit 1
fi
echo "==> ACME path OK on localhost"

# Prefer IPv4-only cert when no working IPv6
CERTBOT_ARGS=(
  certonly
  --webroot
  -w /var/www/certbot
  -d "$DOMAIN"
  --non-interactive
  --agree-tos
  --keep-until-expiring
  --preferred-challenges http
)
if [ "$USE_EMAIL" -eq 1 ]; then
  CERTBOT_ARGS+=(--email "$EMAIL")
else
  CERTBOT_ARGS+=(--register-unsafely-without-email)
fi

echo "==> Requesting Let's Encrypt certificate (webroot)..."
set +e
certbot "${CERTBOT_ARGS[@]}"
CERTBOT_RC=$?
set -e

if [ "$CERTBOT_RC" -ne 0 ]; then
  echo ""
  echo "ERROR: certbot failed (exit $CERTBOT_RC) — often 'Some challenges have failed'."
  echo "DNS looks OK; next suspect is Vultr firewall blocking inbound TCP 80."
  echo ""
  echo "Run diagnostics:"
  echo "  sudo bash deploy/diagnose-https.sh ${DOMAIN}"
  echo ""
  echo "Vultr → Firewall Group → inbound:"
  echo "  TCP 80  from 0.0.0.0/0"
  echo "  TCP 443 from 0.0.0.0/0"
  echo "Attach that group to this server, wait ~1 min, then retry:"
  echo "  sudo bash deploy/setup-https.sh ${DOMAIN} none"
  echo ""
  echo "Certbot detail:"
  tail -n 30 /var/log/letsencrypt/letsencrypt.log 2>/dev/null | sed 's/^/  /' || true
  exit "$CERTBOT_RC"
fi

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
