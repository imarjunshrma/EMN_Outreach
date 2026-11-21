-- EMN Outreach OS — PostgreSQL roles (run as the postgres superuser):
--   sudo -u postgres psql -v owner_pw="'...'" -v app_pw="'...'" -f deployment/postgres/setup.sql
-- emn_owner owns the schema and runs migrations; emn_app is the least-privilege runtime role.
CREATE ROLE emn_owner LOGIN PASSWORD :owner_pw;
CREATE ROLE emn_app   LOGIN PASSWORD :app_pw;
CREATE DATABASE emn OWNER emn_owner ENCODING 'UTF8' TEMPLATE template0;
\connect emn
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO emn_app;
ALTER DEFAULT PRIVILEGES FOR ROLE emn_owner IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO emn_app;
ALTER DEFAULT PRIVILEGES FOR ROLE emn_owner IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO emn_app;
-- Tables created by migrations are owned by emn_owner, so emn_app cannot ALTER/DROP them,
-- and the AuditLog append-only trigger (prisma/sql/001_indexes_and_guards.sql) blocks UPDATE/DELETE on audit rows.
