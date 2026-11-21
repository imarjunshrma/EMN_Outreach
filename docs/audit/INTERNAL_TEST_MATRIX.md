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
| Security | `tests/integration/security-v12.test.ts`, `tests/unit/security.test.ts` | crypto, MFA, keys, permissions, security helpers | Unit security tests PASS in isolated run; integration BLOCKED |
| Email protocol/adapters | `tests/unit/adapters.test.ts`, `smtp-protocol.test.ts` | mocked HTTP adapters and in-process SMTP protocol | Adapter unit tests PASS; SMTP protocol suite not included in isolated run |
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

- `npm test` — NOT RUN TO TESTS: global setup failed running Prisma migration because `127.0.0.1:5432` had no response. Vitest reported no test files after setup aborted.
- Isolated adapter/shared/security unit suites — PASS, 38 tests in 3 files via a temporary config without DB global setup. The temporary config was removed; this does not verify database-backed logic.
- `npm run typecheck` — PASS.
- `npm run build` — PASS.
- `npm run lint` — PASS with 8 existing `no-explicit-any` warnings.
- `npx prisma validate` — PASS.
- Docker/Compose integration — BLOCKED (`docker` executable unavailable).

No test suite is represented as passing in this audit. Existing source test assertions are not execution results.
