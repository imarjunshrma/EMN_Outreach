ALTER TABLE "KnowledgeImportSession"
  ADD COLUMN "processingStep" TEXT,
  ADD COLUMN "progress" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "run" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "applyActor" JSONB,
  ADD COLUMN "extractionRoute" JSONB;

ALTER TABLE "KnowledgeImportFile"
  ADD COLUMN "content" BYTEA,
  ADD COLUMN "parsedRows" JSONB,
  ADD COLUMN "extracted" JSONB,
  ADD COLUMN "error" TEXT,
  ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PENDING';

ALTER TABLE "KnowledgeImportItem"
  ADD COLUMN "extractionKey" TEXT,
  ADD COLUMN "stableKey" TEXT,
  ADD COLUMN "classification" TEXT,
  ADD COLUMN "verificationStatus" TEXT,
  ADD COLUMN "relationships" JSONB,
  ADD COLUMN "mappingExplanation" TEXT,
  ADD COLUMN "duplicateCandidates" JSONB,
  ADD COLUMN "reviewNote" TEXT,
  ADD COLUMN "destinationEntityId" TEXT,
  ADD COLUMN "destinationDocumentId" TEXT,
  ADD COLUMN "applicationResult" TEXT,
  ADD COLUMN "error" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "KnowledgeImportItem_sessionId_extractionKey_key"
  ON "KnowledgeImportItem"("sessionId", "extractionKey");
