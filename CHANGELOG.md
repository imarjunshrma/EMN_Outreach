# Changelog

## 1.4.0 — 2026-11-21 — Production hardening

### Security and access
- Platform staff must use 2FA (cannot be turned off in production); staff cannot disable their own 2FA; support grants require 2FA.
- Platform **User accounts** screen: search, disable (ends all sessions) and re-enable, audited.
- Customers see a banner while support is viewing and a **Support access log** in organization settings.
- `/readyz` no longer returns error text; Prometheus `/metrics` behind `METRICS_TOKEN`.

### Billing and usage
- Refunds from the platform console (idempotent; confirmed only by provider webhook) and dispute handling (a lost dispute suspends the organization).
- Out-of-order webhook protection and a reconciliation job every 6 hours.
- Annual plans can pool allowances for the year.
- One free trial per person and a per-user organization cap (`MAX_ORGS_PER_USER`).
- Storage metered from real bytes, enforced at upload and reconciled daily.

### Operations
- Per-queue job timeouts, dead-letter logging and an **Operations** screen with retry.
- DNS: list, edit (refused if the record changed meanwhile) and delete (typed confirmation) zone records; NS/SOA protected.
- `scripts/restore-drill.sh` (non-destructive) and `scripts/load-test.ts`.
- Fixed: concurrent lead creation for the same company returned 409.

### Website and docs
- Contact page; platform overview adds trial conversion, payment failures, refunds/disputes and growth.
- docs/saas: inventory, execution plan, security audit, isolation, billing/usage, provider readiness, deployment and recovery, launch checklist, changed files; final report with release gates.

## 1.3.0 — 2026-11-21 — Multi-tenant SaaS, public website, documentation

### Multi-tenancy
- **Organizations** above workspaces: owner, status (8 states with enforced transitions and history), settings, branding, billing owner. Existing workspaces became one organization each (additive migration with backfill).
- **Roles:** organization OWNER / ADMIN / BILLING / MEMBER on top of workspace roles. Org owners/admins reach every workspace; invited people only their workspace.
- **Isolation:** 40 database triggers refuse cross-workspace references (72 relations); a workspace can never change organization; append-only platform audit. Every one of the 262 workspace endpoints is tested to answer 404 to another tenant.
- **Lifecycle:** suspend/reactivate/cancel, owner-requested deletion with 14-day grace and cancel, purge (records and files), scheduled `tenant.sync` and `tenant.purge` jobs.
- **Workers** re-check the tenant before costly or outbound jobs and enforce per-tenant fair-share slots (`TENANT_JOB_SLOTS`).

### Commercial
- Self-service **sign-up** with terms acceptance, idempotent transactional provisioning, **email verification**, and a computed **onboarding checklist**.
- **Plans in the database**, edited in the platform console; central **entitlement engine**; idempotent, atomic **usage metering** per organization and month.
- **Billing per organization** (Stripe, Razorpay): checkout, portal, cancel/resume, verified webhooks, grace periods; activation only from verified webhooks.
- **Platform console** (`/platform`): SaaS metrics with definitions, tenant search/detail/lifecycle/overrides, plans, audited read-only support access, audit trail. Platform roles SUPER_ADMIN / SUPPORT / FINANCE.

### Website and documentation
- Public website: home, product, pricing (live from the plan catalogue), security, terms/privacy/AUP (drafts for legal review).
- `/docs`: 21 step-by-step guides, full-text search (⌘K), and an API reference generated from the OpenAPI document with permissions, rate limits, parameters and curl examples.
- Organization settings page; workspace switcher grouped by organization; setup reminder.

### Docs
- `docs/saas/`: 17 reports (assessment, architecture, isolation, ownership matrix, database, API security matrix, billing, metering, platform guide, onboarding, integrations & DNS, tests, security review, progress, remediation, unresolved issues, acceptance report).

## 1.2.0 — 2026-11-21 — Copilot, reply modes, 2FA, workflows, billing

### Audit of 1.1.0 (doc 17)
Five defects were found and fixed, each with a test:
- **A1:** SMTP error codes were mis-classified. 5xx is now permanent, 4xx retryable, auth failure 401. Verified against a real SMTP session.
- **A2:** a batch lead still in GENERATING was counted as done.
- **A3:** the edit fact-check ignored the per-lead cost limit.
- **A4:** personalize.single jobs collided on their job ID.
- **A5:** SMTP had no tests.

### Added
- **Security**
  - TOTP two-factor sign-in with QR setup, single-use recovery codes and a replay guard.
  - Workspace "require 2FA" policy.
  - Email password reset (single-use, 1 hour, signs out all sessions).
  - API-key scopes.
- **AI reply assistant**
  - Permission modes: suggest / draft for approval (**default**) / narrow auto. Narrow auto sends only an approved template, only for allow-listed categories, once per conversation.
  - Pricing, commitment and complaint replies are never auto-sent.
  - Reply templates with manager approval.
- **AI Copilot.** Answers from a snapshot of workspace data. Proposed actions need role-checked confirmation and run once. Business memory; repetitive-wording check.
- **Domain & mailbox management**
  - TXT ownership verification and propagation check across 3 resolvers.
  - Recommended records, with one-record-at-a-time apply through Cloudflare.
  - Renewal reminders.
  - Mailbox health view and a provider capability registry (unreviewed providers are labelled as such).
- **Enrichment.** Verification waterfall (MillionVerifier, ZeroBounce, NeverBounce) that skips fresh results and checks a disposable-domain list; provider comparison; Hunter email finder.
- **Visual workflow builder**
  - Triggers, conditions, nested if/else and 12 actions.
  - Versions, test (dry-run) mode, per-block execution log, run-once per event, daily limit, retries.
  - Daily and inbound-webhook triggers.
- **Billing.** Plans as data, trials, quota and feature enforcement, PAST_DUE grace period, invoices, Stripe and Razorpay gateways with verified idempotent webhooks, platform-admin overrides. Off by default (self-hosted = unlimited).
- **CRM & analytics.** Weighted forecast, won-by-month and win rate; CSV exports; saved filters; scheduled email reports; Slack and email alert channels.
- **Inbox and campaigns.** Inbox star, archive and forward; campaign folders and tags.
- **UI.** Screens for every module in one navigation, dark theme (light / dark / system), billing banner.
- **Testing.**
  - Playwright browser tests (`npm run test:e2e`).
  - Opt-in live provider harness (`npm run live-check`).
  - Frontend/shared vocabulary sync test.
- **Docs.** 17 (audit), 18 (operations, upgrade, live verification, credentials list); ledger 16 rewritten with evidence.

### Fixed
- Saving workspace settings no longer drops server-managed keys (workflow webhook tokens).
- The lead "Verify email" button now uses the waterfall.

### Migration
`20261121090000_v1_2_security_ai_workflows_billing`: additive only.

## 1.1.0 — 2026-11-20 — AI Studio & individual personalization

### Added
- **AI Studio** (sidebar).
  - Versioned business knowledge: services, products, USPs, verified case studies and achievements, audience, competitors, offers and pricing, plus reference documents.
  - Global writing instructions: tone, style, length, complexity, intensity, CTA, formality, language, words to avoid, forbidden claims, good and bad examples, and a 20k-character instruction editor.
  - Research instructions: person and company topics, permitted sources, signals, evidence rules, never-infer list, and what to do when information is missing.
  - Models & budgets: per-task model, fallback and input/output token limits, a workspace monthly AI budget, and a default maximum cost per lead.
- **Prompt library.** Profiles with `{{variables}}` and `{{#if}}/{{else}}/{{#unless}}` conditionals, linting, immutable versions with comparison, folders, tags, team approval, duplicate, JSON import/export, and a test run on a sample lead.
- **Campaign AI profiles.**
  - Per-campaign profile, ICP, writing and research overrides, audience and offer context, and a cost limit per lead.
  - Step and A/B-variant AI instructions, and prospect-specific instructions.
  - A documented instruction hierarchy (doc 15).
- **Per-lead personalization engine.**
  - Uses research evidence, previous steps and engagement state.
  - Runs an independent fact-check and 10 quality checks, and gives an explained personalization score (heuristic).
  - Keeps a revision history and records cost per lead.
  - Supports manual edits (preserved), regeneration with a note, approve/reject, and side-by-side revision comparison.
- **Bulk generation.** Cost estimate, batch cost cap, cancel, retry failed, "research leads without evidence", and the new `personalize` queue.
- **Approval-safe sending.** AI steps send only approved, hash-matching personalization, with no AI calls at send time. Approving a campaign freezes its AI configuration snapshot and records a `SequenceVersion`.
- **Campaign editor.** AI personalization, Preview & test, and Versions tabs; per-lead preview; test emails (workspace members only, rate-limited); version restore; campaign duplication; scheduled start.
- **Research agent.** Follows the research rules; separate search queries for general results, podcasts/interviews and news (where permitted); research focus passed to fact extraction.
- **Infrastructure and security.**
  - S3-compatible storage adapter (`STORAGE_DRIVER=s3`), with workspace-scoped keys and signed URLs.
  - Content-Security-Policy and Permissions-Policy headers.
  - Prompt previews and errors in logs are redacted (emails, phone numbers, keys).
  - Docker: `deployment/docker/Dockerfile`, `Dockerfile.web` and `docker-compose.yml` (optional; the VPS install is unchanged).
- **Docs.** 14 (Instantly parity audit), 15 (AI personalization architecture), 16 (implementation ledger for the master prompt).
- **Migrations.** `20261120180000_ai_studio_personalization` and `20261120190000_prospect_instructions_prompt_library`. Both are additive, with no data loss.

### Changed
- The variant seed is now deterministic per (campaign, lead), so pre-generated content matches the variant that gets sent.
- `factCheck` accepts an explicit claim set and cost attribution.
- AI executions record campaignId, leadId and profileVersionId.
- Existing workspaces get the new PERSONALIZATION prompt automatically on first use.
- Storage keys must belong to a valid workspace UUID.

### Not included (see doc 16)
- Feature gaps: AI Copilot, reply autopilot, billing/plans, MFA, provisioning and registrar adapters, waterfall enrichment, visual workflow builder, dark theme, browser tests.
- Verification gaps: Docker images not built in this environment; no live tests of any provider.


## 1.0.0 — 2026-11-20

First complete release of EMN Outreach OS (self-hosted, single VPS, no Docker/AWS).

### Added
- Backend (Express 5 + TypeScript), worker (BullMQ), and Next.js 15 UI (47 routes) covering accounts and
  workspaces, leads and companies, CSV import/export, prospecting (Apollo adapter), verification
  (MillionVerifier adapter), research with cited evidence, AI writing with fact-check, campaigns and
  sequences, sending engine, Google/Microsoft/SMTP mailboxes, unified inbox, reply classification,
  CRM pipeline and tasks, automations, webhooks, deliverability checks, compliance rules, suppression,
  privacy requests, retention, audit log, analytics, AI usage/costs, job monitor, notifications, realtime SSE.
- 169 API operations (135 paths) generated into `docs/openapi.json` and `API_DOCUMENTATION.md`.
- Prisma 7 schema with ~50 models, initial migration, SQL guards (partial indexes, append-only audit trigger), seed.
- Deployment: Nginx site, systemd units, PM2 alternative, logrotate, Postgres role setup, Redis settings,
  `install.sh`, `deploy.sh` (release folders, health check, automatic rollback), `backup.sh`, `restore.sh`, `healthcheck.sh`.
- 87 automated tests (unit + integration against real PostgreSQL/Redis with fake providers).

### Fixed during final verification
- Booking webhook now verifies Calendly's `t=…,v1=…` signature format (timestamped, 5-minute window), not only plain HMACs.
- `AuditLog` is now protected against DELETE as well as UPDATE; only the retention job can prune expired rows (transaction-local flag).
- An interrupted SMTP send that can't be found in the Sent folder is marked FAILED instead of re-sent (prevents duplicates).
- Backup/restore scripts no longer abort when `DATABASE_MIGRATION_URL` is absent; health check supports `PROCESS_MANAGER=none`.
- Nginx config uses the `listen … http2` form supported by Ubuntu's nginx 1.18/1.24.
- Removed an unimplemented `SENTRY_DSN` option.
- Added `npm run reset-password` (no system email exists for resets) and a "Create opportunity" action in the inbox thread.

### Changed from the architecture plan (docs/ updated accordingly)
- Prisma 7: connection URL lives in `prisma.config.ts`; client generated to `backend/src/generated/prisma` (ESM) and uses `@prisma/adapter-pg`.
- No Docker anywhere; process management via systemd (default) or PM2.
- A sequence belongs to exactly one campaign (`Sequence.campaignId` unique) instead of reusable versioned
  sequences; edits after approval are detected by a content hash and require re-approval.
- Workspace routes are `/api/v1/w/:workspaceId/...` (explicit workspace in the URL) instead of a header.
- Offset pagination `{ data, page, pageSize, total, totalPages }` instead of cursors.
- Automations are rule-based (trigger → conditions → actions), not a visual DAG builder.
- Open/click tracking is optional and off by default.
- SMTP/IMAP adapter included in 1.0 (was "later" in the plan).
- Booking integration is a signed inbound webhook (Cal.com / Calendly / generic) rather than calendar OAuth.
- Workspace-scoped API keys added.

### Not included / known gaps
- No live verification against Gmail, Microsoft Graph, OpenAI, Anthropic, Apollo, MillionVerifier, Brave,
  Serper or Smartlead from this build — all adapter tests use fakes or recorded response shapes.
- No warm-up, no mailbox rotation (deliberately excluded).
- No spam-complaint feedback loop for mailbox sending (providers don't expose one).
- No Content-Security-Policy header yet; no 2FA yet; no frontend unit tests (UI verified by typecheck + production build).
