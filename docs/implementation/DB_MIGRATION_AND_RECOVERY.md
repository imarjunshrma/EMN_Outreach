# Database migration and recovery

## Schema and migration path

PostgreSQL is the supported database. Prisma schema validation is not a database migration test. Deploy uses `prisma migrate deploy` followed by `scripts/apply-sql.ts` for supplemental idempotent SQL. The current history has four migrations; never rewrite or delete applied migrations to make a test pass.

## Isolated test database

Create a new database with a unique `emn_test_<suffix>` or `emn_e2e_<suffix>` name on a local test-only PostgreSQL instance. Set `TEST_DATABASE_URL` or `E2E_DATABASE_URL` explicitly. `TEST_DATABASE_URL` is migrated by Vitest setup; E2E targets must exist and be empty before `scripts/e2e.sh` runs. The script now refuses a nonempty E2E database and does not drop databases.

## Recovery

- Migration failure: keep the isolated database intact; inspect `prisma migrate status`, server logs and `DATABASE_MIGRATION_URL`. Correct migration/runtime defects, then recreate a *new* disposable database for a clean run.
- Failed test data: the integration harness truncates tables and flushes its configured test Redis database between scenarios. Only point it at disposable test resources.
- Lost temporary test cluster: it lives under the unique `/private/tmp/emn-onepass.*` directory used for the pass. It is not a production backup. Preserve it until results are captured; no cleanup of other database directories is authorized.
- Production recovery: use the operator's tested PostgreSQL backup and restore procedure; no production backup/restore was performed during this pass.

## Database checks not yet established

Runtime role grants, production-sized indexes, fresh production upgrade, backup/restore, failover, and any RLS behavior remain unverified. Current schema has no RLS policies.
