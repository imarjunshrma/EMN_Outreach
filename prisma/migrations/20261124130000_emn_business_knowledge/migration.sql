-- CreateEnum
CREATE TYPE "BusinessServiceVersionStatus" AS ENUM ('DRAFT', 'APPROVED', 'SUPERSEDED', 'REVOKED', 'EXPIRED', 'REJECTED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "BusinessProofStatus" AS ENUM ('SUBMITTED', 'REVIEWED', 'APPROVED_FOR_USE', 'REJECTED', 'REVOKED', 'UNVERIFIED', 'VERIFIED');

-- AlterTable
ALTER TABLE "AiExecution" ADD COLUMN     "campaignSnapshotId" UUID;

-- AlterTable
ALTER TABLE "LeadPersonalization" ADD COLUMN     "retrievedExampleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "retrievedKnowledgeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "selectedServiceVersionIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "PersonalizationRevision" ADD COLUMN     "retrievedExampleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "retrievedKnowledgeIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "selectedServiceVersionIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "OutreachExample" ADD COLUMN     "isHumanApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reviewedAt" TIMESTAMPTZ(3),
ADD COLUMN     "reviewedById" UUID,
ADD COLUMN     "sourceFeedbackId" UUID;

-- AlterTable
ALTER TABLE "OutreachFeedback" ADD COLUMN     "reasonCode" TEXT;

-- CreateTable
CREATE TABLE "BusinessService" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BusinessService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessServiceVersion" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "serviceId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "BusinessServiceVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "description" TEXT NOT NULL,
    "targetIndustries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludedIndustries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "targetGeographies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludedGeographies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "minEmployeeCount" INTEGER,
    "maxEmployeeCount" INTEGER,
    "targetCustomerProfiles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "customerProblems" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "desiredOutcomes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "deliverables" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "eligibilityCriteria" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exclusions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "exclusionRules" JSONB NOT NULL DEFAULT '[]',
    "commercialBoundaries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" UUID,
    "approvedById" UUID,
    "approvedAt" TIMESTAMPTZ(3),
    "lifecycleChangedById" UUID,
    "lifecycleChangedAt" TIMESTAMPTZ(3),
    "lifecycleReason" TEXT,
    "expiresAt" TIMESTAMPTZ(3),
    "changeNote" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessServiceVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessServiceLifecycleEvent" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "serviceVersionId" UUID NOT NULL,
    "fromStatus" "BusinessServiceVersionStatus",
    "toStatus" "BusinessServiceVersionStatus" NOT NULL,
    "actorUserId" UUID,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessServiceLifecycleEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessProof" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "serviceVersionId" UUID NOT NULL,
    "knowledgeDocumentId" UUID,
    "claim" TEXT NOT NULL,
    "description" TEXT,
    "sourceUrl" TEXT,
    "sourceTitle" TEXT,
    "sourceType" TEXT NOT NULL DEFAULT 'USER_PROVIDED',
    "verificationMethod" TEXT,
    "status" "BusinessProofStatus" NOT NULL DEFAULT 'SUBMITTED',
    "permittedUse" BOOLEAN NOT NULL DEFAULT false,
    "verifiedById" UUID,
    "verifiedAt" TIMESTAMPTZ(3),
    "reviewDueAt" TIMESTAMPTZ(3),
    "revokedById" UUID,
    "revokedAt" TIMESTAMPTZ(3),
    "reviewNote" TEXT,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BusinessProof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessProofReview" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "proofId" UUID NOT NULL,
    "fromStatus" "BusinessProofStatus",
    "toStatus" "BusinessProofStatus" NOT NULL,
    "verificationMethod" TEXT,
    "reviewerId" UUID,
    "permittedUse" BOOLEAN NOT NULL DEFAULT false,
    "reviewDueAt" TIMESTAMPTZ(3),
    "note" TEXT,
    "proofSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BusinessProofReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignServiceSelection" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "serviceVersionId" UUID NOT NULL,
    "isPreferred" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignServiceSelection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BusinessService_workspaceId_isArchived_idx" ON "BusinessService"("workspaceId", "isArchived");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessService_workspaceId_id_key" ON "BusinessService"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessService_workspaceId_slug_key" ON "BusinessService"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "BusinessServiceVersion_workspaceId_status_serviceId_idx" ON "BusinessServiceVersion"("workspaceId", "status", "serviceId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessServiceVersion_workspaceId_id_key" ON "BusinessServiceVersion"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessServiceVersion_serviceId_version_key" ON "BusinessServiceVersion"("serviceId", "version");

-- CreateIndex
CREATE INDEX "BusinessServiceLifecycleEvent_workspaceId_serviceVersionId__idx" ON "BusinessServiceLifecycleEvent"("workspaceId", "serviceVersionId", "createdAt");

-- CreateIndex
CREATE INDEX "BusinessProof_workspaceId_status_permittedUse_idx" ON "BusinessProof"("workspaceId", "status", "permittedUse");

-- CreateIndex
CREATE INDEX "BusinessProof_serviceVersionId_idx" ON "BusinessProof"("serviceVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessProof_workspaceId_id_key" ON "BusinessProof"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "BusinessProofReview_workspaceId_proofId_createdAt_idx" ON "BusinessProofReview"("workspaceId", "proofId", "createdAt");

-- CreateIndex
CREATE INDEX "CampaignServiceSelection_workspaceId_campaignId_idx" ON "CampaignServiceSelection"("workspaceId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignServiceSelection_workspaceId_id_key" ON "CampaignServiceSelection"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignServiceSelection_campaignId_serviceVersionId_key" ON "CampaignServiceSelection"("campaignId", "serviceVersionId");

-- CreateIndex
CREATE INDEX "AiExecution_campaignSnapshotId_idx" ON "AiExecution"("campaignSnapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "Campaign_workspaceId_id_key" ON "Campaign"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDocument_workspaceId_id_key" ON "KnowledgeDocument"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachExample_sourceFeedbackId_key" ON "OutreachExample"("sourceFeedbackId");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachExample_workspaceId_id_key" ON "OutreachExample"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachFeedback_workspaceId_id_key" ON "OutreachFeedback"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SequenceVersion_workspaceId_id_key" ON "SequenceVersion"("workspaceId", "id");

-- AddForeignKey
ALTER TABLE "AiExecution" ADD CONSTRAINT "AiExecution_workspaceId_campaignSnapshotId_fkey" FOREIGN KEY ("workspaceId", "campaignSnapshotId") REFERENCES "SequenceVersion"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessService" ADD CONSTRAINT "BusinessService_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessServiceVersion" ADD CONSTRAINT "BusinessServiceVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessServiceVersion" ADD CONSTRAINT "BusinessServiceVersion_workspaceId_serviceId_fkey" FOREIGN KEY ("workspaceId", "serviceId") REFERENCES "BusinessService"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessServiceLifecycleEvent" ADD CONSTRAINT "BusinessServiceLifecycleEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessServiceLifecycleEvent" ADD CONSTRAINT "BusinessServiceLifecycleEvent_workspaceId_serviceVersionId_fkey" FOREIGN KEY ("workspaceId", "serviceVersionId") REFERENCES "BusinessServiceVersion"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessProof" ADD CONSTRAINT "BusinessProof_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessProof" ADD CONSTRAINT "BusinessProof_workspaceId_serviceVersionId_fkey" FOREIGN KEY ("workspaceId", "serviceVersionId") REFERENCES "BusinessServiceVersion"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessProof" ADD CONSTRAINT "BusinessProof_workspaceId_knowledgeDocumentId_fkey" FOREIGN KEY ("workspaceId", "knowledgeDocumentId") REFERENCES "KnowledgeDocument"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessProofReview" ADD CONSTRAINT "BusinessProofReview_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessProofReview" ADD CONSTRAINT "BusinessProofReview_workspaceId_proofId_fkey" FOREIGN KEY ("workspaceId", "proofId") REFERENCES "BusinessProof"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignServiceSelection" ADD CONSTRAINT "CampaignServiceSelection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignServiceSelection" ADD CONSTRAINT "CampaignServiceSelection_workspaceId_campaignId_fkey" FOREIGN KEY ("workspaceId", "campaignId") REFERENCES "Campaign"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignServiceSelection" ADD CONSTRAINT "CampaignServiceSelection_workspaceId_serviceVersionId_fkey" FOREIGN KEY ("workspaceId", "serviceVersionId") REFERENCES "BusinessServiceVersion"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachExample" ADD CONSTRAINT "OutreachExample_workspaceId_sourceFeedbackId_fkey" FOREIGN KEY ("workspaceId", "sourceFeedbackId") REFERENCES "OutreachFeedback"("workspaceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A campaign selection must reference entities in the same workspace. Snapshot JSON is immutable
-- audit data; runtime validation rechecks its service/proof lifecycle before each generation.

-- Validate workspace-scoped IDs embedded in immutable JSON snapshots. Composite FKs cannot
-- reference identifiers stored inside JSON, so reject inconsistent snapshots at the DB boundary.


-- Provider routes are embedded as values, so confirm every captured provider belongs to the same workspace.
-- Model IDs are opaque provider identifiers and intentionally are not validated by this database trigger.
CREATE OR REPLACE FUNCTION "assert_campaign_ai_snapshot_workspace"(wid UUID, snap JSONB) RETURNS VOID AS $$
DECLARE item JSONB; proof_item JSONB; candidate JSONB; ref_id UUID; service_id UUID;
BEGIN
  FOR item IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(snap->'selectedServices') = 'array' THEN snap->'selectedServices' ELSE '[]'::jsonb END) LOOP
    ref_id := (item->>'serviceVersionId')::UUID;
    SELECT v.id INTO service_id FROM "BusinessServiceVersion" v JOIN "BusinessService" s ON s.id = v."serviceId" AND s."workspaceId" = v."workspaceId" WHERE v.id = ref_id AND v."workspaceId" = wid AND v.status IN ('APPROVED', 'SUPERSEDED') AND (v."expiresAt" IS NULL OR v."expiresAt" > CURRENT_TIMESTAMP) AND NOT s."isArchived";
    IF service_id IS NULL THEN RAISE EXCEPTION 'Campaign AI snapshot service version is missing, unapproved, or belongs to another workspace'; END IF;
    IF item->>'serviceId' IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "BusinessServiceVersion" v JOIN "BusinessService" s ON s.id = v."serviceId" AND s."workspaceId" = v."workspaceId" WHERE v.id = service_id AND s.id = (item->>'serviceId')::UUID AND s."workspaceId" = wid) THEN RAISE EXCEPTION 'Campaign AI snapshot service ID does not match its version/workspace'; END IF;
    FOR proof_item IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(item->'proof') = 'array' THEN item->'proof' ELSE '[]'::jsonb END) LOOP
      ref_id := (proof_item->>'id')::UUID;
      IF NOT EXISTS (SELECT 1 FROM "BusinessProof" WHERE id = ref_id AND "workspaceId" = wid AND "serviceVersionId" = service_id AND status = 'APPROVED_FOR_USE' AND "permittedUse" AND ("reviewDueAt" IS NULL OR "reviewDueAt" > CURRENT_TIMESTAMP)) THEN RAISE EXCEPTION 'Campaign AI snapshot proof is missing, unusable, or belongs to another workspace/service'; END IF;
    END LOOP;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(snap->'documents') = 'array' THEN snap->'documents' ELSE '[]'::jsonb END) LOOP
    ref_id := (item->>'id')::UUID;
    IF NOT EXISTS (SELECT 1 FROM "KnowledgeDocument" WHERE id = ref_id AND "workspaceId" = wid) THEN RAISE EXCEPTION 'Campaign AI snapshot document belongs to another workspace or is missing'; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(snap->'outreachRules') = 'array' THEN snap->'outreachRules' ELSE '[]'::jsonb END) LOOP
    ref_id := (item->>'id')::UUID;
    IF NOT EXISTS (SELECT 1 FROM "OutreachRule" WHERE id = ref_id AND "workspaceId" = wid) THEN RAISE EXCEPTION 'Campaign AI snapshot rule belongs to another workspace or is missing'; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(snap->'outreachExamples') = 'array' THEN snap->'outreachExamples' ELSE '[]'::jsonb END) LOOP
    ref_id := (item->>'id')::UUID;
    IF NOT EXISTS (SELECT 1 FROM "OutreachExample" WHERE id = ref_id AND "workspaceId" = wid AND "isHumanApproved") THEN RAISE EXCEPTION 'Campaign AI snapshot example is missing, unapproved, or belongs to another workspace'; END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_each(CASE WHEN jsonb_typeof(snap->'taskExecution') = 'object' THEN snap->'taskExecution' ELSE '{}'::jsonb END) LOOP
    IF item->>'promptTemplateId' IS NOT NULL THEN
      ref_id := (item->>'promptTemplateId')::UUID;
      IF NOT EXISTS (SELECT 1 FROM "PromptTemplate" WHERE id = ref_id AND "workspaceId" = wid AND task::TEXT = item->>'task' AND version = (item->>'promptVersion')::INTEGER) THEN RAISE EXCEPTION 'Campaign AI snapshot prompt belongs to another workspace or task'; END IF;
    END IF;
    FOR candidate IN SELECT value FROM jsonb_array_elements(CASE WHEN jsonb_typeof(item->'candidates') = 'array' THEN item->'candidates' ELSE '[]'::jsonb END) LOOP
      IF NOT EXISTS (SELECT 1 FROM "AiProvider" WHERE "workspaceId" = wid AND provider::TEXT = candidate->>'provider' AND "isEnabled") THEN RAISE EXCEPTION 'Campaign AI snapshot provider is missing, disabled, or belongs to another workspace'; END IF;
    END LOOP;
  END LOOP;
END;
$$ LANGUAGE plpgsql;


CREATE OR REPLACE FUNCTION "campaign_ai_snapshot_workspace_trigger"() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."aiConfigSnapshot" IS NOT DISTINCT FROM OLD."aiConfigSnapshot" THEN RETURN NEW; END IF;
  PERFORM "assert_campaign_ai_snapshot_workspace"(NEW."workspaceId", NEW."aiConfigSnapshot");
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "Campaign_aiConfigSnapshot_workspace_check"
BEFORE INSERT OR UPDATE OF "aiConfigSnapshot" ON "Campaign"
FOR EACH ROW EXECUTE FUNCTION "campaign_ai_snapshot_workspace_trigger"();

CREATE OR REPLACE FUNCTION "sequence_version_ai_snapshot_workspace_trigger"() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.snapshot ? 'aiConfigSnapshot' THEN
    PERFORM "assert_campaign_ai_snapshot_workspace"(NEW."workspaceId", NEW.snapshot->'aiConfigSnapshot');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "SequenceVersion_aiConfigSnapshot_workspace_check"
BEFORE INSERT OR UPDATE OF snapshot ON "SequenceVersion"
FOR EACH ROW EXECUTE FUNCTION "sequence_version_ai_snapshot_workspace_trigger"();

-- Enforce approved, non-expired service versions for newly persisted campaign selections.
CREATE OR REPLACE FUNCTION "campaign_service_selection_eligibility_trigger"() RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "BusinessServiceVersion" v
    JOIN "BusinessService" s ON s.id = v."serviceId" AND s."workspaceId" = v."workspaceId"
    WHERE v.id = NEW."serviceVersionId" AND v."workspaceId" = NEW."workspaceId"
      AND v.status = 'APPROVED' AND (v."expiresAt" IS NULL OR v."expiresAt" > CURRENT_TIMESTAMP)
      AND s."isArchived" = FALSE
  ) THEN RAISE EXCEPTION 'Campaign service selection requires a currently approved, non-expired service version in the same workspace'; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "CampaignServiceSelection_approved_service_check"
BEFORE INSERT OR UPDATE OF "workspaceId", "serviceVersionId" ON "CampaignServiceSelection"
FOR EACH ROW EXECUTE FUNCTION "campaign_service_selection_eligibility_trigger"();
