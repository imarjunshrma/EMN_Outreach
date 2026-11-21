# Testing and verification

## Successful checks in this pass

| Check | Result | Evidence / limit |
|---|---|---|
| `npm test` with `TEST_DATABASE_URL=postgresql://emn_onepass_owner@127.0.0.1:55483/emn_test` and `TEST_REDIS_URL=redis://127.0.0.1:56388/15` | PASS: 139 tests / 17 files (repeated after `.env` isolation) | 46 unit + 93 integration tests; isolated temporary services only |
| `npm run test:e2e` with `CHROME_PATH=/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, E2E database `emn_e2e_safe_20261121`, Redis DB 12 (final run with `.env` loading disabled) | PASS: 10 tests | Fresh DB migrated; local Chrome; no external providers or mail |
| E2E runner refusal on already migrated E2E database | PASS | Refused before migration; no data was deleted |
| `npm run start:worker` with isolated DB, Redis DB 11 and unique queue prefix | PASS | Worker started with 15 queues and drained on SIGINT; no jobs/providers were supplied |
| `npm run build:frontend` and E2E Next build | PASS | Next build reports multiple-lockfile/workspace-root warnings |
| `npm run typecheck` | PASS | Backend/shared/integrations/worker and configured TypeScript files |
| `npm run build` | PASS | Backend/worker production TypeScript build |
| `npm run lint` | PASS with 8 warnings | `no-explicit-any` warnings in router/OpenAPI |
| `npx prisma validate` | PASS | Schema validation |
| `npx tsx scripts/migrate-compose.ts` with separate owner and app roles in temporary cluster | PASS after fix | Four migrations, supplemental SQL and seed; runtime role can SELECT and cannot CREATE TABLE |
| `bash -n scripts/e2e.sh` | PASS | E2E shell syntax |

## E2E browser launch diagnostic

The first E2E attempt used Playwright's expected bundled Chromium revision 1255, which was not installed. No test flow ran in that attempt. Retrying with the already-installed Google Chrome via `CHROME_PATH` passed all 10 tests.

## Added/fixed regressions exercised

- API keys cannot reach `auth: user` routes using creator identity (including workspace creation and platform admin).
- A third workspace cannot mutate a second workspace's mailbox by substituting its ID.
- First-owner registration race returns one owner registration and one closed registration.
- Mailbox ingestion rejects mismatched account/workspace IDs.
- PostgreSQL advisory registration lock now returns a Prisma-decodable integer; this fixed registration 500s found by integration tests.
- Cloudflare DNS mutation mock asserts no POST retry; read-only GET retains retry.
- E2E runner requires a fresh local DB and an empty nonzero Redis DB, refuses nonempty DB/Redis, and never runs DROP DATABASE or FLUSHDB.

## Infrastructure facts and limits

- Docker executable is unavailable; Compose interpolation, image health, container restart, and Docker volume behavior were not tested.
- The E2E server environment explicitly clears payment/OAuth/system-SMTP/S3 credentials and sets `EMN_ENV_FILE=/dev/null`; test app processes do not load `.env`.
- Default PostgreSQL at port 5432 and Redis at port 6379 were not available. Local binaries were used to start a new loopback-only temporary cluster at PostgreSQL 55483 and Redis 56388 under `/private/tmp/emn-onepass.CJeV5q`; both processes are now stopped and the PostgreSQL data directory is retained (PostgreSQL 18.3 and Redis 8.4.0). Compose targets PostgreSQL 16 and Redis 7, so those exact container versions were not verified.
- Runtime roles were exercised in a separate fresh `emn` database in that temporary cluster. The app role successfully selected data and was denied DDL. The owner role successfully applied migrations as a non-superuser.
- No RLS policies or separate `Tenant` model were found. Isolation remains application-level at workspace scope.
- No real email, live OAuth, prospect provider, DNS mutation, payment, or paid API calls were performed.
- The 296 endpoints were inventoried, but not every endpoint has individual contract and security coverage. Do not read passing aggregate suites as 296 endpoint passes.

## Exact rerun commands

Start only this disposable local cluster:

```sh
pg_ctl -D /private/tmp/emn-onepass.CJeV5q/pgdata -l /private/tmp/emn-onepass.CJeV5q/postgres.log -o "-h 127.0.0.1 -p 55483" start
redis-server --bind 127.0.0.1 --port 56388 --protected-mode yes --dir /private/tmp/emn-onepass.CJeV5q/redis --dbfilename dump.rdb --appendonly no --save "" --daemonize yes --pidfile /private/tmp/emn-onepass.CJeV5q/redis.pid --logfile /private/tmp/emn-onepass.CJeV5q/redis.log
```

Rerun the database tests against the dedicated test database/Redis DB (the harness truncates/flushes these targets):

```sh
TEST_DATABASE_URL='postgresql://emn_onepass_owner@127.0.0.1:55483/emn_test' \
TEST_REDIS_URL='redis://127.0.0.1:56388/15' npm test
```

For a new E2E run, create a new database (the E2E script refuses an existing migrated DB) and choose a fresh Redis DB index greater than zero:

```sh
createdb -h 127.0.0.1 -p 55483 -U emn_onepass_owner emn_e2e_<unique_suffix>
CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
E2E_DATABASE_URL='postgresql://emn_onepass_owner@127.0.0.1:55483/emn_e2e_<unique_suffix>' \
E2E_REDIS_URL='redis://127.0.0.1:56388/<empty_db_index>' npm run test:e2e
```

The E2E script keeps databases and Redis keys after tests. Do not drop or flush anything unless you separately identify the exact disposable resource you created and intend to remove it.
