#!/usr/bin/env bash
# EMN Outreach OS — zero-surprise release deploy (run as root from the unpacked project folder).
#   1. copies the source into /opt/emn/releases/<timestamp>
#   2. installs dependencies and builds API, worker and web UI (no Docker)
#   3. backs up the database, runs migrations, seeds reference data (idempotent)
#   4. switches the "current" symlink, restarts services and health-checks them
#   5. on a failed health check, switches back to the previous release and restarts
# Database migrations are forward-only: code rollback does NOT undo a migration. Restore the
# pre-deploy backup with scripts/restore.sh if a migration itself must be reverted.
set -euo pipefail

EMN_ROOT="${EMN_ROOT:-/opt/emn}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
PROCESS_MANAGER="${PROCESS_MANAGER:-systemd}"   # systemd | pm2
SKIP_BACKUP="${SKIP_BACKUP:-0}"
RELEASE="$EMN_ROOT/releases/$(date -u +%Y%m%d%H%M%S)"
ENV_FILE="$EMN_ROOT/shared/.env"

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[deploy] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }
as_emn() { sudo -u emn -H env HOME=/home/emn "$@"; }

[[ $EUID -eq 0 ]] || die "run as root"
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE missing — run scripts/install.sh first"
[[ -f "$SRC_DIR/package.json" && -d "$SRC_DIR/frontend" ]] || die "run from the project folder"
PREVIOUS="$(readlink -f "$EMN_ROOT/current" 2>/dev/null || true)"

restart_services() {
  if [[ "$PROCESS_MANAGER" == pm2 ]]; then
    as_emn pm2 startOrReload "$EMN_ROOT/current/deployment/pm2/ecosystem.config.cjs" --update-env
  else
    systemctl restart emn-api emn-worker emn-web
  fi
}

rollback() {
  if [[ -n "$PREVIOUS" && -d "$PREVIOUS" ]]; then
    log "Rolling back to $PREVIOUS"
    ln -sfn "$PREVIOUS" "$EMN_ROOT/current"
    restart_services
    bash "$PREVIOUS/scripts/healthcheck.sh" || log "previous release is unhealthy too — check logs in /var/log/emn"
  else
    log "No previous release to roll back to"
  fi
}

log "Copying source to $RELEASE"
install -d -o emn -g emn "$RELEASE"
rsync -a --delete --exclude node_modules --exclude .next --exclude dist --exclude .env --exclude storage \
  --exclude 'backend/src/generated' --exclude '*.tsbuildinfo' "$SRC_DIR/" "$RELEASE/"
chown -R emn:emn "$RELEASE"
ln -sfn "$ENV_FILE" "$RELEASE/.env"

log "Installing dependencies and building (this takes a few minutes)"
cd "$RELEASE"
as_emn npm ci --no-audit --no-fund
as_emn npm run build
as_emn npm --prefix frontend ci --no-audit --no-fund
as_emn env NEXT_TELEMETRY_DISABLED=1 npm --prefix frontend run build

if [[ "$SKIP_BACKUP" != 1 && -n "$PREVIOUS" ]]; then
  log "Backing up database before migrating"
  bash "$RELEASE/scripts/backup.sh"
fi

log "Running migrations and reference-data seed"
as_emn npm run db:migrate
as_emn npm run db:seed

log "Activating release"
ln -sfn "$RELEASE" "$EMN_ROOT/current"
restart_services

if ! bash "$RELEASE/scripts/healthcheck.sh"; then
  log "Health check failed"
  rollback
  die "deploy failed; see /var/log/emn/*.log"
fi

log "Pruning old releases (keeping $KEEP_RELEASES)"
# shellcheck disable=SC2012
ls -1dt "$EMN_ROOT"/releases/*/ | tail -n +"$((KEEP_RELEASES + 1))" | xargs -r rm -rf
log "Deployed $(basename "$RELEASE")"
