# Internal test matrix

## Existing suites and current execution status

| Area | Existing suite | Internal evidence covered by source | Current audit result |
|---|---|---|---|
| Auth / workspace isolation | `tests/integration/auth-isolation.test.ts` | Registration/login, roles, cross-workspace route checks | BLOCKED: PostgreSQL unavailable during Vitest global setup |
| AI / research | `tests/integration/ai-research.test.ts`, `personalization.test.ts` | fake AI and research adapters, schema and evidence paths | BLOCKED |
| Campaign engine | `tests/integration/campaign-engine.test.ts` | validation, approval, sending gates/idempotency | BLOCKED |
| Leads/import | `tests/integration/leads-import.test.ts` | import pipeline and deduplication | BLOCKED |
| Inbox/replies | `tests/integration/inbox-replies.test.ts` | sync dedupe, threading, classification, stop rules; new account/workspace mismatch regression | BLOCKED |
| CRM/analytics | `tests/integration/crm-insights.test.ts` | pipeline, forecast, reports, inbox operations | BLOCKED |
| Domains/enrichment | `tests/integration/domains-enrichment.test.ts` | fake provider flow and DNS behavior | BLOCKED |
| Workflows/billing | `tests/integration/workflows-billing.test.ts` | dry-run/versioning, webhook dedupe, entitlement paths | BLOCKED |
| Workers/ops | `tests/integration/workers-ops.test.ts` | queue/ops workflows | BLOCKED |
| Security | `tests/integration/security-v12.test.ts`, `tests/unit/security.test.ts` | crypto, MFA, keys, permissions, security helpers | selected unit suite PASS; integration NOT RUN |
| Email protocol/adapters | `tests/unit/adapters.test.ts`, `smtp-protocol.test.ts` | mocked HTTP adapters and in-process SMTP protocol | SMTP protocol and session suites excluded from this selected run |
| Shared business rules | `tests/unit/shared.test.ts` | prompts, compliance, scheduling, workflow helpers | Unit suite PASS in isolated run |
| Browser | `e2e/app.spec.ts`, Playwright config | UI workflows against local API and DB/Redis | BLOCKED |

## Required internal matrix

| Workflow / edge category | Test fixture/action | Expected assertion | Execution status |
|---|---|---|---|
| Account/workspace | two users/workspaces; register, invite, role-denied requests | owner only initializes first account; role checks and workspace boundary hold | BLOCKED; concurrent registration regression added |
| AI personalization | fake provider, sample business facts/evidence, generate/edit/approve | unsupported facts blocked; manual edit retained; approved hash stable | BLOCKED |
| Campaign | fake mailbox, internal leads, approve/schedule/worker send | only eligible content sends once; persisted event/state | BLOCKED |
| Reply | fake inbound raw MIME, repeated sync | unique message; reply updates lead and stops enrollment | BLOCKED |
| Suppression | unsubscribe then enroll/send | both operations refuse send | BLOCKED |
| CRM | create opportunity/task, update stage, query analytics | persisted values and calculations match fixture | BLOCKED |
| Workflow | event, branch, failing action, retry same dedupe key | no duplicate side effects; failure visible | BLOCKED |
| Billing | mocked signature, repeated event ID | one billing event and correct entitlements | BLOCKED |
| Tenant isolation | reads/writes/search/export with workspace B IDs in A session | 404/forbidden; no data mutation or disclosure | BLOCKED |
| Recovery | stop/restart worker/Redis/DB in disposable env | jobs resume safely; no duplicate outbound | BLOCKED |
| Generic edge cases | empty/missing/invalid/boundary/large/duplicate/concurrent/expired/session/provider timeout | validation or deterministic safe error; state unchanged on failure | BLOCKED |

## Current commands and actual results

- `SKIP_TEST_DB=1 npx vitest run tests/unit --exclude tests/unit/smtp-protocol.test.ts --exclude tests/unit/smtp-session.test.ts` — PASS, 88 tests in 10 files. The two excluded SMTP suites open local sockets and were not exercised in this restricted environment; this result covers only the selected unit suite.

- `npm test` — NOT RUN TO TESTS: global setup failed running Prisma migration because `127.0.0.1:5432` had no response. Vitest reported no test files after setup aborted.
- `npm run typecheck` — PASS.
- `npm run build` — PASS.
- Focused ESLint (`npx eslint backend/src worker/src shared/src integrations/src tests e2e`) — PASS, 0 errors and 16 `no-explicit-any` warnings. The whole-repository `npm run lint` is not represented by this focused result.
- `npx prisma validate` — PASS.
- Docker/Compose integration — BLOCKED (`docker` executable unavailable).

The 88 passing tests are only the selected pure unit subset. Database-backed suites and excluded socket-based SMTP suites are not represented as passing. Source assertions alone are not execution results.
