#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 || "$1" != "--confirm-database" || ! "$2" =~ ^[a-zA-Z][a-zA-Z0-9_]{0,62}$ ]]; then
  printf 'Usage: use administrator PG connection settings and pass --confirm-database DATABASE_NAME\n' >&2
  exit 2
fi

psql -X --dbname "$2" --set ON_ERROR_STOP=1 --command 'CREATE EXTENSION IF NOT EXISTS vector;'
