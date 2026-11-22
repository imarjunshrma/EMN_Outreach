# v1.3 product-wide audit: progress log

Persistent record of the engineering audit (brief: "complete product-wide engineering audit, testing, bug fixing and production readiness"). Updated as each phase finishes, so work can resume after any interruption.

Environment for every run recorded here: Node 22, PostgreSQL 16 (`emn_test`, `emn_e2e`), Redis 7, self-hosted mode (`BILLING_ENABLED` unset). No real email, payment, DNS or AI provider was contacted: DNS is stubbed in tests, mail and AI providers use the test fakes.

## Status by phase

| Phase | Area | Status |
|---|---|---|
| 1 | Inventory | Done |
| 2 | Authentication and accounts | Covered by existing suites; re-run green |
| 3 | Multi-tenant isolation | Re-run green; new isolation cases for verification and the admin console |
| 4 | Frontend | New console screens built and browser-tested |
| 5 | Leads and import | Re-run green |
| 6 | Mailboxes | Done: 8 new tests (OAuth, settings, pause rules, reauth, diagnostic, disconnect, isolation) |
| 7 | Campaigns and engine | Re-run green (30 stale tests fixed) |
| 8 | Inbox and replies | Re-run green |
| 9 | AI | Re-run green |
| 10 | Workflows | Re-run green |
| 11 | Analytics | Re-run green |
| 12 | Billing | Re-run green |
| 13 | Platform admin (ERP console) | Done: backend, UI, 8 integration tests, browser walk-through |
| 14 | Integrations | Adapters tested against fakes; live verification open |
| 15 | Database and migrations | Repair migration added; drift check clean |
| 16 | Jobs and queues | Verification queue paths done; others covered by existing suites |
| 17 | Security | Done: dependency audit fixed, secrets scan clean (fake test tokens only), header/CSRF/auth baseline tests, OAuth CSRF fixed |
| 18 | Performance | One redundant query removed; no load test (open) |
| 19 | Deployment | Migrations verified from zero and on an existing database; real servers not checked |
| 20 | Testing and coverage | Done: 278/278, 18/18, lines 76.0% |
| 21 | Fix everything / final report | Done: `FINAL_AUDIT_REPORT.md` |

## Test results so far

| Run | Result |
|---|---|
| Vitest (unit + integration) | 30 files, 258 tests, all pass (before the verification suite below) |
| New verification suite | 8 of 8 pass |
| Playwright (browser) | 18 of 18 pass, including the new console walk-through |
| ESLint | 0 errors, 16 warnings (`any` types) |
| TypeScript | 0 errors |
| Coverage baseline (v8, backend + integrations + shared + worker + ai) | Lines 72.3%, statements 64.2%, branches 54.4%, functions 55.4% |

## Bugs found and fixed

| # | Severity | Area | Problem | Fix | Test |
|---|---|---|---|---|---|
| 1 | High | Compliance | A disposable-domain verification record had no expiry, so the send-time check ignored it; with "unknown: allow" a disposable address could be emailed | `enrichment.ts` stores the record with the workspace freshness window | `domains-enrichment.test.ts` |
| 2 | High | Database | Migration `20261121193000` was edited after it had been applied; existing databases lacked `hasHeader` and six other batch columns | Idempotent repair migration `20261122110000_email_verification_batch_repair` | Old and fresh databases compared equal after applying |
| 3 | High | Email verification | Processing a CSV row replaced its stored details, dropping the uploaded row; exports lost the customer's columns and every verification column shifted left | Source columns kept on complete, retrying, failed and manual-retry paths | `email-verification-flow.test.ts` |
| 4 | Medium | Email verification | Duplicate emails in one CSV kept the last occurrence instead of the first | First occurrence kept | same |
| 5 | Medium | Email verification | Exporting another workspace's batch returned 500 instead of 404 | `NotFound` error | same |
| 6 | Low | Email verification | One unused database query per verification; unused variables; control-character regex | Removed / rewritten as `isAsciiLocalPart` | lint + suites |
| 7 | — | Tests | 30 tests used a stale helper (VALID without a verification date) | Harness sets `emailVerifiedAt` | suites |
| 8 | Medium | Platform admin | Module and limit switches were ignored when billing is off | Admin overrides stored on the organization and applied in both modes, including `autoReply`, `waterfall` and API access | `platform-admin.test.ts` |
| 9 | High | Security (mailboxes) | OAuth callback trusted the `state` alone. A consent link started by one user could be finished by another signed-in user, attaching the second user's mailbox to the first user's workspace (OAuth login CSRF) | Callback requires the signed-in user to be the one who started it and to still have access to the workspace | `mailboxes.test.ts` |
| 10 | Medium | API | Any route with a malformed record ID (`/leads/abc`) answered 500 because the database rejected the value | Router answers 404 for malformed UUID path parameters, after authentication and access checks | `security-baseline.test.ts` |
| 11 | Medium | Dependencies | `npm audit` (production): Prisma CLI pulled `effect` 3.20.0 (ReDoS advisory); Next.js bundled `postcss` 8.4.31 (several advisories) | npm `overrides` to `effect` 3.22.5 and `postcss` 8.5.33 (same major versions); Prisma generate/validate and a full Next build verified | `npm audit --omit=dev`: 0 in both packages |

## Status

Audit complete on 22 November 2026. Open items are in `UNRESOLVED_ISSUES.md`.
