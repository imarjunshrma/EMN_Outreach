-- pgvector must be installed in the PostgreSQL server before this migration.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "IntelligenceEmbedding" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "workspaceId" UUID NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" UUID NOT NULL,
  "contentVersion" INTEGER NOT NULL DEFAULT 1,
  "contentHash" CHAR(64) NOT NULL,
  "embeddingModel" TEXT NOT NULL,
  "dimensions" INTEGER NOT NULL DEFAULT 1536,
  "content" TEXT NOT NULL,
  "sourceUrl" TEXT,
  "isCurrent" BOOLEAN NOT NULL DEFAULT TRUE,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "embedding" vector(1536) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IntelligenceEmbedding_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IntelligenceEmbedding_dimensions_check" CHECK ("dimensions" = 1536),
  CONSTRAINT "IntelligenceEmbedding_entityType_check" CHECK ("entityType" IN ('LEAD','COMPANY','RESEARCH_CLAIM','KNOWLEDGE_DOCUMENT','BUSINESS_SERVICE_VERSION','BUSINESS_PROOF','OUTREACH_EXAMPLE')),
  CONSTRAINT "IntelligenceEmbedding_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "IntelligenceEmbedding_workspace_entity_model_hash_key"
  ON "IntelligenceEmbedding"("workspaceId","entityType","entityId","embeddingModel","contentHash");
CREATE INDEX "IntelligenceEmbedding_workspace_type_current_idx"
  ON "IntelligenceEmbedding"("workspaceId","entityType","isCurrent");
CREATE INDEX "IntelligenceEmbedding_workspace_type_entity_current_idx"
  ON "IntelligenceEmbedding"("workspaceId","entityType","entityId","isCurrent");
CREATE INDEX "IntelligenceEmbedding_embedding_hnsw_idx"
  ON "IntelligenceEmbedding" USING hnsw ("embedding" vector_cosine_ops) WITH (m=16, ef_construction=64);

CREATE OR REPLACE FUNCTION emn_delete_intelligence_embedding() RETURNS trigger AS $$
BEGIN
  DELETE FROM "IntelligenceEmbedding"
   WHERE "workspaceId" = OLD."workspaceId"
     AND "entityType" = TG_ARGV[0]
     AND "entityId" = OLD."id";
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER emn_embedding_cleanup AFTER DELETE ON "Lead"
  FOR EACH ROW EXECUTE FUNCTION emn_delete_intelligence_embedding('LEAD');
CREATE TRIGGER emn_embedding_cleanup AFTER DELETE ON "Company"
  FOR EACH ROW EXECUTE FUNCTION emn_delete_intelligence_embedding('COMPANY');
CREATE TRIGGER emn_embedding_cleanup AFTER DELETE ON "ResearchClaim"
  FOR EACH ROW EXECUTE FUNCTION emn_delete_intelligence_embedding('RESEARCH_CLAIM');
CREATE TRIGGER emn_embedding_cleanup AFTER DELETE ON "KnowledgeDocument"
  FOR EACH ROW EXECUTE FUNCTION emn_delete_intelligence_embedding('KNOWLEDGE_DOCUMENT');
CREATE TRIGGER emn_embedding_cleanup AFTER DELETE ON "BusinessServiceVersion"
  FOR EACH ROW EXECUTE FUNCTION emn_delete_intelligence_embedding('BUSINESS_SERVICE_VERSION');
CREATE TRIGGER emn_embedding_cleanup AFTER DELETE ON "BusinessProof"
  FOR EACH ROW EXECUTE FUNCTION emn_delete_intelligence_embedding('BUSINESS_PROOF');
CREATE TRIGGER emn_embedding_cleanup AFTER DELETE ON "OutreachExample"
  FOR EACH ROW EXECUTE FUNCTION emn_delete_intelligence_embedding('OUTREACH_EXAMPLE');
