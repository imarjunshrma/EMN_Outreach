ALTER TABLE "EmailVerification" ALTER COLUMN "leadId" DROP NOT NULL;
ALTER TABLE "EmailVerification" ADD COLUMN "batchId" UUID;
ALTER TABLE "EmailVerification" ADD COLUMN "details" JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "EmailVerification" ADD COLUMN "expiresAt" TIMESTAMPTZ(3);
ALTER TABLE "EmailVerification" DROP CONSTRAINT "EmailVerification_leadId_fkey";
ALTER TABLE "EmailVerification" ADD CONSTRAINT "EmailVerification_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "EmailVerification_workspaceId_email_createdAt_idx" ON "EmailVerification"("workspaceId", "email", "createdAt");
CREATE INDEX "EmailVerification_batchId_idx" ON "EmailVerification"("batchId");
CREATE TABLE "EmailVerificationBatch" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "createdBy" UUID,
  "status" TEXT NOT NULL DEFAULT 'QUEUED',
  "total" INTEGER NOT NULL DEFAULT 0,
  "processed" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(3),
  CONSTRAINT "EmailVerificationBatch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EmailVerificationBatch_workspaceId_createdAt_idx" ON "EmailVerificationBatch"("workspaceId", "createdAt");
CREATE INDEX "EmailVerificationBatch_workspaceId_status_idx" ON "EmailVerificationBatch"("workspaceId", "status");
ALTER TABLE "EmailVerificationBatch" ADD CONSTRAINT "EmailVerificationBatch_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailVerification" ADD CONSTRAINT "EmailVerification_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "EmailVerificationBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE UNIQUE INDEX "EmailVerification_batchId_email_key" ON "EmailVerification"("batchId", "email");
ALTER TABLE "EmailVerificationBatch" ADD COLUMN "fileName" TEXT;
ALTER TABLE "EmailVerificationBatch" ADD COLUMN "storageKey" TEXT;
ALTER TABLE "EmailVerificationBatch" ADD COLUMN "fileSizeBytes" BIGINT;
ALTER TABLE "EmailVerificationBatch" ADD COLUMN "emailColumn" TEXT;
ALTER TABLE "EmailVerificationBatch" ADD COLUMN "hasHeader" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "EmailVerificationBatch" ADD COLUMN "error" TEXT;
CREATE UNIQUE INDEX "EmailVerificationBatch_storageKey_key" ON "EmailVerificationBatch"("storageKey");
ALTER TABLE "EmailVerificationBatch" ADD COLUMN "csvHeaders" JSONB;
