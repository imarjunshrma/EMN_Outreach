-- Super admin "log in as": a session can carry the staff member who opened it on the user's behalf. Additive only.
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "impersonatorId" UUID;
ALTER TABLE "Session" ADD COLUMN IF NOT EXISTS "impersonationReason" TEXT;
CREATE INDEX IF NOT EXISTS "Session_impersonatorId_idx" ON "Session"("impersonatorId");
