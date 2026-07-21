#!/usr/bin/env bash
# Patch live nginx so /admin-site/ is not cached by Cloudflare/browsers.
# Safe to re-run. Does not require re-issuing TLS certs.
#
#   sudo bash deploy/patch-admin-cache.sh

set -euo pipefail

CONF="$(ls /etc/nginx/sites-enabled/*cryptocharts* /etc/nginx/sites-enabled/*orbinex* 2>/dev/null | head -n 1 || true)"
if [[ -z "${CONF}" ]]; then
  CONF="$(ls /etc/nginx/sites-enabled/* 2>/dev/null | head -n 1 || true)"
fi
if [[ -z "${CONF}" || ! -f "${CONF}" ]]; then
  echo "ERROR: no nginx site config found in /etc/nginx/sites-enabled/"
  exit 1
fi

# Resolve symlink target for editing
REAL="$(readlink -f "$CONF")"
echo "==> Patching: $REAL"

if grep -q 'location \^~ /admin-site/' "$REAL"; then
  echo "==> /admin-site/ cache block already present"
else
  # Insert admin-site location before the generic location / block (443 server preferred)
  python3 - "$REAL" <<'PY'
import pathlib, sys, re
path = pathlib.Path(sys.argv[1])
text = path.read_text(encoding="utf-8")
block = """
    location ^~ /admin-site/ {
        proxy_pass http://127.0.0.1:8765;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        add_header Cache-Control "private, no-cache, no-store, must-revalidate" always;
        add_header CDN-Cache-Control "no-store" always;
        add_header Cloudflare-CDN-Cache-Control "no-store" always;
    }

"""
if "location ^~ /admin-site/" in text:
    print("already patched")
    raise SystemExit(0)
# Prefer inserting before the last "location / {" in SSL server; fallback first match
matches = list(re.finditer(r"\n    location / \{", text))
if not matches:
    print("ERROR: could not find location / block", file=sys.stderr)
    raise SystemExit(1)
m = matches[-1]
text = text[: m.start()] + "\n" + block + text[m.start() + 1 :]
path.write_text(text, encoding="utf-8")
print("inserted /admin-site/ no-cache location")
PY
fi

nginx -t
systemctl reload nginx
echo "==> nginx reloaded"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -f "$ROOT/.env" ]]; then
  if ! grep -qE '^ADMIN_EMAILS=.+' "$ROOT/.env"; then
    echo ""
    echo "WARN: ADMIN_EMAILS is empty in .env — console login will be denied."
    echo "  Set: ADMIN_EMAILS=you@email.com"
    echo "  Then: systemctl restart crypto-web"
  else
    echo "==> ADMIN_EMAILS is set"
  fi
fi

systemctl restart crypto-web
echo "==> crypto-web restarted"
echo "Done. Hard-refresh console: https://orbinex.net/admin-site/login.html"
