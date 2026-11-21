-- CreateEnum
CREATE TYPE "OrgStatus" AS ENUM ('PENDING_SETUP', 'TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'DELETION_PENDING', 'DELETED');

-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'BILLING', 'MEMBER');

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('SUPER_ADMIN', 'SUPPORT', 'FINANCE');

-- DropForeignKey
ALTER TABLE "Invoice" DROP CONSTRAINT "Invoice_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_workspaceId_fkey";

-- DropIndex
DROP INDEX "Invoice_workspaceId_createdAt_idx";

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "organizationId" UUID,
ALTER COLUMN "workspaceId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "archivedAt" TIMESTAMPTZ(3),
ADD COLUMN     "description" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "canceledAt" TIMESTAMPTZ(3),
ADD COLUMN     "organizationId" UUID,
ADD COLUMN     "scheduledPlanId" UUID,
ALTER COLUMN "workspaceId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "locale" TEXT,
ADD COLUMN     "platformRole" "PlatformRole",
ADD COLUMN     "termsAcceptedAt" TIMESTAMPTZ(3),
ADD COLUMN     "termsVersion" TEXT;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "archivedAt" TIMESTAMPTZ(3),
ADD COLUMN     "branding" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "organizationId" UUID;

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "status" "OrgStatus" NOT NULL DEFAULT 'PENDING_SETUP',
    "ownerId" UUID,
    "billingOwnerId" UUID,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "locale" TEXT NOT NULL DEFAULT 'en',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "branding" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "onboarding" JSONB NOT NULL DEFAULT '{}',
    "statusReason" TEXT,
    "statusChangedAt" TIMESTAMPTZ(3),
    "deletionRequestedAt" TIMESTAMPTZ(3),
    "deletionScheduledFor" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),
    "registrationKey" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMember" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "OrgRole" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationStatusChange" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "fromStatus" "OrgStatus",
    "toStatus" "OrgStatus" NOT NULL,
    "reason" TEXT,
    "actorUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationStatusChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageCounter" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "metric" TEXT NOT NULL,
    "periodStart" TIMESTAMPTZ(3) NOT NULL,
    "periodEnd" TIMESTAMPTZ(3) NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "UsageCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "workspaceId" UUID,
    "metric" TEXT NOT NULL,
    "quantity" BIGINT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportAccessGrant" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "adminUserId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'read',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportAccessGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformAuditEvent" (
    "id" UUID NOT NULL,
    "actorUserId" UUID,
    "action" TEXT NOT NULL,
    "organizationId" UUID,
    "targetType" TEXT,
    "targetId" TEXT,
    "reason" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAuditEvent_pkey" PRIMARY KEY ("id")
);


-- ---------------------------------------------------------------- Backfill (preserves all existing data)
-- Every existing workspace becomes its own tenant. The organization reuses the workspace's UUID so the
-- mapping is deterministic and repeatable. Status: from its subscription when billing was used, else ACTIVE.
INSERT INTO "Organization" ("id","name","slug","status","ownerId","billingOwnerId","timezone","createdAt","updatedAt","statusChangedAt")
SELECT w."id", w."name", w."slug",
       CASE s."status"::text WHEN 'TRIALING' THEN 'TRIAL' WHEN 'PAST_DUE' THEN 'PAST_DUE' WHEN 'CANCELED' THEN 'CANCELLED' ELSE 'ACTIVE' END::"OrgStatus",
       o."userId", o."userId", w."timezone", w."createdAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "Workspace" w
LEFT JOIN "Subscription" s ON s."workspaceId" = w."id"
LEFT JOIN LATERAL (SELECT m."userId" FROM "WorkspaceMember" m WHERE m."workspaceId" = w."id" ORDER BY (m."role" = 'OWNER') DESC, m."createdAt" ASC LIMIT 1) o ON true
ON CONFLICT ("id") DO NOTHING;

UPDATE "Workspace" SET "organizationId" = "id" WHERE "organizationId" IS NULL;

INSERT INTO "OrganizationMember" ("id","organizationId","userId","role","createdAt","updatedAt")
SELECT gen_random_uuid(), m."workspaceId", m."userId",
       (CASE m."role"::text WHEN 'OWNER' THEN 'OWNER' WHEN 'ADMIN' THEN 'ADMIN' ELSE 'MEMBER' END)::"OrgRole", m."createdAt", CURRENT_TIMESTAMP
FROM "WorkspaceMember" m
ON CONFLICT DO NOTHING;

UPDATE "Subscription" SET "organizationId" = "workspaceId" WHERE "organizationId" IS NULL;
UPDATE "Invoice" SET "organizationId" = "workspaceId" WHERE "organizationId" IS NULL;
UPDATE "User" SET "platformRole" = 'SUPER_ADMIN' WHERE "isPlatformAdmin" = true AND "platformRole" IS NULL;
INSERT INTO "OrganizationStatusChange" ("id","organizationId","fromStatus","toStatus","reason","createdAt")
SELECT gen_random_uuid(), o."id", NULL, o."status", 'Migrated from workspace (v1.3)', CURRENT_TIMESTAMP FROM "Organization" o;

ALTER TABLE "Workspace" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Subscription" ALTER COLUMN "organizationId" SET NOT NULL;
ALTER TABLE "Invoice" ALTER COLUMN "organizationId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_registrationKey_key" ON "Organization"("registrationKey");

-- CreateIndex
CREATE INDEX "Organization_status_idx" ON "Organization"("status");

-- CreateIndex
CREATE INDEX "OrganizationMember_userId_idx" ON "OrganizationMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMember_organizationId_userId_key" ON "OrganizationMember"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "OrganizationStatusChange_organizationId_createdAt_idx" ON "OrganizationStatusChange"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "UsageCounter_organizationId_metric_periodStart_key" ON "UsageCounter"("organizationId", "metric", "periodStart");

-- CreateIndex
CREATE INDEX "UsageEvent_organizationId_metric_occurredAt_idx" ON "UsageEvent"("organizationId", "metric", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "UsageEvent_organizationId_idempotencyKey_key" ON "UsageEvent"("organizationId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "SupportAccessGrant_adminUserId_expiresAt_idx" ON "SupportAccessGrant"("adminUserId", "expiresAt");

-- CreateIndex
CREATE INDEX "PlatformAuditEvent_organizationId_createdAt_idx" ON "PlatformAuditEvent"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "PlatformAuditEvent_action_createdAt_idx" ON "PlatformAuditEvent"("action", "createdAt");

-- CreateIndex
CREATE INDEX "Invoice_organizationId_createdAt_idx" ON "Invoice"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_organizationId_key" ON "Subscription"("organizationId");

-- CreateIndex
CREATE INDEX "Workspace_organizationId_idx" ON "Workspace"("organizationId");

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationStatusChange" ADD CONSTRAINT "OrganizationStatusChange_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageCounter" ADD CONSTRAINT "UsageCounter_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportAccessGrant" ADD CONSTRAINT "SupportAccessGrant_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

