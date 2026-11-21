# Implementation progress

## Completed in this pass

- Recalculated source inventories: 296 HTTP endpoints, 65 frontend page files, 84 Prisma models, 44 enums, 4 migrations, 15 queues and 17 test files.
- Fixed API-key privilege inheritance: workspace API keys cannot access `auth: user` routes via creator identity. Regression tests passed.
- Fixed first-owner registration: transaction advisory lock now returns an integer supported by Prisma 7. Integration tests caught the original HTTP 500 and passed after the fix.
- Extended tenant isolation to three workspaces, including foreign mailbox-ID substitution.
- Removed `ALTER ROLE emn_app PASSWORD` from `scripts/migrate-compose.ts`; migration owner should not need CREATEROLE or superuser privileges. Smoke test passed with separate non-superuser owner and runtime roles.
- Demoted the fresh Docker bootstrap owner role after it creates `emn_app`, preserving it as database/migration owner without cluster superuser privileges.
- Reworked `scripts/e2e.sh` to require explicit localhost DB/Redis endpoints, require empty resources, use unique queue/storage prefixes, and never drop databases or flush Redis. Empty target E2E passed; nonempty target refusal passed.
- Set test `EMN_ENV_FILE=/dev/null` so test processes do not import developer `.env` provider credentials.
- Added the required one-pass ledger and architecture/provider/database/deployment/test environment documentation.

## Verification

- Full `npm test`: **139 passed across 17 files** (46 unit, 93 integration).
- Playwright: **10 passed** using existing Google Chrome, a new E2E database, and isolated Redis DB. First attempt with the missing bundled browser did not execute test flows.
- Frontend production build, backend typecheck/build, Prisma validation and Compose YAML syntax parse passed.
- Lint passed with 8 `no-explicit-any` warnings.
- Fresh PostgreSQL migrations and supplemental SQL applied; `prisma migrate status` says up to date. Runtime app role SELECT passed, DDL was denied. Built worker started with 15 queues and drained cleanly on a separate isolated Redis DB; temporary PostgreSQL/Redis processes have since been stopped with the PostgreSQL data directory retained.

## Incomplete

- Docker executable is unavailable; Compose model/build/container health/restart/volume tests remain.
- Current schema has Workspace but no separate Tenant model or RLS; the separate tenant hierarchy is pending coordination with the parallel SaaS work.
- All 296 endpoints are inventoried, but full per-endpoint implementation classification and verification is incomplete.
- The 65 page files are counted; browser run covers 48 common routes, dynamic details and representative flows, not every action/page state.
- No live providers, real email, prospect contact, DNS mutation, payment, backup/restore, or worker outage/restart run.

See `ONE_PASS_COMPLETION_LEDGER.md`, `FINAL_IMPLEMENTATION_REPORT.md`, and `TESTING_AND_VERIFICATION.md`.
