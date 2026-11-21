#!/usr/bin/env bash
# Backs up PostgreSQL (custom format) and local file storage. Keeps BACKUP_KEEP_DAYS (default 14).
# Backups contain personal data and encrypted credentials: keep them private (mode 600) and
# copy them off the server (e.g. rsync to another host). The .env with ENCRYPTION_KEYS is needed
# to decrypt stored credentials — back it up separately and securely.
# Cron example (root): 15 2 * * * bash /opt/emn/current/scripts/backup.sh >> /var/log/emn/backup.log 2>&1
set -euo pipefail
ENV_FILE="${EMN_ENV_FILE:-/opt/emn/shared/.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/emn/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
[[ -r "$ENV_FILE" ]] || { echo "cannot read $ENV_FILE" >&2; exit 1; }

env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
DB_URL="$(env_get DATABASE_MIGRATION_URL)"
[[ -n "$DB_URL" ]] || DB_URL="$(env_get DATABASE_URL)"
[[ -n "$DB_URL" ]] || { echo "DATABASE_URL not set in $ENV_FILE" >&2; exit 1; }
STORAGE="$(env_get STORAGE_ROOT)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
mkdir -p "$BACKUP_DIR"

pg_dump --format=custom --no-owner --dbname="$DB_URL" --file="$BACKUP_DIR/emn-db-$STAMP.dump"
if [[ -n "$STORAGE" && -d "$STORAGE" ]]; then
  tar -C "$(dirname "$STORAGE")" -czf "$BACKUP_DIR/emn-storage-$STAMP.tar.gz" "$(basename "$STORAGE")"
fi
find "$BACKUP_DIR" -maxdepth 1 -name 'emn-*' -type f -mtime +"$KEEP_DAYS" -delete
echo "backup ok: $BACKUP_DIR/emn-db-$STAMP.dump"
