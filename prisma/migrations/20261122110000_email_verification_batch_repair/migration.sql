-- Repair for databases that applied 20261121193000_first_party_email_verification before it was edited.
-- Lines 24-32 of that migration were added after it had already run on existing databases, so those databases
-- lack these columns/indexes (prisma migrate deploy never re-runs an applied migration). Idempotent: a no-op on
-- databases created from the current migration files.
ALTER TABLE "EmailVerificationBatch" ADD COLUMN IF NOT EXISTS "fileName" TEXT;
ALTER TABLE "EmailVerificationBatch" ADD COLUMN IF NOT EXISTS "storageKey" TEXT;
ALTER TABLE "EmailVerificationBatch" ADD COLUMN IF NOT EXISTS "fileSizeBytes" BIGINT;
ALTER TABLE "EmailVerificationBatch" ADD COLUMN IF NOT EXISTS "emailColumn" TEXT;
ALTER TABLE "EmailVerificationBatch" ADD COLUMN IF NOT EXISTS "hasHeader" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "EmailVerificationBatch" ADD COLUMN IF NOT EXISTS "error" TEXT;
ALTER TABLE "EmailVerificationBatch" ADD COLUMN IF NOT EXISTS "csvHeaders" JSONB;
CREATE UNIQUE INDEX IF NOT EXISTS "EmailVerificationBatch_storageKey_key" ON "EmailVerificationBatch"("storageKey");
-- If an old database holds duplicate (batchId, email) rows this index cannot be created; the migration then stops
-- with a clear duplicate-key error instead of silently leaving the constraint out.
CREATE UNIQUE INDEX IF NOT EXISTS "EmailVerification_batchId_email_key" ON "EmailVerification"("batchId", "email");
