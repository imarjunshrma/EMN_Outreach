#!/bin/sh
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=runtime_password="$DB_APP_PASSWORD" <<'SQL'
CREATE ROLE emn_app LOGIN PASSWORD :'runtime_password';
GRANT CONNECT ON DATABASE emn TO emn_app;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
-- The official Postgres image initializes POSTGRES_USER as a superuser. Keep
-- this role as the database/migration owner, but remove cluster-wide powers.
ALTER ROLE emn_owner NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
SQL
