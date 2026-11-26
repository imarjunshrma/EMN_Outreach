ALTER TABLE "Campaign" ADD COLUMN "sendingPolicy" JSONB;
ALTER TABLE "Domain" ADD COLUMN "sendingHoldReason" TEXT;
