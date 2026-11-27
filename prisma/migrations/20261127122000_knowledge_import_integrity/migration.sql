ALTER TYPE "KnowledgeImportStatus" ADD VALUE 'CANCELLED';

ALTER TABLE "KnowledgeImportItem" ADD COLUMN "sourceMetadata" JSONB;
CREATE UNIQUE INDEX "KnowledgeImportSession_workspaceId_id_key" ON "KnowledgeImportSession"("workspaceId", "id");
CREATE UNIQUE INDEX "KnowledgeImportFile_workspaceId_sessionId_id_key" ON "KnowledgeImportFile"("workspaceId", "sessionId", "id");

ALTER TABLE "KnowledgeImportFile" ADD CONSTRAINT "KnowledgeImportFile_workspaceId_sessionId_fkey"
  FOREIGN KEY ("workspaceId", "sessionId") REFERENCES "KnowledgeImportSession"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "KnowledgeImportItem" ADD CONSTRAINT "KnowledgeImportItem_workspaceId_sessionId_fkey"
  FOREIGN KEY ("workspaceId", "sessionId") REFERENCES "KnowledgeImportSession"("workspaceId", "id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "KnowledgeImportItem" ADD CONSTRAINT "KnowledgeImportItem_workspaceId_sessionId_fileId_fkey"
  FOREIGN KEY ("workspaceId", "sessionId", "fileId") REFERENCES "KnowledgeImportFile"("workspaceId", "sessionId", "id")
  ON DELETE NO ACTION ON UPDATE CASCADE NOT VALID;

ALTER TABLE "KnowledgeImportFile" DROP CONSTRAINT "KnowledgeImportFile_sessionId_fkey";
ALTER TABLE "KnowledgeImportItem" DROP CONSTRAINT "KnowledgeImportItem_sessionId_fkey";

DROP INDEX "KnowledgeImportFile_workspaceId_sha256_key";
CREATE INDEX "KnowledgeImportFile_workspaceId_sha256_idx" ON "KnowledgeImportFile"("workspaceId", "sha256");
CREATE UNIQUE INDEX "KnowledgeImportFile_live_sha256_key" ON "KnowledgeImportFile"("workspaceId", "sha256") WHERE "status" <> 'CANCELLED';
