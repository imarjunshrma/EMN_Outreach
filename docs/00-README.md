# EMN Outreach OS — Architecture & Implementation Docs (v1.2.0)

These documents started as the pre-build architecture pack. They have been **updated to describe the
system as implemented**. Where the build differs from the original plan, the difference is called out
in a "Changed from plan" note in the doc concerned and summarised in `../CHANGELOG.md`.

| # | Document | Contents |
|---|---|---|
| 01 | system-architecture | Processes, request and data flow, deployment topology |
| 02 | monorepo-structure | Folders, packages, build outputs, conventions |
| 03 | database-schema | Models by domain, key constraints, indexes and SQL guards |
| 04 | backend-modules | Services, responsibilities, invariants |
| 05 | frontend-routes | UI routes and what each does (v1.2 adds the screens listed in doc 18 / ledger §25) |
| 06 | api-specification | API conventions (full reference: `../API_DOCUMENTATION.md`, `openapi.json`) |
| 07 | ai-architecture | Orchestrator, routing, prompts, evidence, fact-check, budgets |
| 08 | email-provider-architecture | Gmail, Graph, SMTP/IMAP, sending engine, sync, replies |
| 09 | queue-architecture | Queues, jobs, schedules, retries, idempotency |
| 10 | security-and-isolation | Auth, RBAC, tenancy, secrets, SSRF, audit (see `../SECURITY.md`) |
| 11 | environment-and-deployment | Env vars, VPS layout, systemd/PM2, Nginx, backups |
| 12 | implementation-roadmap | What was delivered per phase, and what comes next |
| 13 | risks-gaps-and-open-questions | Remaining risks, provider dependencies, legal notes |
| 14 | instantly-parity-audit | Feature-by-feature comparison with Instantly (full / partial / missing / external) |
| 15 | ai-personalization | AI Studio, instruction hierarchy, per-lead generation pipeline, quality control, cost limits |
| 16 | implementation-ledger | Status of every section of the master implementation prompt, with test evidence (v1.2) |
| 17 | audit-v1.1 | Source-code audit of 1.1.0: defects found and fixed, adapter readiness, isolation checks |
| 18 | v1.2-operations | Upgrade, new env vars, billing setup, Docker, test commands, live-check harness, credentials still needed |

The Prisma schema is `../prisma/schema.prisma` (the earlier draft copy in `docs/schema/` was removed
to avoid two diverging sources of truth).

## Decisions applied (from the final build instruction)
1. Own sending engine is the default; Smartlead is an optional export adapter.
2. Lead data via Apollo adapter + CSV import; verifier and web-search providers are configurable.
3. Google Workspace and Microsoft 365 via OAuth; SMTP/IMAP where the provider permits it.
4. Open/click tracking off by default, optional, reported as estimates.
5. Booking via signed webhook; internal CRM; outgoing webhooks.
6. Conservative compliance defaults for US, UK, EU/EEA, CA, AU, IN; unknown countries blocked.
7. Linux VPS + Nginx + systemd/PM2. No Docker, no mandatory AWS, local disk storage behind an adapter.
