# Unimplemented and blocked items

## Verified this pass

- 296 HTTP endpoints were counted (284 declarative, 12 direct). Aggregated API/integration tests passed, but endpoint-by-endpoint completeness counts are not established.
- All 139 automated unit/integration tests passed using isolated PostgreSQL/Redis.
- All 10 Playwright E2E tests passed on local Google Chrome. The browser crawl visits 48 common page paths plus dynamic details and admin; it is not full 65-file action coverage.
- Fresh migrations, supplemental SQL and seed completed in the temporary cluster. Runtime database role SELECT passed and DDL was denied.
- API-key user-route authorization and three-workspace mailbox isolation regressions passed.

## Remaining blockers and incomplete work

- Docker is unavailable, so Docker Compose configuration semantics, image builds, service health, database initialization, and container restart/persistence are unverified.
- No separate `Tenant` model or RLS policies exist. The current security boundary is `Workspace` with application-level checks. The intended Platform → Tenant → Workspace hierarchy needs confirmation/integration with the parallel SaaS transformation before schema changes.
- The route inventory does not include a completed per-endpoint audit of data scoping, validation, transactions, response contracts, audit events, pagination and negative cases. Exact complete/partial/missing/externally blocked endpoint counts remain unknown.
- Browser coverage is selective: 65 page files exist, while E2E covers key flows and a 48-path common-screen crawl. Not every action/state/error/permission on every page is tested.
- Provider credentials were not used. Google/Microsoft OAuth and real mail, AI/search/enrichment, Cloudflare, S3 and payment connectivity remain unverified live.
- DNS update/delete/broad record writes are unsupported; Cloudflare currently supports read and explicit TXT/CNAME creation.
- Backup/restore, real outage recovery, worker process restart, queue duplicate handling under Redis outage, production-grade role credentials, and Docker restarts remain untested.
- Lint has 8 existing `no-explicit-any` warnings. Next reports multiple lockfiles and missing Next ESLint plugin configuration.

## Exact resume path

Use the safe isolated commands and current disposable service coordinates in `TESTING_AND_VERIFICATION.md`. Docker runtime requires Docker Desktop and a newly isolated Compose project/volume; never target the default existing `emn` project volumes. For full tenant-hierarchy work, coordinate the existing transformation model first; do not add a competing Tenant table.
