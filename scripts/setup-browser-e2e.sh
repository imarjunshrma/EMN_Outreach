#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

fixture_root=/private/tmp/outvexa-browser-e2e
mkdir -p "$fixture_root"
chmod 700 "$fixture_root"

# The administrator connection only creates these named fixture objects and installs extensions.
psql -X -h 127.0.0.1 -p 5432 -d postgres -w -v ON_ERROR_STOP=1 <<'SQL'
SELECT 'CREATE ROLE outvexa_browser_e2e LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'outvexa_browser_e2e') \gexec
SELECT 'CREATE DATABASE outvexa_browser_e2e OWNER outvexa_browser_e2e'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'outvexa_browser_e2e') \gexec
SQL
psql -X -h 127.0.0.1 -p 5432 -d outvexa_browser_e2e -w -v ON_ERROR_STOP=1 \
  -c 'CREATE EXTENSION IF NOT EXISTS vector' \
  -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm' \
  -c 'CREATE EXTENSION IF NOT EXISTS unaccent'

if redis-cli -h 127.0.0.1 -p 6387 ping 2>/dev/null | grep -qx PONG; then
  live_pid="$(redis-cli -h 127.0.0.1 -p 6387 info server | awk -F: '/^process_id:/ { gsub(/\r/, "", $2); print $2 }')"
  if [[ ! -f "$fixture_root/redis.pid" || "$(cat "$fixture_root/redis.pid")" != "$live_pid" ]]; then
    echo 'Port 6387 is occupied by a Redis instance outside this fixture.' >&2
    exit 1
  fi
else
  redis-server --bind 127.0.0.1 --port 6387 --save '' --appendonly no --daemonize yes \
    --pidfile "$fixture_root/redis.pid" --logfile "$fixture_root/redis.log"
fi

node scripts/browser-e2e-env.mjs npm run db:migrate
node scripts/browser-e2e-env.mjs node --import tsx scripts/seed-browser-e2e.ts
