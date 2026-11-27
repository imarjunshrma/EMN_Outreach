#!/usr/bin/env bash
# Browser test run: fresh e2e database → migrations → Playwright (starts API + frontend itself).
set -euo pipefail
cd "$(dirname "$0")/.."
DB_URL="${E2E_DATABASE_URL:-postgresql://emn:emn@127.0.0.1:5432/emn_e2e}"
# The specs open their own fixture connections; give them the same database the servers use.
export E2E_DATABASE_URL="$DB_URL"
export E2E_REDIS_URL="${E2E_REDIS_URL:-redis://127.0.0.1:6379/14}"
ADMIN_URL="${DB_URL%/*}/postgres"
psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS emn_e2e WITH (FORCE)" -c "CREATE DATABASE emn_e2e"
DATABASE_URL="$DB_URL" npm run -s db:migrate
redis-cli -u "$E2E_REDIS_URL" flushdb >/dev/null
# Rewrites are fixed at build time, so the browser tests use their own build pointing at the e2e API.
(cd frontend && NEXT_DIST_DIR=.next-e2e EMN_API_INTERNAL_URL=http://127.0.0.1:4100 NEXT_TELEMETRY_DISABLED=1 npx next build >/dev/null)
npx playwright test "$@"
