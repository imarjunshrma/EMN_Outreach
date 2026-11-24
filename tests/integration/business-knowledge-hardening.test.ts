import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../backend/src/core/db.js';
import * as businessKnowledge from '../../backend/src/services/business-knowledge.js';
import { resetDb, createUserSession, type Session } from '../helpers/harness.js';

beforeEach(async () => { await resetDb(); });
const actor = (s: Session) => ({ type: 'USER' as const, userId: s.userId });

async function campaign(s: Session) {
  const response = await s.agent.post(`/api/v1/w/${s.workspaceId}/campaigns`).set('x-csrf-token', s.csrf).send({ name: 'Isolation test' });
  expect(response.status).toBe(201);
  return response.body.id as string;
}
async function approvedService(workspaceId: string, name: string) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const service = await db().businessService.create({ data: { workspaceId, name, slug } });
  return db().businessServiceVersion.create({ data: { workspaceId, serviceId: service.id, version: 1, status: 'APPROVED', description: 'Synthetic service for tenant constraint tests.' } });
}

describe('business knowledge tenant foreign keys', () => {
  it('accepts same-workspace service and campaign selections, and rejects cross-workspace references at the DB boundary', async () => {
    const a = await createUserSession('owner-a@example.test');
    const b = await createUserSession('owner-b@example.test');
    const campaignId = await campaign(a);
    const versionA = await approvedService(a.workspaceId, 'Workspace A service');
    const versionB = await approvedService(b.workspaceId, 'Workspace B service');
    await expect(db().campaignServiceSelection.create({ data: { workspaceId: a.workspaceId, campaignId, serviceVersionId: versionA.id } })).resolves.toMatchObject({ workspaceId: a.workspaceId });
    await expect(db().campaignServiceSelection.create({ data: { workspaceId: a.workspaceId, campaignId, serviceVersionId: versionB.id } })).rejects.toThrow();
    await expect(db().businessServiceVersion.create({ data: { workspaceId: a.workspaceId, serviceId: (await db().businessService.findFirstOrThrow({ where: { workspaceId: b.workspaceId } })).id, version: 99, description: 'Cross-workspace service reference' } })).rejects.toThrow();
  });

  it('rejects cross-workspace proof references and AI snapshot JSON at database triggers', async () => {
    const a = await createUserSession('owner-a@example.test');
    const b = await createUserSession('owner-b@example.test');
    const campaignId = await campaign(a);
    const versionA = await approvedService(a.workspaceId, 'Workspace A proof service');
    const versionB = await approvedService(b.workspaceId, 'Workspace B proof service');
    const proof = await db().businessProof.create({ data: { workspaceId: a.workspaceId, serviceVersionId: versionA.id, claim: 'Synthetic approved proof claim', status: 'APPROVED_FOR_USE', permittedUse: true, sourceType: 'USER_PROVIDED' } });
    await expect(db().businessProof.create({ data: { workspaceId: a.workspaceId, serviceVersionId: versionB.id, claim: 'Cross-workspace proof reference' } })).rejects.toThrow();
    await expect(db().campaign.update({ where: { id: campaignId }, data: { aiConfigSnapshot: { selectedServices: [{ serviceVersionId: versionB.id, proof: [] }] } } })).rejects.toThrow();
    await expect(db().campaign.update({ where: { id: campaignId }, data: { aiConfigSnapshot: { selectedServices: [{ serviceVersionId: versionA.id, proof: [{ id: proof.id }] }] } } })).resolves.toMatchObject({ id: campaignId });
  });
});

describe('service and proof lifecycle transitions', () => {
  it('supersedes only when a newer draft is approved, then records revocation with actor and reason', async () => {
    const s = await createUserSession('owner@example.test');
    const first = await businessKnowledge.createService(s.workspaceId, businessKnowledge.ServiceCreateSchema.parse({ name: 'Lifecycle service', description: 'First approved version.' }), actor(s));
    const firstVersion = first.versions[0];
    await businessKnowledge.approveServiceVersion(s.workspaceId, firstVersion.id, actor(s));
    const draft = await businessKnowledge.createServiceVersion(s.workspaceId, first.id, businessKnowledge.ServiceVersionInputSchema.parse({ description: 'Second version draft.' }), actor(s));
    expect((await db().businessServiceVersion.findUniqueOrThrow({ where: { id: firstVersion.id } })).status).toBe('APPROVED');
    await businessKnowledge.approveServiceVersion(s.workspaceId, draft.id, actor(s));
    expect((await db().businessServiceVersion.findUniqueOrThrow({ where: { id: firstVersion.id } })).status).toBe('SUPERSEDED');
    await businessKnowledge.revokeServiceVersion(s.workspaceId, firstVersion.id, 'Evidence is no longer valid', actor(s));
    expect(await db().businessServiceLifecycleEvent.findMany({ where: { serviceVersionId: firstVersion.id }, orderBy: { createdAt: 'asc' }, select: { fromStatus: true, toStatus: true, actorUserId: true } })).toEqual([
      { fromStatus: 'DRAFT', toStatus: 'APPROVED', actorUserId: s.userId },
      { fromStatus: 'APPROVED', toStatus: 'SUPERSEDED', actorUserId: s.userId },
      { fromStatus: 'SUPERSEDED', toStatus: 'REVOKED', actorUserId: s.userId },
    ]);
  });

  it('records manager proof review separately from independent verification and excludes revoked evidence', async () => {
    const s = await createUserSession('owner@example.test');
    const service = await businessKnowledge.createService(s.workspaceId, businessKnowledge.ServiceCreateSchema.parse({ name: 'Proof service', description: 'Synthetic test service.' }), actor(s));
    const version = service.versions[0];
    const proof = await businessKnowledge.addProof(s.workspaceId, { serviceVersionId: version.id, claim: 'A source-backed synthetic statement', sourceUrl: 'https://example.test/proof' }, actor(s));
    await businessKnowledge.reviewProof(s.workspaceId, proof.id, { decision: 'REVIEWED', note: 'Inspected the source and claim wording' }, actor(s));
    await businessKnowledge.reviewProof(s.workspaceId, proof.id, { decision: 'APPROVED_FOR_USE', note: 'Reviewed the source and claim relationship' }, actor(s));
    await businessKnowledge.reviewProof(s.workspaceId, proof.id, { decision: 'REVOKED', note: 'Source no longer supports this claim' }, actor(s));
    const current = await db().businessProof.findUniqueOrThrow({ where: { id: proof.id } });
    expect(current).toMatchObject({ status: 'REVOKED', permittedUse: false, verificationMethod: 'MANAGER_SOURCE_REVIEW' });
    expect(await db().businessProofReview.count({ where: { proofId: proof.id } })).toBe(3);
  });
});
