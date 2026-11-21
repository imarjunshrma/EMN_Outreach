# Unresolved issues and blockers

| ID | Area | Why unresolved | Risk | Dependency / exact next step |
|---|---|---|---|---|
| BLOCK-001 | Docker runtime | `docker` is not installed/available in this environment. | Compose builds, health, role init, proxy, restarts and isolated volumes unverified. | Start Docker Desktop on Mac; run isolated commands in final report, preserve test project volumes. |
| BLOCK-002 | PostgreSQL/Redis suites | `pg_isready` reports no response; Vitest global setup runs Prisma migrations against Postgres before tests. | Application logic regression coverage cannot execute. | Start isolated Compose test stack, then run `npm test` with explicit test URLs or add equivalent test-service config. |
| BLOCK-003 | Browser E2E | Playwright web servers require DB/Redis and Chromium. | 65 page workflows unverified. | Start isolated test DB/Redis; install Chromium if missing; run `npm run build:frontend && npm run test:e2e`. |
| BLOCK-004 | Full feature trace | 284 API handlers and 65 pages exceed source-only verification; each mutation/persistence/error path was not individually traced in this turn. | Hidden functional defects remain possible. | Work through `API_REVIEW.md` and `FRONTEND_REVIEW.md` grouped by feature, add internal test per confirmed issue. |
| BLOCK-005 | First-owner concurrency verification | Advisory-lock serialization and in-transaction recheck are implemented; the regression test cannot currently run. | SQL/runtime behavior remains unverified until PostgreSQL test passes. | Run the new concurrent registration test in an isolated PostgreSQL environment. |
| BLOCK-006 | Provider reality | Rules forbid live provider operations and no test credentials supplied. | API/version/consent/tenant-specific compatibility unknown. | Use mock suite now; only separately authorized controlled accounts for live tests. |
| BLOCK-007 | Backup/restore and persistence | No DB/container runtime. | Recovery behavior unknown. | Run dump/restore and restart tests on isolated project; never use existing volume. |
| BLOCK-008 | Repository baseline | No `.git` directory in project. | Cannot reliably produce diff or establish pre-existing versus new edits. | Preserve workspace; use external source control/baseline if available. |

No production data was used. Existing `.env` was not printed or edited in this task.
