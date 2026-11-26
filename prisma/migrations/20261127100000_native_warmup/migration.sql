-- CreateEnum
CREATE TYPE "WarmupStatus" AS ENUM ('READY_TO_START', 'ACTIVE', 'PAUSED', 'HEALTH_HOLD', 'AUTH_REQUIRED', 'COMPLETED', 'STOPPED');

-- CreateEnum
CREATE TYPE "WarmupSubmission" AS ENUM ('RESERVED', 'ACCEPTED', 'REJECTED', 'UNCERTAIN', 'NOT_SUBMITTED');

-- CreateTable
CREATE TABLE "WarmupProgram" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "emailAccountId" UUID NOT NULL,
    "status" "WarmupStatus" NOT NULL DEFAULT 'READY_TO_START',
    "config" JSONB NOT NULL,
    "dailyTarget" INTEGER NOT NULL,
    "nextAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "progressedAt" TIMESTAMPTZ(3),
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "WarmupProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarmupRecipient" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "programId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "authorizedBy" UUID NOT NULL,
    "authorizedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dailyLimit" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "WarmupRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarmupMessage" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "emailAccountId" UUID NOT NULL,
    "programId" UUID NOT NULL,
    "recipientId" UUID NOT NULL,
    "status" "WarmupSubmission" NOT NULL DEFAULT 'RESERVED',
    "internetMessageId" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "providerThreadId" TEXT,
    "reason" TEXT,
    "reservedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMPTZ(3),
    "bouncedAt" TIMESTAMPTZ(3),
    "hardBounce" BOOLEAN NOT NULL DEFAULT false,
    "repliedAt" TIMESTAMPTZ(3),
    "resolvedAt" TIMESTAMPTZ(3),
    "reconciliation" JSONB,

    CONSTRAINT "WarmupMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WarmupProgram_workspaceId_emailAccountId_idx" ON "WarmupProgram"("workspaceId", "emailAccountId");

-- CreateIndex
CREATE INDEX "WarmupProgram_status_nextAt_idx" ON "WarmupProgram"("status", "nextAt");

-- CreateIndex
CREATE UNIQUE INDEX "WarmupProgram_workspaceId_id_key" ON "WarmupProgram"("workspaceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WarmupRecipient_programId_email_key" ON "WarmupRecipient"("programId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "WarmupRecipient_workspaceId_programId_id_key" ON "WarmupRecipient"("workspaceId", "programId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WarmupMessage_internetMessageId_key" ON "WarmupMessage"("internetMessageId");

-- CreateIndex
CREATE INDEX "WarmupMessage_workspaceId_emailAccountId_reservedAt_idx" ON "WarmupMessage"("workspaceId", "emailAccountId", "reservedAt");

-- CreateIndex
CREATE INDEX "WarmupMessage_programId_reservedAt_idx" ON "WarmupMessage"("programId", "reservedAt");

-- CreateIndex
CREATE INDEX "WarmupMessage_status_reservedAt_idx" ON "WarmupMessage"("status", "reservedAt");

-- AddForeignKey
ALTER TABLE "WarmupProgram" ADD CONSTRAINT "WarmupProgram_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarmupProgram" ADD CONSTRAINT "WarmupProgram_emailAccountId_fkey" FOREIGN KEY ("emailAccountId") REFERENCES "EmailAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarmupRecipient" ADD CONSTRAINT "WarmupRecipient_workspaceId_programId_fkey" FOREIGN KEY ("workspaceId", "programId") REFERENCES "WarmupProgram"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarmupMessage" ADD CONSTRAINT "WarmupMessage_workspaceId_programId_fkey" FOREIGN KEY ("workspaceId", "programId") REFERENCES "WarmupProgram"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarmupMessage" ADD CONSTRAINT "WarmupMessage_workspaceId_programId_recipientId_fkey" FOREIGN KEY ("workspaceId", "programId", "recipientId") REFERENCES "WarmupRecipient"("workspaceId", "programId", "id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE UNIQUE INDEX "WarmupProgram_one_open_per_mailbox"
ON "WarmupProgram"("workspaceId", "emailAccountId")
WHERE "status" IN ('READY_TO_START', 'ACTIVE', 'PAUSED', 'HEALTH_HOLD', 'AUTH_REQUIRED');

ALTER TABLE "WarmupRecipient" ADD CONSTRAINT "WarmupRecipient_dailyLimit_positive" CHECK ("dailyLimit" > 0);
ALTER TABLE "WarmupProgram" ADD CONSTRAINT "WarmupProgram_dailyTarget_positive" CHECK ("dailyTarget" > 0);
