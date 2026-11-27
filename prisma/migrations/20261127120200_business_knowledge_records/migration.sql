CREATE TABLE "BusinessKnowledgeRecord" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "stableKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "BusinessKnowledgeRecord_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BusinessKnowledgeRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BusinessKnowledgeRecord_workspaceId_id_key" ON "BusinessKnowledgeRecord"("workspaceId", "id");
CREATE UNIQUE INDEX "BusinessKnowledgeRecord_workspaceId_kind_stableKey_key" ON "BusinessKnowledgeRecord"("workspaceId", "kind", "stableKey");
CREATE INDEX "BusinessKnowledgeRecord_workspaceId_kind_name_idx" ON "BusinessKnowledgeRecord"("workspaceId", "kind", "name");
CREATE INDEX "BusinessKnowledgeRecord_workspaceId_kind_domain_idx" ON "BusinessKnowledgeRecord"("workspaceId", "kind", "domain");

CREATE TABLE "BusinessKnowledgeRevision" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "recordId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "provenance" JSONB NOT NULL,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BusinessKnowledgeRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BusinessKnowledgeRevision_workspaceId_recordId_fkey" FOREIGN KEY ("workspaceId", "recordId") REFERENCES "BusinessKnowledgeRecord"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BusinessKnowledgeRevision_recordId_version_key" ON "BusinessKnowledgeRevision"("recordId", "version");
CREATE INDEX "BusinessKnowledgeRevision_workspaceId_recordId_idx" ON "BusinessKnowledgeRevision"("workspaceId", "recordId");
