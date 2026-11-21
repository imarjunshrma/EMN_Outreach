#!/usr/bin/env bash
# Local development on macOS (Apple Silicon or Intel) with Homebrew.
#   bash scripts/mac-dev.sh setup   # installs Postgres 16 + Redis, creates the DB, writes .env, installs deps, migrates
#   bash scripts/mac-dev.sh start   # starts API (4000), worker and web UI (http://localhost:3000)
#   bash scripts/mac-dev.sh stop    # stops them
#   bash scripts/mac-dev.sh logs    # follow the logs
# Uses its own database (emn_local) and Redis DB 2, so it does not touch other projects.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
LOGS="$ROOT/.local-dev"
mkdir -p "$LOGS"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

need_node() {
  local major
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$major" -ge 22 ]; then return; fi
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"; nvm install 22 >/dev/null; nvm use 22 >/dev/null
  else
    brew install node@22; PATH="$(brew --prefix node@22)/bin:$PATH"; export PATH
  fi
}

use_node() {
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$HOME/.nvm/nvm.sh"; nvm use 22 >/dev/null 2>&1 || true
  fi
  if command -v brew >/dev/null && [ -d "$(brew --prefix)/opt/node@22/bin" ]; then PATH="$(brew --prefix)/opt/node@22/bin:$PATH"; export PATH; fi
}

pg_bin() { echo "$(brew --prefix postgresql@16)/bin"; }

setup() {
  command -v brew >/dev/null || die "Homebrew is required: https://brew.sh"
  say "Node.js 22"
  need_node; use_node; node -v

  say "PostgreSQL 16 and Redis (Homebrew services)"
  brew list postgresql@16 >/dev/null 2>&1 || brew install postgresql@16
  brew list redis >/dev/null 2>&1 || brew install redis
  brew services start postgresql@16 >/dev/null || true
  brew services start redis >/dev/null || true
  local PG; PG="$(pg_bin)"
  for _ in $(seq 1 30); do "$PG/pg_isready" -q -h 127.0.0.1 -p 5432 && break; sleep 1; done
  "$PG/pg_isready" -h 127.0.0.1 -p 5432 || die "PostgreSQL is not answering on 127.0.0.1:5432 (another Postgres may own the port)"
  redis-cli -h 127.0.0.1 ping >/dev/null || die "Redis is not answering on 127.0.0.1:6379"

  say "Database emn_local (role emn)"
  "$PG/psql" -h 127.0.0.1 -d postgres -tAc "SELECT 1 FROM pg_roles WHERE rolname='emn'" | grep -q 1 \
    || "$PG/psql" -h 127.0.0.1 -d postgres -qc "CREATE ROLE emn LOGIN PASSWORD 'emn' CREATEDB"
  "$PG/psql" -h 127.0.0.1 -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='emn_local'" | grep -q 1 \
    || "$PG/psql" -h 127.0.0.1 -d postgres -qc "CREATE DATABASE emn_local OWNER emn"
  "$PG/psql" -h 127.0.0.1 -d emn_local -qc "CREATE EXTENSION IF NOT EXISTS pg_trgm" # needs superuser (your Homebrew user)

  if [ ! -f .env ]; then
    say "Writing .env (local development values + fresh secrets)"
    {
      echo "NODE_ENV=development"
      echo "APP_URL=http://localhost:3000"
      echo "API_PORT=4000"
      echo "API_HOST=127.0.0.1"
      echo "LOG_LEVEL=info"
      echo "DATABASE_URL=postgresql://emn:emn@127.0.0.1:5432/emn_local"
      echo "REDIS_URL=redis://127.0.0.1:6379/2"
      echo "QUEUE_PREFIX=emnlocal"
      echo "STORAGE_DRIVER=local"
      echo "STORAGE_ROOT=$ROOT/storage"
      echo "PUBLIC_REGISTRATION=false"
      echo "BILLING_ENABLED=false"
      echo "# SYSTEM_SMTP_URL= (set to receive password-reset emails and reports)"
      echo "# GOOGLE_CLIENT_ID= / GOOGLE_CLIENT_SECRET= / MICROSOFT_CLIENT_ID= / MICROSOFT_CLIENT_SECRET= (mailbox OAuth)"
      node scripts/gen-keys.mjs
    } > .env
    chmod 600 .env
  else
    say ".env already exists, keeping it"
  fi
  mkdir -p storage

  say "Installing dependencies (backend + frontend)"
  npm ci --no-audit --no-fund
  npm --prefix frontend ci --no-audit --no-fund

  say "Migrations + seed"
  npm run -s db:migrate
  npm run -s db:seed

  say "Setup complete. Next: bash scripts/mac-dev.sh start"
}

start() {
  use_node
  [ -f .env ] || die "Run: bash scripts/mac-dev.sh setup"
  # Install again only when a lockfile changed since the last install (e.g. after an update)
  if [ package-lock.json -nt node_modules/.package-lock.json ]; then say "Dependencies changed: installing"; npm ci --no-audit --no-fund; fi
  if [ frontend/package-lock.json -nt frontend/node_modules/.package-lock.json ]; then say "Frontend dependencies changed: installing"; npm --prefix frontend ci --no-audit --no-fund; fi
  # After an update: regenerate the Prisma client if the schema changed, and apply new migrations (idempotent).
  if [ prisma/schema.prisma -nt backend/src/generated/prisma/client.ts ] 2>/dev/null || [ ! -d backend/src/generated/prisma ]; then say "Database schema changed: regenerating the Prisma client"; npx prisma generate >/dev/null; fi
  say "Applying database migrations (safe to repeat)"
  npm run -s db:migrate || die "Migration failed — see the output above. Your data was not changed by a failed migration."
  stop quiet
  say "Starting API, worker and web UI (logs in .local-dev/)"
  nohup npm run -s dev:api    > "$LOGS/api.log" 2>&1 & echo $! > "$LOGS/api.pid"
  nohup npm run -s dev:worker > "$LOGS/worker.log" 2>&1 & echo $! > "$LOGS/worker.pid"
  (cd frontend && EMN_API_INTERNAL_URL=http://127.0.0.1:4000 nohup npm run -s dev > "$LOGS/web.log" 2>&1 & echo $! > "$LOGS/web.pid")
  printf 'Waiting for the API'; for _ in $(seq 1 60); do curl -sf http://127.0.0.1:4000/readyz >/dev/null && break; printf '.'; sleep 1; done; echo
  curl -sf http://127.0.0.1:4000/readyz >/dev/null || { tail -30 "$LOGS/api.log"; die "API did not start, see .local-dev/api.log"; }
  printf 'Waiting for the web UI'; for _ in $(seq 1 90); do curl -sf -o /dev/null http://localhost:3000/login && break; printf '.'; sleep 1; done; echo
  say "Running"
  echo "  Web UI:  http://localhost:3000   (first visit → /setup creates your owner account)"
  echo "  API:     http://127.0.0.1:4000/healthz   ·   API docs: http://127.0.0.1:4000/api/v1/openapi.json"
  echo "  Logs:    bash scripts/mac-dev.sh logs     Stop: bash scripts/mac-dev.sh stop"
  command -v open >/dev/null && open http://localhost:3000 || true
}

stop() {
  for s in web worker api; do
    if [ -f "$LOGS/$s.pid" ]; then
      pid=$(cat "$LOGS/$s.pid")
      pkill -TERM -P "$pid" 2>/dev/null || true; kill "$pid" 2>/dev/null || true
      rm -f "$LOGS/$s.pid"
    fi
  done
  # dev servers spawn children: also stop listeners on 3000/4000, but only processes running from this project
  for port in 3000 4000; do
    for p in $(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null); do
      cwd=$(lsof -a -p "$p" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
      case "$cwd" in "$ROOT"*) kill "$p" 2>/dev/null || true ;; esac
    done
  done
  pkill -f "$ROOT/node_modules" 2>/dev/null || true
  [ "${1:-}" = quiet ] || say "Stopped"
}

case "${1:-}" in
  setup) setup ;;
  start) start ;;
  stop) stop ;;
  restart) stop quiet; start ;;
  logs) tail -f "$LOGS"/*.log ;;
  *) echo "Usage: bash scripts/mac-dev.sh setup|start|stop|restart|logs"; exit 1 ;;
esac
