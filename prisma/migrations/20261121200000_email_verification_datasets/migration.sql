CREATE TABLE "DisposableEmailDomain" (
  "domain" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "fetchedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "DisposableEmailDomain_pkey" PRIMARY KEY ("domain")
);
CREATE INDEX "DisposableEmailDomain_source_fetchedAt_idx" ON "DisposableEmailDomain"("source", "fetchedAt");
CREATE TABLE "EmailVerificationDomainOverride" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "domain" TEXT NOT NULL,
  "disposable" BOOLEAN NOT NULL,
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "EmailVerificationDomainOverride_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmailVerificationDomainOverride_workspaceId_domain_key" ON "EmailVerificationDomainOverride"("workspaceId", "domain");
CREATE INDEX "EmailVerificationDomainOverride_workspaceId_disposable_idx" ON "EmailVerificationDomainOverride"("workspaceId", "disposable");
ALTER TABLE "EmailVerificationDomainOverride" ADD CONSTRAINT "EmailVerificationDomainOverride_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE TABLE "EmailVerificationDataset" (
  "key" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "lastUpdated" TIMESTAMPTZ(3),
  "domainCount" INTEGER NOT NULL DEFAULT 0,
  "checksum" TEXT,
  "lastStatus" TEXT NOT NULL DEFAULT 'NEVER_UPDATED',
  "lastError" TEXT,
  CONSTRAINT "EmailVerificationDataset_pkey" PRIMARY KEY ("key")
);
CREATE TABLE "EmailVerificationRolePattern" (
  "id" UUID NOT NULL,
  "workspaceId" UUID NOT NULL,
  "localPart" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdBy" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EmailVerificationRolePattern_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmailVerificationRolePattern_workspaceId_localPart_key" ON "EmailVerificationRolePattern"("workspaceId", "localPart");
CREATE INDEX "EmailVerificationRolePattern_workspaceId_enabled_idx" ON "EmailVerificationRolePattern"("workspaceId", "enabled");
ALTER TABLE "EmailVerificationRolePattern" ADD CONSTRAINT "EmailVerificationRolePattern_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
