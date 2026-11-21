# 03 — Database schema

Source of truth: `prisma/schema.prisma` (Prisma 7, PostgreSQL 15+). Migrations: `prisma/migrations/`.
Extra SQL that Prisma can't express: `prisma/sql/001_indexes_and_guards.sql` (idempotent, applied by
`npm run db:migrate` after `prisma migrate deploy`).

Conventions: UUID primary keys, `timestamptz(3)`, every tenant-owned table has `workspaceId` with an index
and `onDelete: Cascade` from `Workspace`; secrets are stored only in `encrypted*` columns (AES-256-GCM, `v<ver>:iv:tag:ct`).

## Models by domain

| Domain | Models |
|---|---|
| Identity & tenancy | `User`, `Session`, `Workspace` (settings JSON), `WorkspaceMember` (role), `WorkspaceInvitation`, `ApiKey` |
| Mailboxes & deliverability | `Domain`, `DomainHealthCheck`, `EmailAccount` (provider, status, daily limit, min spacing, window), `ProviderCredential` (encrypted tokens / SMTP password) |
| AI | `AiProvider` (encrypted key, monthly budget), `AiModelRoute` (task → provider/model + fallback), `AiModelPrice`, `PromptTemplate` (versioned per task), `AiExecution` (tokens, cost, estimate flag, status) |
| Integrations & usage | `Integration` (type, encrypted secret, public config), `UsageRecord` |
| Leads | `Company`, `LeadSource`, `Lead` (unique `workspaceId+emailNormalized`, status, country, timezone, lawful basis, verification), `LeadStatusChange`, `EmailVerification`, `LeadList`, `LeadListMember`, `ImportJob` |
| Prospecting & research | `IdealCustomerProfile`, `ProspectSearch`, `ResearchReport`, `ResearchEvidence` (URL, text, hash), `ResearchClaim` (quote, status SUPPORTED/UNSUPPORTED/CONFLICTING), `LeadScore` |
| Campaigns | `Template`, `Campaign` (limits, window, review mode, thresholds, approval hash), `Sequence` (1:1 campaign), `SequenceStep` (delayDays, condition, thread mode), `SequenceStepVariant` (A/B), `CampaignList`, `CampaignEmailAccount`, `SequenceEnrollment` (fixed sender, next action), `OutboundEmail` (unique `enrollmentId+stepId`, status machine, approval, fact-check), `TrackedLink` |
| Inbox | `Conversation`, `EmailMessage` (Message-ID, references, direction, category), `EmailAttachment`, `EmailEvent` (sent/bounce/reply/open/click/complaint/unsubscribe, with `isEstimate`) |
| Compliance | `SuppressionEntry` (email or domain, reason), `ComplianceRule` (per country), `PrivacyRequest` |
| CRM | `Opportunity`, `Note`, `Task` |
| Automation | `AutomationRule`, `AutomationRun`, `Webhook`, `WebhookDelivery` |
| Ops | `Notification`, `AuditLog`, `JobRun`, `ErrorLog` |

## Key constraints and invariants
- `OutboundEmail @@unique([enrollmentId, stepId])` — a step can never be sent twice to the same enrolment.
- `SequenceEnrollment @@unique([campaignId, leadId])` — a lead is in a campaign at most once.
- `Lead @@unique([workspaceId, emailNormalized])`; `SuppressionEntry @@unique([workspaceId, type, value])`.
- `Sequence.campaignId @unique` — changed from plan (was reusable, versioned sequences); approval integrity
  comes from `Campaign.approvedContentHash` instead.
- Outbound status machine: `PENDING → QUEUED → SENDING → SENT` or `FAILED / SKIPPED / CANCELLED`.

## SQL guards (`001_indexes_and_guards.sql`)
- `pg_trgm` + GIN trigram indexes for lead email/name and company name search.
- Partial indexes for the hot paths: due active enrolments, ready outbound emails.
- `AuditLog` append-only: `BEFORE UPDATE` and `BEFORE DELETE` triggers raise an error unless the current
  transaction set `emn.allow_audit_delete = 'on'` (used only by the retention job for expired rows).

## Seed (`prisma/seed.ts`, idempotent)
Starter `AiModelPrice` rows (USD per million tokens). These are reference values to be checked against the
provider's current price list; unpriced models record cost 0 with `isEstimate = true`.
