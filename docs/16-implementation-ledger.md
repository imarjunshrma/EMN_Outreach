# 16 — Implementation ledger against the master implementation prompt (v1.2.0)

This ledger tracks every section of the "Master implementation prompt" (sections 1–30) against what this codebase actually does. The **Evidence** column names the test that proves each claim.

Status key:
- ✅ **Done**: implemented and covered by automated tests. External services are replaced by fakes in those tests.
- 🟡 **Partial**: part of the requirement is built; the cell says which part.
- ❌ **Not started**.
- 🔑 **Needs credentials or live verification**: the code exists and is tested with fakes or protocol-level servers, but has **not** been run against the real service. `npm run live-check` (doc 18) is the harness for that.

Nothing is marked done because it compiles or because a mock test passes for a live integration.

Test suites referenced below:
- `tests/integration/*.test.ts` and `tests/unit/*.test.ts` run with Vitest: 134 tests in 17 files.
- `e2e/app.spec.ts` runs with Playwright in a real Chrome against the real API and the built frontend: 7 tests.

v1.1 audit findings, with fixes and their evidence: doc 17.

## 1. Existing project & infrastructure decisions
| Item | Status | Evidence / notes |
|---|---|---|
| Audit of existing code before changes | ✅ | doc 17 (v1.1 audit, defects A1–A5 fixed with tests) |
| PostgreSQL vs MySQL | ✅ decision | Keep PostgreSQL. Reasons (unchanged): `pg_trgm`, partial indexes, JSONB, arrays, transactional DDL, trigger-enforced audit log |
| Safe migrations | ✅ | `20261121090000_v1_2_…` is additive: 69 statements, no DROP or type change. Verified three ways: from scratch, on the existing dev DB, and on a v1.1 DB with data (doc 18 §Migration) |
| Docker support | 🟡 | `docker compose config` validates and the new env vars pass through `env_file`. `.dockerignore` excludes e2e and live-check artefacts. **Images not built here** because Docker Hub is blocked in the build environment. VPS (systemd/PM2) install unchanged |
| S3-compatible storage | ✅ mocked client · 🔑 | `tests/unit/security.test.ts` (S3Storage section); live put/get/delete via `npm run live-check` (S3 section) |
| Existing EMN Google Workspace not modified | ✅ | Nothing touches it |

## 2–3. Multi-tenant SaaS
| Item | Status | Evidence / notes |
|---|---|---|
| Workspace isolation, invitations, RBAC (5 roles), audit, export, retention | ✅ | `auth-isolation.test.ts`; new modules repeat the isolation checks (Copilot threads, workflows cross-tenant refs, webhook payload leadId, saved filters) |
| API-key scopes (finer than role) | ✅ | `security-v12.test.ts` › API key scopes; UI on the API keys page |
| Subscription plans, quotas (users, mailboxes, running campaigns, AI allowance, API calls, features) | ✅ code · 🔑 gateways | `workflows-billing.test.ts` › billing (4 tests). Enforced server-side. Self-hosted default = unlimited |
| Granular custom roles | ❌ | Fixed role ladder plus key scopes |
| Full workspace deletion flow | 🟡 | Contact-level erasure only |

## 4. Domain & mailbox manager
| Item | Status | Evidence / notes |
|---|---|---|
| SPF/DKIM/DMARC/MX checks, history | ✅ | existing |
| Ownership verification (TXT), propagation across 3 public resolvers, recommended records per provider, renewal tracking with weekly reminders | ✅ | `domains-enrichment.test.ts` › domain manager (2 tests); domain detail UI |
| Cloudflare DNS: create one record on explicit confirmation; refuses foreign names, placeholders and a second SPF | ✅ fake · 🔑 | same test; live token check in live-check (read-only) |
| GoDaddy / Namecheap / Primeforge / Maildoso / Icemail | ❌ (registry says so) | `shared/src/provider-registry.ts` marks them *unreviewed*; shown on Mailbox health. No API was invented |
| Gmail / Graph send + sync, SMTP/IMAP | ✅ code · 🔑 | SMTP protocol verified against an in-process SMTP server (`smtp-protocol.test.ts`, incl. 4xx/5xx/auth mapping). IMAP, Gmail and Graph still need live accounts (live-check) |
| Mailbox health view (status, auth, sync, last sent/received, sent today vs limit, 30-day bounce/complaints, domain, last error) | ✅ | `/mailbox-health` page; e2e screen test |
| No rotation, no warm-up networks | ✅ by design | |

## 5–6. Outreach engine & campaign builder
| Item | Status | Evidence / notes |
|---|---|---|
| Duplication, scheduling, approval, versioning, test emails, idempotent sends, reconciliation | ✅ | v1.1 tests (`campaign-engine.test.ts`) |
| Campaign folders and tags (do not affect approval) | ✅ | `crm-insights.test.ts` › saved filters / folders |
| Conditional branches beyond opened / not opened | 🟡 | Use the workflow builder (doc 18) for event-driven branching |
| Holiday calendar | ❌ | |

## 7–8. AI Personalization Studio
| Item | Status | Evidence |
|---|---|---|
| All v1.1 items (knowledge, instructions, hierarchy, prompt library, per-lead engine, fact-check, approval-safe sending) | ✅ | Re-verified by the audit in doc 17 across frontend, backend, DB and worker. Fixes: batch GENERATING retry (A2), cost limit on edit fact-check (A3), personalize.single jobId (A4) |

## 9. AI Copilot
| Item | Status | Evidence / notes |
|---|---|---|
| Ask about workspace data (bounded snapshot of real data), threads per user, business memory, repetitive-wording check | ✅ | `assist-copilot.test.ts` › copilot |
| Proposed actions (allow-listed types), role-checked confirmation, atomic run-once, no sending or starting campaigns | ✅ | same; schema rejects other action types |
| Copilot UI | ✅ | `/copilot`; e2e screen test |

## 10. AI research agent — unchanged from v1.1 (✅ code · 🔑 search key)

## 11–12. Lead finder & enrichment
| Item | Status | Evidence |
|---|---|---|
| Verification waterfall (MillionVerifier → ZeroBounce → NeverBounce, configurable order), skip recently verified, disposable-domain list, per-step history and credits, provider comparison | ✅ fake · 🔑 | `domains-enrichment.test.ts` › verification waterfall |
| Email finder (Hunter) | ✅ fake · 🔑 | same |
| Lookalikes, technographics | ❌ | |

## 13–14. Inbox & AI reply management
| Item | Status | Evidence |
|---|---|---|
| Star, archive (default hidden), forward from the original mailbox (suppression enforced), saved filters | ✅ | `crm-insights.test.ts` › inbox |
| Permission modes: suggest / **draft for approval (default)** / narrow auto (approved template only, allow-listed categories, once per conversation) | ✅ | `assist-copilot.test.ts` › reply modes (4 tests); e2e checks the default |
| Pricing, commitment, unsubscribe, complaint and OOO replies never auto-sent; commitment language flagged | ✅ | same |
| Reply templates with manager approval; editing withdraws approval | ✅ | same + e2e |

## 15. Workflow automation — visual builder
| Item | Status | Evidence |
|---|---|---|
| Builder: triggers, AND conditions, nested if/else (depth 4), 12 actions, drag and arrow reordering | ✅ | `/workflows/[id]`; e2e builds a branched workflow |
| Versions + restore, activate/deactivate, test mode (dry run), execution log per block | ✅ | `workflows-billing.test.ts` › branches / dry-run / versioning; e2e |
| Run once per event (dedupe), daily run limit, retries via BullMQ, failure notifications | ✅ | same |
| Scheduled (daily) and inbound-webhook triggers (per-workflow token, tenant-safe payload) | ✅ | same › inbound webhook |
| Safety: resume only an unchanged, approved, not-safety-paused campaign; webhooks to public URLs only | ✅ | same |

## 16. CRM
| Item | Status | Evidence |
|---|---|---|
| Weighted forecast (editable stage probabilities), expected close by month, won by month, win rate | ✅ | `crm-insights.test.ts` › forecast |
| CSV export (opportunities, campaigns) with formula-injection guard | ✅ | same |

## 17. Analytics & reports
| Item | Status | Evidence |
|---|---|---|
| Scheduled email reports (daily / weekly Monday), member recipients only, failure recorded | ✅ · 🔑 system SMTP | `crm-insights.test.ts` › reports |
| Custom dashboards, revenue attribution beyond campaign→opportunity | ❌ | |

## 18. Deliverability intelligence — 🟡 (unchanged; no blocklist or placement measurement, never claimed)

## 19. Compliance & privacy — ✅ (unchanged)

## 20. Integrations & developer platform
| Item | Status |
|---|---|
| New: ZeroBounce, NeverBounce, Hunter, Cloudflare, Stripe, Razorpay, Slack incoming webhooks, inbound workflow webhooks, API-key scopes | ✅ code · 🔑 |
| Google Calendar, CRM sync (HubSpot etc.) | ❌ |

## 21. Notifications
| Item | Status | Evidence |
|---|---|---|
| In-app (existing) plus Slack and email channels with event filters; webhook URL encrypted and never returned; failures recorded; queued fan-out | ✅ · 🔑 Slack/SMTP | `crm-insights.test.ts` › Slack channel |

## 22. Security
| Item | Status | Evidence |
|---|---|---|
| TOTP 2FA (RFC 6238 vectors, replay guard, encrypted secret, single-use hashed recovery codes), MFA login challenge | ✅ | `security-v12.test.ts`; e2e enables 2FA and signs in with a real TOTP |
| Workspace "require 2FA" policy | ✅ | `security-v12.test.ts` › policy; UI redirects to setup |
| Email password reset (same answer for unknown accounts, 1 h single-use token, revokes sessions) | ✅ · 🔑 system SMTP | `security-v12.test.ts`; e2e |
| Billing webhook signatures (Stripe t/v1 HMAC with 5-minute tolerance, Razorpay HMAC), idempotent events | ✅ | `workflows-billing.test.ts` |
| Settings edits cannot wipe server-managed secrets (regression found during this work) | ✅ | `workflows-billing.test.ts` › inbound webhook (regression lines) |
| Email verification of new accounts | ❌ | Accounts are created by the owner or invitation |

## 23. Files — 🟡 (unchanged)

## 24. Billing
| Item | Status | Evidence |
|---|---|---|
| Plans as data (Starter, Growth, Agency), trials, PAST_DUE with 7-day grace, cancel at period end, invoices | ✅ | `workflows-billing.test.ts` |
| Stripe Checkout + portal; Razorpay subscription links | ✅ code · 🔑 | Written against the public APIs. **Not exercised against live accounts** |
| Platform-admin override (plan, status, trial) | ✅ | same + `/admin` page |
| Taxes / GST invoices, proration UI | ❌ | Handled by the gateway dashboards |

## 25. UI
| Item | Status | Evidence |
|---|---|---|
| Screens for every v1.2 module, wired into one navigation, billing banner, 2FA redirect | ✅ | e2e › every v1.2 screen renders without errors (17 screens) |
| Dark theme (light / dark / system, no flash, persisted) | ✅ | e2e › dark theme |
| Accessibility audit | ❌ | |

## 26. Workers & reliability — ✅ (new jobs: workflow.run/daily, ai.replyAssist, domain.renewals, reports.daily, channel.notify, reply.forward; started and scheduled in smoke test)

## 27. Testing
| Item | Status |
|---|---|
| Unit / integration / API / permission / isolation / migration tests | ✅ 134 tests |
| Browser tests (Playwright, real Chrome, real API + built UI) | ✅ 7 tests, run twice with no flakes |
| Live provider tests | 🔑 Harness `npm run live-check` exists, needs real accounts (doc 18). **Not run here** |

## 28. Deployment — ✅ / 🟡 (VPS unchanged; doc 18 has v1.2 upgrade steps; Docker images not built here)

## 29–30. Delivery & audit — this file plus doc 17 and doc 18.
