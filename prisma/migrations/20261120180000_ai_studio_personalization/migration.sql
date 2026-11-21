-- CreateEnum
CREATE TYPE "AiConfigKind" AS ENUM ('KNOWLEDGE', 'WRITING', 'RESEARCH');

-- CreateEnum
CREATE TYPE "PersonalizationStatus" AS ENUM ('QUEUED', 'GENERATING', 'NEEDS_RESEARCH', 'GENERATED', 'BLOCKED', 'APPROVED', 'REJECTED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "RevisionSource" AS ENUM ('AI', 'MANUAL');

-- AlterEnum
ALTER TYPE "AiTask" ADD VALUE 'PERSONALIZATION';

-- AlterTable
ALTER TABLE "AiExecution" ADD COLUMN     "campaignId" UUID,
ADD COLUMN     "leadId" UUID,
ADD COLUMN     "profileVersionId" UUID;

-- AlterTable
ALTER TABLE "AiModelRoute" ADD COLUMN     "maxInputTokens" INTEGER;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "aiConfigSnapshot" JSONB,
ADD COLUMN     "aiOverrides" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "aiProfileId" UUID,
ADD COLUMN     "aiSnapshotAt" TIMESTAMPTZ(3),
ADD COLUMN     "icpId" UUID,
ADD COLUMN     "maxAiCostPerLeadUsd" DECIMAL(10,4),
ADD COLUMN     "scheduledStartAt" TIMESTAMPTZ(3),
ADD COLUMN     "usePregeneratedAi" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "IdealCustomerProfile" ADD COLUMN     "aiInstructions" TEXT;

-- AlterTable
ALTER TABLE "SequenceStep" ADD COLUMN     "aiInstructions" TEXT;

-- AlterTable
ALTER TABLE "SequenceStepVariant" ADD COLUMN     "aiInstructions" TEXT;

-- CreateTable
CREATE TABLE "AiConfigVersion" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "kind" "AiConfigKind" NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "changeNote" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiConfigVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT,
    "storageKey" TEXT,
    "text" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptProfile" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "activeVersionId" UUID,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "PromptProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptProfileVersion" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "instructions" TEXT NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "changeNote" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptProfileVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadPersonalization" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "leadId" UUID NOT NULL,
    "stepId" UUID NOT NULL,
    "variantId" UUID,
    "status" "PersonalizationStatus" NOT NULL DEFAULT 'QUEUED',
    "subject" TEXT,
    "openingLine" TEXT,
    "body" TEXT,
    "cta" TEXT,
    "subjectAlternatives" TEXT[],
    "usedClaimIds" TEXT[],
    "researchReportIds" TEXT[],
    "quality" JSONB,
    "qualityPassed" BOOLEAN NOT NULL DEFAULT false,
    "score" INTEGER,
    "scoreExplanation" JSONB,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "costIsEstimate" BOOLEAN NOT NULL DEFAULT true,
    "manuallyEdited" BOOLEAN NOT NULL DEFAULT false,
    "editedById" UUID,
    "editedAt" TIMESTAMPTZ(3),
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "approvedContentHash" TEXT,
    "configHash" TEXT,
    "profileVersionId" UUID,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "batchId" UUID,
    "error" TEXT,
    "generatedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "LeadPersonalization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonalizationRevision" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "personalizationId" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "source" "RevisionSource" NOT NULL,
    "subject" TEXT,
    "openingLine" TEXT,
    "body" TEXT,
    "cta" TEXT,
    "usedClaimIds" TEXT[],
    "quality" JSONB,
    "score" INTEGER,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "executionIds" TEXT[],
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PersonalizationRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PersonalizationBatch" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "total" INTEGER NOT NULL DEFAULT 0,
    "done" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "maxCostUsd" DECIMAL(12,4),
    "spentUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "options" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),

    CONSTRAINT "PersonalizationBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SequenceVersion" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "contentHash" TEXT NOT NULL,
    "approvedById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SequenceVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiConfigVersion_workspaceId_kind_isActive_idx" ON "AiConfigVersion"("workspaceId", "kind", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "AiConfigVersion_workspaceId_kind_version_key" ON "AiConfigVersion"("workspaceId", "kind", "version");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_workspaceId_isActive_idx" ON "KnowledgeDocument"("workspaceId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "PromptProfile_workspaceId_name_key" ON "PromptProfile"("workspaceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PromptProfileVersion_profileId_version_key" ON "PromptProfileVersion"("profileId", "version");

-- CreateIndex
CREATE INDEX "LeadPersonalization_workspaceId_campaignId_status_idx" ON "LeadPersonalization"("workspaceId", "campaignId", "status");

-- CreateIndex
CREATE INDEX "LeadPersonalization_batchId_idx" ON "LeadPersonalization"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadPersonalization_campaignId_leadId_stepId_key" ON "LeadPersonalization"("campaignId", "leadId", "stepId");

-- CreateIndex
CREATE UNIQUE INDEX "PersonalizationRevision_personalizationId_revision_key" ON "PersonalizationRevision"("personalizationId", "revision");

-- CreateIndex
CREATE INDEX "PersonalizationBatch_workspaceId_campaignId_idx" ON "PersonalizationBatch"("workspaceId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "SequenceVersion_campaignId_version_key" ON "SequenceVersion"("campaignId", "version");

-- CreateIndex
CREATE INDEX "AiExecution_workspaceId_campaignId_leadId_idx" ON "AiExecution"("workspaceId", "campaignId", "leadId");

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_icpId_fkey" FOREIGN KEY ("icpId") REFERENCES "IdealCustomerProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_aiProfileId_fkey" FOREIGN KEY ("aiProfileId") REFERENCES "PromptProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiConfigVersion" ADD CONSTRAINT "AiConfigVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptProfile" ADD CONSTRAINT "PromptProfile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptProfileVersion" ADD CONSTRAINT "PromptProfileVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptProfileVersion" ADD CONSTRAINT "PromptProfileVersion_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PromptProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadPersonalization" ADD CONSTRAINT "LeadPersonalization_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadPersonalization" ADD CONSTRAINT "LeadPersonalization_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadPersonalization" ADD CONSTRAINT "LeadPersonalization_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadPersonalization" ADD CONSTRAINT "LeadPersonalization_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "SequenceStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadPersonalization" ADD CONSTRAINT "LeadPersonalization_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "SequenceStepVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalizationRevision" ADD CONSTRAINT "PersonalizationRevision_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalizationRevision" ADD CONSTRAINT "PersonalizationRevision_personalizationId_fkey" FOREIGN KEY ("personalizationId") REFERENCES "LeadPersonalization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalizationBatch" ADD CONSTRAINT "PersonalizationBatch_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PersonalizationBatch" ADD CONSTRAINT "PersonalizationBatch_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceVersion" ADD CONSTRAINT "SequenceVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SequenceVersion" ADD CONSTRAINT "SequenceVersion_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

