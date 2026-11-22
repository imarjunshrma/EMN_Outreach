# Complete test results — v1.3 product audit

Run on 22 November 2026 in a clean Linux container: Node 22, PostgreSQL 16, Redis 7, self-hosted mode (billing off). No real email, payment, DNS, OAuth or AI provider was contacted; providers are in-process fakes and DNS is stubbed.

## Summary

| Check | Command | Result |
|---|---|---|
| Unit + integration | `npx vitest run` | **278 passed, 0 failed** (33 files) |
| Browser (Playwright, Chrome) | `npm run test:e2e` | **18 passed, 0 failed** (5 spec files), fresh `emn_e2e` database migrated from zero |
| Type check (backend, shared, worker, integrations) | `npx tsc -p tsconfig.json --noEmit` | 0 errors |
| Type check (frontend) | `cd frontend && npx tsc --noEmit` | 0 errors |
| Lint | `npx eslint .` | 0 errors, 16 warnings (`any` types in older files) |
| Production build (frontend) | `next build` (inside the e2e script) | Pass |
| Dependency audit (production) | `npm audit --omit=dev` in root and `frontend` | 0 vulnerabilities in both |
| Migration drift | `prisma migrate diff` migrations → schema | No difference |

## Before and after this audit

| | Before | After |
|---|---|---|
| Unit + integration tests | 32 failing | 278, all passing |
| Browser tests | 18 | 18, all passing (the platform test now also walks the whole new console) |
| Lint errors | 4 | 0 |
| Production dependency advisories | 5 (4 high, 1 moderate) | 0 |
| Line coverage (server code) | 72.3% | 76.0% |

## Coverage (v8, server code: backend, integrations, shared, worker)

| Measure | Value |
|---|---|
| Lines | 76.0% (6,250 / 8,221) |
| Statements | 67.7% (7,467 / 11,037) |
| Branches | 57.2% (4,957 / 8,662) |
| Functions | 58.7% (1,335 / 2,273) |

Files changed in this audit: `platform-admin` service and routes 100%, `router.ts` 100%, `entitlements.ts` 89%, `verification-csv.ts` 89% (was 10%), `accounts.ts` 66% (was 39%), `first-party-verification.ts` 57% (was 18%; the uncovered part is SMTP probing, which needs a live mail server).

The frontend has no unit-test coverage measurement; it is exercised by the 18 browser tests, including a crawl of every page for console errors.

## Lowest-covered server files remaining

`outreach-brain.ts` 37%, `copilot.ts` 49%, Gmail and Microsoft adapters 50% (need live providers), `worker/processors.ts` 50%, billing gateways 58% (need live Stripe/Razorpay), `ops.ts` 60%. See `UNRESOLVED_ISSUES.md`.

## New test files in this audit

`platform-admin.test.ts` (8), `email-verification-flow.test.ts` (8), `mailboxes.test.ts` (8), `security-baseline.test.ts` (4), plus the extended platform console browser test.
