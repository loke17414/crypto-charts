#!/bin/bash
# Diagnose Let's Encrypt / nginx HTTP-01 failures for Orbinex
# Usage: sudo bash deploy/diagnose-https.sh orbinex.net

set -euo pipefail

DOMAIN="${1:-orbinex.net}"
if [ "$(id -u)" -ne 0 ]; then
  echo "Need root: sudo bash $0 $DOMAIN"
  exit 1
fi

echo "==> Diagnose HTTPS for ${DOMAIN}"
echo ""

VPS_IP="$(curl -4 -sf --max-time 5 ifconfig.me 2>/dev/null || curl -4 -sf --max-time 5 icanhazip.com 2>/dev/null || true)"
VPS_IP="$(echo "$VPS_IP" | tr -d '[:space:]')"
DNS_A="$(dig +short A "$DOMAIN" @8.8.8.8 2>/dev/null | grep -E '^[0-9.]+$' | tr '\n' ' ')"
DNS_AAAA="$(dig +short AAAA "$DOMAIN" @8.8.8.8 2>/dev/null | tr '\n' ' ')"

echo "1) DNS"
echo "   VPS IPv4:     ${VPS_IP:-unknown}"
echo "   ${DOMAIN} A:  ${DNS_A:-none}"
echo "   ${DOMAIN} AAAA:${DNS_AAAA:-none}"
if [ -n "$VPS_IP" ] && echo " $DNS_A " | grep -q " ${VPS_IP} "; then
  echo "   OK: A record matches VPS"
else
  echo "   FAIL: A record must be ${VPS_IP} (DNS only / grey cloud)"
fi
if [ -n "$(echo "$DNS_AAAA" | tr -d '[:space:]')" ]; then
  echo "   WARN: AAAA exists — Let's Encrypt may use IPv6. Remove AAAA unless VPS has working IPv6."
fi

echo ""
echo "2) Listening ports"
ss -tlnp | grep -E ':80 |:443 |:8000 |:8765 ' || echo "   (none of 80/443/8000/8765 listening)"

echo ""
echo "3) nginx"
systemctl is-active nginx 2>/dev/null || echo "   nginx not active"
nginx -t 2>&1 | sed 's/^/   /' || true

echo ""
echo "4) Local ACME path test"
mkdir -p /var/www/certbot/.well-known/acme-challenge
echo ok-acme > /var/www/certbot/.well-known/acme-challenge/diag-test
LOCAL="$(curl -sf --max-time 3 "http://127.0.0.1/.well-known/acme-challenge/diag-test" -H "Host: ${DOMAIN}" || true)"
if [ "$LOCAL" = "ok-acme" ]; then
  echo "   OK: nginx serves challenge on localhost"
else
  echo "   FAIL: nginx did not serve challenge on localhost (got: '${LOCAL:-empty}')"
  echo "   Check /etc/nginx/sites-enabled/ and: systemctl status nginx"
fi

echo ""
echo "5) Firewall (host)"
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -qi 'Status: active'; then
  ufw status | sed 's/^/   /'
  if ! ufw status | grep -qE '80/tcp.*ALLOW'; then
    echo "   FAIL: ufw does not allow 80/tcp — run: ufw allow 80/tcp && ufw allow 443/tcp"
  fi
else
  echo "   ufw inactive or not installed"
fi
iptables -L INPUT -n 2>/dev/null | head -n 20 | sed 's/^/   /' || true

echo ""
echo "6) Public HTTP from this VPS (via public IP)"
PUB="$(curl -4 -sf --max-time 8 "http://${VPS_IP}/.well-known/acme-challenge/diag-test" -H "Host: ${DOMAIN}" || true)"
if [ "$PUB" = "ok-acme" ]; then
  echo "   OK: port 80 reachable on public IP from VPS itself"
else
  echo "   FAIL/WARN: cannot fetch challenge via public IP (got: '${PUB:-timeout/empty}')"
  echo "   → Open TCP 80 and 443 in Vultr Firewall / Security Group for this instance"
fi

echo ""
echo "7) Recent certbot log (last 40 lines)"
if [ -f /var/log/letsencrypt/letsencrypt.log ]; then
  tail -n 40 /var/log/letsencrypt/letsencrypt.log | sed 's/^/   /'
else
  echo "   (no log yet)"
fi

echo ""
echo "==> Most common remaining cause after DNS fix:"
echo "    Vultr Firewall blocking inbound 80/443"
echo "    Fix: Vultr → Firewall → allow TCP 80, TCP 443 → attach to this server"
echo ""
echo "Then: sudo bash deploy/setup-https.sh ${DOMAIN} none"
