CREATE TABLE "OutreachRule" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "condition" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "triggerTerms" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "OutreachRule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OutreachRule_workspaceId_status_category_priority_idx" ON "OutreachRule"("workspaceId", "status", "category", "priority");
ALTER TABLE "OutreachRule" ADD CONSTRAINT "OutreachRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OutreachExample" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "correctedContent" TEXT,
    "category" TEXT NOT NULL,
    "polarity" TEXT NOT NULL,
    "explanation" TEXT,
    "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "OutreachExample_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OutreachExample_workspaceId_isActive_category_polarity_idx" ON "OutreachExample"("workspaceId", "isActive", "category", "polarity");
ALTER TABLE "OutreachExample" ADD CONSTRAINT "OutreachExample_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OutreachFeedback" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "personalizationId" UUID NOT NULL,
    "feedbackType" TEXT NOT NULL,
    "originalContent" JSONB NOT NULL,
    "finalContent" JSONB NOT NULL,
    "changedFields" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "explanation" TEXT,
    "scope" TEXT NOT NULL DEFAULT 'CAMPAIGN',
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutreachFeedback_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OutreachFeedback_workspaceId_feedbackType_createdAt_idx" ON "OutreachFeedback"("workspaceId", "feedbackType", "createdAt");
CREATE INDEX "OutreachFeedback_workspaceId_personalizationId_idx" ON "OutreachFeedback"("workspaceId", "personalizationId");
ALTER TABLE "OutreachFeedback" ADD CONSTRAINT "OutreachFeedback_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OutreachFeedback" ADD CONSTRAINT "OutreachFeedback_personalizationId_fkey" FOREIGN KEY ("personalizationId") REFERENCES "LeadPersonalization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AiLearningSuggestion" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "signature" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "sampleCount" INTEGER NOT NULL,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "AiLearningSuggestion_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AiLearningSuggestion_workspaceId_signature_key" ON "AiLearningSuggestion"("workspaceId", "signature");
CREATE INDEX "AiLearningSuggestion_workspaceId_status_createdAt_idx" ON "AiLearningSuggestion"("workspaceId", "status", "createdAt");
ALTER TABLE "AiLearningSuggestion" ADD CONSTRAINT "AiLearningSuggestion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
