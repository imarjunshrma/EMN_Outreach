# Existing architecture assessment (before v1.3)

Assessed on 2026-11-21 against the v1.2.0 code base, by reading the repository, `prisma/schema.prisma`, every route file, the worker, the frontend routes and running the test suites.

## Stack (verified, unchanged)

| Layer | Technology | Notes |
|---|---|---|
| API | Node 22, TypeScript (ESM), Express 5 | Routes declared through a typed registry (`backend/src/http/router.ts`) that also generates OpenAPI |
| Validation | Zod 4 | Bodies, queries and params |
| Database | PostgreSQL 16, Prisma 7.10 (adapter-pg, generated client in `backend/src/generated/prisma`) | Additive SQL migrations + `prisma/sql/*.sql` applied by `scripts/apply-sql.ts` |
| Queue | BullMQ on Redis | 15 queues, processors in `worker/src/processors.ts` |
| Frontend | Next.js 15 App Router, React 19, TanStack Query, Tailwind 3 | Client-rendered app; API reached through `/api` rewrite (dev) or Nginx (prod) |
| Tests | Vitest (unit + integration against a real Postgres/Redis), Playwright | Provider adapters replaced by fakes in tests only |

No reason was found to change any of these. PostgreSQL + Prisma + Redis remain.

## Tenancy before v1.3

The only tenant boundary was the **workspace**. A user could create any number of workspaces (`POST /workspaces`), each completely independent, with `WorkspaceMember` rows granting roles. There was no organization, so:

- Billing (`Subscription`, `Invoice`) hung off a workspace; an agency with ten clients would have needed ten subscriptions.
- No tenant owner, tenant status or lifecycle existed; suspension meant editing a subscription row.
- "Platform admin" was a boolean `User.isPlatformAdmin` with `/admin/*` routes that returned 403 (revealing their existence) to others.
- No usage ledger: AI spend was computed from `AiExecution`, API calls from a Redis counter per workspace.
- Entitlement checks used `billing.assertEntitled(workspaceId, …)` with limits per workspace.

What was already sound and was kept:

- **78 of 84 models carried `workspaceId`**, and services consistently filtered by the workspace from the request context, never from the body. Integration tests (`tests/integration/auth-isolation.test.ts`) already proved cross-workspace reads and writes failed.
- Membership resolution on every workspace request; 404 for non-members.
- Credentials encrypted (AES-256-GCM, key ring with rotation) and never returned.
- Signed outbound webhooks, signature-verified inbound webhooks with event dedupe.
- CSRF, CSP, rate limits, audit log per workspace.

The 6 models without `workspaceId`: `User`, `Session`, `Workspace`, `AiModelPrice`, `Plan`, `BillingEvent` (platform-level by nature).

## Redis usage (all reviewed)

| Key pattern | Purpose | Tenant context |
|---|---|---|
| `events:<workspaceId>` (pub/sub) | Realtime notifications | Workspace id |
| `lock:pz:<campaignId>:<leadId>:<stepId>`, `lock:token:<accountId>` | Mutual exclusion | Ids are UUIDs of workspace-owned rows (globally unique) |
| `oauth:state:<state>` | OAuth state (stores workspace id inside) | Random, single-use |
| `totp:<userId>:<counter>` | TOTP replay guard | User |
| `rl:<method>:<path>:<ip|userId|workspaceId>` | Route rate limits | Per caller |
| API-key throughput counter (v1.2) | Per workspace | **Replaced** by `rl:tenant:<organizationId>:api:<minute>` in v1.3 so limits apply to the paying tenant |
| BullMQ `emn:<queue>:*` | Jobs; payload carries `workspaceId` | In payload |

No cached business data was found in Redis (no analytics or search caches), so there was no cross-tenant cache-collision risk beyond the rate-limit key change.

## Gaps against the SaaS brief

| Area | Gap | Resolution in v1.3 |
|---|---|---|
| Hierarchy | No organization | `Organization` model; every workspace belongs to exactly one (NOT NULL, immutable) |
| Roles | No tenant-level roles | `OrganizationMember` with OWNER / ADMIN / BILLING / MEMBER |
| Status | None | 8 statuses with a transition table and history |
| DB constraints | Cross-workspace FK references possible if code were wrong | 40 triggers (`emn_same_workspace`) guarding 72 relations |
| Provisioning | Not transactional; no idempotency | `provisionTenant` in one transaction with a registration key |
| Registration | No terms, no email verification | Sign-up with terms + version, verification tokens |
| Plans | Seeded in code | DB-managed via platform console; defaults only seeded once |
| Usage | Derived counts only | `UsageEvent` (idempotent) + `UsageCounter` (atomic) per organization and month |
| Workers | No re-check of tenant state | Tenant gate + per-tenant fair-share slots |
| Platform admin | Boolean flag, discoverable routes | Platform roles + permissions, 404 to tenants, audited support grants |
| Public website / docs | None (root redirected to login) | Marketing site, pricing from DB, `/docs` with generated API reference |

## Row-level security

RLS was evaluated and **not adopted**. Prisma uses a pooled connection without a per-transaction `SET LOCAL app.tenant`; wiring tenant context into every query would require wrapping every request in an interactive transaction, and background jobs plus raw SQL paths would bypass or break it. Policies that the application role bypasses would give false assurance, which the brief explicitly forbids claiming. Isolation is instead enforced by request-level membership resolution, scoped queries, database triggers and tests — see `TENANT_ISOLATION_DESIGN.md`.
