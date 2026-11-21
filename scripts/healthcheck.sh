#!/usr/bin/env bash
# Checks API liveness/readiness (DB + Redis), the web UI and that the worker process is up.
# Exit code 0 = healthy. Usage: bash scripts/healthcheck.sh [retries]
set -uo pipefail
RETRIES="${1:-20}"
API="${EMN_API_URL:-http://127.0.0.1:4000}"
WEB="${EMN_WEB_URL:-http://127.0.0.1:3000}"
PROCESS_MANAGER="${PROCESS_MANAGER:-systemd}"   # systemd | pm2 | none (skip worker check)

check() {
  curl -fsS --max-time 5 "$API/readyz" | grep -q '"ok":true' || { echo "api not ready"; return 1; }
  curl -fsS --max-time 10 -o /dev/null "$WEB/login" || { echo "web not responding"; return 1; }
  if [[ "$PROCESS_MANAGER" == pm2 ]]; then
    sudo -u emn -H pm2 jlist 2>/dev/null | grep -q '"name":"emn-worker".*"status":"online"' || { echo "worker not online"; return 1; }
  elif [[ "$PROCESS_MANAGER" == systemd ]]; then
    systemctl is-active --quiet emn-worker || { echo "worker not active"; return 1; }
  fi
}

for ((i = 1; i <= RETRIES; i++)); do
  if out="$(check)"; then echo "healthy"; exit 0; fi
  echo "attempt $i/$RETRIES: $out"; sleep 3
done
exit 1
