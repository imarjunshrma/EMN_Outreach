# Database review

## Inventory

Source inspection only: no migration, CRUD, permission, backup, or restore operation ran against a database during this continuation.

- Provider: PostgreSQL (`prisma/schema.prisma`).
- ORM/client: Prisma 7 with generated client in `backend/src/generated/prisma`, using `@prisma/adapter-pg`.
- Current declarations: **111 models**, **50 enums**, **15 migration directories**.
- Migration directories (15): `20261120152841_init`, `20261120180000_ai_studio_personalization`, `20261120190000_prospect_instructions_prompt_library`, `20261121090000_v1_2_security_ai_workflows_billing`, `20261121120000_v1_3_saas_tenancy`, `20261121150000_v1_4_billing_storage_trials`, `20261121170000_universal_ai_providers`, `20261121190000_ai_outreach_brain`, `20261121193000_first_party_email_verification`, `20261121200000_email_verification_datasets`, `20261121210000_ai_subscriptions_workflows`, `20261122110000_email_verification_batch_repair`, `20261122120000_platform_settings`, `20261123090000_super_admin_impersonation`, `20261124100000_ai_execution_generation_mode`.
- Supplementary SQL: `prisma/sql/001_indexes_and_guards.sql` enables `pg_trgm`, adds GIN/hot-path indexes, and enforces append-only audit rows.
- Fresh seed: `prisma/seed.ts` upserts reference AI model price rows. Workspace defaults are initialized by workspace/account creation services.

## Models

`User`, `Session`, `Workspace`, `WorkspaceMember`, `WorkspaceInvitation`, `ApiKey`, `Domain`, `DomainHealthCheck`, `EmailAccount`, `ProviderCredential`, `AiProvider`, `AiModelRoute`, `AiModelPrice`, `PromptTemplate`, `AiExecution`, `Integration`, `UsageRecord`, `Company`, `LeadSource`, `Lead`, `LeadStatusChange`, `EmailVerification`, `IdealCustomerProfile`, `ProspectSearch`, `LeadList`, `LeadListMember`, `ImportJob`, `ResearchReport`, `ResearchEvidence`, `ResearchClaim`, `LeadScore`, `Template`, `Campaign`, `Sequence`, `SequenceStep`, `SequenceStepVariant`, `CampaignList`, `CampaignEmailAccount`, `SequenceEnrollment`, `OutboundEmail`, `TrackedLink`, `Conversation`, `EmailMessage`, `EmailAttachment`, `EmailEvent`, `SuppressionEntry`, `ComplianceRule`, `PrivacyRequest`, `Opportunity`, `Note`, `Task`, `AutomationRule`, `AutomationRun`, `Webhook`, `WebhookDelivery`, `Notification`, `AuditLog`, `JobRun`, `ErrorLog`, `AiConfigVersion`, `KnowledgeDocument`, `PromptProfile`, `PromptProfileVersion`, `LeadPersonalization`, `PersonalizationRevision`, `PersonalizationBatch`, `SequenceVersion`, `PasswordResetToken`, `ReplyTemplate`, `ReplySuggestion`, `CopilotThread`, `CopilotMessage`, `CopilotAction`, `CopilotMemory`, `Workflow`, `WorkflowVersion`, `WorkflowRun`, `Plan`, `Subscription`, `Invoice`, `BillingEvent`, `SavedFilter`, `ScheduledReport`, `NotificationChannel`

## Enums

`UserStatus`, `WorkspaceRole`, `DnsCheckStatus`, `HealthStatus`, `EmailProviderType`, `EmailAccountStatus`, `AiProviderType`, `AiTask`, `AiExecutionStatus`, `LeadSourceType`, `LeadStatus`, `EmailVerificationStatus`, `LawfulBasis`, `AiConfigKind`, `PersonalizationStatus`, `RevisionSource`, `SuggestionStatus`, `CopilotActionStatus`, `SubscriptionStatus`, `JobStatus`, `EvidenceSourceType`, `ClaimStatus`, `ScoreTier`, `StepCondition`, `ThreadMode`, `PersonalizationMode`, `CampaignStatus`, `ReviewMode`, `EnrollmentStatus`, `OutboundStatus`, `ApprovalStatus`, `FactCheckStatus`, `ConversationStatus`, `MessageDirection`, `ReplyCategory`, `EmailEventType`, `SuppressionType`, `SuppressionReason`, `OpportunityStage`, `TaskStatus`, `TaskPriority`, `ActorType`, `PrivacyRequestType`, `DeliveryStatus`

## Integrity observations

Schema contains UUID primary keys, PostgreSQL JSON/arrays, unique constraints, indexes, foreign keys and explicit delete actions. Workspace-owned entities generally have `workspaceId`; some child relations are protected through service-layer scoping rather than composite foreign keys. This means model presence alone does not enforce all same-workspace relationship invariants.

Migration SQL was not run against a disposable database in this environment. No destructive migration was executed. Existing populated upgrade safety, grant behavior, `pg_trgm` permission, FK edge cases, backup/restore and persistence are **NOT TESTED**. The current test setup points to a separate `emn_test` database by default, but no server is listening at the configured port.
