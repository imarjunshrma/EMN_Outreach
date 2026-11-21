#!/usr/bin/env bash
# Restores a database dump (and optionally a storage archive) created by backup.sh.
# DESTRUCTIVE: replaces current data. Services are stopped during the restore.
# Usage: sudo bash scripts/restore.sh /var/lib/emn/backups/emn-db-<stamp>.dump [/var/lib/emn/backups/emn-storage-<stamp>.tar.gz]
set -euo pipefail
DUMP="${1:-}"; ARCHIVE="${2:-}"
ENV_FILE="${EMN_ENV_FILE:-/opt/emn/shared/.env}"
[[ -f "$DUMP" ]] || { echo "usage: restore.sh <db.dump> [storage.tar.gz]" >&2; exit 1; }
[[ -z "$ARCHIVE" || -f "$ARCHIVE" ]] || { echo "storage archive not found: $ARCHIVE" >&2; exit 1; }
env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
DB_URL="$(env_get DATABASE_MIGRATION_URL)"
[[ -n "$DB_URL" ]] || DB_URL="$(env_get DATABASE_URL)"
[[ -n "$DB_URL" ]] || { echo "DATABASE_URL not set in $ENV_FILE" >&2; exit 1; }
STORAGE="$(env_get STORAGE_ROOT)"

if [[ "${EMN_RESTORE_CONFIRM:-}" != yes ]]; then
  read -r -p "This replaces ALL current EMN data with $DUMP. Type 'restore' to continue: " ans
  [[ "$ans" == restore ]] || { echo "aborted"; exit 1; }
fi

command -v systemctl >/dev/null && systemctl stop emn-web emn-worker emn-api || true
pg_restore --clean --if-exists --no-owner --single-transaction --dbname="$DB_URL" "$DUMP"
if [[ -n "$ARCHIVE" && -n "$STORAGE" ]]; then
  rm -rf "${STORAGE:?}.restore-old" && { [[ -d "$STORAGE" ]] && mv "$STORAGE" "$STORAGE.restore-old" || true; }
  tar -C "$(dirname "$STORAGE")" -xzf "$ARCHIVE"
  chown -R emn:emn "$STORAGE" 2>/dev/null || true
fi
command -v systemctl >/dev/null && systemctl start emn-api emn-worker emn-web || true
echo "restore complete; verify with: bash scripts/healthcheck.sh"
