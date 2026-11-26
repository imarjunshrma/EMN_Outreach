CREATE TYPE "QualificationReview" AS ENUM ('QUALIFIED', 'NEEDS_REVIEW', 'DISQUALIFIED');
ALTER TABLE "Lead" ADD COLUMN "qualificationReview" "QualificationReview",
  ADD COLUMN "qualificationReviewScoreId" UUID,
  ADD COLUMN "qualificationReviewReason" TEXT;
CREATE INDEX "Lead_workspaceId_qualificationReview_idx" ON "Lead"("workspaceId", "qualificationReview");
