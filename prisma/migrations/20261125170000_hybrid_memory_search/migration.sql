CREATE INDEX "IntelligenceEmbedding_content_fts_idx"
  ON "IntelligenceEmbedding" USING GIN (to_tsvector('simple', "content"));
