# Outvexa

Self-hosted AI outreach and email-management platform for Elite Media Networks. It finds and imports
leads, researches them from public sources with cited evidence, writes fact-checked emails with Claude
or OpenAI, sends them from your own Google Workspace / Microsoft 365 / SMTP mailboxes with a
compliance-gated sending engine, syncs replies into a unified inbox, classifies them, and tracks
everything through a small built-in CRM.

Runs on one Linux VPS: **Node.js 22 + PostgreSQL + Redis + Nginx**, managed by **systemd** (or PM2).
Docker/Compose files are included as an optional alternative. Files are stored on local disk or any
S3-compatible bucket behind one storage adapter.

> Status: **version 1.4.0 — production hardening** (staff 2FA, refunds and disputes, storage metering, trial controls, DNS editing, job timeouts, metrics, restore drill; not yet declared production-ready — see the release gates in `docs/saas/FINAL_SAAS_ACCEPTANCE_REPORT.md`). Earlier: 1.3.0 — multi-tenant SaaS: organizations above workspaces, sign-up with onboarding, plans and usage metering, per-organization billing, a platform console, a public website and a `/docs` documentation site. Read `docs/saas/FINAL_SAAS_ACCEPTANCE_REPORT.md` first. Earlier: 1.2.0 (Copilot, reply permission modes, 2FA, workflow builder, billing, dark theme — see `docs/16-implementation-ledger.md`, `docs/18-v1.2-operations.md`). Earlier: 1.1.0 (AI Studio & individual personalization — see `docs/15-ai-personalization.md`,
> the Instantly comparison in `docs/14-instantly-parity-audit.md` and the full status ledger in
> `docs/16-implementation-ledger.md`). Everything listed under "Implemented" runs end to end against real
> PostgreSQL and Redis in the test suite, with **fake** external providers. No external
> integration (Gmail, Microsoft Graph, OpenAI, Anthropic, Apollo, MillionVerifier, Brave,
> Serper, Smartlead) has been exercised against its live service from this build — each needs your
> credentials and a live smoke test first. See "What needs real credentials" below.

## Repository layout

| Path | Contents |
|---|---|
| `backend/` | Express 5 + TypeScript API: route registry (validation, RBAC, rate limits, OpenAPI), services |
| `worker/` | BullMQ worker: sending, mailbox sync, AI, research, imports, verification, schedules |
| `frontend/` | Next.js 15 (App Router) + Tailwind basic UI — 47 routes |
| `integrations/` | Provider adapters: Gmail, Microsoft Graph, SMTP/IMAP, OpenAI, Anthropic, Apollo, MillionVerifier, Brave, Serper, Smartlead, safe web fetcher, DNS checks |
| `shared/` | Code shared by API, worker and UI: templates, schedules, compliance rules, AI schemas, prompts, permissions |
| `prisma/` | Prisma 7 schema (≈50 models), migrations, SQL guards (indexes + append-only audit trigger), seed |
| `tests/` | Vitest unit + integration tests (real Postgres/Redis, fake providers) |
| `deployment/` | Nginx site, systemd units, PM2 ecosystem, logrotate, Postgres roles, Redis settings, Dockerfiles |
| `scripts/` | `install.sh`, `deploy.sh`, `backup.sh`, `restore.sh`, `healthcheck.sh`, admin/keys/OpenAPI generators |
| `docs/` | Architecture docs 00–16 (incl. Instantly audit, personalization design, implementation ledger) + `openapi.json` |

## Implemented

* **AI Studio (new in 1.1)** – versioned business knowledge (+ reference documents), global writing
  instructions with a large instruction editor, research instructions, models & budgets (per-task model,
  fallback, token limits, workspace monthly budget, max cost per lead), and a prompt library (variables,
  conditionals, versions + compare, folders, tags, team approval, import/export, test on a lead).
* **Individual personalization (new in 1.1)** – every recipient gets an email built from their own
  evidence-backed research, following the hierarchy workspace → profile → campaign → ICP → step → variant →
  prospect; independent fact-check + 10 quality checks + explained score; follow-ups that know earlier steps;
  manual edits preserved; bulk generation with estimates and cost caps; only approved content is ever sent,
  and approved campaigns keep a frozen AI configuration.

* **Accounts & workspaces** – first-run setup, login (argon2id), sessions + CSRF, invitations, 5 roles,
  workspace isolation (non-members get 404), workspace-scoped API keys, password change, session list.
* **Leads & companies** – CRUD, search/filter, bulk actions, lists, notes, status history, CSV import with
  column mapping/preview/dedupe, CSV export with spreadsheet-formula guard, lead source + lawful basis per lead.
* **Prospecting** – ICP builder (manual or AI from text), Apollo search + import via adapter, saved searches.
* **Verification** – MillionVerifier adapter (configurable), results stored per lead; INVALID leads are never sent to.
* **Research** – safe public-web fetcher (blocks private IPs, odd ports, respects robots.txt, no login walls, no
  LinkedIn scraping), optional web search (Brave / Serper), evidence → claims with exact-quote validation, lead scoring against ICP.
* **AI writing** – evidence-backed email generation (only SUPPORTED claims allowed), subject lines, follow-ups,
  independent fact-check that blocks approval, prompt versioning, per-task model routing with fallback,
  monthly budgets, cost + token logging (cost marked as estimate when a model has no price row).
* **Campaigns** – sequence builder (steps, delays, conditions, A/B variants), sender assignment, sending
  windows in recipient time zone, daily limits, minimum spacing, review & approval with content hash
  (any edit requires re-approval), per-email review mode, start/pause/resume/stop, results.
* **Sending engine** – idempotent send with crash reconciliation, all gates re-checked at send time,
  auto-pause on bounce rate / complaints, RFC 8058 one-click unsubscribe + List-Unsubscribe headers,
  fixed sender per lead (no rotation), reply/bounce/opt-out stop the sequence.
* **Mailboxes** – Google Workspace (Gmail API, OAuth + PKCE), Microsoft 365 (Graph, OAuth + PKCE, delta sync,
  optional change notifications), SMTP + IMAP; encrypted tokens; NEEDS_REAUTH handling.
* **Inbox** – thread matching, bounce (DSN) and auto-reply detection, AI reply classification (11 categories)
  with deterministic effects (opt-out → suppression, complaint → suppression + alert, interested → status + notification, OOO → resume), replies
  from the original mailbox, AI reply drafts (never auto-sent), conversation summaries.
* **CRM** – pipeline (opportunities by stage), tasks with reminders, notes, timeline.
* **Automation** – rule-based automations (trigger → conditions → actions), outgoing signed webhooks with retries, booking webhook (Cal.com / Calendly / generic HMAC).
* **Deliverability** – domain SPF/DKIM/DMARC/MX checks with history, mailbox health, bounce/complaint tracking.
* **Compliance** – country rules (US, UK, EU/EEA, CA, AU, IN, default-deny for unknown), suppression list
  (email/domain), privacy export & erasure requests, retention job, append-only audit log.
* **Ops** – dashboard, analytics, AI usage & cost, job monitor (queue counts, retry), error log, notifications, SSE realtime.
* **Tracking** – open/click tracking **off by default**; when enabled, results are labelled as estimates.

## SaaS mode (v1.3)

| Setting | Effect |
|---|---|
| `BILLING_ENABLED=true` | Plans, trials, Stripe/Razorpay billing, limits enforced |
| `REGISTRATION_OPEN` | `true`/`false`; empty = open in SaaS mode, invite-only otherwise |
| `REQUIRE_EMAIL_VERIFICATION` | Force verification in self-hosted mode too |
| `BILLING_GRACE_DAYS`, `TENANT_DELETION_GRACE_DAYS`, `TENANT_JOB_SLOTS` | Grace periods and per-tenant worker fair share |

- Public website at `/`, pricing at `/pricing`, documentation at `/docs` (guides in `frontend/content/docs/*.md`; the API reference is generated from `frontend/content/openapi.json`, refreshed by `npm run openapi`).
- Customers: `/signup` → `/onboarding/<org>` → `/w/<workspace>`; organization settings at `/org/<org>`.
- EMN staff: `/platform` (needs a platform role; the first user is SUPER_ADMIN).
- Reports: `docs/saas/` (17 documents). Regenerate the API security and data-ownership matrices with `npm run saas:matrices`.

## Quick start (development)

```bash
# prerequisites: Node 22, PostgreSQL 15+, Redis 7+
cp .env.example .env              # set DATABASE_URL, REDIS_URL, APP_URL=http://localhost:3000, NODE_ENV=development
npm run gen-keys >> .env          # then remove the duplicate CHANGE_ME lines
npm install                       # also runs prisma generate
npm run db:migrate && npm run db:seed
npm --prefix frontend install
npm run dev:api & npm run dev:worker & npm --prefix frontend run dev
# open http://localhost:3000/setup to create the owner account
```

Production install on a VPS: see **[INSTALLATION.md](INSTALLATION.md)**.

## Checks

```bash
npm run typecheck && npm run lint && npm test     # tests need a Postgres DB "emn_test" and Redis
npm run build && npm run build:frontend
npm run openapi && npm run api-docs              # regenerate docs/openapi.json and API_DOCUMENTATION.md
```

```bash
npm run test:e2e        # Playwright browser tests (real Chrome, real API + built UI; set CHROME_PATH)
LIVE_CHECK=1 npm run live-check   # opt-in checks against REAL provider accounts (docs/18)
```

Results of the 1.2.0 build:
- Prisma schema valid; migrations applied from scratch, on the existing database, and on a populated v1.1 database.
- Typecheck clean; lint 0 errors (8 pre-existing `no-explicit-any` warnings).
- **134 unit and integration tests passing** (17 files).
- **7 Playwright browser tests passing** (twice).
- Backend, worker and frontend builds succeed. The compiled API and worker were smoke-tested (health, readiness, public webhooks, schedule registration).
- The live-check harness ran without credentials: every provider was skipped, so **no live provider verification has been done**. See `docs/18-v1.2-operations.md` §6 for what still needs credentials.

## What needs real credentials or approval

| Integration | What you must do | Notes |
|---|---|---|
| Google Workspace (Gmail API) | Create an OAuth client in Google Cloud; add redirect URI | `gmail.modify` is a **restricted** scope. An app marked **Internal** in your own Workspace tenant needs no verification; an **External** app needs Google verification + a security assessment before other organisations' mailboxes can connect. |
| Microsoft 365 (Graph) | Register an Entra ID app with `Mail.ReadWrite`, `Mail.Send`, `offline_access`, `User.Read` | Tenants may require admin consent; publisher verification recommended. Graph change notifications need a public HTTPS `APP_URL` (`GRAPH_WEBHOOKS_ENABLED=true`); polling always runs as a backstop. |
| SMTP / IMAP | Host, port, username, app password | Only where the provider allows SMTP for your use; crash reconciliation requires the provider to keep a Sent-folder copy. |
| OpenAI / Anthropic | API keys in AI Settings | Model names/prices are editable; seed prices are a starting point — verify against current price lists. |
| Apollo | API key (plan with API access) | Search path is configurable (default `/api/v1/mixed_people/api_search`); Apollo's API and terms change — verify. |
| MillionVerifier | API key | Uses credits per check. |
| Brave Search / Serper | API key | Optional; research works from the company website without it. |
| Smartlead | API key | Optional export of eligible leads only; the built-in engine is the default sender. |
| Booking (Cal.com / Calendly / other) | Shared secret | Point the scheduler's webhook at `/api/v1/hooks/booking/<workspaceId>`. |

## Known limitations (by design or by provider)

* Spam-complaint feedback loops are **not available** for mailbox-based sending (Gmail/Graph don't expose them per sender); complaint auto-pause only reacts to complaints you record or that arrive as replies.
* Open tracking is unreliable (Apple Mail Privacy Protection, image proxies); opens/clicks are shown as **estimates**, never as measured fact.
* Warm-up is not included and **no tool can guarantee inbox placement**. Daily limits are yours to set; the defaults are conservative and are not a statement that any volume is safe.
* Compliance rules are **technical safeguards, not legal advice**. CA, AU and EU/EEA are disabled by default; review them with counsel before enabling. A publicly listed email address does not by itself authorise marketing email.
* The UI is intentionally basic.

See [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md), [API_DOCUMENTATION.md](API_DOCUMENTATION.md) and `docs/`.
