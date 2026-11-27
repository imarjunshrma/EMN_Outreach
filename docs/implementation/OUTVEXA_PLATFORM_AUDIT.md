# Outvexa platform audit

Internal engineering audit of the Outvexa platform, run on 27 November 2026 against the working tree at commit `9169b2d` plus the uncommitted Knowledge Importer extension present at the time (17 files, about 400 changed lines). Every result below comes from a command that was executed in an isolated local environment. No live external service was called, no email was sent and no development or production database was touched.

## 1. Platform architecture overview

| Layer | Implementation | Size (first-party) |
| --- | --- | --- |
| API | Express with a declarative route registry (`backend/src/http/router.ts`): one definition drives wiring, validation, authorization, rate limiting and the OpenAPI document. 472 routes: 352 workspace, 50 platform, 38 user, 20 organization and 12 public. | 13 route files, 1,186 lines |
| Business logic | Services in `backend/src/services` (campaign engine, inbox, leads, research, personalization, AI routing, Knowledge Importer, billing, tenancy, platform administration, warm-up). | 59 files, 16,534 lines |
| Core | Database, Redis, queues, encryption, audit, tenant lifecycle and configuration in `backend/src/core`; HTTP middleware in `backend/src/http`. | 20 files, 1,457 lines |
| Workers | BullMQ processors and schedulers in `worker/src` (25 queues, 20 scheduled jobs). | 2 files, 391 lines |
| Integrations | Email providers, AI providers, payment gateways, research fetcher and email verification in `integrations/src`. | 24 files, 2,985 lines |
| Shared | Schemas, prompts, permissions and tenancy rules in `shared/src`. | 23 files, 2,227 lines |
| Frontend | Next.js 15 application with React Query. | 169 files, 12,109 lines |
| Data | PostgreSQL 16 with pgvector, trigram and unaccent; Prisma 7.10.1; 39 migrations plus repository SQL. | — |

Tenancy runs organization → workspaces → members. Workspace access is resolved server-side on every request, from a workspace membership, the owner or admin role in the workspace's organization, or an audited, read-only support grant. A workspace ID in a URL is never proof of access.

## 2. Modules inspected

Authentication and sessions; authorization and tenancy; the route registry; API keys; impersonation; billing and payment webhooks; entitlements; the campaign send engine; suppression and compliance; inbox and replies; lead import and export; research and personalization; the AI provider routing and prompt registry; the Knowledge Importer, including the uncommitted extension; queues, workers and maintenance jobs; outbound webhooks and workflows; data export; logging; and the frontend API client and export downloads.

## 3. Source files inspected and method

The review combined systematic, repository-wide checks with line-by-line reading of the highest-risk code.

- **Repository-wide.** Every first-party TypeScript file passed type checking and ESLint (including the React hooks rules). Every database call that looks up or changes a record by bare `id` without a workspace filter (329 sites) was listed, and the 23 inside workspace-scoped functions that take a caller-supplied ID were traced individually. Every route handler that queries the database with a request ID was checked. Every queue, producer, consumer, concurrency setting and scheduler was inventoried. Every query of a large table without `take` was listed. Every outbound `fetch` was traced to its address check. Every log call that could carry a secret was checked.
- **Read line by line:** `router.ts`, `middleware.ts`, `impersonation.ts`, billing webhooks and both payment gateways, the send engine's pre-send gates and claim, `canContact`, personalization claim validation, the Copilot knowledge snapshot, `ensurePrompt`, `validateBaseUrl` and `assertPublicUrl`, webhook and workflow delivery, workspace and organization export, lead import processing and retry, the fair-slot gate in the worker, and the uncommitted Knowledge Importer changes (`knowledge-import-apply.ts` and related files).
- **Not read line by line:** most of the 169 frontend files and the long tail of service functions. Those are covered by type checking, lint, the 488 unit and integration tests, and the browser crawl, which opens every screen with real data and fails on any page or console error. The limits of this are recorded in section 20.

## 4. Important findings

Seven defects were reproduced, root-caused and fixed, each with a regression test or harness scenario that failed before the fix. One suspected defect was disproved and recorded as such. The browser test harness had three configuration defects that hid five failing scenarios. One of them deleted keys from Redis DB 0, which is the development database on a developer's machine.

## 5. Bugs identified

| # | Priority | Defect |
| --- | --- | --- |
| 1 | P1 | A payment webhook whose processing failed was recorded as handled. The provider's retry was answered "duplicate" and the event was lost, which could leave a paid subscription inactive or miss a failed payment. |
| 2 | P1 | During a Redis outage, every rate-limited route (65 routes, including login and sign-up) waited forever instead of answering. |
| 3 | P1 | On an instance with open sign-up, a tenant could configure a custom AI endpoint on `localhost` or a private network, making the server send requests to internal services (SSRF). |
| 4 | P1 | A lead CSV import whose worker died stayed RUNNING forever. Retry refused it ("still pending or running"), and no sweep recovered it. |
| 5 | P2 | The lead import lock lasted 15 minutes and was never renewed, so an import running longer could be processed twice by a redelivered job. |
| 6 | P2 | Concurrent first AI calls in a workspace raced while seeding the default prompt. 7 of 8 failed (a unique-constraint error, or a false "No active prompt" configuration error). |
| 7 | P2 | Workspace and organization exports loaded the whole tenant into API memory: +572 MiB RSS for 100,000 leads and 20,000 messages, plus another full copy on send. |
| 8 | P2 (test infra) | `scripts/e2e.sh` did not export `E2E_DATABASE_URL` or `E2E_REDIS_URL`. Three specs failed; the login-limiter reset fell back to Redis DB 0; and the login limit then failed four more specs. |
| — | Disproved | Webhook delivery following redirects past the address check. It already uses `redirect: 'error'`; a regression test now locks this in. |

## 6. Root causes

1. `billing.handleWebhook` inserted the de-duplication row before processing and never removed it on failure.
2. `mountRoutes` awaited the Redis rate-limit decision without a bound. The Redis client queues commands while reconnecting (`maxRetriesPerRequest: null`), so the promise never settles during an outage. Only the importer upload had a timeout.
3. `validateBaseUrl` allowed local and private HTTP endpoints for Ollama and custom providers regardless of deployment mode.
4. The import job runs with `attempts: 1`. A stalled redelivery cannot take the dead worker's lock, so it returns and BullMQ records success. Nothing else ever revisits RUNNING imports.
5. A fixed lock TTL with no renewal.
6. `ensurePrompt` did read-check-insert without atomicity, and its "user deactivated everything" check counted a row a concurrent caller had just inserted.
7. `findMany` without batching on every tenant table, followed by `res.json` of the whole object.
8. The environment variables were computed but not exported, the helper had no defaults, and `new Redis(undefined)` connects to DB 0.

## 7. Fixes implemented

1. Processing failures now release the event row (`billing.ts`), so the provider's retry is applied. A genuine duplicate after success is still ignored.
2. All rate-limit checks are bounded at 2 s and fail closed with `503 RATE_LIMIT_UNAVAILABLE` (`router.ts`). The importer keeps its own code. Failing closed keeps brute-force protection on login.
3. While sign-up is open, custom AI endpoints must pass `assertPublicUrl` (DNS-resolved, public, standard port) in `ai.ts`. Private installs keep local models. `AI_ALLOW_PRIVATE_ENDPOINTS=true` is an explicit operator opt-in, set only for the local test fixtures.
4. `acquireLock` gains optional renewal (`redis.ts`). Lead imports hold a 2-minute lock renewed every 30 s (`leads.ts`). The new `recoverInterruptedLeadImports` sweep, scheduled every minute (`worker/src/main.ts`, `processors.ts`), marks RUNNING imports with no live lock as FAILED and audits `import.interrupted`. The existing retry finishes them, skipping leads already imported.
5. Covered by fix 4's renewable lock.
6. `ensurePrompt` seeds with `createMany({ skipDuplicates: true })`, then re-reads the active prompt.
7. `writeWorkspaceExport` and `streamJsonDownload` (`ops.ts`) stream each table in id-ordered batches of 1,000, with back-pressure. A failure mid-stream aborts the response rather than sending a truncated file. The same JSON keys and order are kept; `workspaceExport` remains for compatibility.
8. `e2e.sh` exports both URLs, the helpers default to the same isolated stores as `playwright.config.ts`, and the flush uses the configured URL.

No migration was added; `prisma/` is unchanged.

## 8. Security findings

- **Tenant isolation.** No exploitable IDOR was found. All 23 caller-ID lookups in workspace functions validate the ID with a workspace-scoped query first, or receive it from such a query. Route-level database calls with request IDs are confined to platform-staff routes. API keys are bound to their workspace and hashed, compared in constant time, and checked for revocation and expiry. They cannot reach user, organization or platform routes.
- **Sessions.** CSRF uses a double-submit token on every unsafe request, plus an origin check in production. Sessions expire on a rolling basis.
- **Impersonation.** Staff cannot impersonate staff, cannot nest impersonation, and are limited to members of the target tenant. Sessions are time-limited and every write is audited. Personal security settings are blocked while impersonating.
- **Billing webhooks.** HMAC with constant-time comparison and a 5-minute Stripe replay window; an empty secret is rejected. Delivery is idempotent, and stale events cannot roll subscription state back.
- **SSRF.** Webhooks and workflow webhooks check the address and refuse redirects. The research fetcher checks addresses and handles redirects manually. Custom AI endpoints were fixed (finding 3). The checks resolve DNS before the request, so DNS rebinding between check and connect remains theoretically possible (section 20).
- **Secrets.** Logging uses pino redaction plus `scrubSecrets`, and no secret was found in log calls. Credentials are encrypted at rest with a rotating keyring.
- **Dependencies.** `npm audit --omit=dev` reports 0 vulnerabilities. The full audit reports one high in `xlsx`, which is now a development-only dependency used by tests and scripts.

## 9. Database findings

The schema has workspace-aware foreign keys and unique constraints on idempotency keys (`BillingEvent(provider,eventId)`, email event `dedupeKey`, `PromptTemplate(workspaceId,task,version)`, the importer's live-file SHA-256). A fresh database takes all 39 migrations plus repository SQL, and `prisma migrate status` reports it up to date. The only differences between the database and the Prisma schema are pre-existing raw-SQL indexes and defaults that Prisma cannot express (recorded in the Knowledge Importer report). `ImportJob` has no `updatedAt`, so import liveness is now tracked through the renewed lock rather than a timestamp.

## 10. Queue and worker findings

The platform has 25 queues with explicit concurrency (for example: send, prepare, sync and ai at 4; research and knowledge-import at 2; imports, scheduler and warm-up at 1) and 20 schedulers.

- **What's in place.** Per-tenant fair slots are keyed by organization *and* queue, so queues cannot take each other's slots. Jobs for inactive tenants are skipped. Every queue has a timeout. Workers force-exit 60 s after SIGTERM. Reconcilers exist for importer jobs, stuck sends (`SENDING` older than 3 minutes) and, now, lead imports.
- **Verified with a real Redis kill:** HTTP admission (section 15).
- **Verified under concurrent load:** lead-import and knowledge-import isolation in both directions.
- **Verified with a real worker SIGKILL:** lead imports, plus 22 importer stage scenarios.
- **Remaining:** fair slots expire after 10 minutes, so a single job running longer than that (an importer extraction can run up to 3 hours) frees its slot early. That weakens per-tenant fairness slightly but does not affect correctness (P3).

## 11. AI system findings

- **Routing and trust.** Routing resolves per workspace and task, with an explicit fallback flag on each candidate. Prompts wrap untrusted content.
- **Personalization.** The server filters model-cited claim IDs down to the claims actually given to the writer, and drops unsupported facts and inferences.
- **Copilot.** It reads only named knowledge fields plus approved services and proof, never unverified case studies or achievements. The text builder for knowledge also excludes unverified entries.
- **Importer extension.** The uncommitted change writes achievements and proof into the knowledge configuration with `verified: false`; those consumers exclude them, so the trust boundary holds. Invalid new-entity data becomes NEEDS_REVIEW during inspection, approval re-inspects reviewer edits, and application converts destination changes into per-record failures. No defect was found in the extension.
- **Fixed:** the prompt-seeding race (6) and the endpoint SSRF (3).

## 12. Frontend findings

The API client shows server messages for JSON and non-JSON errors, redirects on 401 and routes MFA-required responses. Both export downloads remain compatible with streaming: the organization download reads a blob, so an aborted stream becomes an error toast. The browser crawl opens every screen and tab with real data and fails on any page or console error, and it passes. Lint (including the React hooks rules) shows no warnings in frontend code. No frontend defect was found beyond the test-harness configuration.

## 13. Performance findings

| Measurement | Result |
| --- | --- |
| Workspace export, 100,000 leads and 20,000 messages (113 MiB JSON) | Before: RSS 166 → 738 MiB, plus a second copy on send. After streaming: peak 423–503 MiB, bounded by batch size rather than tenant size. |
| Knowledge-import full pipeline (3 tenants, 9 files) | Review in 6.0 s, 6.3 s total, 0 failed deliveries, peak RSS 441 MiB. |
| Queue isolation, knowledge backlog then leads | First lead import waited 6 ms and finished 2.8 s before the knowledge backlog. |
| Queue isolation, 45,000-row lead backlog then knowledge | The knowledge import reached review in 153 ms. |
| Rate-limited request during a Redis outage | 503 in 2.0 s (previously no response). |
| Lead CSV import throughput | 115–200 rows/s. Identical 15,000-row files took 74, 100 and 131 s as the workspace grew, consistent with per-row duplicate checks. Recorded, not changed (section 20). |

## 14. Test coverage matrix

| Area | Unit | Integration and API | Queue and recovery harness | Browser |
| --- | --- | --- | --- | --- |
| Auth, sessions, 2FA, password reset | ✓ | ✓ | HTTP outage (login) | ✓ |
| Tenancy, roles, cross-tenant access | ✓ | ✓ (multi-tenant, importer resilience) | — | ✓ (cross-organization URL) |
| Billing, entitlements, webhooks | — | ✓ (billing-v14, workflows-billing, webhook retry) | — | — |
| Campaign engine, suppression, sending safety | ✓ | ✓ (campaign-engine and others) | — | ✓ (activity, reconciliation) |
| Lead import and export | — | ✓ (lead recovery, workspace export) | Crash recovery, queue isolation | ✓ (CSV import) |
| Research and personalization | ✓ | ✓ | — | ✓ (crawl) |
| AI routing, prompts, outbound URLs | ✓ | ✓ (prompt seeding, URL safety) | — | ✓ (personal AI) |
| Knowledge Importer | ✓ | ✓ (workflow, AI, retrieval, resilience) | 22-stage matrix, load, Redis outage | ✓ (2 scenarios) |
| Platform administration and impersonation | — | ✓ | — | ✓ (super admin, platform console) |
| Warm-up | ✓ | ✓ | — | ✓ |

## 15. Complete test results

| Suite | Baseline (unmodified tree) | Final |
| --- | --- | --- |
| Vitest | 61 files, 478 passed, 0 failed, 0 skipped (373 s) | 66 files, 488 passed, 0 failed, 0 skipped, in two consecutive full runs (373 s and 334 s) |
| Recovery harness, default | — | Passed: parse kill before and after the checkpoint, application kill, Redis outage during submission (1,507 ms) |
| Recovery harness, `--stage-matrix` | — | 22 scenarios applied exactly once, plus load with 0 failed deliveries |
| Recovery harness, `--http-outage` (new) | Login gave no response within 15 s | Upload 503 in 1.5 s, login 503 in 2.0 s, an unlimited route kept working, both recovered |
| Recovery harness, `--queue-isolation` (new) | — | Passed in both directions, 0 failed deliveries |
| Recovery harness, `--lead-import-crash` (new) | Still RUNNING 90 s after the kill | FAILED after 122 s, then the retry completed with exactly 20,000 leads |

## 16. Browser acceptance results

| Suite | Baseline | Final |
| --- | --- | --- |
| `npm run test:e2e` (main) | 17 passed, 5 failed, 2 skipped, 3 not run | 25 passed, 2 skipped (both final runs) |
| `playwright.knowledge-import.config.ts` | 2 passed | 2 passed |

The two skips are the Knowledge Importer specs, which run only under their own config (above). The five baseline failures were all harness configuration (finding 8), not product defects.

## 17. Build and type-check results

| Command | Baseline | Final |
| --- | --- | --- |
| `npm run typecheck` | Passed | Passed |
| `npm --prefix frontend run typecheck` | Passed | Passed |
| `npm run build` | Passed | Passed |
| Frontend `next build` | Compiled | Compiled |
| `npx eslint .` | 0 errors, 12 warnings | 0 errors, 12 warnings |

## 18. Dependency audit

`npm audit --omit=dev` reports 0 vulnerabilities. `npm audit` reports 1 high in `xlsx` (SheetJS 0.18.5, GHSA-4r6h-8v6p-xvw6 and GHSA-5pgg-2g8v-p4x9). It is a devDependency used only by tests and scripts to build fixture workbooks; production code reads and writes XLSX with `read-excel-file` and the in-repo `jszip` writer. No fixed release exists on npm.

## 19. Remaining warnings

- **ESLint, 12 × `no-explicit-any`:** `backend/src/http/router.ts` lines 56, 64, 72, 201 and 215 (two each) and `backend/src/http/openapi.ts` line 17 (two). These are the type erasure the heterogeneous route registry needs; `unknown` is rejected because handler parameters are contravariant. Intentional.
- **Next.js build:** a notice about multiple lockfiles (root and frontend) and the Next ESLint plugin not being detected. Informational; it does not affect the build.

## 20. Remaining limitations

- Not every frontend file and long-tail service function was read line by line. Coverage there rests on type checking, lint, 488 tests and the browser crawl.
- DNS rebinding between the address check and the connection is not prevented for webhooks, research and custom endpoints. That would require pinning the resolved address in the HTTP agent.
- Lead CSV throughput slows as a workspace grows. It is measured but unchanged, because a batched duplicate check is a behavior-sensitive change to import semantics.
- A PENDING lead import whose queue job was lost (Redis without persistence) has no reconciler. Production Compose uses AOF, and the retry path does not cover PENDING.
- Fair slots expire after 10 minutes for long jobs (P3).
- Live third-party services were deliberately not called: AI providers, payment gateways, Gmail, Microsoft and SMTP are verified only through contract tests, in-process gateways and loopback fixtures. The live provider smoke for the Knowledge Importer still needs a non-production OpenAI key (see `OUTREACH_BRAIN_IMPORTER_PROGRESS.md`).
- Load figures come from a single host. They are not a capacity statement.

## 21. Production configuration requirements

- Deploy the API and worker together. The worker adds the `lead-import-recovery` scheduler (every 60 s) on the maintenance queue.
- Rate-limited routes now answer `503 RATE_LIMIT_UNAVAILABLE` within 2 s when Redis is unreachable. Alert on Redis availability; keep AOF and a persistent volume.
- On instances with open sign-up, custom AI endpoints must be public HTTPS addresses. Set `AI_ALLOW_PRIVATE_ENDPOINTS=true` only if every tenant is trusted with access to the host's network.
- Exports stream: proxies must allow long-running chunked downloads, without buffering limits that would cut them short.
- For browser tests, `npm run test:e2e` now exports `E2E_DATABASE_URL` and `E2E_REDIS_URL`; overrides must point to throwaway stores.

## 22. Exact commands executed

Isolated stores: PostgreSQL `emn_test` (Vitest), `emn_e2e` (browser), `outvexa_knowledge_import_acceptance` (importer browser test and harness), and `outvexa_audit_migrate` (migrations). Redis: DB 15 (Vitest), 14 (browser), 13 (importer browser test), and a disposable `redis-server` on a random port for every harness mode.

```bash
npx vitest run                                    # baseline: 478 passed; final: 488 passed (twice)
npm run typecheck && npm --prefix frontend run typecheck
npx eslint .
npm run build && (cd frontend && NEXT_DIST_DIR=.next-verify npx next build)
npm audit --omit=dev && npm audit
CHROME_PATH=/usr/bin/google-chrome bash scripts/e2e.sh --reporter=list
CHROME_PATH=/usr/bin/google-chrome npx playwright test --config playwright.knowledge-import.config.ts
# harness, with DATABASE_URL=postgresql://emn:emn@127.0.0.1:5432/outvexa_knowledge_import_acceptance EMN_ENV_FILE=/dev/null
node --import tsx scripts/knowledge-import-recovery-smoke.ts
node --import tsx scripts/knowledge-import-recovery-smoke.ts --stage-matrix
node --import tsx scripts/knowledge-import-recovery-smoke.ts --http-outage
node --import tsx scripts/knowledge-import-recovery-smoke.ts --queue-isolation
node --import tsx scripts/knowledge-import-recovery-smoke.ts --lead-import-crash
DATABASE_URL=…/outvexa_audit_migrate npm run db:migrate && npx prisma migrate status
```

Each fix was first run against the unfixed code, and the failure observed is the "before" result in sections 5 and 15.

## 23. Files changed

**Product code (10 files):**

| File | Change |
| --- | --- |
| `backend/src/services/billing.ts` | Release webhook events whose processing failed (fix 1). |
| `backend/src/http/router.ts` | Bounded rate-limit checks for every route (fix 2). |
| `backend/src/services/ai.ts` | Public-endpoint rule in SaaS mode (fix 3); atomic prompt seeding (fix 6). |
| `backend/src/core/redis.ts` | Optional lock renewal (fixes 4 and 5). |
| `backend/src/services/leads.ts` | Renewed import lock and `recoverInterruptedLeadImports` (fixes 4 and 5). |
| `worker/src/processors.ts`, `worker/src/main.ts` | Lead-import recovery handler and scheduler (fix 4). |
| `backend/src/services/ops.ts`, `backend/src/routes/core.ts`, `backend/src/routes/saas.ts` | Streamed exports (fix 7). |

**Test infrastructure (4 files):** `scripts/e2e.sh` and `e2e/helpers.ts` (fix 8); `playwright.knowledge-import.config.ts` (private-endpoint opt-in for the loopback fixture); `scripts/knowledge-import-recovery-smoke.ts` (new `--http-outage`, `--queue-isolation` and `--lead-import-crash` modes, a latency control on the fixture provider, and the fixture opt-in).

**New tests (5 files):** `tests/integration/billing-webhook-retry.test.ts`, `ai-prompt-seeding.test.ts`, `outbound-url-safety.test.ts`, `workspace-export.test.ts` and `lead-import-recovery.test.ts`.

**Documentation:** this report.

The 17 files with uncommitted Knowledge Importer changes were reviewed but not modified.

## Verdict

**Internally verified, with the limitations in section 20.** Every P0 and P1 defect found was fixed and verified against real failures in isolated infrastructure. Authentication, authorization and workspace isolation passed both review and tests, workers recover from kills and Redis outages, and all suites, builds and type checks pass on the final code. This is not a claim of complete correctness: the review was systematic rather than line by line across every file, and third-party services were verified only through internal contracts.
