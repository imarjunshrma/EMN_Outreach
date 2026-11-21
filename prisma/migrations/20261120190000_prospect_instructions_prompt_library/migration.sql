-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "aiInstructions" TEXT;

-- AlterTable
ALTER TABLE "PromptProfile" ADD COLUMN     "approvedById" UUID,
ADD COLUMN     "folder" TEXT,
ADD COLUMN     "isApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tags" TEXT[];

