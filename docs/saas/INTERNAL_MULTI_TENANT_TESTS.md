# Internal multi-tenant tests

All tests run against a real local PostgreSQL 16 and Redis 7 (`emn_test`, Redis DB 15 for Vitest; `emn_e2e`, DB 14 for Playwright). External providers (email, AI, DNS, verification, payments) are replaced by in-process fakes or signed fixtures — **no real email, payment, DNS change or provider call is made**, and none of these tests counts as live provider verification.

## Test tenants (`tests/integration/multi-tenant.test.ts`)

Each test starts from an empty database and creates, through the real `POST /auth/signup` endpoint:

| Tenant | Owner | Purpose |
|---|---|---|
| Platform staff | `root@emn.test` (SUPER_ADMIN, created first so no customer becomes staff) + SUPPORT and FINANCE where needed | Console, grants |
| A — Alpha Corp | `owner@alpha.test` | Ordinary business |
| B — Beta Ltd | `owner@beta.test` | Separate business, attacker in isolation tests |
| C — Gamma Agency | `owner@agency.test` | Agency plan with two client workspaces |

## Required flows

| # | Flow | Evidence |
|---|---|---|
| 1 | Tenant registration | multi-tenant › provisioning (terms required, duplicate email 409, closed registration 403); e2e saas › sign-up |
| 2 | Tenant provisioning | provisioning › one org/owner/workspace each; concurrent provisioning with one key → one tenant; retried sign-up → same tenant |
| 3 | Workspace creation | agency › agency plan allows client workspaces, starter refuses (402); e2e › organization settings |
| 4 | User invitations | isolation › invitation gives MEMBER of one workspace only; email verification gate |
| 5 | Role permissions | isolation › invited member cannot manage org, billing or deletion (403); auth-isolation › minimum roles; platform › SUPPORT cannot run lifecycle |
| 6 | Subscription assignment | workflows-billing › trial on start, override by platform only; agency › trial per plan |
| 7 | Plan entitlement checks | workflows-billing › quota + feature gates; platform › plan edit changes entitlements live |
| 8 | Usage metering | usage › idempotent under 20 concurrent duplicates, per tenant, per period |
| 9 | Lead creation | isolation and lifecycle tests create leads through the API |
| 10 | Campaign creation | campaign-engine suite (workspace-scoped); DB trigger test links campaigns/lists |
| 11 | AI personalization | personalization + ai-research suites (fake AI adapter) |
| 12 | Mailbox configuration (mocks) | campaign-engine / inbox-replies / workers-ops suites (fake Gmail, Graph, SMTP) |
| 13 | DNS operations (mocks) | domains-enrichment suite (fake Cloudflare + resolvers) |
| 14 | CRM | crm-insights suite |
| 15 | Workflow automation | workflows-billing suite |
| 16 | Billing webhooks (fixtures) | workflows-billing (Stripe/Razorpay signatures, dedupe, grace, invoices); multi-tenant › webhook activates only the named tenant |
| 17 | Tenant suspension | lifecycle › platform suspension (read-only, billing/export open, worker skips); e2e › platform console suspends |
| 18 | Tenant reactivation | lifecycle › reactivate; e2e › reactivate |
| 19 | Tenant deletion | lifecycle › name confirmation, grace, cancel, purge only after due date, other tenant intact, audit survives |

## Critical isolation tests

| Requirement | Evidence |
|---|---|
| A cannot read B leads | isolation › 404 on B workspace, B lead id in own workspace 404, list excludes |
| A cannot update B campaigns | auth-isolation › campaign by foreign id 404; exhaustive route sweep |
| A cannot access B mailbox credentials | Sweep covers `email-accounts` routes (404); credentials are never serialized |
| A cannot access B DNS credentials | Sweep covers `integrations` and `domains` routes |
| A cannot access B AI knowledge | Sweep covers `ai-studio`, `ai`, prompt routes |
| A cannot access B files | Sweep covers attachment and privacy-export downloads; storage keys checked against the workspace prefix |
| A cannot access B billing | `/orgs/<B>/billing` → 404; `/w/<B>/billing` → 404 |
| A cannot access B analytics | Sweep covers analytics and reports routes |
| A cannot access B background jobs | Sweep covers `jobs` routes; job handlers load with `{ id, workspaceId }`; tenant gate test |
| A cannot use B API keys | API key bound to its workspace; 404 on other workspaces, 401 on org/platform routes |
| Changing ids does not bypass | **Every one of the 262 workspace routes** called by A with B's workspace id (and random sub-ids, all methods) returns 404 |
| Workspace switching cannot grant access | e2e › customer opening another org's workspace URL sees "not found"; org route 404 |
| Suspended tenants cannot continue restricted operations | API 403 TENANT_INACTIVE on writes; worker skips AI/research/etc.; e2e confirms in browser |
| Expired subscriptions enforce policy | workflows-billing › expired trial → SUBSCRIPTION_INACTIVE; grace expiry → inactive |
| DB refuses cross-tenant references | isolation › trigger rejects CampaignList across workspaces; workspace cannot move organization; platform audit cannot be deleted |
| Fair use | fair use › one tenant at its slot limit is delayed; another tenant is not |

## Results (this build, 2026-11-21)

| Suite | Result |
|---|---|
| Vitest (unit + integration) | 19 files, 160 tests, all passing (includes 4 tests from the parallel hardening pass merged from the Mac copy) |
| Playwright (browser, real API + production build) | 16 tests, all passing — includes 6 new SaaS tests (website, docs, sign-up/onboarding, cross-tenant URL, organization settings, platform console) |
| ESLint | 0 errors |
| TypeScript (backend, frontend) | 0 errors |

Run: `npm test`, `npm run test:e2e` (needs Postgres, Redis and Chrome).
