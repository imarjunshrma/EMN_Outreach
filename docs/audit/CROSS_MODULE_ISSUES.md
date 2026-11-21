# Cross-module issues

## Confirmed and corrected

### XMOD-001 — mailbox ingestion trusted caller workspace separately from account ID

`backend/src/services/inbox.ts::ingestMessages(workspaceId, accountId, messages)` previously selected the account by ID only and subsequently wrote mailbox-derived records using the supplied `workspaceId`. A mismatched worker/job payload could associate data across workspace context. The lookup now includes both identifiers and returns a workspace-neutral 404. Regression test added to `tests/integration/inbox-replies.test.ts`; execution is blocked by local PostgreSQL outage. See `FIX_LOG.md`.

### XMOD-002 — concurrent initial registration race

`backend/src/services/auth.ts::register()` previously checked the user count before entering its transaction. It now takes a transaction-scoped PostgreSQL advisory lock, rechecks the count and email uniqueness inside the transaction, and then creates the initial user/workspace/member. A concurrent registration regression test was added to `tests/integration/auth-isolation.test.ts`; it remains unexecuted because PostgreSQL is unavailable.

## Cross-module checks still required

| ID | Concern | Relevant modules | Required verification / status |
|---|---|---|---|
| XMOD-003 | Campaign sends and reply sync must share one consistent enrollment stop/idempotency model | `engine.ts`, `inbox.ts`, worker processors | Existing tests cover portions; full DB/worker recovery blocked |
| XMOD-004 | Analytics counters need reconciliation against persisted event records and retries | `analytics.ts`, `insights.ts`, EmailEvent, OutboundEmail | Fixture-based aggregate comparison not executed |
| XMOD-005 | Entitlement decisions must match UI and API; backend enforcement is present in billing/service routes but broad endpoint audit is pending | `billing.ts`, router, feature services | Exhaustive limit coverage blocked |
| XMOD-006 | Integration error responses and logs need systematic secret/PII review | `integrations/src/http.ts`, error handler, pino redaction | Source spot-check only; no redaction regression pass |
| XMOD-007 | Review Compose changes against README/example and validate role grants on a brand-new isolated DB | Compose, migration image/script, Postgres init | Docker unavailable; BLOCKED |

Do not infer these remaining items are defects solely from their audit status; they are unverified risk areas.
