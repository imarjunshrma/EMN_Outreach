import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { closeRedis } from '../backend/src/core/redis.js';
import { db, disconnectDb } from '../backend/src/core/db.js';
import { captureImportExtraction, extractImportRows } from '../backend/src/services/knowledge-import-extraction.js';
import { providerModels, updateRoute, upsertProvider } from '../backend/src/services/ai.js';
import { initWorkspaceDefaults } from '../backend/src/services/workspace.js';
import { IMPORT_ENTITIES, type ImportEntityType } from '../shared/src/knowledge-import.js';

// Run only against a purpose-created workspace with a non-production AI route.
async function smoke() {
  let workspaceId = process.env.KNOWLEDGE_IMPORT_SMOKE_WORKSPACE_ID;
  const database = new URL(process.env.DATABASE_URL ?? '');
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname) || database.pathname !== '/outvexa_knowledge_import_acceptance') {
    throw new Error('A loopback importer acceptance database is required.');
  }
  if (process.argv.includes('--provision-openai')) {
    const apiKey = process.env.KNOWLEDGE_IMPORT_SMOKE_OPENAI_KEY?.trim();
    const model = process.env.KNOWLEDGE_IMPORT_SMOKE_OPENAI_MODEL?.trim();
    if (!apiKey || !model) throw new Error('Set the smoke OpenAI project API key and model.');
    const actor = { type: 'SYSTEM' as const };
    const slug = `knowledge-import-smoke-${randomUUID()}`;
    const organization = await db().organization.create({ data: { name: 'Knowledge Import Provider Smoke', slug, status: 'ACTIVE' } });
    const workspace = await db().workspace.create({ data: { organizationId: organization.id, name: 'Knowledge Import Provider Smoke', slug } });
    workspaceId = workspace.id;
    await initWorkspaceDefaults(workspaceId);
    await upsertProvider(workspaceId, { provider: 'OPENAI', apiKey, defaultModel: model }, actor);
    await updateRoute(workspaceId, { task: 'KNOWLEDGE_IMPORT_EXTRACTION', provider: 'OPENAI', model }, actor);
    const catalog = await providerModels(workspaceId, 'OPENAI');
    if (catalog.warning || !catalog.models.some(candidate => candidate === model)) throw new Error('The configured OpenAI model is unavailable to the smoke credential.');
  }
  workspaceId = z.uuid().parse(workspaceId);
  const workspace = await db().workspace.findFirst({ where: { id: workspaceId, name: { startsWith: 'Knowledge Import Provider Smoke' }, archivedAt: null } });
  if (!workspace) throw new Error('A dedicated Knowledge Import Provider Smoke workspace is required.');
  const snapshot = await captureImportExtraction(workspaceId);
  if (snapshot.route?.candidates[0]?.provider !== 'OPENAI' || snapshot.source?.mode !== 'api') throw new Error('Configure a dedicated API provider route for extraction.');
  const types = Object.keys(IMPORT_ENTITIES) as ImportEntityType[];
  const runId = randomUUID();
  const rows = types.map((entityType, index) => ({
    entityType, locator: `${IMPORT_ENTITIES[entityType].sheet}:row-2`, row: 2,
    excerpt: `Synthetic specimen ${index + 1}`,
    value: { name: `Synthetic specimen ${index + 1}`, description: 'Synthetic example for schema mapping.', external_id: `smoke-${index + 1}` },
  }));
  const extracted = await extractImportRows(workspaceId, rows, runId, snapshot);
  const covered = new Set(extracted.map(item => item.entityType));
  const executions = await db().aiExecution.findMany({
    where: { workspaceId, task: 'KNOWLEDGE_IMPORT_EXTRACTION', entityId: runId },
    select: { provider: true, model: true, status: true, usedFallback: true, inputTokens: true, outputTokens: true, costUsd: true, inputPreview: true, output: true },
  });
  if (executions.some(row => row.inputPreview !== null || row.output !== null)) throw new Error('Extraction retained provider content unexpectedly.');
  console.log(JSON.stringify({ covered: [...covered], usage: executions }, null, 2));
  if (types.some(type => !covered.has(type))) throw new Error('The provider did not extract every worksheet entity.');
}

try {
  await smoke();
} catch {
  console.error('Importer provider smoke failed. Check the isolated database, non-production API key and model, or the dedicated workspace ID and API route.');
  process.exitCode = 1;
} finally {
  await Promise.all([disconnectDb(), closeRedis()]);
}
