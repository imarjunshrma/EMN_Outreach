# Tenant isolation report — v1.4.0

Design: `TENANT_ISOLATION_DESIGN.md`. Data ownership per model: `TENANT_DATA_OWNERSHIP_MATRIX.md` (generated). Route-level controls: `API_TENANT_SECURITY_MATRIX.md` (generated, 328 operations).

## Result

| Layer | Mechanism | Evidence | Status |
|---|---|---|---|
| API (workspace) | Membership resolved per request; 404 to non-members | Sweep: all 262 workspace routes × all methods called by Tenant A with Tenant B's ids → 404 | PASS |
| API (organization) | `OrganizationMember` row required; billing/own permissions | Cross-org read/update/billing/deletion → 404; invited member → 403 on owner actions | PASS |
| API (platform) | Platform role + permission + 2FA | Tenant owners → 404; staff without 2FA → 403 MFA_REQUIRED; SUPPORT/FINANCE limits | PASS |
| API keys | Bound to one workspace; refused on user/org/platform routes | Key of B on A → 404; on org/platform → 401; on user routes → 403 | PASS |
| Database | 40 triggers / 72 relations; immutable workspace→organization; StoredObject org check; append-only platform audit | Cross-workspace `CampaignList` refused; workspace move refused; forged StoredObject refused; audit delete refused | PASS |
| Workers | Payloads carry workspace; handlers load `{ id, workspaceId }`; tenant gate; per-org fair-share slots; job timeouts | Suspended tenant's AI job skipped, compliance job runs; one tenant at slot limit delayed, other not; hung job cut off | PASS |
| Cache / Redis | Keys include organization or workspace; no tenant data cached | Code review of all key patterns | PASS (review) |
| Storage | `<workspaceId>/…` keys; prefix re-checked; per-org accounting | Download refuses foreign prefix; storage usage tenant-scoped | PASS |
| Billing | Webhook matched by provider ids/metadata; only the named tenant changes | Webhook for A leaves B untouched; refunds/disputes matched by payment id | PASS |
| Support access | Grant per organization, read-only, expiring, audited, customer-visible | Grant for A gives nothing on B; writes 403; expired → 404 | PASS |
| Live stream (SSE) | Membership + organization status | Deletion-pending organization → 403 | PASS |
| Row-level security | Not used (pooled connections without tenant context) | Documented decision; not claimed | N/A |

## Matrix of actors (direct API calls)

| Actor → resource | Same workspace | Same org, other workspace | Other organization |
|---|---|---|---|
| Workspace member | by role | 404 | 404 |
| Org owner/admin | yes | yes | 404 |
| Org MEMBER/BILLING (invited) | by workspace role | 404 | 404 |
| Removed member | 404 | 404 | 404 |
| Disabled user | 401 (all sessions revoked) | 401 | 401 |
| API key | by key role/scopes | 404 | 404 |
| Support staff with grant (2FA) | read-only, audited | read-only, audited | 404 |
| Support staff without grant or 2FA | 404 | 404 | 404 |
| Platform admin | console only; customer data only via grant | — | — |

Tests: `tests/integration/multi-tenant.test.ts`, `auth-isolation.test.ts`, `billing-v14.test.ts`, `ops-dns-v14.test.ts`, `e2e/saas.spec.ts`.
