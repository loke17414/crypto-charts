#!/usr/bin/env bash
# Install local PostgreSQL and wire Orbinex DATABASE_URL for production.
#
# Usage (VPS as root):
#   cd /root/crypto-charts && git pull
#   bash deploy/setup-postgres.sh
#   bash deploy/setup-postgres.sh --migrate-sqlite   # copy existing SQLite rows
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export ROOT

MIGRATE_SQLITE=0
for arg in "$@"; do
  case "$arg" in
    --migrate-sqlite) MIGRATE_SQLITE=1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Need root. Run: sudo bash $0" >&2
  exit 1
fi

DB_NAME="${ORBINEX_DB_NAME:-orbinex}"
DB_USER="${ORBINEX_DB_USER:-orbinex}"
ENV_FILE="$ROOT/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE — copy .env.example first" >&2
  exit 1
fi

echo "==> Install PostgreSQL"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y postgresql postgresql-contrib
systemctl enable --now postgresql

DB_PASS="$(python3 - <<'PY'
import re
from pathlib import Path
text = Path(".env").read_text(encoding="utf-8")
m = re.search(r"^DATABASE_URL=postgresql://[^:]+:([^@]+)@", text, re.M)
print(m.group(1) if m else "")
PY
)"
if [[ -z "$DB_PASS" ]]; then
  DB_PASS="$(openssl rand -hex 16)"
fi

echo "==> Ensure role + database"
sudo -u postgres psql -v ON_ERROR_STOP=1 -c \
  "DO \$\$ BEGIN
     IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${DB_USER}') THEN
       CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASS}';
     ELSE
       ALTER ROLE ${DB_USER} WITH LOGIN PASSWORD '${DB_PASS}';
     END IF;
   END \$\$;"

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
  sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
  echo "    created database $DB_NAME"
else
  echo "    database $DB_NAME already exists"
  sudo -u postgres psql -v ON_ERROR_STOP=1 -c \
    "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"
fi

URL="postgresql://${DB_USER}:${DB_PASS}@127.0.0.1:5432/${DB_NAME}"
export URL

echo "==> Write DATABASE_URL into .env"
python3 <<'PY'
from pathlib import Path
import os
path = Path(os.environ["ROOT"]) / ".env"
url = os.environ["URL"]
lines = path.read_text(encoding="utf-8").splitlines()
out, found = [], False
for line in lines:
    if line.startswith("DATABASE_URL="):
        out.append(f"DATABASE_URL={url}")
        found = True
    else:
        out.append(line)
if not found:
    if out and out[-1].strip():
        out.append("")
    out.append("# Production DB (managed by deploy/setup-postgres.sh)")
    out.append(f"DATABASE_URL={url}")
path.write_text("\n".join(out).rstrip() + "\n", encoding="utf-8")
print("DATABASE_URL updated")
PY

echo "==> Python deps + schema"
if [[ ! -d "$ROOT/.venv" ]]; then
  python3 -m venv "$ROOT/.venv"
fi
# shellcheck disable=SC1091
source "$ROOT/.venv/bin/activate"
pip install -q -r requirements.txt

if [[ "$MIGRATE_SQLITE" == "1" ]]; then
  echo "==> Migrate SQLite → Postgres"
  if python -m bot.migrate_sqlite_to_postgres; then
    echo "    migrate OK"
  else
    echo "    WARN: migrate failed — applying alembic empty schema" >&2
    alembic upgrade head
  fi
else
  echo "==> alembic upgrade head"
  alembic upgrade head
fi

echo "==> Done"
echo "    DATABASE_URL=postgresql://${DB_USER}:****@127.0.0.1:5432/${DB_NAME}"
echo "    Restart: systemctl restart crypto-web"

# Postgres 15+ often needs explicit schema grants for non-superuser apps
sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" <<SQL || true
GRANT ALL ON SCHEMA public TO ${DB_USER};
ALTER SCHEMA public OWNER TO ${DB_USER};
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${DB_USER};
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${DB_USER};
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${DB_USER};
SQL
