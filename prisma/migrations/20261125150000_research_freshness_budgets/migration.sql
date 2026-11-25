ALTER TABLE "ResearchReport"
  ADD COLUMN "subjectFingerprint" CHAR(64),
  ADD COLUMN "researchDepth" TEXT NOT NULL DEFAULT 'INITIAL',
  ADD COLUMN "searchCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pageCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "ResearchReport_workspace_lead_fingerprint_completed_idx"
  ON "ResearchReport"("workspaceId","leadId","subjectFingerprint","completedAt");
CREATE INDEX "ResearchReport_workspace_company_fingerprint_completed_idx"
  ON "ResearchReport"("workspaceId","companyId","subjectFingerprint","completedAt");

ALTER TABLE "ResearchReport"
  ADD CONSTRAINT "ResearchReport_researchDepth_check" CHECK ("researchDepth" IN ('INITIAL','DEEP')),
  ADD CONSTRAINT "ResearchReport_researchCounters_check" CHECK ("searchCount" >= 0 AND "pageCount" >= 0);

CREATE UNIQUE INDEX "IntelligenceEmbedding_one_current_version_idx"
  ON "IntelligenceEmbedding"("workspaceId","entityType","entityId","embeddingModel")
  WHERE "isCurrent" = TRUE;
