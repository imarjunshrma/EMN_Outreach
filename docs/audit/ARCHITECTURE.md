# Actual architecture (source audit)

## Version and stack

The checkout identifies itself as **1.2.0** in `package.json`, `frontend/package.json`, and README. Backend is TypeScript/Express 5 on Node 22; frontend is Next.js 15 App Router with React 19; persistence is PostgreSQL through Prisma 7 and `@prisma/adapter-pg`; jobs use BullMQ 6 over Redis 7.

## Services and entry points

- API: `backend/src/main.ts` constructs `createApp()` from `backend/src/app.ts`, binds `API_HOST:API_PORT`, validates `backend/src/core/config.ts` and encryption keyring, and installs graceful shutdown.
- Worker: `worker/src/main.ts` registers BullMQ processors from `worker/src/processors.ts`, schedules periodic work, and closes workers/queues/Redis/DB on SIGTERM/SIGINT.
- Web: `frontend/app` contains App Router pages; `frontend/lib/api.ts` sends relative `/api/v1...` requests with same-origin cookies and CSRF header. `frontend/next.config.mjs` rewrites `/api/:path*` to `EMN_API_INTERNAL_URL` (host default localhost; Docker build arg internal API name). This rewrite is server-side.
- Composition root: `backend/src/core/container.ts` wires email, AI, lead, verifier, search, DNS, fetch and storage adapters; tests override them via `setAdapters()`.

## Request, auth, and authorization flow

Browser request → `frontend/lib/api.ts` → Next rewrite → Express middleware in `backend/src/app.ts` → `authenticate()` from `backend/src/http/middleware.ts` → declarative route in `backend/src/routes/*.ts` → `mountRoutes()` from `backend/src/http/router.ts` (rate limit, session/API key, workspace membership, role/scope, Zod body/query) → service in `backend/src/services/*.ts` → Prisma client in `backend/src/core/db.ts`. Cookie sessions use a random opaque token whose SHA-256 hash is stored in `Session`; CSRF uses a double-submit token and origin check in production. Workspace role and API key scope are enforced in route registry.

## Database and tenant model

`prisma/schema.prisma` declares PostgreSQL enums/models, UUID identities, foreign keys and workspace-owned rows. Most customer records carry `workspaceId` and relate to `Workspace`; migration SQL lives in `prisma/migrations`, and `prisma/sql/001_indexes_and_guards.sql` adds `pg_trgm`, indexes and an append-only audit trigger. `scripts/apply-sql.ts` runs post-Prisma SQL. Tenant isolation is primarily enforced in route resolution plus service queries scoped by workspace; this audit fixed one inconsistent mailbox ingestion lookup (see `FIX_LOG.md`). Static structure alone does not prove every query is tenant-safe.

## Queues and workers

Producers use `backend/src/core/queues.ts` (`enqueue`, BullMQ defaults: three attempts, exponential backoff, bounded completion/failure retention). Queue names: `scheduler` (`scheduler`), `prepare` (`outbound-prepare`), `send` (`send`), `replySend` (`reply-send`), `sync` (`mailbox-sync`), `ai` (`ai`), `research` (`research`), `imports` (`import`), `verify` (`verify`), `domain` (`domain-health`), `maintenance` (`maintenance`), `automation` (`automation`), `webhooks` (`webhooks`), `privacy` (`privacy`), `personalize` (`personalize`). Processors are registered in `worker/src/processors.ts`; periodic schedulers are upserted in `worker/src/main.ts`. Redis connection comes from `backend/src/core/redis.ts`. Worker is separate from API; no live queue or restart test ran in this environment.

## AI flow

Routes in `backend/src/routes/ai-studio.ts`, `assist.ts`, `intelligence.ts`, `outreach.ts` call services including `ai-studio.ts`, `ai.ts`, `personalization.ts`, `intelligence.ts`, `reply-assist.ts`, and `copilot.ts`. Prompt building/validation is in `shared/src/prompt-builder.ts`, `prompts.ts`, `ai-schemas.ts`, with untrusted-data handling in `integrations/src/ai/guard.ts`. `runAi()` resolves workspace provider/model config, decrypts stored credentials and calls `OpenAiAdapter` or `AnthropicAdapter`; workers process queued generation. Live provider behavior is not established.

## Mail send/receive flow

Campaign services in `backend/src/services/engine.ts` validate, approve/hash, schedule and enqueue outbound work. Worker processors prepare and send; adapters are Gmail, Graph and SMTP/IMAP under `integrations/src/email`. Send attempts use an atomic outbound state claim and provider-specific no-retry send calls, with reconciliation paths. Mailbox sync flows through `accounts.ts` and `inbox.ts`; message IDs are deduplicated per email account, conversations match references/provider threads, replies and bounces trigger campaign/CRM/compliance effects. Mock-backed integration coverage exists; provider live checks are explicitly outstanding.

## Storage and integrations

`backend/src/core/storage.ts` implements local disk and S3-compatible storage. Integrations use `integrations/src/http.ts` for timeout/retry/error behavior; providers are wired through `container.ts`. Integration credentials are stored through workspace integration/AI configuration and encrypted using the keyring in `backend/src/core/crypto.ts`.

## Deployment and test architecture

Compose: `docker-compose.yml`, API/worker image `deployment/docker/Dockerfile`, Next image `deployment/docker/Dockerfile.web`, migration image `deployment/docker/Dockerfile.migrate`, Postgres init script under `deployment/docker/postgres-init`. VPS deployment is a separate systemd/PM2 + Nginx path (`INSTALLATION.md`, `scripts/install.sh`, `scripts/deploy.sh`). Tests are Vitest unit/integration suites in `tests/`; their global setup applies migrations to a PostgreSQL test database. Playwright tests use `playwright.config.ts` and local API/web servers, PostgreSQL and Redis.

## Scope/evidence limit

This is source-derived architecture, not a runtime trace. Docker is absent and Postgres is unavailable in the current environment. End-to-end behaviors that depend on those services remain `BLOCKED`/`NOT TESTED`; see `FINAL_AUDIT_REPORT.md`.
