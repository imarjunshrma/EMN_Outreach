-- CreateEnum
CREATE TYPE "SuggestionStatus" AS ENUM ('PENDING', 'APPROVED', 'SENT', 'DISMISSED', 'FAILED');

-- CreateEnum
CREATE TYPE "CopilotActionStatus" AS ENUM ('PROPOSED', 'EXECUTED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'INCOMPLETE');

-- AlterEnum
ALTER TYPE "AiTask" ADD VALUE 'COPILOT';

-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "scopes" TEXT[];

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "folder" TEXT,
ADD COLUMN     "tags" TEXT[];

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "isArchived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isStarred" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Domain" ADD COLUMN     "autoRenew" BOOLEAN,
ADD COLUMN     "dnsProvider" TEXT,
ADD COLUMN     "dnsZoneId" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMPTZ(3),
ADD COLUMN     "propagation" JSONB,
ADD COLUMN     "registrar" TEXT,
ADD COLUMN     "renewalNotifiedAt" TIMESTAMPTZ(3),
ADD COLUMN     "verificationToken" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "EmailAccount" ADD COLUMN     "lastReceivedAt" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "EmailVerification" ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "costCredits" DOUBLE PRECISION,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'VERIFY',
ADD COLUMN     "step" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerifiedAt" TIMESTAMPTZ(3),
ADD COLUMN     "mfaEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mfaEnabledAt" TIMESTAMPTZ(3),
ADD COLUMN     "mfaRecoveryHashes" TEXT[],
ADD COLUMN     "mfaSecretEnc" TEXT;

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "workspaceId" UUID,
    "kind" TEXT NOT NULL DEFAULT 'RESET',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "usedAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "ip" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplyTemplate" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "categories" TEXT[],
    "isApproved" BOOLEAN NOT NULL DEFAULT false,
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ReplyTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReplySuggestion" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "category" TEXT,
    "body" TEXT NOT NULL,
    "templateId" UUID,
    "status" "SuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "decidedById" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplySuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopilotThread" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CopilotThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopilotMessage" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "data" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopilotMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopilotAction" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "threadId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "requiredRole" TEXT NOT NULL,
    "status" "CopilotActionStatus" NOT NULL DEFAULT 'PROPOSED',
    "result" JSONB,
    "executedById" UUID,
    "executedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopilotAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopilotMemory" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopilotMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workflow" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "activeVersionId" UUID,
    "maxRunsPerDay" INTEGER NOT NULL DEFAULT 1000,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Workflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowVersion" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "graph" JSONB NOT NULL,
    "changeNote" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkflowVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkflowRun" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "workflowId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "dedupeKey" TEXT,
    "event" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'RUNNING',
    "testMode" BOOLEAN NOT NULL DEFAULT false,
    "log" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "WorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priceMonthlyCents" INTEGER NOT NULL,
    "priceYearlyCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "entitlements" JSONB NOT NULL,
    "trialDays" INTEGER NOT NULL DEFAULT 14,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "providerPriceIds" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "planId" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "interval" TEXT NOT NULL DEFAULT 'month',
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "providerCustomerId" TEXT,
    "providerSubscriptionId" TEXT,
    "currentPeriodEnd" TIMESTAMPTZ(3),
    "trialEndsAt" TIMESTAMPTZ(3),
    "graceUntil" TIMESTAMPTZ(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "overrides" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "providerInvoiceId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "hostedUrl" TEXT,
    "periodStart" TIMESTAMPTZ(3),
    "periodEnd" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingEvent" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "processedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedFilter" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "entity" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" JSONB NOT NULL,
    "isShared" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SavedFilter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledReport" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "recipients" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastSentAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScheduledReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationChannel" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "encryptedConfig" TEXT NOT NULL,
    "events" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationChannel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_kind_idx" ON "PasswordResetToken"("userId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ReplyTemplate_workspaceId_name_key" ON "ReplyTemplate"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "ReplySuggestion_workspaceId_status_idx" ON "ReplySuggestion"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReplySuggestion_messageId_mode_key" ON "ReplySuggestion"("messageId", "mode");

-- CreateIndex
CREATE INDEX "CopilotThread_workspaceId_userId_idx" ON "CopilotThread"("workspaceId", "userId");

-- CreateIndex
CREATE INDEX "CopilotMessage_threadId_createdAt_idx" ON "CopilotMessage"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "CopilotAction_workspaceId_status_idx" ON "CopilotAction"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "CopilotMemory_workspaceId_idx" ON "CopilotMemory"("workspaceId");

-- CreateIndex
CREATE INDEX "Workflow_workspaceId_trigger_isActive_idx" ON "Workflow"("workspaceId", "trigger", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Workflow_workspaceId_name_key" ON "Workflow"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowVersion_workflowId_version_key" ON "WorkflowVersion"("workflowId", "version");

-- CreateIndex
CREATE INDEX "WorkflowRun_workspaceId_startedAt_idx" ON "WorkflowRun"("workspaceId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowRun_workflowId_dedupeKey_key" ON "WorkflowRun"("workflowId", "dedupeKey");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_code_key" ON "Plan"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_workspaceId_key" ON "Subscription"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_providerSubscriptionId_key" ON "Subscription"("providerSubscriptionId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_providerInvoiceId_key" ON "Invoice"("providerInvoiceId");

-- CreateIndex
CREATE INDEX "Invoice_workspaceId_createdAt_idx" ON "Invoice"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingEvent_provider_eventId_key" ON "BillingEvent"("provider", "eventId");

-- CreateIndex
CREATE INDEX "SavedFilter_workspaceId_entity_idx" ON "SavedFilter"("workspaceId", "entity");

-- AddForeignKey
ALTER TABLE "PasswordResetToken" ADD CONSTRAINT "PasswordResetToken_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplyTemplate" ADD CONSTRAINT "ReplyTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReplySuggestion" ADD CONSTRAINT "ReplySuggestion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopilotThread" ADD CONSTRAINT "CopilotThread_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopilotMessage" ADD CONSTRAINT "CopilotMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopilotMessage" ADD CONSTRAINT "CopilotMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "CopilotThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopilotAction" ADD CONSTRAINT "CopilotAction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopilotAction" ADD CONSTRAINT "CopilotAction_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "CopilotThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopilotMemory" ADD CONSTRAINT "CopilotMemory_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowRun" ADD CONSTRAINT "WorkflowRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "Workflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedFilter" ADD CONSTRAINT "SavedFilter_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledReport" ADD CONSTRAINT "ScheduledReport_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationChannel" ADD CONSTRAINT "NotificationChannel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

