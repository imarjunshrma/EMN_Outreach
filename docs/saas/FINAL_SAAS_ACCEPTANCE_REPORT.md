# Final SaaS acceptance report — v1.4.0

- **Version / build:** 1.4.0, build `v1.4.0-20261121` (working tree on top of Mac commit `9013ca4`; uncommitted for your review)
- **Date:** 2026-11-21
- **Environment:** Linux build VM, 2 vCPU / 7 GB, PostgreSQL 16, Redis 7, Node 22, Google Chrome. No live or sandbox provider credentials.

## Verdict

**Not declared production-ready.** Code for every phase of the brief is complete and internally tested, and tenant isolation, auth and data handling pass their gates. Launch is blocked by items that need things outside this environment: live payment verification, staging infrastructure, provider credentials, an external penetration test and legal review. See the release gates below.

## Status levels

| Level | Meaning | Where v1.4 stands |
|---|---|---|
| Code-complete | Implemented, no stubs presented as real | All phases except HubSpot/Pipedrive connectors (documented as not built) |
| Test-complete | Covered by automated tests that pass | Yes — 179 integration/unit tests, 16 browser tests |
| Sandbox-verified | Tested against provider test environments | **No** — no credentials |
| Production-verified | Tested on production infrastructure | **No** |

## Architecture (summary)

Platform → Organization → Workspace. Express 5 API with five auth modes (public, user, workspace, org, platform); every workspace route resolves the tenant from the session and membership, never from the browser. Prisma/PostgreSQL with 40 tenant-guard triggers plus the new storage guard. BullMQ worker re-checks tenant status, applies fair-share slots and per-queue timeouts. Next.js 15 frontend: customer app, organization settings, platform console, public site and `/docs`. Details: `SAAS_TARGET_ARCHITECTURE.md`, `TENANT_ISOLATION_REPORT.md`.

## Features added in v1.4

- **Auth:** mandatory 2FA for platform staff (production cannot turn it off); staff cannot disable their own 2FA; platform user search with disable/enable that revokes sessions; support grants require 2FA; customer-visible support banner and support-access log.
- **Billing:** refunds (idempotent, staff-initiated, marked succeeded only by webhook), disputes (a lost dispute suspends the organization), out-of-order webhook protection, reconciliation every 6 hours, annual pooled allowances, one free trial per person, per-user organization cap.
- **Usage:** storage metered from real bytes with atomic enforcement and daily reconciliation.
- **Workers:** per-queue job timeouts, dead-letter logging, operations page with retry.
- **DNS:** list, edit (refused if the record changed meanwhile) and delete (typed confirmation) of zone records; NS/SOA protected; audited before/after.
- **Observability:** Prometheus `/metrics` (token-gated); `/readyz` no longer leaks errors.
- **Platform console:** trial conversion, payment failures, refunds/disputes, growth; user accounts; operations.
- **Website:** contact page; docs updated.
- **Scripts:** non-destructive restore drill; load test that refuses production-like URLs.

## Defects fixed

| Defect | Found by | Fix |
|---|---|---|
| Concurrent lead creation for the same company returned 409 | Load test | Retry company upsert on unique conflict; regression test added |
| DNS audit "before" value equalled "after" | Integration test | Snapshot before the provider call |
| `/readyz` exposed internal error text | Security review | Returns `ok`/`error` only; detail logged |
| SSE stream stayed open for organizations pending deletion | Review | Refused for DELETION_PENDING/DELETED |
| A second trial could be obtained with a new organization | Review | TrialGrant per normalized email; INCOMPLETE subscription when denied |
| Registration race could bypass `registrationOpen` | Review | Advisory lock and re-check |

## Security improvements

See `SECURITY_AUDIT_REPORT.md`. Highlights: staff MFA, session revocation on disable, support-grant MFA, idempotent refunds with permission `billing:refund` (FINANCE/SUPER_ADMIN only), metrics behind a token, storage trigger, DNS stale-edit protection, no error leakage on readiness.

## Database changes and migrations

One additive migration `20261121150000_v1_4_billing_storage_trials` and guard `prisma/sql/003_storage_guard.sql`. Full list in `CHANGED_FILES_AND_MIGRATIONS.md`. Applied to the dev database and to every fresh test database.

## Tests executed

| Suite | Environment | Command | Passed | Failed | Skipped | Blocked |
|---|---|---|---|---|---|---|
| Unit + integration (Vitest, 21 files) | Build VM, PG 16, Redis 7 | `npx vitest run` | 179 | 0 | 0 | 0 |
| Browser (Playwright, Chrome) | Build VM, fresh DB `emn_e2e_final*`, Redis db 9 | `E2E_DATABASE_URL=… E2E_REDIS_URL=… bash scripts/e2e.sh` | 16 | 0 | 0 | 0 |
| Lint | Build VM | `npm run lint` | 0 errors | — | 8 warnings | — |
| Type check backend / frontend | Build VM | `npx tsc --noEmit` (root and `frontend`) | OK | — | — | — |
| Backend build | Build VM | `npm run build` | OK | — | — | — |
| Frontend production build | Build VM | inside `scripts/e2e.sh` | OK | — | — | — |
| Live provider check | — | `npm run live-check` | — | — | — | All providers (no credentials) |

New v1.4 tests: `billing-v14.test.ts` (8: refunds, idempotency, disputes, out-of-order events, reconciliation, annual pooling, trial-once, org cap) and `ops-dns-v14.test.ts` (8: storage metering/enforcement/reconcile, job timeout, DNS list/edit/stale-edit/delete/NS protection, company race). Multi-tenant suite extended for staff MFA, user disable and support visibility.

## Browser tests

16 Playwright scenarios including sign-up, cross-organization URL denial, organization settings, platform console with staff 2FA, a crawl of every screen with seeded data and every tab (now including `/platform/users`, `/platform/operations`, `/contact`) and light/dark theme.

## Isolation results

Every one of the workspace routes answers 404 to another tenant (exhaustive sweep, part of the Vitest run); org and platform routes checked; DB triggers refuse cross-workspace references and mismatched storage rows. Details: `TENANT_ISOLATION_REPORT.md`.

## Provider testing

Mocked and fixture-tested only. No sandbox or live verification. See `PROVIDER_READINESS_MATRIX.md`.

## Performance results

Single node, build VM (2 vCPU / 7 GB), `LOAD_SECONDS=10 LOAD_CONCURRENCY=20 npx tsx scripts/load-test.ts` against a `NODE_ENV=production` API and a dedicated database. Milliseconds.

| Scenario | req/s | p50 | p95 | p99 | Errors |
|---|---|---|---|---|---|
| Session check | 356 | 53.9 | 81.8 | 97.5 | 0% |
| List leads | 161 | 121.2 | 164.1 | 199.3 | 0% |
| Search | 198 | 100.6 | 125.9 | 143.9 | 0% |
| Create lead | 149 | 134.2 | 166.5 | 181.0 | 0% (after the race fix) |
| Organization usage | 349 | 54.9 | 81.2 | 96.6 | 0% |
| Cross-tenant probe | 886 | 22.1 | 31.7 | — | all 404 (correct) |
| Webhook ingestion | 600/min/IP accepted | 18.2 | 27.3 | 32.0 | remainder 429 by design |
| Sign-in | — | 5.8 | 15.2 | — | 401/429 by design (limiter) |

These are development-VM numbers, not a capacity claim for production.

**Restore drill:** `SOURCE_DATABASE_URL=…/emn_dev bash scripts/restore-drill.sh` — 308 KB dump, 96 tables with identical row counts, migrations current, temporary database dropped.

**Scans:** `npm audit` backend 3 high (Prisma tooling → `effect`, build-time only; fix requires a major downgrade; accepted), frontend 1 high (postcss) + 1 moderate (next), build-time, fix requires Next 16; accepted. Secret scan of the tree: 0 findings.

## Release gates

| Gate | Scope | Status | Reason |
|---|---|---|---|
| A | Tenant isolation and data ownership | **PASS** | Exhaustive route sweep, DB triggers, browser denial test |
| B | Authentication, authorization, staff MFA, sessions | **PASS** | Tests for staff MFA, disable/revoke, support grants |
| C | Billing, usage and entitlements | **PARTIAL** | Fully tested with fakes/fixtures; live payments not verified |
| D | Reliability, deployment, backup/restore, observability | **PARTIAL** | Restore drill, timeouts, metrics verified in VM; no staging/production infrastructure verified |
| E | Live provider integrations | **BLOCKED** | No credentials for any provider |
| F | Security and compliance sign-off | **PARTIAL** | Internal audit done; no external penetration test, legal pages are drafts, accepted dependency advisories |

Gates C–F are not PASS, so the product is **not production-ready**.

## Remaining issues

See `UNRESOLVED_ISSUES.md`.

## Credentials required

Stripe and/or Razorpay (test then live), system SMTP, Google OAuth (with restricted-scope verification), Microsoft app registration, a Cloudflare token for a test zone, AI provider keys, Apollo/verifier/search keys.

## Manual actions

1. On the Mac: `bash scripts/mac-dev.sh start` (applies the v1.4 migration).
2. Enable 2FA on your platform account before opening `/platform`.
3. Review the uncommitted changes (`git status`, `git diff`) and commit them yourself.
4. Follow `PRODUCTION_LAUNCH_CHECKLIST.md`.

## Launch blockers

Live payment verification; transactional email; a staging deployment with backups and alerts; external penetration test; lawyer-reviewed legal pages.
