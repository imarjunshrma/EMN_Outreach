-- Personal AI subscriptions (Claude / Codex), customizable AI workflows, writing playbook versions, workflow runs.
-- Additive only: new enums and tables; no existing table is altered.
-- CreateEnum
CREATE TYPE "AiSubscriptionProvider" AS ENUM ('CLAUDE_SUBSCRIPTION', 'CODEX_SUBSCRIPTION');

-- CreateEnum
CREATE TYPE "AiSubscriptionStatus" AS ENUM ('DISCONNECTED', 'CONNECTING', 'CONNECTED', 'EXPIRED', 'USAGE_LIMITED', 'ERROR');

-- CreateEnum
CREATE TYPE "AiWorkflowRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PAUSED', 'PAUSED_LIMIT', 'CANCELLED');

-- CreateTable
CREATE TABLE "AiSubscriptionConnection" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "provider" "AiSubscriptionProvider" NOT NULL,
    "status" "AiSubscriptionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "encryptedCredential" TEXT,
    "credentialHint" TEXT,
    "accountLabel" TEXT,
    "model" TEXT,
    "concurrency" INTEGER NOT NULL DEFAULT 1,
    "delayMs" INTEGER NOT NULL DEFAULT 3000,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "connectedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3),
    "lastTestedAt" TIMESTAMPTZ(3),
    "lastTestOk" BOOLEAN,
    "lastError" TEXT,
    "limitResetsAt" TIMESTAMPTZ(3),
    "limitType" TEXT,
    "utilization" DOUBLE PRECISION,
    "lastUsedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AiSubscriptionConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiWorkflow" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "presetKey" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "stages" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AiWorkflow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiStageTemplate" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "stage" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiStageTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiPlaybookVersion" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "note" TEXT,
    "isCurrent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiPlaybookVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiWorkflowRun" (
    "id" UUID NOT NULL,
    "ownerUserId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "campaignId" UUID,
    "workflowId" UUID,
    "workflowName" TEXT NOT NULL,
    "workflowSnapshot" JSONB NOT NULL,
    "playbookVersionId" UUID,
    "status" "AiWorkflowRunStatus" NOT NULL DEFAULT 'QUEUED',
    "currentStage" INTEGER NOT NULL DEFAULT 0,
    "stageOutputs" JSONB NOT NULL DEFAULT '{}',
    "research" JSONB,
    "variants" JSONB NOT NULL DEFAULT '[]',
    "selectedVariant" INTEGER,
    "draft" JSONB,
    "draftSavedAt" TIMESTAMPTZ(3),
    "pausedReason" TEXT,
    "pausedProvider" TEXT,
    "autoResume" BOOLEAN NOT NULL DEFAULT false,
    "jobToken" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AiWorkflowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiWorkflowStageExecution" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "stageIndex" INTEGER NOT NULL,
    "stageId" TEXT NOT NULL,
    "stageName" TEXT NOT NULL,
    "taskType" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT,
    "status" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "durationMs" INTEGER,
    "errorMessage" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "AiWorkflowStageExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiSubscriptionConnection_ownerUserId_provider_key" ON "AiSubscriptionConnection"("ownerUserId", "provider");

-- CreateIndex
CREATE INDEX "AiWorkflow_ownerUserId_idx" ON "AiWorkflow"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "AiWorkflow_ownerUserId_presetKey_key" ON "AiWorkflow"("ownerUserId", "presetKey");

-- CreateIndex
CREATE INDEX "AiStageTemplate_ownerUserId_idx" ON "AiStageTemplate"("ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "AiPlaybookVersion_ownerUserId_version_key" ON "AiPlaybookVersion"("ownerUserId", "version");

-- CreateIndex
CREATE INDEX "AiWorkflowRun_workspaceId_leadId_idx" ON "AiWorkflowRun"("workspaceId", "leadId");

-- CreateIndex
CREATE INDEX "AiWorkflowRun_ownerUserId_status_idx" ON "AiWorkflowRun"("ownerUserId", "status");

-- CreateIndex
CREATE INDEX "AiWorkflowStageExecution_runId_idx" ON "AiWorkflowStageExecution"("runId");

-- CreateIndex
CREATE INDEX "AiWorkflowStageExecution_workspaceId_startedAt_idx" ON "AiWorkflowStageExecution"("workspaceId", "startedAt");

-- AddForeignKey
ALTER TABLE "AiSubscriptionConnection" ADD CONSTRAINT "AiSubscriptionConnection_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiWorkflow" ADD CONSTRAINT "AiWorkflow_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiStageTemplate" ADD CONSTRAINT "AiStageTemplate_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiPlaybookVersion" ADD CONSTRAINT "AiPlaybookVersion_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiWorkflowRun" ADD CONSTRAINT "AiWorkflowRun_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiWorkflowRun" ADD CONSTRAINT "AiWorkflowRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiWorkflowRun" ADD CONSTRAINT "AiWorkflowRun_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiWorkflowRun" ADD CONSTRAINT "AiWorkflowRun_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiWorkflowRun" ADD CONSTRAINT "AiWorkflowRun_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "AiWorkflow"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiWorkflowRun" ADD CONSTRAINT "AiWorkflowRun_playbookVersionId_fkey" FOREIGN KEY ("playbookVersionId") REFERENCES "AiPlaybookVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiWorkflowStageExecution" ADD CONSTRAINT "AiWorkflowStageExecution_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AiWorkflowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

