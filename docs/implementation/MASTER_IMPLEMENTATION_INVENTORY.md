# Master implementation inventory

Checkout version 1.2.0. Discovered counts: **296 HTTP endpoints (284 declarative + 12 directly mounted)**, **65 page files**, **13 TSX shared components**, **84 Prisma models**, **44 enums**, 4 migration files, 15 queues, 17 internal test files. Detailed item-level indexes: `API_IMPLEMENTATION_MATRIX.md`, `FRONTEND_IMPLEMENTATION_MATRIX.md`, `DATABASE_IMPLEMENTATION.md`.

| ID | Feature | Purpose / subfeatures | Source/data references | Dependencies | Status |
|---|---|---|---|---|---|
| IMPL-AUTH | Authentication and accounts | First registration, login/logout, Argon2id passwords, sessions/CSRF, reset, TOTP MFA, profile/session controls. | backend/src/services/auth.ts, security.ts; routes/core.ts; frontend login/setup/reset/account pages; User, Session, PasswordResetToken | Redis rate limits, Postgres, optional system SMTP | PARTIAL; 2 regression fixes in current audit; DB integration passed; endpoint audit incomplete |
| IMPL-WS | Workspace/team/RBAC | Workspace creation/switch, memberships/invites, fixed role ladder, API keys/scopes. | services/workspace.ts; routes/core.ts; Workspace, WorkspaceMember, WorkspaceInvitation, ApiKey | Session auth; route registry; billing usage | PARTIAL; three-workspace isolation integration passed; broader resource audit remains |
| IMPL-LEADS | Lead/company/list/import | CRUD, CSV mapping/import/export, search/filter, status, lists, company relations. | services/leads.ts; routes/leads.ts; Lead, Company, LeadList, ImportJob | Storage, DB, import queue | PARTIAL; integration suite passed; route-level completeness remains |
| IMPL-RESEARCH | Prospecting/research/enrichment | Apollo, public fetch, Brave/Serper, evidence/claims, scoring, verification waterfall/Hunter finder. | services/intelligence.ts,enrichment.ts; integrations/providers and research; ResearchReport, Evidence, Claim, LeadScore, EmailVerification | Provider keys, network and workers | local mock/integration tests passed; live credentials not used |
| IMPL-AI | AI Studio/personalization | Knowledge, prompts/profiles, model routing, generation, quality/fact-check, revisions/review, costs. | services/ai-studio.ts,ai.ts,personalization.ts; shared prompt modules; AiConfigVersion, KnowledgeDocument, PromptProfile, LeadPersonalization, PersonalizationBatch | OpenAI/Anthropic keys, DB, queue, research | PARTIAL; mocks exist; providers not live-tested |
| IMPL-CAMPAIGN | Campaign/sequence/send | Campaigns, steps/variants, approval/snapshots, schedule, enrollments, compliance gates, send reconciliation. | services/engine.ts; routes/outreach.ts; Campaign, Sequence, SequenceEnrollment, OutboundEmail | Mailbox adapters, worker, Redis, suppression | PARTIAL; integration tests passed; worker outage/restart behavior unverified |
| IMPL-MAIL | Mailbox/inbox/reply | Gmail/Graph/SMTP/IMAP, OAuth, sync, conversation, attachment, classification, drafts/replies. | services/accounts.ts,inbox.ts,reply-assist.ts; integrations/email; EmailAccount, Conversation, EmailMessage | Provider credentials, DB, storage, AI optional | PARTIAL; protocol/mocks only; mailbox workspace verification fix added |
| IMPL-COMP | Compliance/privacy/suppression | Unsubscribe, suppression, country policy, privacy requests/export/erasure, retention. | services/compliance.ts; SuppressionEntry, ComplianceRule, PrivacyRequest | Campaign gates, worker | PARTIAL; integration suite passed, feature breadth remains |
| IMPL-DOMAIN | Domains/DNS/deliverability | SPF/DKIM/DMARC/MX checks, ownership, propagation, manual guidance, Cloudflare record creation, renewal reminders. | services/domains.ts; integrations/research/dns.ts; CloudflareDns; Domain, DomainHealthCheck | DNS resolvers; optional Cloudflare key | PARTIAL; no live DNS operations allowed; create retry fix added |
| IMPL-CRM | CRM/tasks/pipeline | Opportunities, tasks, notes, activity, forecast. | services/crm.ts; Opportunity, Task, Note | Leads/inbox/workspace | PARTIAL; integration suite passed, analytics reconciliation incomplete |
| IMPL-WF | Automation/workflows/webhooks | Rule automation, versioned visual workflows, inbound/outbound hooks, dedupe/retry. | services/workflows.ts,automation.ts,webhooks.ts; Workflow, WorkflowVersion, WorkflowRun, Webhook, WebhookDelivery | Queue, Redis, safe egress | PARTIAL; failure recovery blocked |
| IMPL-AN | Analytics/reports/notifications | Dashboards, campaign/CRM aggregates, scheduled reports, inbox notifications, SSE. | services/analytics.ts,insights.ts,ops.ts; Analytics models, ScheduledReport, Notification | DB/worker, optional SMTP/Slack | PARTIAL; no fixture reconciliation run |
| IMPL-BILL | Billing/entitlements | Plans/trials/subscriptions/usage/payment webhooks. | services/billing.ts; gateways.ts; Plan, Subscription, Invoice, BillingEvent, UsageRecord | Optional Stripe/Razorpay keys | PARTIAL; mocks only, no live payments |
| IMPL-STOR | Files/storage | Local disk/S3 adapter, attachments/imports/exports/knowledge docs. | backend/src/core/storage.ts; EmailAttachment, KnowledgeDocument, ImportJob | Filesystem or S3 credentials | PARTIAL; mock/unit evidence; persistence blocked |
| IMPL-OPS | Health/API/deployment | healthz/readyz, job/error surfaces, docs, Docker, VPS scripts, backups. | backend/src/app.ts; scripts; deployment/ | Postgres/Redis/Docker | Docker runtime blocked; local DB/Redis tests passed |

## Queue inventory

| Queue ID | Producer/processor name | Worker | Status |
|---|---|---|---|
| QUEUE-01 | `scheduler` (`QUEUES.scheduler`) | `worker/src/main.ts`, handlers in `worker/src/processors.ts` | Source present; exercised by integration tests; process recovery/outage behavior remains unverified |
| QUEUE-02 | `outbound-prepare` (`QUEUES.prepare`) | `worker/src/main.ts`, handlers in `worker/src/processors.ts` | Source present; exercised by integration tests; process recovery/outage behavior remains unverified |
| QUEUE-03 | `send` (`QUEUES.send`) | `worker/src/main.ts`, handlers in `worker/src/processors.ts` | Source present; exercised by integration tests; process recovery/outage behavior remains unverified |
| QUEUE-04 | `reply-send` (`QUEUES.replySend`) | `worker/src/main.ts`, handlers in `worker/src/processors.ts` | Source present; exercised by integration tests; process recovery/outage behavior remains unverified |
| QUEUE-05 | `mailbox-sync` (`QUEUES.sync`) | `worker/src/main.ts`, handlers in `worker/src/processors.ts` | Source present; exercised by integration tests; process recovery/outage behavior remains unverified |
| QUEUE-06 | `ai` (`QUEUES.ai`) | `worker/src/main.ts`, handlers in `worker/src/processors.ts` | Source present; exercised by integration tests; process recovery/outage behavior remains unverified |
| QUEUE-07 | `research` (`QUEUES.research`) | `worker/src/main.ts`, handlers in `worker/src/processors.ts` | Source present; exercised by integration tests; process recovery/outage behavior remains unverified |
| QUEUE-08 | `import` (`QUEUES.imports`) | `worker/src/main.ts`, handlers in `worker/src/processors.ts` | Source present; exercised by integration tests; process recovery/outage behavior remains unverified |
| QUEUE-09 | `verify` (`QUEUES.verify`) | `worker/src/main.ts`, handlers in `worker/src/processors.ts` | Source present; exercised by integration tests; process recovery/outage behavior remains unverified |
| QUEUE-10 | `domain-health` (`QUEUES.domain`) | `worker/src/main.ts`, handlers in `worker/src/processors.ts` | Source present; exercised by integration tests; process recovery/outage behavior remains unverified |
| QUEUE-11 | `maintenance` (`QUEUES.maintenance`) | `worker/src/main.ts`, handlers in `worker/src/processors.ts` | Source present; exercised by integration tests; process recovery/outage behavior remains unverified |
| QUEUE-12 | `automation` (`QUEUES.automation`) | `worker/src/main.ts`, handlers in `worker/src/processors.ts` | Source present; exercised by integration tests; process recovery/outage behavior remains unverified |
| QUEUE-13 | `webhooks` (`QUEUES.webhooks`) | `worker/src/main.ts`, handlers in `worker/src/processors.ts` | Source present; exercised by integration tests; process recovery/outage behavior remains unverified |
| QUEUE-14 | `privacy` (`QUEUES.privacy`) | `worker/src/main.ts`, handlers in `worker/src/processors.ts` | Source present; exercised by integration tests; process recovery/outage behavior remains unverified |
| QUEUE-15 | `personalize` (`QUEUES.personalize`) | `worker/src/main.ts`, handlers in `worker/src/processors.ts` | Source present; exercised by integration tests; process recovery/outage behavior remains unverified |

## Integration/provider inventory

See `INTEGRATION_IMPLEMENTATION_MATRIX.md`. Provider adapter existence is not live verification.

## Test inventory

`tests/integration/ai-research.test.ts`, `tests/integration/assist-copilot.test.ts`, `tests/integration/auth-isolation.test.ts`, `tests/integration/campaign-engine.test.ts`, `tests/integration/crm-insights.test.ts`, `tests/integration/domains-enrichment.test.ts`, `tests/integration/inbox-replies.test.ts`, `tests/integration/leads-import.test.ts`, `tests/integration/personalization.test.ts`, `tests/integration/security-v12.test.ts`, `tests/integration/workers-ops.test.ts`, `tests/integration/workflows-billing.test.ts`, `tests/unit/adapters.test.ts`, `tests/unit/frontend-sync.test.ts`, `tests/unit/security.test.ts`, `tests/unit/shared.test.ts`, `tests/unit/smtp-protocol.test.ts`

Full test run: 139 tests passed across 17 files (46 unit, 93 integration) using isolated PostgreSQL/Redis. Playwright: 10 E2E tests passed with local Chrome. Docker remains unavailable, so container behavior is unverified.
