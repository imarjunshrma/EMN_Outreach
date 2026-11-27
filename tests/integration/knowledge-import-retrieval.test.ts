import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { db, Prisma } from '../../backend/src/core/db.js';
import { activateConfigVersion, activeDocuments, getConfig } from '../../backend/src/services/ai-studio.js';
import { ask } from '../../backend/src/services/copilot.js';
import { applyImportItem, destinationFor, getImportExclusions, getKnowledgeRecord, inspectImportItem, retrieveImportedKnowledge, syncImportRetrieval } from '../../backend/src/services/knowledge-import-apply.js';
import { resetMemoryFetchForTests, searchMemory, setMemoryFetchForTests } from '../../backend/src/services/intelligence-memory.js';
import type { ImportEntityType, ImportRelationship } from '../../shared/src/knowledge-import.js';
import type { FakeAi } from '../helpers/fakes.js';
import { addAiProvider, createUserSession, installFakes, type Session } from '../helpers/harness.js';

const owner = () => createUserSession(`knowledge-${randomUUID()}@example.test`);
const actor = (s: Session) => ({ type: 'USER' as const, userId: s.userId });

async function proposed(s: Session, entityType: ImportEntityType, payload: Record<string, string | string[] | number>, options: {
  classification?: string;
  status?: 'APPROVED' | 'REJECTED' | 'NEEDS_REVIEW';
  relationships?: ImportRelationship[];
} = {}) {
  const { workspaceId } = s;
  const session = await db().knowledgeImportSession.create({ data: { workspaceId, status: 'REVIEW', createdById: s.userId } });
  const file = await db().knowledgeImportFile.create({ data: {
    workspaceId, sessionId: session.id, fileName: 'source.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    sha256: randomUUID(), byteCount: 100,
  } });
  const destination = destinationFor(entityType);
  const classification = options.classification ?? 'EXPLICIT_FACT';
  const inspection = await inspectImportItem(db(), workspaceId, { entityType, destination, payload, classification });
  return db().knowledgeImportItem.create({ data: {
    workspaceId, entityType, destination, payload, proposedValue: payload, sessionId: session.id, fileId: file.id,
    status: options.status ?? 'APPROVED', sourceLocator: 'source:row-4', classification, verificationStatus: 'UNVERIFIED',
    stableKey: inspection.stableKey, existingValue: inspection.existingValue as Prisma.InputJsonValue ?? Prisma.DbNull,
    relationships: options.relationships ?? [],
  } });
}

async function apply(s: Session, item: Awaited<ReturnType<typeof proposed>>) {
  return db().$transaction(async tx => {
    const current = await tx.knowledgeImportItem.findFirstOrThrow({ where: { id: item.id, workspaceId: s.workspaceId } });
    const result = await applyImportItem(tx, s.workspaceId, current, actor(s));
    await tx.knowledgeImportItem.update({ where: { id: current.id }, data: { ...result, status: 'APPLIED', appliedAt: new Date() } });
    return result;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

afterEach(() => { vi.unstubAllEnvs(); resetMemoryFetchForTests(); });

describe('approved knowledge import destination retrieval', () => {
  it('applies additional native destinations and preserves cross-sheet references in approved records', async () => {
    const s = await owner();
    const service = await proposed(s, 'SERVICE', { name: 'Synthetic diagnostics', externalId: 'service-1', description: 'Tests industrial sensors.' });
    const serviceResult = await apply(s, service);
    expect(await db().businessServiceVersion.findFirst({ where: { workspaceId: s.workspaceId, serviceId: serviceResult.destinationEntityId } }))
      .toMatchObject({ status: 'DRAFT' });
    const audience = await proposed(s, 'TARGET_AUDIENCE', { name: 'Industrial teams', externalId: 'audience-1' }, {
      relationships: [{ entityType: 'SERVICE', externalId: 'service-1' }],
    });
    await apply(s, audience);
    const persona = await proposed(s, 'TARGET_PERSONA', { name: 'Reliability engineer', jobTitles: ['Reliability engineer'] }, {
      relationships: [{ entityType: 'TARGET_AUDIENCE', externalId: 'audience-1' }],
    });
    const { destinationEntityId } = await apply(s, persona);
    expect((await getKnowledgeRecord(s.workspaceId, destinationEntityId)).revisions[0].provenance).toMatchObject({
      relationships: [{ entityType: 'TARGET_AUDIENCE', externalId: 'audience-1' }],
    });
    const additional: Array<[ImportEntityType, Record<string, string | string[]>]> = [
      ['BUSINESS_OPPORTUNITY', { name: 'Sensor upgrades', marketProblem: 'Legacy instrumentation' }],
      ['COMPETITOR', { name: 'Synthetic competitor', website: 'https://competitor.example' }],
      ['RESEARCH_RULE', { name: 'Check company publications', priorities: ['Review public product documents'] }],
      ['OUTREACH_RULE', { name: 'Use concise copy', tone: 'Concise and factual' }],
    ];
    for (const [type, payload] of additional) {
      const item = await proposed(s, type, { ...payload }, { classification: 'RECOMMENDATION' });
      expect(await apply(s, item)).toMatchObject({ applicationResult: 'CREATED' });
    }
    const missing = await proposed(s, 'TARGET_PERSONA', { name: 'Missing parent' }, {
      relationships: [{ entityType: 'TARGET_AUDIENCE', externalId: 'missing' }],
    });
    await expect(apply(s, missing)).rejects.toThrow('in this workspace first');
  });

  it('indexes provenance, supplies approved evidence to Copilot, and scopes all query results to their workspace', async () => {
    const fakes = installFakes();
    const alice = await owner();
    const bob = await owner();
    await addAiProvider(alice.workspaceId);
    await addAiProvider(alice.workspaceId, 'OPENAI', 'gpt-4o-mini');
    vi.stubEnv('OUTVEXA_EMBEDDING_PROVIDER', 'OPENAI');
    vi.stubEnv('OUTVEXA_EMBEDDING_MODEL', 'synthetic-import-embedding-1536');
    setMemoryFetchForTests(async (_url, init) => {
      const input = (JSON.parse(String(init?.body)) as { input: string[] }).input;
      return Response.json({ data: input.map((_, index) => ({ index, embedding: Array.from({ length: 1536 }, (_, dim) => dim === 0 ? 1 : 0) })), usage: { total_tokens: 12 } });
    });

    const audience = await proposed(alice, 'TARGET_AUDIENCE', { externalId: 'bio-1', name: 'Kestrel Milling', description: 'Makes custom surgical instrument handles' });
    const rejected = await proposed(alice, 'TARGET_PERSONA', { name: 'Private Comet Buyer', description: 'Confidential policy' }, { status: 'REJECTED' });
    await expect(apply(alice, rejected)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const applied = await apply(alice, audience);
    await expect(syncImportRetrieval(alice.workspaceId, audience.id)).resolves.toMatchObject({ indexed: 1, disabled: false });
    expect(await searchMemory(alice.workspaceId, 'Kestrel Milling', { KNOWLEDGE_DOCUMENT: [applied.destinationDocumentId!] })).toEqual([
      expect.objectContaining({ entityId: applied.destinationDocumentId, metadata: expect.objectContaining({ importItemId: audience.id, sourceLocator: 'source:row-4' }) }),
    ]);
    await expect(retrieveImportedKnowledge(bob.workspaceId, 'Kestrel Milling')).resolves.toEqual([]);
    await expect(retrieveImportedKnowledge(alice.workspaceId, 'Kestrel Milling', ['TARGET_AUDIENCE'])).resolves.toEqual([
      expect.objectContaining({ importItemId: audience.id, title: 'Kestrel Milling', sourceLocator: 'source:row-4', fileName: 'source.xlsx', verificationStatus: 'UNVERIFIED' }),
    ]);
    expect(await activeDocuments(alice.workspaceId)).toEqual([]);
    const reply: Parameters<FakeAi['on']>[1] = request => {
      expect(request.user).toContain('Kestrel Milling');
      expect(request.user).toContain('source:row-4');
      expect(request.user).not.toContain('Private Comet Buyer');
      return { answer: 'The Kestrel Milling audience makes custom surgical instrument handles.', recommendations: [], proposedActions: [] };
    };
    fakes.anthropic.on('COPILOT', reply);
    fakes.openai.on('COPILOT', reply);
    await expect(ask(alice.workspaceId, alice.userId, 'OWNER', null, 'Tell me about Kestrel Milling')).resolves.toMatchObject({ answer: expect.stringContaining('Kestrel Milling') });
    await expect(getKnowledgeRecord(bob.workspaceId, applied.destinationEntityId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('versions updates, rejects stale reviews, leaves a repeat unchanged, and audits the destination write', async () => {
    const s = await owner();
    const payload = { name: 'Northwind Foundry', externalId: 'target-1', industries: ['Industrial tooling'] };
    const initial = await proposed(s, 'TARGET_AUDIENCE', payload);
    const created = await apply(s, initial);
    const update = await proposed(s, 'TARGET_AUDIENCE', { ...payload, industries: ['Machinery'] });
    const stale = await proposed(s, 'TARGET_AUDIENCE', { ...payload, industries: ['Robotics'] });
    await expect(apply(s, update)).resolves.toMatchObject({ destinationEntityId: created.destinationEntityId, applicationResult: 'UPDATED' });
    await expect(apply(s, stale)).rejects.toMatchObject({ code: 'CONFLICT' });
    const replay = await proposed(s, 'TARGET_AUDIENCE', { ...payload, industries: ['Machinery'] });
    await expect(apply(s, replay)).resolves.toMatchObject({ destinationEntityId: created.destinationEntityId, applicationResult: 'UNCHANGED' });
    const record = await getKnowledgeRecord(s.workspaceId, created.destinationEntityId);
    expect(record.revisions.map(revision => revision.version)).toEqual([2, 1]);
    const documents = await retrieveImportedKnowledge(s.workspaceId, 'Northwind');
    expect(documents).toHaveLength(1);
    expect(documents[0]?.text).toContain('Machinery');
    expect(documents[0]?.text).not.toContain('Industrial tooling');
    await expect(db().auditLog.count({ where: { workspaceId: s.workspaceId, action: 'knowledge_import.destination_applied', entityId: created.destinationEntityId } })).resolves.toBe(2);
  });

  it('reuses active config versions for commercial terms and omits inactive facts after a version rollback', async () => {
    const s = await owner();
    const profile = await proposed(s, 'COMPANY_PROFILE', { name: 'Silverwind Assembly', description: 'Builds instrumentation for rail maintenance' });
    await apply(s, profile);
    const original = (await getConfig(s.workspaceId, 'KNOWLEDGE')).versionId!;
    const evidence = await proposed(s, 'PROOF_CASE_STUDY', { name: 'Epic Swift Revenue', results: 'Ten million dollars in new revenue' }, { classification: 'CLAIM' });
    const proofResult = await apply(s, evidence);
    expect(proofResult.destinationDocumentId).toBeNull();
    const offer = await proposed(s, 'COMMERCIAL_OFFER', { name: 'Baseline Diagnostics', price: 850, currency: 'USD', billingModel: 'one-time' }, { classification: 'CLAIM' });
    await expect(apply(s, offer)).resolves.toMatchObject({ applicationResult: 'CREATED' });
    expect((await getConfig(s.workspaceId, 'KNOWLEDGE')).data.offers[0]).toMatchObject({ name: 'Baseline Diagnostics', price: '850', currency: 'USD' });
    const eligible = await retrieveImportedKnowledge(s.workspaceId, 'Baseline Diagnostics');
    expect(eligible.map(item => item.title)).toContain('Baseline Diagnostics');
    expect(eligible.map(item => item.title)).not.toContain('Epic Swift Revenue');
    await activateConfigVersion(s.workspaceId, original, actor(s));
    expect((await retrieveImportedKnowledge(s.workspaceId, 'Baseline Diagnostics')).map(item => item.title)).toEqual(['Silverwind Assembly']);
  });

  it('persists native ICP revisions, campaign preferences, and workspace exclusion policy', async () => {
    const s = await owner();
    const icp = await proposed(s, 'ICP_CRITERIA', { name: 'Maintenance Operators', requiredConditions: ['has a rail maintenance team'], threshold: 78 });
    const native = await apply(s, icp);
    const update = await proposed(s, 'ICP_CRITERIA', { name: 'Maintenance Operators', requiredConditions: ['runs a rail maintenance depot'], threshold: 85 });
    await apply(s, update);
    await expect(db().idealCustomerProfile.findFirst({ where: { workspaceId: s.workspaceId, id: native.destinationEntityId }, include: { revisions: { orderBy: { version: 'asc' } } } })).resolves.toMatchObject({
      minScore: 85, version: 2, revisions: [{ version: 1 }, { version: 2 }],
    });
    const preference = await proposed(s, 'CAMPAIGN_PREFERENCE', { name: 'Low volume', objective: 'Invite to a workshop' }, { classification: 'RECOMMENDATION' });
    await apply(s, preference);
    expect(await activeDocuments(s.workspaceId)).toEqual([expect.objectContaining({ title: 'Low volume', usage: 'CAMPAIGN_PREFERENCE' })]);
    const exclusion = await proposed(s, 'EXCLUSION', { name: 'Defense businesses', industries: ['Defense'] }, { classification: 'RECOMMENDATION' });
    await apply(s, exclusion);
    await expect(getImportExclusions(s.workspaceId, { industry: 'DEFENSE' })).resolves.toMatchObject([{ name: 'Defense businesses', match: true }]);
    await expect(getImportExclusions(s.workspaceId, { industry: 'Transport' })).resolves.toMatchObject([{ name: 'Defense businesses', match: false }]);
  });
});
