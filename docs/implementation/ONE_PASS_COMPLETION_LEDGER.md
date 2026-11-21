# One-pass completion ledger

Updated: 2026-11-21. Source counts were recalculated from the current checkout. Git metadata is absent, so branch status and attribution of preexisting edits cannot be verified.

## Status key

- **Implemented:** source behavior exists, but that alone is not verification.
- **Tested:** evidence is recorded in `TESTING_AND_VERIFICATION.md`.
- **In progress:** fixes are being validated against isolated local services.
- **Blocked:** infrastructure or provider access is unavailable.
- **Not started:** no complete review has been performed.

## Progress

| Module | Status | Evidence / remaining work |
|---|---|---|
| Authentication and users | Tested | 9 auth/isolation tests passed; first-owner lock decoding fixed. Separate email verification flow is absent; only selected browser flows were exercised. |
| Workspaces, membership, API keys | Tested | Three-tenant isolation and API-key scope checks run in integration suite; verify support/ownership operations and all resource families. |
| Tenant model / RLS | Blocked | Current model has Workspace but no Tenant model or RLS policies. Preserve the concurrent SaaS model decision; do not add a competing schema. |
| Leads and imports | Tested | Full integration suite passed; endpoint-level coverage across all filters/exports and property-specific isolation remains. |
| Discovery and enrichment | Implemented | Mock adapters and integration fixtures exist; live providers not connected. Verify cost/limit accounting and all provider error cases. |
| Campaigns and sequences | Tested | Integration suite and E2E passed core flows; sending-window/queue recovery remain. No external email sent. |
| Mailboxes and email | Implemented | Mock provider integrations; mailbox setup/live OAuth and real mailbox sync remain unverified. SMTP local unit tests pass using a local test server. |
| AI personalization | Implemented | Mock providers and evidence checks exist; live provider behavior and all unsupported-claim paths remain unverified. |
| Unified inbox | Implemented | Integration coverage present; full provider sync and live thread behavior remain unverified. |
| CRM and activities | Implemented | Integration coverage present; complete API matrix and UI action verification remain. |
| Automation and queues | In progress | Integration tests and worker boot/drain pass on isolated Redis; outage, delayed retry and process-restart recovery remain. |
| DNS and domains | Implemented | Mock Cloudflare tests; live DNS mutation deliberately not performed. Update/delete operations are unsupported. |
| Analytics and reporting | Implemented | Integration coverage exists; aggregate reconciliation and scheduled report runtime remain. |
| Billing and entitlements | Implemented | Deterministic gateway tests/integration tests; no payment credentials or live payment actions. |
| Frontend/API integration | Tested | Frontend build and 10 E2E tests passed; 65 page files counted, but per-action coverage for every page remains incomplete. |
| Runtime/deployment | Partially tested | Fresh PostgreSQL 18.3/Redis 8.4 migration, role and tests passed locally; Compose target versions and Docker remain unavailable. Temporary PostgreSQL/Redis processes are stopped; PostgreSQL test data remains under the isolated directory. |
| Documentation | Implemented | Architecture, provider, database, deployment, test-environment and API verification docs added/updated. |

## Current source counts

- 296 HTTP endpoints: 284 declarative and 12 directly mounted, including health/readiness and OpenAPI.
- 65 frontend `page.tsx` files.
- 84 Prisma models, 44 enums, 4 migration directories.
- 15 queues and 17 test files.
- No direct `Tenant` model or PostgreSQL RLS policy found in schema/migrations.

## Immediate next actions

1. Final typecheck/build/lint/Prisma checks passed after source and initializer changes.
2. Stop only the temporary PostgreSQL/Redis processes created for this pass; retain the isolated data directory. Do not touch other local services.
3. Coordinate the Tenant/RLS decision with the parallel SaaS transformation.
4. Continue endpoint-by-endpoint contract/security coverage; current aggregate tests are not 296 route certifications.
5. Complete Docker Compose health/restart/volume checks when Docker Desktop is available.
