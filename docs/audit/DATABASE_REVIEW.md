# Database review

## Inventory

- Provider: PostgreSQL (`prisma/schema.prisma`).
- ORM/client: Prisma 7 with generated client in `backend/src/generated/prisma`, using `@prisma/adapter-pg`.
- Current declarations: **84 models**, **44 enums**, **4 migration SQL files**.
- Migration order: `20261120152841_init`, `20261120180000_ai_studio_personalization`, `20261120190000_prospect_instructions_prompt_library`, `20261121090000_v1_2_security_ai_workflows_billing`.
- Supplementary SQL: `prisma/sql/001_indexes_and_guards.sql` enables `pg_trgm`, adds GIN/hot-path indexes, and enforces append-only audit rows.
- Fresh seed: `prisma/seed.ts` upserts reference AI model price rows. Workspace defaults are initialized by workspace/account creation services.

## Models

`User`, `Session`, `Workspace`, `WorkspaceMember`, `WorkspaceInvitation`, `ApiKey`, `Domain`, `DomainHealthCheck`, `EmailAccount`, `ProviderCredential`, `AiProvider`, `AiModelRoute`, `AiModelPrice`, `PromptTemplate`, `AiExecution`, `Integration`, `UsageRecord`, `Company`, `LeadSource`, `Lead`, `LeadStatusChange`, `EmailVerification`, `IdealCustomerProfile`, `ProspectSearch`, `LeadList`, `LeadListMember`, `ImportJob`, `ResearchReport`, `ResearchEvidence`, `ResearchClaim`, `LeadScore`, `Template`, `Campaign`, `Sequence`, `SequenceStep`, `SequenceStepVariant`, `CampaignList`, `CampaignEmailAccount`, `SequenceEnrollment`, `OutboundEmail`, `TrackedLink`, `Conversation`, `EmailMessage`, `EmailAttachment`, `EmailEvent`, `SuppressionEntry`, `ComplianceRule`, `PrivacyRequest`, `Opportunity`, `Note`, `Task`, `AutomationRule`, `AutomationRun`, `Webhook`, `WebhookDelivery`, `Notification`, `AuditLog`, `JobRun`, `ErrorLog`, `AiConfigVersion`, `KnowledgeDocument`, `PromptProfile`, `PromptProfileVersion`, `LeadPersonalization`, `PersonalizationRevision`, `PersonalizationBatch`, `SequenceVersion`, `PasswordResetToken`, `ReplyTemplate`, `ReplySuggestion`, `CopilotThread`, `CopilotMessage`, `CopilotAction`, `CopilotMemory`, `Workflow`, `WorkflowVersion`, `WorkflowRun`, `Plan`, `Subscription`, `Invoice`, `BillingEvent`, `SavedFilter`, `ScheduledReport`, `NotificationChannel`

## Enums

`UserStatus`, `WorkspaceRole`, `DnsCheckStatus`, `HealthStatus`, `EmailProviderType`, `EmailAccountStatus`, `AiProviderType`, `AiTask`, `AiExecutionStatus`, `LeadSourceType`, `LeadStatus`, `EmailVerificationStatus`, `LawfulBasis`, `AiConfigKind`, `PersonalizationStatus`, `RevisionSource`, `SuggestionStatus`, `CopilotActionStatus`, `SubscriptionStatus`, `JobStatus`, `EvidenceSourceType`, `ClaimStatus`, `ScoreTier`, `StepCondition`, `ThreadMode`, `PersonalizationMode`, `CampaignStatus`, `ReviewMode`, `EnrollmentStatus`, `OutboundStatus`, `ApprovalStatus`, `FactCheckStatus`, `ConversationStatus`, `MessageDirection`, `ReplyCategory`, `EmailEventType`, `SuppressionType`, `SuppressionReason`, `OpportunityStage`, `TaskStatus`, `TaskPriority`, `ActorType`, `PrivacyRequestType`, `DeliveryStatus`

## Integrity observations

Schema contains UUID primary keys, PostgreSQL JSON/arrays, unique constraints, indexes, foreign keys and explicit delete actions. Workspace-owned entities generally have `workspaceId`; some child relations are protected through service-layer scoping rather than composite foreign keys. This means model presence alone does not enforce all same-workspace relationship invariants.

Migration SQL was not run against a disposable database in this environment. No destructive migration was executed. Existing populated upgrade safety, grant behavior, `pg_trgm` permission, FK edge cases, backup/restore and persistence are **NOT TESTED**. The current test setup points to a separate `emn_test` database by default, but no server is listening at the configured port.
