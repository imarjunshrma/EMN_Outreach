import { z } from 'zod';
import { db, Prisma } from '../core/db.js';
import { sha256 } from '../core/crypto.js';
import { AI_PROVIDER_BASE_URLS } from '../../../integrations/src/ai/openai-compatible.js';
import { monthSpend } from './ai.js';
import { decryptSecret, readSettings } from './workspace.js';

const DIMENSIONS = 1536;
const SUPPORTED_PROVIDERS = ['OPENAI', 'OPENROUTER', 'TOGETHER', 'DEEPSEEK', 'MISTRAL', 'CUSTOM_OPENAI', 'OLLAMA'] as const;
const ConfigSchema = z.object({ provider: z.enum(SUPPORTED_PROVIDERS), model: z.string().trim().min(1).max(160) });
export type MemoryEntityType = 'LEAD' | 'COMPANY' | 'RESEARCH_CLAIM' | 'KNOWLEDGE_DOCUMENT' | 'BUSINESS_SERVICE_VERSION' | 'BUSINESS_PROOF' | 'OUTREACH_EXAMPLE';
export interface MemoryItem { entityType: MemoryEntityType; entityId: string; content: string; sourceUrl?: string | null; metadata?: Record<string, unknown> }
export interface MemoryHit { id: string; entityType: MemoryEntityType; entityId: string; content: string; sourceUrl: string | null; metadata: unknown; score: number; lexicalScore: number }
type EmbedFetch = typeof fetch;
let fetchImpl: EmbedFetch = fetch;
export function setMemoryFetchForTests(f: EmbedFetch) { fetchImpl = f; }
export function resetMemoryFetchForTests() { fetchImpl = fetch; }

function memoryConfig() {
  const provider = process.env.OUTVEXA_EMBEDDING_PROVIDER;
  const model = process.env.OUTVEXA_EMBEDDING_MODEL;
  if (!provider && !model) return null;
  const parsed = ConfigSchema.safeParse({ provider, model });
  return parsed.success ? parsed.data : null;
}

export function embeddingEndpoint(provider: string, baseUrl: string) {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (provider === 'OLLAMA' && !/\/v1$/i.test(trimmed)) return `${trimmed}/api/embed`;
  return `${trimmed}/embeddings`;
}

export function embeddingBaseUrl(provider: string, workspaceBaseUrl?: string | null) {
  return workspaceBaseUrl || (provider === 'OPENAI' ? 'https://api.openai.com/v1' : AI_PROVIDER_BASE_URLS[provider as keyof typeof AI_PROVIDER_BASE_URLS]) || null;
}

function vectorLiteral(values: number[]) {
  if (values.length !== DIMENSIONS || values.some((v) => !Number.isFinite(v))) throw new Error(`Embedding must contain ${DIMENSIONS} finite values`);
  return `[${values.join(',')}]`;
}

export function parseEmbeddingResponse(provider: string, body: unknown, expected: number) {
  const ollamaNative = provider === 'OLLAMA' && !!(body as { embeddings?: unknown }).embeddings;
  const vectors: number[][] = ollamaNative
    ? (body as { embeddings?: number[][] }).embeddings ?? []
    : ((body as { data?: Array<{ index: number; embedding: number[] }> }).data ?? []).sort((a, b) => a.index - b.index).map((x) => x.embedding);
  if (vectors.length !== expected) throw new Error('Embedding provider returned an incomplete batch');
  for (const vector of vectors) vectorLiteral(vector);
  const usage = body as { usage?: { total_tokens?: number; prompt_tokens?: number } };
  return { vectors, totalTokens: usage.usage?.total_tokens ?? usage.usage?.prompt_tokens ?? 0 };
}

async function embed(workspaceId: string, texts: string[]): Promise<{ vectors: number[][]; model: string; provider: string; totalTokens: number } | null> {
  const cfg = memoryConfig();
  if (!cfg || !texts.length) return null;
  const providerRow = await db().aiProvider.findUnique({ where: { workspaceId_provider: { workspaceId, provider: cfg.provider } } });
  if (!providerRow?.isEnabled) return null;
  const workspace = await db().workspace.findUnique({ where: { id: workspaceId }, select: { settings: true } });
  const budget = readSettings(workspace?.settings).aiMonthlyBudgetUsd;
  if (budget !== null) {
    const price = await db().aiModelPrice.findFirst({
      where: { provider: cfg.provider, model: cfg.model, effectiveFrom: { lte: new Date() } },
      orderBy: { effectiveFrom: 'desc' }, select: { inputPerMTokUsd: true },
    });
    const maxTokens = texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    if (!price || await monthSpend(workspaceId) + maxTokens * Number(price.inputPerMTokUsd) / 1_000_000 > budget) return null;
  }
  const baseUrl = embeddingBaseUrl(cfg.provider, providerRow.baseUrl);
  if (!baseUrl) return null;
  const secret = decryptSecret(providerRow.encryptedApiKey);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret && cfg.provider !== 'OLLAMA') headers.authorization = `Bearer ${secret}`;
  const ollamaNative = cfg.provider === 'OLLAMA' && /\/api\/embed$/i.test(embeddingEndpoint(cfg.provider, baseUrl));
  const response = await fetchImpl(embeddingEndpoint(cfg.provider, baseUrl), {
    method: 'POST', headers,
    body: JSON.stringify(ollamaNative ? { model: cfg.model, input: texts } : { model: cfg.model, input: texts }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Embedding provider request failed (HTTP ${response.status})`);
  const body: unknown = await response.json();
  const parsed = parseEmbeddingResponse(cfg.provider, body, texts.length);
  const totalTokens = parsed.totalTokens
    ?? texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0);
  return { vectors: parsed.vectors, model: cfg.model, provider: cfg.provider, totalTokens: totalTokens || texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0) };
}

async function recordEmbeddingUsage(workspaceId: string, result: { model: string; provider: string; totalTokens: number }) {
  const price = await db().aiModelPrice.findFirst({ where: { provider: result.provider as never, model: result.model, effectiveFrom: { lte: new Date() } }, orderBy: { effectiveFrom: 'desc' } });
  const cost = price ? (result.totalTokens / 1_000_000) * Number(price.inputPerMTokUsd) : null;
  await db().usageRecord.create({ data: {
    workspaceId, provider: result.provider, kind: 'embedding', units: result.totalTokens,
    costUsd: cost, isEstimate: true,
    metadata: { model: result.model, dimensions: DIMENSIONS, tokenCount: result.totalTokens, priced: !!price } as Prisma.InputJsonValue,
  } });
}

/** Index or refresh one workspace's source record. Old content versions remain for audit, marked non-current. */
export async function indexMemoryItems(workspaceId: string, items: MemoryItem[]) {
  const cfg = memoryConfig();
  if (!cfg || !items.length) return { indexed: 0, skipped: items.length, disabled: true };
  const normalized = items.map((item) => ({ ...item, content: item.content.trim().slice(0, 8_000) })).filter((item) => item.content.length >= 40);
  const pending: Array<{ item: MemoryItem; hash: string }> = [];
  for (const item of normalized) {
    const hash = sha256(item.content);
    const exists = await db().$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "IntelligenceEmbedding"
      WHERE "workspaceId" = ${workspaceId}::uuid AND "entityType" = ${item.entityType}
        AND "entityId" = ${item.entityId}::uuid AND "embeddingModel" = ${cfg.model} AND "contentHash" = ${hash}
      LIMIT 1`;
    if (!exists.length) pending.push({ item, hash });
    else await db().$transaction(async (tx) => {
      await tx.$executeRaw`UPDATE "IntelligenceEmbedding" SET "isCurrent" = false
        WHERE "workspaceId" = ${workspaceId}::uuid AND "entityType" = ${item.entityType}
          AND "entityId" = ${item.entityId}::uuid AND "isCurrent" = true`;
      await tx.$executeRaw`UPDATE "IntelligenceEmbedding" SET "isCurrent" = true
        WHERE "id" = ${exists[0]!.id}::uuid AND "workspaceId" = ${workspaceId}::uuid`;
    });
  }
  let indexed = 0;
  for (let offset = 0; offset < pending.length; offset += 16) {
    const batch = pending.slice(offset, offset + 16);
    const result = await embed(workspaceId, batch.map((x) => x.item.content));
    if (!result) return { indexed, skipped: items.length - indexed, disabled: true };
    await db().$transaction(async (tx) => {
      for (let i = 0; i < batch.length; i++) {
        const { item, hash } = batch[i]!;
        const vector = vectorLiteral(result.vectors[i]!);
        const old = await tx.$queryRaw<Array<{ version: number }>>`
          SELECT COALESCE(MAX("contentVersion"),0)::int AS version FROM "IntelligenceEmbedding"
          WHERE "workspaceId" = ${workspaceId}::uuid AND "entityType" = ${item.entityType} AND "entityId" = ${item.entityId}::uuid`;
        await tx.$executeRaw`UPDATE "IntelligenceEmbedding" SET "isCurrent" = false
          WHERE "workspaceId" = ${workspaceId}::uuid AND "entityType" = ${item.entityType}
            AND "entityId" = ${item.entityId}::uuid AND "isCurrent" = true`;
        await tx.$executeRaw`INSERT INTO "IntelligenceEmbedding"
          ("id","workspaceId","entityType","entityId","contentVersion","contentHash","embeddingModel","dimensions","content","sourceUrl","isCurrent","metadata","embedding")
          VALUES (gen_random_uuid(),${workspaceId}::uuid,${item.entityType},${item.entityId}::uuid,${(old[0]?.version ?? 0) + 1},${hash},${cfg.model},${DIMENSIONS},${item.content},${item.sourceUrl ?? null},true,${JSON.stringify(item.metadata ?? {})}::jsonb,${vector}::vector(1536))
          ON CONFLICT ("workspaceId","entityType","entityId","embeddingModel","contentHash") DO UPDATE SET "isCurrent"=true`;
      }
    });
    indexed += batch.length;
    await recordEmbeddingUsage(workspaceId, result);
  }
  return { indexed, skipped: items.length - indexed, disabled: false };
}

/** Always filters on workspace and the caller's allow-listed entity types before ranking. */
export async function searchMemory(workspaceId: string, query: string, allow: Partial<Record<MemoryEntityType, string[]>>, limit = 6, minScore = 0.15): Promise<MemoryHit[]> {
  const cfg = memoryConfig();
  if (!cfg || !query.trim()) return [];
  const scopes = Object.entries(allow).flatMap(([entityType, ids]) => {
    const safeIds = [...new Set((ids ?? []).filter((id) => /^[0-9a-f-]{36}$/i.test(id)))];
    if (!safeIds.length) return [];
    return [Prisma.sql`("entityType" = ${entityType} AND "entityId" IN (${Prisma.join(safeIds.map((id) => Prisma.sql`${id}::uuid`))}))`];
  });
  if (!scopes.length) return [];
  const result = await embed(workspaceId, [query]);
  if (!result) return [];
  const vector = vectorLiteral(result.vectors[0]!);
  const allowedRecords = Prisma.join(scopes, ' OR ');
  const hits = await db().$queryRaw<Array<{ id: string; entityType: string; entityId: string; content: string; sourceUrl: string | null; metadata: unknown; score: number; lexicalScore: number }>>`
    WITH search_query AS (SELECT plainto_tsquery('simple', ${query}) AS q),
    vector_candidates AS (
      SELECT "id" FROM "IntelligenceEmbedding"
      WHERE "workspaceId" = ${workspaceId}::uuid AND "embeddingModel" = ${cfg.model}
        AND "isCurrent" = true AND (${allowedRecords})
      ORDER BY "embedding" <=> ${vector}::vector(1536)
      LIMIT 80
    ),
    text_candidates AS (
      SELECT e."id" FROM "IntelligenceEmbedding" e CROSS JOIN search_query sq
      WHERE e."workspaceId" = ${workspaceId}::uuid AND e."embeddingModel" = ${cfg.model}
        AND e."isCurrent" = true AND (${allowedRecords})
        AND to_tsvector('simple', e."content") @@ sq.q
      ORDER BY ts_rank_cd(to_tsvector('simple', e."content"), sq.q) DESC
      LIMIT 80
    ),
    candidate_ids AS (SELECT "id" FROM vector_candidates UNION SELECT "id" FROM text_candidates)
    SELECT e."id",e."entityType",e."entityId",e."content",e."sourceUrl",e."metadata",
      GREATEST(0, 0.8 * (1 - (e."embedding" <=> ${vector}::vector(1536)))
        + 0.2 * ts_rank_cd(to_tsvector('simple', e."content"), sq.q))::float8 AS score,
      ts_rank_cd(to_tsvector('simple', e."content"), sq.q)::float8 AS "lexicalScore"
    FROM "IntelligenceEmbedding" e JOIN candidate_ids c ON c."id" = e."id" CROSS JOIN search_query sq
    WHERE e."workspaceId" = ${workspaceId}::uuid AND e."embeddingModel" = ${cfg.model}
      AND e."isCurrent" = true AND (${allowedRecords})
    ORDER BY score DESC, e."embedding" <=> ${vector}::vector(1536)
    LIMIT ${Math.max(1, Math.min(limit, 20))}`;
  await recordEmbeddingUsage(workspaceId, result);
  return hits.filter((h) => h.score >= minScore) as MemoryHit[];
}
