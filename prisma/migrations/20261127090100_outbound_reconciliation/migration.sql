ALTER TABLE "OutboundEmail"
  ADD COLUMN "uncertainAt" TIMESTAMPTZ(3),
  ADD COLUMN "resolvedAt" TIMESTAMPTZ(3),
  ADD COLUMN "reconciliation" JSONB;

UPDATE "OutboundEmail" SET "status" = 'UNCERTAIN', "uncertainAt" = "updatedAt"
WHERE "status" = 'FAILED' AND "lastError" LIKE 'Delivery state unknown after an interrupted %';

CREATE INDEX "OutboundEmail_reconciliation_queue_idx"
  ON "OutboundEmail"("workspaceId", "status", "resolvedAt", "uncertainAt");
