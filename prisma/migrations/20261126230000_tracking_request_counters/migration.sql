ALTER TABLE "OutboundEmail"
  ADD COLUMN "pixelRequestCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "automatedPixelRequestCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "TrackedLink"
  ADD COLUMN "automatedClickCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "TrackedLink_outboundEmailId_idx" ON "TrackedLink"("outboundEmailId");
CREATE INDEX "EmailEvent_outboundEmailId_idx" ON "EmailEvent"("outboundEmailId");
