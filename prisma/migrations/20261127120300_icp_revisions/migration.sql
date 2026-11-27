ALTER TABLE "IdealCustomerProfile" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX "IdealCustomerProfile_workspaceId_id_key" ON "IdealCustomerProfile"("workspaceId", "id");

CREATE TABLE "IdealCustomerProfileRevision" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "icpId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IdealCustomerProfileRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IdealCustomerProfileRevision_workspaceId_icpId_fkey" FOREIGN KEY ("workspaceId", "icpId") REFERENCES "IdealCustomerProfile"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "IdealCustomerProfileRevision_icpId_version_key" ON "IdealCustomerProfileRevision"("icpId", "version");
CREATE INDEX "IdealCustomerProfileRevision_workspaceId_icpId_idx" ON "IdealCustomerProfileRevision"("workspaceId", "icpId");
