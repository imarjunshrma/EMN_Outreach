#!/usr/bin/env bash
# Backup → restore drill that never touches the source database:
#   1. pg_dump (custom format) of SOURCE_DATABASE_URL
#   2. restore into a NEW database named emn_restore_drill_<timestamp> on the same server
#   3. compare exact row counts of every table, and re-apply migrations to prove the restored copy is usable
# Usage: SOURCE_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/emn bash scripts/restore-drill.sh [--keep]
# The drill database is dropped at the end unless --keep is given. It refuses to reuse an existing name.
set -euo pipefail
SRC="${SOURCE_DATABASE_URL:?set SOURCE_DATABASE_URL}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
DRILL_DB="emn_restore_drill_${STAMP}"
ADMIN_URL="${SRC%/*}/postgres"
DRILL_URL="${SRC%/*}/${DRILL_DB}"
DUMP="$(mktemp -d)/emn-${STAMP}.dump"
cleanup() { rm -f "$DUMP"; }
trap cleanup EXIT

echo "1/4 dumping source ($(echo "$SRC" | sed -E 's#//[^@]*@#//***@#'))"
pg_dump --format=custom --no-owner --no-privileges "$SRC" -f "$DUMP"
echo "    dump size: $(du -h "$DUMP" | cut -f1)"

echo "2/4 restoring into new database ${DRILL_DB}"
if [[ "$(psql "$ADMIN_URL" -Atqc "SELECT 1 FROM pg_database WHERE datname='${DRILL_DB}'")" == 1 ]]; then echo "refusing: ${DRILL_DB} exists" >&2; exit 1; fi
psql "$ADMIN_URL" -qc "CREATE DATABASE ${DRILL_DB}"
pg_restore --no-owner --no-privileges --exit-on-error -d "$DRILL_URL" "$DUMP"

echo "3/4 comparing row counts"
count_rows() {
  psql "$1" -Atqc "SELECT string_agg(t, ' ' ORDER BY t) FROM (SELECT format('%s=%s', c.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text) AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname='public' AND c.relkind='r') s"
}
A="$(count_rows "$SRC")"; B="$(count_rows "$DRILL_URL")"
TABLES=$(echo "$A" | wc -w)
if [[ "$A" == "$B" ]]; then echo "    OK: ${TABLES} tables, identical row counts"; else echo "    MISMATCH"; diff <(echo "$A" | tr ' ' '\n') <(echo "$B" | tr ' ' '\n') || true; RESULT=1; fi

echo "4/4 re-applying migrations to the restored copy (must be a no-op)"
DATABASE_URL="$DRILL_URL" DATABASE_MIGRATION_URL="$DRILL_URL" npm run -s db:migrate >/dev/null && echo "    OK: migrations applied cleanly"

if [[ "${1:-}" != "--keep" ]]; then psql "$ADMIN_URL" -qc "DROP DATABASE ${DRILL_DB}"; echo "drill database dropped"; else echo "kept: ${DRILL_DB}"; fi
exit "${RESULT:-0}"
