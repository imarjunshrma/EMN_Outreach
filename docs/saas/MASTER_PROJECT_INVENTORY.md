# Master project inventory

Baseline taken 2026-11-21 (before the v1.4 hardening pass) from the working copy on the build machine, reconciled byte-for-byte against the user's Mac copy (`/Users/bridgestonetec/Codebase/emn-outreach-os`). No Git repository exists in either copy; changes are tracked in `CHANGED_FILES_AND_MIGRATIONS.md`, and every Mac file that is replaced is backed up first under `.local-dev/backup-<timestamp>/`.

## Version

- `package.json` said **1.2.0**; the code and CHANGELOG were **1.3.0** (organizations, billing per organization, platform console, website, docs). Corrected to 1.4.0 in this pass.
- The Mac copy also contains a parallel hardening pass (documents in `docs/audit/` and `docs/implementation/`, which describe the code as it was *before* the organization model). It was merged in v1.3. Those documents are historical; `docs/saas/` is current.

## Stack (verified from lockfiles)

| Layer | Version |
|---|---|
| Node.js | 22 (`.nvmrc`) |
| Express | 5.3.0 |
| Prisma / adapter-pg | 7.10.1 |
| PostgreSQL | 16 (build machine), Homebrew postgresql@16 (Mac) |
| Redis / ioredis / BullMQ | 7 / 6.0.0 / 6.7.8 |
| Zod | 4.6.7 |
| argon2 | 0.45.2 |
| nodemailer / imapflow | 10.6.1 / 2.12.2 |
| Next.js / React | 15.5.29 / 19.3.1 |
| Tests | Vitest, Playwright 1.65 |

## Size

| Item | Count |
|---|---|
| Registered API operations | 317 (public 10, user 12, workspace 262, organization 19, platform 14) plus raw-body payment webhooks, tracking pixel, SSE, health |
| Frontend pages | 84 `page.tsx` routes (app, website, docs, onboarding, organization, platform) |
| Prisma models | 91 |
| Migrations | 5 SQL migrations + 2 idempotent SQL files (`prisma/sql/`) |
| Worker job handlers | 32 across 15 queues, 11 repeatable schedules |
| Test files | 6 unit, 13 integration, 4 browser (160 + 16 tests at baseline, all passing) |
| Docs | 21 customer guides (`/docs`), 18 `docs/saas` reports, earlier design docs `docs/00-18` |

## Architecture

Platform → Organization (tenant, billing, status) → Workspace (operational data) → members and records. Organization roles OWNER/ADMIN/BILLING/MEMBER; workspace roles OWNER/ADMIN/MANAGER/MEMBER/VIEWER; platform roles SUPER_ADMIN/SUPPORT/FINANCE. Isolation: membership resolution per request, scoped queries, 40 database triggers (72 relations), immutable workspace→organization link, worker tenant gate, per-tenant Redis keys. See `TENANT_ISOLATION_REPORT.md`.

## Integrations (all real adapters; none verified against a live account in this environment)

Gmail API + Google OAuth, Microsoft Graph + OAuth, SMTP (nodemailer) + IMAP (imapflow), OpenAI, Anthropic, Apollo, MillionVerifier, ZeroBounce, NeverBounce, Hunter, Brave, Serper, Smartlead export, Cloudflare DNS, Calendly/Cal.com booking webhooks, Slack incoming webhooks, Stripe, Razorpay, S3-compatible storage. Status per provider: `PROVIDER_READINESS_MATRIX.md`.

## Baseline findings (cross-checked against code, not reports)

### Complete and tested
Organization model and migration, isolation layers, sign-up/provisioning, onboarding checklist, plans in DB, entitlements, idempotent metering (sends, AI, verification, API calls, workflow runs), billing webhooks (fixtures), lifecycle and deletion, platform console, website, docs, campaign engine, inbox, AI studio, workflows, CRM, enrichment waterfall.

### Partial or missing at baseline (addressed in v1.4 unless stated)
1. Platform staff are not required to use 2FA.
2. No way to disable a user account; suspending an organization does not end active sessions; sessions are not rotated on privilege changes.
3. Storage is neither metered nor limited.
4. Refunds, disputes and out-of-order payment events are not handled; no reconciliation with providers.
5. Annual plans silently use monthly allowances (policy not stated).
6. Free-trial reuse: one person can create unlimited organizations, each with a trial.
7. DNS: create-only; no record listing, editing or deletion; provider abstraction is Cloudflare-shaped.
8. Jobs have no execution timeout; failed jobs are not surfaced as a dead-letter list to staff; SSE ignores tenant status.
9. Support access is not visible to the customer in the app (only in the audit log); support staff see no banner.
10. Metrics lack trial conversion, payment failures, AI spend, email volume and growth.
11. Website lacks a contact/support page.
12. `package.json` version wrong.
13. No backup/restore verification, load test, or security scans recorded.
14. No native HubSpot/Pipedrive connectors (API + webhooks only) — remains a documented limitation.

## Configuration requirements

See `.env.example`. Required: `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `ENCRYPTION_KEYS` + `ENCRYPTION_ACTIVE_KEY`, `APP_URL`. SaaS: `BILLING_ENABLED`, Stripe/Razorpay keys, `SYSTEM_SMTP_URL`. Mailboxes: Google/Microsoft OAuth client credentials. Configuration is validated at start (`backend/src/core/config.ts`).

## Blockers outside this environment

Live provider credentials, a transactional email account, a Cloudflare test zone, legal review, a professional penetration test, production infrastructure.
