# Remediation log

## Current pass

### API-key privilege separation

- Finding: generic `auth: user` routes accepted the creator user ID assigned to workspace API keys for audit attribution.
- Fix: router denies API-key principals on user-session routes; workspace-scoped API key role/scope behavior remains.
- Coverage: API key denied `/auth/me`, workspace creation, and platform-admin listing. Full integration suite passed.
- Files: `backend/src/http/router.ts`, `tests/integration/security-v12.test.ts`.

### First-owner registration Prisma decoding

- Finding: `$queryRaw` returned PostgreSQL `void` from `pg_advisory_xact_lock`, which Prisma 7's adapter failed to deserialize; registration returned 500.
- Fix: materialized CTE acquires the same transaction lock and returns integer `1`.
- Coverage: registration and concurrent-first-owner integration tests passed; included in 139-test run.
- File: `backend/src/services/auth.ts`.

### Migration owner/app role separation

- Finding: `scripts/migrate-compose.ts` attempted `ALTER ROLE emn_app PASSWORD` as the migration owner. A properly non-superuser owner lacks CREATEROLE, so migrations stopped after schema creation.
- Fix: remove password mutation; runtime-role password is provisioned by Postgres initialization. Migration script only applies migrations/grants/seed.
- Coverage: ran migration/SQL/seed as non-superuser owner; runtime role could SELECT and could not CREATE TABLE. Prisma reports schema up to date.
- Files: `scripts/migrate-compose.ts`, `deployment/docker/postgres-init/001-runtime-role.sh`.

### E2E data safety

- Finding: prior E2E script dropped database `emn_e2e` and flushed Redis DB 14 unconditionally.
- Fix: require explicit localhost URLs, unique `emn_e2e_` DB, empty DB/Redis preflight, fresh queue/storage namespace; no database drop or Redis flush. Playwright config requires E2E endpoints.
- Coverage: fresh DB browser run passed; repeat against a nonempty migrated database refused before migration.
- Files: `scripts/e2e.sh`, `playwright.config.ts`.

### Test credential isolation

- Finding: app test startup could load `.env`, adding developer/provider credentials not intended for isolated fixtures.
- Fix: `EMN_ENV_FILE=/dev/null` in Vitest and Playwright app environments.
- Files: `tests/helpers/env.ts`, `playwright.config.ts`.

## Previous-pass fixes

- Inbox ingestion now scopes email-account lookup by both account ID and workspace ID; integration regression passed in the full test suite.
- First-owner race is serialized by PostgreSQL advisory transaction lock.
- Cloudflare DNS mutating requests do not retry after uncertain provider outcomes; mocked tests passed.
