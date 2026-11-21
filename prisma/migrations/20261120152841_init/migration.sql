-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "WorkspaceRole" AS ENUM ('OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "DnsCheckStatus" AS ENUM ('UNKNOWN', 'PASS', 'WARN', 'FAIL');

-- CreateEnum
CREATE TYPE "HealthStatus" AS ENUM ('UNKNOWN', 'HEALTHY', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "EmailProviderType" AS ENUM ('GMAIL', 'MICROSOFT', 'SMTP_IMAP');

-- CreateEnum
CREATE TYPE "EmailAccountStatus" AS ENUM ('CONNECTED', 'NEEDS_REAUTH', 'ERROR', 'PAUSED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "AiProviderType" AS ENUM ('OPENAI', 'ANTHROPIC');

-- CreateEnum
CREATE TYPE "AiTask" AS ENUM ('ICP_FROM_TEXT', 'FACT_EXTRACTION', 'LEAD_QUALIFICATION', 'EMAIL_WRITING', 'SUBJECT_LINES', 'FOLLOWUP_WRITING', 'FACT_CHECK', 'REPLY_CLASSIFICATION', 'CONVERSATION_SUMMARY', 'REPLY_DRAFT');

-- CreateEnum
CREATE TYPE "AiExecutionStatus" AS ENUM ('SUCCEEDED', 'FAILED', 'SCHEMA_INVALID', 'BLOCKED');

-- CreateEnum
CREATE TYPE "LeadSourceType" AS ENUM ('CSV_IMPORT', 'MANUAL', 'API', 'PROVIDER_SEARCH');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'RESEARCHED', 'QUALIFIED', 'DISQUALIFIED', 'CONTACTED', 'REPLIED', 'INTERESTED', 'MEETING_BOOKED', 'NOT_INTERESTED', 'CUSTOMER', 'UNSUBSCRIBED', 'BOUNCED');

-- CreateEnum
CREATE TYPE "EmailVerificationStatus" AS ENUM ('UNVERIFIED', 'VALID', 'INVALID', 'RISKY', 'CATCH_ALL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "LawfulBasis" AS ENUM ('UNKNOWN', 'CONSENT', 'LEGITIMATE_INTEREST', 'EXISTING_RELATIONSHIP', 'NOT_REQUIRED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EvidenceSourceType" AS ENUM ('WEBSITE', 'SEARCH_RESULT', 'DATA_PROVIDER', 'USER_PROVIDED');

-- CreateEnum
CREATE TYPE "ClaimStatus" AS ENUM ('SUPPORTED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ScoreTier" AS ENUM ('A', 'B', 'C', 'D');

-- CreateEnum
CREATE TYPE "StepCondition" AS ENUM ('ALWAYS', 'IF_OPENED', 'IF_NOT_OPENED');

-- CreateEnum
CREATE TYPE "ThreadMode" AS ENUM ('NEW_THREAD', 'REPLY_IN_THREAD');

-- CreateEnum
CREATE TYPE "PersonalizationMode" AS ENUM ('TEMPLATE_ONLY', 'AI_FIRST_LINE', 'AI_FULL');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ReviewMode" AS ENUM ('NONE', 'AI_CONTENT_ONLY', 'ALL');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'STOPPED_REPLIED', 'STOPPED_BOUNCED', 'STOPPED_UNSUBSCRIBED', 'STOPPED_SUPPRESSED', 'STOPPED_COMPLAINT', 'STOPPED_INELIGIBLE', 'STOPPED_MANUAL', 'FAILED');

-- CreateEnum
CREATE TYPE "OutboundStatus" AS ENUM ('PENDING', 'AWAITING_APPROVAL', 'QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "FactCheckStatus" AS ENUM ('NOT_REQUIRED', 'PASSED', 'FAILED');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('OPEN', 'WAITING', 'CLOSED');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "ReplyCategory" AS ENUM ('INTERESTED', 'WANTS_PRICING', 'WANTS_MEETING', 'NEEDS_INFO', 'NOT_INTERESTED', 'HAS_PROVIDER', 'WRONG_PERSON', 'OUT_OF_OFFICE', 'UNSUBSCRIBE', 'COMPLAINT', 'OTHER');

-- CreateEnum
CREATE TYPE "EmailEventType" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'BOUNCED_HARD', 'BOUNCED_SOFT', 'REPLIED', 'AUTO_REPLIED', 'UNSUBSCRIBED', 'COMPLAINED', 'OPENED', 'CLICKED');

-- CreateEnum
CREATE TYPE "SuppressionType" AS ENUM ('EMAIL', 'DOMAIN');

-- CreateEnum
CREATE TYPE "SuppressionReason" AS ENUM ('UNSUBSCRIBED', 'HARD_BOUNCE', 'COMPLAINT', 'DO_NOT_CONTACT_REQUEST', 'MANUAL', 'LEGAL');

-- CreateEnum
CREATE TYPE "OpportunityStage" AS ENUM ('NEW', 'QUALIFIED', 'MEETING', 'PROPOSAL', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'WORKER', 'API');

-- CreateEnum
CREATE TYPE "PrivacyRequestType" AS ENUM ('EXPORT', 'ERASURE');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfToken" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "activeWorkspaceId" UUID,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "senderLegalName" TEXT,
    "postalAddress" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceMember" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "WorkspaceRole" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceInvitation" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "invitedById" UUID NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "role" "WorkspaceRole" NOT NULL DEFAULT 'MEMBER',
    "lastUsedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Domain" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "healthStatus" "HealthStatus" NOT NULL DEFAULT 'UNKNOWN',
    "spfStatus" "DnsCheckStatus" NOT NULL DEFAULT 'UNKNOWN',
    "dkimStatus" "DnsCheckStatus" NOT NULL DEFAULT 'UNKNOWN',
    "dmarcStatus" "DnsCheckStatus" NOT NULL DEFAULT 'UNKNOWN',
    "mxStatus" "DnsCheckStatus" NOT NULL DEFAULT 'UNKNOWN',
    "dkimSelectors" TEXT[] DEFAULT ARRAY['google', 'selector1', 'selector2', 'default']::TEXT[],
    "lastCheckedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Domain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DomainHealthCheck" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "domainId" UUID NOT NULL,
    "spfStatus" "DnsCheckStatus" NOT NULL,
    "spfRecord" TEXT,
    "dkimStatus" "DnsCheckStatus" NOT NULL,
    "dkimResults" JSONB NOT NULL,
    "dmarcStatus" "DnsCheckStatus" NOT NULL,
    "dmarcRecord" TEXT,
    "mxStatus" "DnsCheckStatus" NOT NULL,
    "mxRecords" JSONB NOT NULL,
    "issues" JSONB NOT NULL DEFAULT '[]',
    "checkedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DomainHealthCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailAccount" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "domainId" UUID,
    "provider" "EmailProviderType" NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "displayName" TEXT,
    "replyTo" TEXT,
    "providerAccountId" TEXT,
    "status" "EmailAccountStatus" NOT NULL DEFAULT 'CONNECTED',
    "statusReason" TEXT,
    "dailySendLimit" INTEGER NOT NULL DEFAULT 25,
    "minSecondsBetweenSends" INTEGER NOT NULL DEFAULT 180,
    "sendingWindow" JSONB NOT NULL,
    "signatureText" TEXT,
    "connectionConfig" JSONB NOT NULL DEFAULT '{}',
    "syncCursor" TEXT,
    "watchExpiresAt" TIMESTAMPTZ(3),
    "subscriptionId" TEXT,
    "subscriptionSecretHash" TEXT,
    "lastSyncedAt" TIMESTAMPTZ(3),
    "lastSentAt" TIMESTAMPTZ(3),
    "lastErrorAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "EmailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderCredential" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "emailAccountId" UUID NOT NULL,
    "encryptedAccessToken" TEXT,
    "encryptedRefreshToken" TEXT,
    "encryptedPassword" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(3),
    "scopes" TEXT[],
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ProviderCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiProvider" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "provider" "AiProviderType" NOT NULL,
    "encryptedApiKey" TEXT NOT NULL,
    "keyLast4" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "defaultModel" TEXT NOT NULL,
    "lastTestedAt" TIMESTAMPTZ(3),
    "lastTestOk" BOOLEAN,
    "lastTestError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AiProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiModelRoute" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "task" "AiTask" NOT NULL,
    "provider" "AiProviderType" NOT NULL,
    "model" TEXT NOT NULL,
    "fallbackProvider" "AiProviderType",
    "fallbackModel" TEXT,
    "temperature" DOUBLE PRECISION,
    "maxOutputTokens" INTEGER NOT NULL DEFAULT 1500,
    "monthlyBudgetUsd" DECIMAL(10,2),

    CONSTRAINT "AiModelRoute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiModelPrice" (
    "id" UUID NOT NULL,
    "provider" "AiProviderType" NOT NULL,
    "model" TEXT NOT NULL,
    "inputPerMTokUsd" DECIMAL(12,6) NOT NULL,
    "outputPerMTokUsd" DECIMAL(12,6) NOT NULL,
    "cachedInputPerMTokUsd" DECIMAL(12,6),
    "effectiveFrom" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiModelPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptTemplate" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "task" "AiTask" NOT NULL,
    "version" INTEGER NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "userPromptTemplate" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "changeNote" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiExecution" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "task" "AiTask" NOT NULL,
    "provider" "AiProviderType" NOT NULL,
    "model" TEXT NOT NULL,
    "promptTemplateId" UUID,
    "status" "AiExecutionStatus" NOT NULL,
    "usedFallback" BOOLEAN NOT NULL DEFAULT false,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "cachedTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "costIsEstimate" BOOLEAN NOT NULL DEFAULT true,
    "latencyMs" INTEGER,
    "errorMessage" TEXT,
    "entityType" TEXT,
    "entityId" TEXT,
    "inputPreview" TEXT,
    "output" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "encryptedConfig" TEXT,
    "publicConfig" JSONB NOT NULL DEFAULT '{}',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastTestedAt" TIMESTAMPTZ(3),
    "lastTestOk" BOOLEAN,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "units" INTEGER NOT NULL DEFAULT 1,
    "costUsd" DECIMAL(12,6),
    "isEstimate" BOOLEAN NOT NULL DEFAULT true,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "website" TEXT,
    "linkedinUrl" TEXT,
    "industry" TEXT,
    "employeeCount" INTEGER,
    "country" TEXT,
    "city" TEXT,
    "description" TEXT,
    "services" TEXT[],
    "audience" TEXT,
    "businessModel" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadSource" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "type" "LeadSourceType" NOT NULL,
    "name" TEXT NOT NULL,
    "provider" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "companyId" UUID,
    "sourceId" UUID,
    "ownerId" UUID,
    "email" TEXT NOT NULL,
    "emailNormalized" TEXT NOT NULL,
    "emailVerificationStatus" "EmailVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "emailVerifiedAt" TIMESTAMPTZ(3),
    "firstName" TEXT,
    "lastName" TEXT,
    "title" TEXT,
    "linkedinUrl" TEXT,
    "website" TEXT,
    "phone" TEXT,
    "country" TEXT,
    "city" TEXT,
    "timezone" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "lawfulBasis" "LawfulBasis" NOT NULL DEFAULT 'UNKNOWN',
    "lawfulBasisNote" TEXT,
    "externalId" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "tags" TEXT[],
    "currentScore" INTEGER,
    "lastContactedAt" TIMESTAMPTZ(3),
    "lastRepliedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadStatusChange" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "fromStatus" "LeadStatus",
    "toStatus" "LeadStatus" NOT NULL,
    "reason" TEXT,
    "actorUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailVerification" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "result" "EmailVerificationStatus" NOT NULL,
    "rawResult" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdealCustomerProfile" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "criteria" JSONB NOT NULL,
    "minScore" INTEGER NOT NULL DEFAULT 60,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "IdealCustomerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProspectSearch" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "icpId" UUID,
    "provider" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "results" JSONB NOT NULL DEFAULT '[]',
    "resultCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProspectSearch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadList" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LeadList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadListMember" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "listId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "addedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadListMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "targetListId" UUID,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "fileName" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "headers" TEXT[],
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "options" JSONB NOT NULL DEFAULT '{}',
    "totalRows" INTEGER NOT NULL DEFAULT 0,
    "importedRows" INTEGER NOT NULL DEFAULT 0,
    "updatedRows" INTEGER NOT NULL DEFAULT 0,
    "skippedRows" INTEGER NOT NULL DEFAULT 0,
    "errorRows" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchReport" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "leadId" UUID,
    "companyId" UUID,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "summary" TEXT,
    "services" TEXT[],
    "industry" TEXT,
    "audience" TEXT,
    "businessModel" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "ResearchReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchEvidence" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "sourceType" "EvidenceSourceType" NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "httpStatus" INTEGER,
    "fetchedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResearchClaim" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "reportId" UUID NOT NULL,
    "evidenceId" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "status" "ClaimStatus" NOT NULL DEFAULT 'SUPPORTED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ResearchClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadScore" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "icpId" UUID,
    "score" INTEGER NOT NULL,
    "tier" "ScoreTier" NOT NULL,
    "qualified" BOOLEAN NOT NULL,
    "reasons" JSONB NOT NULL,
    "risks" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Template" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "useLeadTimezone" BOOLEAN NOT NULL DEFAULT true,
    "sendingWindow" JSONB NOT NULL,
    "dailyNewLeadLimit" INTEGER NOT NULL DEFAULT 25,
    "dailySendLimit" INTEGER NOT NULL DEFAULT 100,
    "stopOnReply" BOOLEAN NOT NULL DEFAULT true,
    "stopOnAutoReply" BOOLEAN NOT NULL DEFAULT false,
    "reviewMode" "ReviewMode" NOT NULL DEFAULT 'AI_CONTENT_ONLY',
    "requireFactCheck" BOOLEAN NOT NULL DEFAULT true,
    "trackOpens" BOOLEAN NOT NULL DEFAULT false,
    "trackClicks" BOOLEAN NOT NULL DEFAULT false,
    "requireVerifiedEmail" BOOLEAN NOT NULL DEFAULT true,
    "minLeadScore" INTEGER,
    "maxBounceRatePct" DOUBLE PRECISION NOT NULL DEFAULT 5,
    "maxComplaints" INTEGER NOT NULL DEFAULT 1,
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "approvedContentHash" TEXT,
    "startedAt" TIMESTAMPTZ(3),
    "pausedAt" TIMESTAMPTZ(3),
    "pauseReason" TEXT,
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Sequence" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Sequence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SequenceStep" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "sequenceId" UUID NOT NULL,
    "order" INTEGER NOT NULL,
    "delayDays" INTEGER NOT NULL DEFAULT 0,
    "threadMode" "ThreadMode" NOT NULL DEFAULT 'REPLY_IN_THREAD',
    "personalizationMode" "PersonalizationMode" NOT NULL DEFAULT 'TEMPLATE_ONLY',
    "condition" "StepCondition" NOT NULL DEFAULT 'ALWAYS',

    CONSTRAINT "SequenceStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SequenceStepVariant" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "stepId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "SequenceStepVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignList" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "listId" UUID NOT NULL,

    CONSTRAINT "CampaignList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignEmailAccount" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "emailAccountId" UUID NOT NULL,

    CONSTRAINT "CampaignEmailAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SequenceEnrollment" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "emailAccountId" UUID NOT NULL,
    "variantSeed" INTEGER NOT NULL,
    "status" "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentStepOrder" INTEGER NOT NULL DEFAULT 0,
    "nextActionAt" TIMESTAMPTZ(3),
    "stopReason" TEXT,
    "conversationId" UUID,
    "enrolledAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "SequenceEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundEmail" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "enrollmentId" UUID NOT NULL,
    "stepId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "emailAccountId" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "internetMessageId" TEXT NOT NULL,
    "status" "OutboundStatus" NOT NULL DEFAULT 'PENDING',
    "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "factCheckStatus" "FactCheckStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
    "factCheckReport" JSONB,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT,
    "bodyText" TEXT,
    "usedClaimIds" TEXT[],
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "scheduledFor" TIMESTAMPTZ(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sendStartedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "providerMessageId" TEXT,
    "providerThreadId" TEXT,
    "emailMessageId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OutboundEmail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrackedLink" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "outboundEmailId" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrackedLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "emailAccountId" UUID NOT NULL,
    "leadId" UUID,
    "campaignId" UUID,
    "providerThreadId" TEXT NOT NULL,
    "subject" TEXT,
    "status" "ConversationStatus" NOT NULL DEFAULT 'OPEN',
    "category" "ReplyCategory",
    "isUnread" BOOLEAN NOT NULL DEFAULT true,
    "labels" TEXT[],
    "assigneeId" UUID,
    "summary" TEXT,
    "lastMessageAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "emailAccountId" UUID NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "providerMessageId" TEXT NOT NULL,
    "internetMessageId" TEXT,
    "inReplyTo" TEXT,
    "references" TEXT[],
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT,
    "toAddresses" TEXT[],
    "ccAddresses" TEXT[],
    "subject" TEXT,
    "snippet" TEXT,
    "bodyText" TEXT,
    "bodyHtmlSanitized" TEXT,
    "isAutoReply" BOOLEAN NOT NULL DEFAULT false,
    "isBounce" BOOLEAN NOT NULL DEFAULT false,
    "category" "ReplyCategory",
    "categoryConfidence" DOUBLE PRECISION,
    "sentiment" TEXT,
    "objection" TEXT,
    "meetingInterest" BOOLEAN,
    "sentAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailAttachment" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "providerAttachmentId" TEXT,
    "storageKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailEvent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "type" "EmailEventType" NOT NULL,
    "leadId" UUID,
    "campaignId" UUID,
    "enrollmentId" UUID,
    "outboundEmailId" UUID,
    "emailMessageId" UUID,
    "emailAccountId" UUID,
    "dedupeKey" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuppressionEntry" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "type" "SuppressionType" NOT NULL,
    "value" TEXT NOT NULL,
    "reason" "SuppressionReason" NOT NULL,
    "source" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuppressionEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceRule" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "countryCode" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "sendingAllowed" BOOLEAN NOT NULL DEFAULT false,
    "allowedLawfulBases" "LawfulBasis"[],
    "requirePostalAddress" BOOLEAN NOT NULL DEFAULT true,
    "requireUnsubscribeLink" BOOLEAN NOT NULL DEFAULT true,
    "reviewedByOwner" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ComplianceRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PrivacyRequest" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "type" "PrivacyRequestType" NOT NULL,
    "subjectEmail" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "resultStorageKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "PrivacyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "companyId" UUID,
    "campaignId" UUID,
    "title" TEXT NOT NULL,
    "stage" "OpportunityStage" NOT NULL DEFAULT 'NEW',
    "valueCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "expectedCloseAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "leadId" UUID,
    "companyId" UUID,
    "conversationId" UUID,
    "authorId" UUID,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "TaskPriority" NOT NULL DEFAULT 'MEDIUM',
    "dueAt" TIMESTAMPTZ(3),
    "remindedAt" TIMESTAMPTZ(3),
    "assigneeId" UUID,
    "leadId" UUID,
    "conversationId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRule" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "trigger" TEXT NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "actions" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AutomationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationRun" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "ruleId" UUID NOT NULL,
    "eventKey" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "result" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Webhook" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "events" TEXT[],
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Webhook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "webhookId" UUID NOT NULL,
    "event" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "responseStatus" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMPTZ(3),

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "readAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL,
    "workspaceId" UUID,
    "actorType" "ActorType" NOT NULL,
    "actorUserId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ipAddress" TEXT,
    "requestId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" UUID NOT NULL,
    "workspaceId" UUID,
    "queue" TEXT NOT NULL,
    "jobName" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "error" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ErrorLog" (
    "id" UUID NOT NULL,
    "workspaceId" UUID,
    "source" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "context" JSONB NOT NULL DEFAULT '{}',
    "requestId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ErrorLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceMember_workspaceId_userId_key" ON "WorkspaceMember"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceInvitation_tokenHash_key" ON "WorkspaceInvitation"("tokenHash");

-- CreateIndex
CREATE INDEX "WorkspaceInvitation_workspaceId_email_idx" ON "WorkspaceInvitation"("workspaceId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_prefix_key" ON "ApiKey"("prefix");

-- CreateIndex
CREATE INDEX "ApiKey_workspaceId_idx" ON "ApiKey"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_workspaceId_name_key" ON "Domain"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "DomainHealthCheck_domainId_checkedAt_idx" ON "DomainHealthCheck"("domainId", "checkedAt");

-- CreateIndex
CREATE INDEX "DomainHealthCheck_workspaceId_idx" ON "DomainHealthCheck"("workspaceId");

-- CreateIndex
CREATE INDEX "EmailAccount_subscriptionId_idx" ON "EmailAccount"("subscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailAccount_workspaceId_emailAddress_key" ON "EmailAccount"("workspaceId", "emailAddress");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderCredential_emailAccountId_key" ON "ProviderCredential"("emailAccountId");

-- CreateIndex
CREATE INDEX "ProviderCredential_workspaceId_idx" ON "ProviderCredential"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AiProvider_workspaceId_provider_key" ON "AiProvider"("workspaceId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "AiModelRoute_workspaceId_task_key" ON "AiModelRoute"("workspaceId", "task");

-- CreateIndex
CREATE UNIQUE INDEX "AiModelPrice_provider_model_effectiveFrom_key" ON "AiModelPrice"("provider", "model", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "PromptTemplate_workspaceId_task_version_key" ON "PromptTemplate"("workspaceId", "task", "version");

-- CreateIndex
CREATE INDEX "AiExecution_workspaceId_createdAt_idx" ON "AiExecution"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AiExecution_workspaceId_task_createdAt_idx" ON "AiExecution"("workspaceId", "task", "createdAt");

-- CreateIndex
CREATE INDEX "AiExecution_entityType_entityId_idx" ON "AiExecution"("entityType", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_workspaceId_type_key" ON "Integration"("workspaceId", "type");

-- CreateIndex
CREATE INDEX "UsageRecord_workspaceId_createdAt_idx" ON "UsageRecord"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageRecord_workspaceId_provider_createdAt_idx" ON "UsageRecord"("workspaceId", "provider", "createdAt");

-- CreateIndex
CREATE INDEX "Company_workspaceId_name_idx" ON "Company"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Company_workspaceId_domain_key" ON "Company"("workspaceId", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "LeadSource_workspaceId_name_key" ON "LeadSource"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_status_idx" ON "Lead"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_companyId_idx" ON "Lead"("workspaceId", "companyId");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_createdAt_idx" ON "Lead"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_currentScore_idx" ON "Lead"("workspaceId", "currentScore");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_workspaceId_emailNormalized_key" ON "Lead"("workspaceId", "emailNormalized");

-- CreateIndex
CREATE INDEX "LeadStatusChange_leadId_createdAt_idx" ON "LeadStatusChange"("leadId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadStatusChange_workspaceId_createdAt_idx" ON "LeadStatusChange"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "EmailVerification_leadId_idx" ON "EmailVerification"("leadId");

-- CreateIndex
CREATE INDEX "EmailVerification_workspaceId_createdAt_idx" ON "EmailVerification"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdealCustomerProfile_workspaceId_name_key" ON "IdealCustomerProfile"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "ProspectSearch_workspaceId_createdAt_idx" ON "ProspectSearch"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LeadList_workspaceId_name_key" ON "LeadList"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "LeadListMember_workspaceId_idx" ON "LeadListMember"("workspaceId");

-- CreateIndex
CREATE INDEX "LeadListMember_leadId_idx" ON "LeadListMember"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadListMember_listId_leadId_key" ON "LeadListMember"("listId", "leadId");

-- CreateIndex
CREATE INDEX "ImportJob_workspaceId_createdAt_idx" ON "ImportJob"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ResearchReport_workspaceId_leadId_idx" ON "ResearchReport"("workspaceId", "leadId");

-- CreateIndex
CREATE INDEX "ResearchReport_workspaceId_companyId_idx" ON "ResearchReport"("workspaceId", "companyId");

-- CreateIndex
CREATE INDEX "ResearchEvidence_reportId_idx" ON "ResearchEvidence"("reportId");

-- CreateIndex
CREATE INDEX "ResearchEvidence_workspaceId_idx" ON "ResearchEvidence"("workspaceId");

-- CreateIndex
CREATE INDEX "ResearchClaim_reportId_status_idx" ON "ResearchClaim"("reportId", "status");

-- CreateIndex
CREATE INDEX "ResearchClaim_workspaceId_idx" ON "ResearchClaim"("workspaceId");

-- CreateIndex
CREATE INDEX "LeadScore_workspaceId_leadId_createdAt_idx" ON "LeadScore"("workspaceId", "leadId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Template_workspaceId_name_key" ON "Template"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "Campaign_workspaceId_status_idx" ON "Campaign"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Sequence_campaignId_key" ON "Sequence"("campaignId");

-- CreateIndex
CREATE INDEX "SequenceStep_workspaceId_idx" ON "SequenceStep"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SequenceStep_sequenceId_order_key" ON "SequenceStep"("sequenceId", "order");

-- CreateIndex
CREATE INDEX "SequenceStepVariant_workspaceId_idx" ON "SequenceStepVariant"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SequenceStepVariant_stepId_label_key" ON "SequenceStepVariant"("stepId", "label");

-- CreateIndex
CREATE INDEX "CampaignList_workspaceId_idx" ON "CampaignList"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignList_campaignId_listId_key" ON "CampaignList"("campaignId", "listId");

-- CreateIndex
CREATE INDEX "CampaignEmailAccount_workspaceId_idx" ON "CampaignEmailAccount"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignEmailAccount_campaignId_emailAccountId_key" ON "CampaignEmailAccount"("campaignId", "emailAccountId");

-- CreateIndex
CREATE INDEX "SequenceEnrollment_status_nextActionAt_idx" ON "SequenceEnrollment"("status", "nextActionAt");

-- CreateIndex
CREATE INDEX "SequenceEnrollment_workspaceId_campaignId_status_idx" ON "SequenceEnrollment"("workspaceId", "campaignId", "status");

-- CreateIndex
CREATE INDEX "SequenceEnrollment_leadId_idx" ON "SequenceEnrollment"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "SequenceEnrollment_campaignId_leadId_key" ON "SequenceEnrollment"("campaignId", "leadId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundEmail_idempotencyKey_key" ON "OutboundEmail"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundEmail_internetMessageId_key" ON "OutboundEmail"("internetMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundEmail_emailMessageId_key" ON "OutboundEmail"("emailMessageId");

-- CreateIndex
CREATE INDEX "OutboundEmail_status_scheduledFor_idx" ON "OutboundEmail"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "OutboundEmail_workspaceId_campaignId_status_idx" ON "OutboundEmail"("workspaceId", "campaignId", "status");

-- CreateIndex
CREATE INDEX "OutboundEmail_emailAccountId_sentAt_idx" ON "OutboundEmail"("emailAccountId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundEmail_enrollmentId_stepId_key" ON "OutboundEmail"("enrollmentId", "stepId");

-- CreateIndex
CREATE UNIQUE INDEX "TrackedLink_token_key" ON "TrackedLink"("token");

-- CreateIndex
CREATE INDEX "TrackedLink_workspaceId_idx" ON "TrackedLink"("workspaceId");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_lastMessageAt_idx" ON "Conversation"("workspaceId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_status_isUnread_idx" ON "Conversation"("workspaceId", "status", "isUnread");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_emailAccountId_providerThreadId_key" ON "Conversation"("emailAccountId", "providerThreadId");

-- CreateIndex
CREATE INDEX "EmailMessage_internetMessageId_idx" ON "EmailMessage"("internetMessageId");

-- CreateIndex
CREATE INDEX "EmailMessage_conversationId_sentAt_idx" ON "EmailMessage"("conversationId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_emailAccountId_providerMessageId_key" ON "EmailMessage"("emailAccountId", "providerMessageId");

-- CreateIndex
CREATE INDEX "EmailAttachment_messageId_idx" ON "EmailAttachment"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailEvent_dedupeKey_key" ON "EmailEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "EmailEvent_workspaceId_type_occurredAt_idx" ON "EmailEvent"("workspaceId", "type", "occurredAt");

-- CreateIndex
CREATE INDEX "EmailEvent_campaignId_type_idx" ON "EmailEvent"("campaignId", "type");

-- CreateIndex
CREATE INDEX "EmailEvent_emailAccountId_type_occurredAt_idx" ON "EmailEvent"("emailAccountId", "type", "occurredAt");

-- CreateIndex
CREATE INDEX "EmailEvent_leadId_idx" ON "EmailEvent"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "SuppressionEntry_workspaceId_type_value_key" ON "SuppressionEntry"("workspaceId", "type", "value");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceRule_workspaceId_countryCode_key" ON "ComplianceRule"("workspaceId", "countryCode");

-- CreateIndex
CREATE INDEX "PrivacyRequest_workspaceId_subjectEmail_idx" ON "PrivacyRequest"("workspaceId", "subjectEmail");

-- CreateIndex
CREATE INDEX "Opportunity_workspaceId_stage_idx" ON "Opportunity"("workspaceId", "stage");

-- CreateIndex
CREATE INDEX "Note_workspaceId_leadId_idx" ON "Note"("workspaceId", "leadId");

-- CreateIndex
CREATE INDEX "Note_conversationId_idx" ON "Note"("conversationId");

-- CreateIndex
CREATE INDEX "Task_workspaceId_status_dueAt_idx" ON "Task"("workspaceId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "AutomationRule_workspaceId_trigger_idx" ON "AutomationRule"("workspaceId", "trigger");

-- CreateIndex
CREATE INDEX "AutomationRun_workspaceId_createdAt_idx" ON "AutomationRun"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationRun_ruleId_eventKey_key" ON "AutomationRun"("ruleId", "eventKey");

-- CreateIndex
CREATE INDEX "WebhookDelivery_webhookId_createdAt_idx" ON "WebhookDelivery"("webhookId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "JobRun_workspaceId_createdAt_idx" ON "JobRun"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "JobRun_queue_status_createdAt_idx" ON "JobRun"("queue", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ErrorLog_workspaceId_createdAt_idx" ON "ErrorLog"("workspaceId", "createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvitation" ADD CONSTRAINT "WorkspaceInvitation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvitation" ADD CONSTRAINT "WorkspaceInvitation_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Domain" ADD CONSTRAINT "Domain_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainHealthCheck" ADD CONSTRAINT "DomainHealthCheck_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DomainHealthCheck" ADD CONSTRAINT "DomainHealthCheck_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAccount" ADD CONSTRAINT "EmailAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAccount" ADD CONSTRAINT "EmailAccount_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "Domain"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCredential" ADD CONSTRAINT "ProviderCredential_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderCredential" ADD CONSTRAINT "ProviderCredential_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiProvider" ADD CONSTRAINT "AiProvider_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiModelRoute" ADD CONSTRAINT "AiModelRoute_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptTemplate" ADD CONSTRAINT "PromptTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiExecution" ADD CONSTRAINT "AiExecution_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiExecution" ADD CONSTRAINT "AiExecution_promptTemplateId_fkey" FOREIGN KEY ("promptTemplateId") REFERENCES "PromptTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSource" ADD CONSTRAINT "LeadSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "LeadSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadStatusChange" ADD CONSTRAINT "LeadStatusChange_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadStatusChange" ADD CONSTRAINT "LeadStatusChange_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailVerification" ADD CONSTRAINT "EmailVerification_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailVerification" ADD CONSTRAINT "EmailVerification_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IdealCustomerProfile" ADD CONSTRAINT "IdealCustomerProfile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectSearch" ADD CONSTRAINT "ProspectSearch_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectSearch" ADD CONSTRAINT "ProspectSearch_icpId_fkey" FOREIGN KEY ("icpId") REFERENCES "IdealCustomerProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadList" ADD CONSTRAINT "LeadList_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadListMember" ADD CONSTRAINT "LeadListMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadListMember" ADD CONSTRAINT "LeadListMember_listId_fkey" FOREIGN KEY ("listId") REFERENCES "LeadList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadListMember" ADD CONSTRAINT "LeadListMember_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchReport" ADD CONSTRAINT "ResearchReport_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchReport" ADD CONSTRAINT "ResearchReport_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchReport" ADD CONSTRAINT "ResearchReport_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchEvidence" ADD CONSTRAINT "ResearchEvidence_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchEvidence" ADD CONSTRAINT "ResearchEvidence_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "ResearchReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchClaim" ADD CONSTRAINT "ResearchClaim_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchClaim" ADD CONSTRAINT "ResearchClaim_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "ResearchReport"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResearchClaim" ADD CONSTRAINT "ResearchClaim_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "ResearchEvidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadScore" ADD CONSTRAINT "LeadScore_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadScore" ADD CONSTRAINT "LeadScore_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadScore" ADD CONSTRAINT "LeadScore_icpId_fkey" FOREIGN KEY ("icpId") REFERENCES "IdealCustomerProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sequence" ADD CONSTRAINT "Sequence_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Sequence" ADD CONSTRAINT "Sequence_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceStep" ADD CONSTRAINT "SequenceStep_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceStep" ADD CONSTRAINT "SequenceStep_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "Sequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceStepVariant" ADD CONSTRAINT "SequenceStepVariant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceStepVariant" ADD CONSTRAINT "SequenceStepVariant_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "SequenceStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignList" ADD CONSTRAINT "CampaignList_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignList" ADD CONSTRAINT "CampaignList_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignList" ADD CONSTRAINT "CampaignList_listId_fkey" FOREIGN KEY ("listId") REFERENCES "LeadList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignEmailAccount" ADD CONSTRAINT "CampaignEmailAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignEmailAccount" ADD CONSTRAINT "CampaignEmailAccount_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignEmailAccount" ADD CONSTRAINT "CampaignEmailAccount_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceEnrollment" ADD CONSTRAINT "SequenceEnrollment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceEnrollment" ADD CONSTRAINT "SequenceEnrollment_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceEnrollment" ADD CONSTRAINT "SequenceEnrollment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceEnrollment" ADD CONSTRAINT "SequenceEnrollment_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceEnrollment" ADD CONSTRAINT "SequenceEnrollment_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundEmail" ADD CONSTRAINT "OutboundEmail_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundEmail" ADD CONSTRAINT "OutboundEmail_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundEmail" ADD CONSTRAINT "OutboundEmail_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "SequenceEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundEmail" ADD CONSTRAINT "OutboundEmail_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "SequenceStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundEmail" ADD CONSTRAINT "OutboundEmail_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "SequenceStepVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundEmail" ADD CONSTRAINT "OutboundEmail_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundEmail" ADD CONSTRAINT "OutboundEmail_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedLink" ADD CONSTRAINT "TrackedLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrackedLink" ADD CONSTRAINT "TrackedLink_outboundEmailId_fkey" FOREIGN KEY ("outboundEmailId") REFERENCES "OutboundEmail"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAttachment" ADD CONSTRAINT "EmailAttachment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailAttachment" ADD CONSTRAINT "EmailAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "EmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "SequenceEnrollment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_outboundEmailId_fkey" FOREIGN KEY ("outboundEmailId") REFERENCES "OutboundEmail"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "EmailMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailEvent" ADD CONSTRAINT "EmailEvent_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuppressionEntry" ADD CONSTRAINT "SuppressionEntry_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceRule" ADD CONSTRAINT "ComplianceRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrivacyRequest" ADD CONSTRAINT "PrivacyRequest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "AutomationRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Webhook" ADD CONSTRAINT "Webhook_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_webhookId_fkey" FOREIGN KEY ("webhookId") REFERENCES "Webhook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ErrorLog" ADD CONSTRAINT "ErrorLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
