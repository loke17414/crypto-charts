#!/usr/bin/env bash
# Print SMTP-related .env keys (values redacted) and run diagnose.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> .env SMTP lines (secrets redacted)"
if [[ ! -f .env ]]; then
  echo "Missing .env"
  exit 1
fi

while IFS= read -r line || [[ -n "$line" ]]; do
  case "$line" in
    SMTP*|EMAIL_REQUIRE*)
      key="${line%%=*}"
      val="${line#*=}"
      val="${val%$'\r'}"
      if [[ "$key" == *PASSWORD* ]]; then
        echo "${key}=*** (len=${#val})"
      else
        echo "${key}=${val}"
      fi
      ;;
  esac
done < .env

echo ""
echo "==> smtp_diagnose"
# shellcheck disable=SC1091
source .venv/bin/activate
python -m bot.smtp_diagnose
