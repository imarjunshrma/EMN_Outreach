# Isolated local test environment

## Integration tests

The current pass uses a fresh PostgreSQL cluster and Redis instance under `/private/tmp/emn-onepass.CJeV5q`, bound to loopback on ports 55483 and 56388. It has a dedicated `emn_test` database and Redis DB 15. The host binaries are PostgreSQL 18.3 and Redis 8.4.0; production Compose versions (PostgreSQL 16/Redis 7) were not available to test. This is separate from default PostgreSQL/Redis ports and Docker volumes.

For a later run, set explicit URLs to a disposable local database and nonzero, empty Redis DB, then run:

```sh
TEST_DATABASE_URL='postgresql://<test-user>@127.0.0.1:<port>/<fresh-test-db>' \
TEST_REDIS_URL='redis://127.0.0.1:<port>/<empty-db-index>' \
npm run test:integration
```

The test harness truncates all tables other than `_prisma_migrations` and flushes its configured Redis DB. Never point these variables at a user, staging, or production database/Redis.

## Browser E2E

`scripts/e2e.sh` now requires explicit `E2E_DATABASE_URL` and `E2E_REDIS_URL`, accepts only localhost URLs, requires an `emn_e2e_<unique-suffix>` database and Redis DB index greater than zero, and refuses to run if either target contains data. It never executes `DROP DATABASE` or `FLUSHDB`. It assigns a random queue prefix and unique storage directory.

Provision a *new* database and an empty Redis DB yourself, then run:

```sh
E2E_DATABASE_URL='postgresql://<test-user>@127.0.0.1:<port>/emn_e2e_<unique-suffix>' \
E2E_REDIS_URL='redis://127.0.0.1:<port>/<empty-db-index>' \
npm run test:e2e
```

The browser suite needs local Chromium/Chrome. It starts API and web processes locally, does not exercise external provider operations or contact prospects/providers. The database and Redis DB are left intact after the run; manually remove only the exact test resources you created when you have retained the evidence.

## SMTP protocol unit test

`tests/unit/smtp-protocol.test.ts` starts a temporary loopback SMTP fixture. In restricted environments it may fail with `listen EPERM`; run it in an environment that permits local loopback binds. It sends only to the in-process fake server.
