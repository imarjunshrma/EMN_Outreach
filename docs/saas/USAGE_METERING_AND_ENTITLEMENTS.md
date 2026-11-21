# Usage metering and entitlements

## Entitlements (`shared/src/plans.ts`)

Limits: `maxUsers`, `maxWorkspaces`, `maxMailboxes`, `maxActiveCampaigns`, `maxLeads`, `storageMb`, `apiRequestsPerMinute`.
Monthly allowances: `monthlyEmailSends`, `monthlyAiUsd`, `monthlyEnrichments`, `monthlyApiCalls`, `monthlyWorkflowRuns`.
Features: `copilot`, `workflows`, `autoReply`, `waterfall`, `apiAccess`, `agencyWorkspaces`. Integrations: allow-list or `*`.

Plans are rows in `Plan`; defaults (Starter, Growth, Agency) are seeded once and then edited in the platform console. No limit is hard-coded in the frontend; the pricing page and billing panel render what the API returns.

## Engine (`backend/src/services/entitlements.ts`)

`tenantState(organizationId)` returns `{ operational, reason, entitlements, source }`:

| Source | When |
|---|---|
| `unlimited` | Self-hosted mode (status still enforced) |
| `plan` | ACTIVE subscription — plan entitlements merged with per-tenant overrides |
| `trial` | TRIALING and not expired |
| `grace` | PAST_DUE within `graceUntil` |
| `none` | No subscription, expired trial/grace, or a non-operational organization status |

Checks: `assertOperational`, `assertFeature`, `assertQuota` (users, workspaces, mailboxes, activeCampaigns, leads — counted live), `assertMetered` (usage counter vs. allowance), `assertIntegration`. `ws.*` wrappers resolve the organization from a workspace. Errors: `QUOTA_EXCEEDED` (402), `SUBSCRIPTION_INACTIVE` (402), `TENANT_INACTIVE` (403), `AI_BUDGET_EXCEEDED` (402).

Where enforced: lead create/import/prospect import (leads), mailbox connect (mailboxes), campaign start (activeCampaigns, email verified), workspace create (workspaces + agency feature), invitations (users), workflows (feature + monthly runs), AI calls (AI USD), verification (enrichments), integrations (allow-list), API keys (per-minute + monthly), sending engine (operational + monthly sends). **Workers apply the same checks** because they call the same service functions, plus the tenant gate.

## Metering (`backend/src/services/usage.ts`)

`recordUsage({ organizationId | workspaceId, metric, quantity, key })` in one SQL transaction:

1. `INSERT INTO "UsageEvent" … ON CONFLICT (organizationId, idempotencyKey) DO NOTHING`
2. Only if a row was inserted: `INSERT INTO "UsageCounter" … ON CONFLICT (organizationId, metric, periodStart) DO UPDATE SET value = value + EXCLUDED.value`

So retries and concurrent duplicates count once (tested with 20 parallel calls).

| Metric | Counted when | Idempotency key |
|---|---|---|
| `email_sends` | Provider accepted the message (after `finalize`) | `send:<outboundId>` |
| `ai_requests`, `ai_tokens`, `ai_cost_micro_usd` | A model call returned | `ai:<executionId>` |
| `enrichments` | A verification result was stored, or a finder provider answered | `verify:<verificationId>`; finder calls are interactive (not retried) and each paid provider call is its own key `find:<provider>:<domain>:<name>:<time>` |
| `api_calls` | An API-key request reached a workspace route | `api:<requestId>` |
| `workflow_runs` | A non-test workflow run started | `wf:<runId>` |
| `storage_bytes` | **Not yet recorded** (adapter `usage()` exists) | — |

Periods are calendar months in UTC (`periodOf`). Annual plans still use monthly allowances; there is no annual pooling. **Overage policy:** hard stop — new work of that kind is refused or deferred until the next period or an upgrade; nothing is billed as overage. History: `GET /orgs/:id/usage` (current + 6 months).
