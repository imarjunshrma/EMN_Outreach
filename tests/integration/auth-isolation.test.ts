import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../../backend/src/core/db.js';
import { getApp, resetDb, installFakes, createUserSession, addLead } from '../helpers/harness.js';

beforeEach(async () => { await resetDb(); installFakes(); });

describe('authentication', () => {
  it('bootstraps the first owner, then closes public registration', async () => {
    const app = getApp();
    expect((await request(app).get('/api/v1/auth/bootstrap')).body.needsSetup).toBe(true);
    const weak = await request(app).post('/api/v1/auth/register').send({ email: 'a@x.com', name: 'A', password: 'short', workspaceName: 'EMN' });
    expect(weak.status).toBe(400);
    const ok = await request(app).post('/api/v1/auth/register').send({ email: 'Owner@X.com', name: 'Owner', password: 'LongEnough12345', workspaceName: 'EMN' });
    expect(ok.status).toBe(201);
    expect(String(ok.headers['set-cookie'])).toMatch(/emn_session=.*HttpOnly/i);
    const rules = await db().complianceRule.count({ where: { workspaceId: ok.body.workspace.id } });
    expect(rules).toBeGreaterThanOrEqual(7); // defaults seeded
    const second = await request(app).post('/api/v1/auth/register').send({ email: 'b@x.com', name: 'B', password: 'LongEnough12345', workspaceName: 'Other' });
    expect(second.status).toBe(403);
    expect(second.body.error.code).toBe('REGISTRATION_CLOSED');
  });

  it('rejects bad passwords, enforces CSRF and revokes sessions on logout', async () => {
    const s = await createUserSession('owner@x.com');
    const bad = await request(getApp()).post('/api/v1/auth/login').send({ email: 'owner@x.com', password: 'nope' });
    expect(bad.status).toBe(401);
    const noCsrf = await s.agent.post(`/api/v1/w/${s.workspaceId}/lists`).send({ name: 'L' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_FAILED');
    const withCsrf = await s.agent.post(`/api/v1/w/${s.workspaceId}/lists`).set('x-csrf-token', s.csrf).send({ name: 'L' });
    expect(withCsrf.status).toBe(201);
    await s.agent.post('/api/v1/auth/logout').set('x-csrf-token', s.csrf);
    expect((await s.agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('validates request bodies with field-level errors', async () => {
    const s = await createUserSession('owner@x.com');
    const r = await s.agent.post(`/api/v1/w/${s.workspaceId}/leads`).set('x-csrf-token', s.csrf).send({ email: 'not-an-email' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
    expect(r.body.error.details[0].path).toBe('email');
  });

  it('rate-limits login attempts', async () => {
    const app = getApp();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await request(app).post('/api/v1/auth/login').send({ email: 'x@x.com', password: 'y' })).status;
    expect(last).toBe(429);
  });
});

describe('authorization (RBAC)', () => {
  it('enforces minimum roles per action', async () => {
    const owner = await createUserSession('owner@x.com');
    const viewer = await createUserSession('viewer@x.com', 'VIEWER', owner.workspaceId);
    const member = await createUserSession('member@x.com', 'MEMBER', owner.workspaceId);
    expect((await viewer.agent.get(`/api/v1/w/${owner.workspaceId}/leads`)).status).toBe(200);
    expect((await viewer.agent.post(`/api/v1/w/${owner.workspaceId}/lists`).set('x-csrf-token', viewer.csrf).send({ name: 'x' })).status).toBe(403);
    const c = await member.agent.post(`/api/v1/w/${owner.workspaceId}/campaigns`).set('x-csrf-token', member.csrf).send({ name: 'C1' });
    expect(c.status).toBe(201);
    // Members cannot approve; AI keys and integrations are admin-only.
    expect((await member.agent.post(`/api/v1/w/${owner.workspaceId}/campaigns/${c.body.id}/approve`).set('x-csrf-token', member.csrf)).status).toBe(403);
    expect((await member.agent.get(`/api/v1/w/${owner.workspaceId}/ai/providers`)).status).toBe(403);
    expect((await member.agent.get(`/api/v1/w/${owner.workspaceId}/audit-logs`)).status).toBe(403);
  });

  it('prevents removing or demoting the last owner', async () => {
    const owner = await createUserSession('owner@x.com');
    const m = await db().workspaceMember.findFirstOrThrow({ where: { userId: owner.userId } });
    const r = await owner.agent.patch(`/api/v1/w/${owner.workspaceId}/members/${m.id}`).set('x-csrf-token', owner.csrf).send({ role: 'ADMIN' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('LAST_OWNER');
  });

  it('API keys authenticate without CSRF, are scoped to their workspace and role, and can be revoked', async () => {
    const owner = await createUserSession('owner@x.com');
    const other = await createUserSession('other@y.com');
    const k = await owner.agent.post(`/api/v1/w/${owner.workspaceId}/api-keys`).set('x-csrf-token', owner.csrf).send({ name: 'zapier', role: 'MEMBER' });
    expect(k.status).toBe(201);
    const token = k.body.token as string;
    const app = getApp();
    expect((await request(app).post(`/api/v1/w/${owner.workspaceId}/leads`).set('authorization', `Bearer ${token}`).send({ email: 'api@lead.com' })).status).toBe(201);
    expect((await request(app).get(`/api/v1/w/${other.workspaceId}/leads`).set('authorization', `Bearer ${token}`)).status).toBe(404);
    expect((await request(app).get(`/api/v1/w/${owner.workspaceId}/audit-logs`).set('authorization', `Bearer ${token}`)).status).toBe(403);
    await owner.agent.delete(`/api/v1/w/${owner.workspaceId}/api-keys/${k.body.id}`).set('x-csrf-token', owner.csrf);
    expect((await request(app).get(`/api/v1/w/${owner.workspaceId}/leads`).set('authorization', `Bearer ${token}`)).status).toBe(401);
  });
});

describe('tenant isolation', () => {
  it('never exposes or mutates another workspace’s records', async () => {
    const a = await createUserSession('a@a.com');
    const b = await createUserSession('b@b.com');
    const leadB = await addLead(b.workspaceId, 'secret@b-client.com');
    const listB = await db().leadList.create({ data: { workspaceId: b.workspaceId, name: 'B list' } });
    const campB = await db().campaign.create({ data: { workspaceId: b.workspaceId, name: 'B camp', sendingWindow: {} } });
    const supB = await db().suppressionEntry.create({ data: { workspaceId: b.workspaceId, type: 'EMAIL', value: 'x@y.com', reason: 'MANUAL' } });
    const h = { 'x-csrf-token': a.csrf };
    // Direct access to B's workspace is 404 (existence not revealed)
    expect((await a.agent.get(`/api/v1/w/${b.workspaceId}/leads`)).status).toBe(404);
    // B's IDs used inside A's workspace are not found
    expect((await a.agent.get(`/api/v1/w/${a.workspaceId}/leads/${leadB.id}`)).status).toBe(404);
    expect((await a.agent.patch(`/api/v1/w/${a.workspaceId}/leads/${leadB.id}`).set(h).send({ firstName: 'hacked' })).status).toBe(404);
    expect((await a.agent.get(`/api/v1/w/${a.workspaceId}/campaigns/${campB.id}`)).status).toBe(404);
    expect((await a.agent.delete(`/api/v1/w/${a.workspaceId}/suppressions/${supB.id}`).set(h)).status).toBe(404);
    // Linking B's list to A's campaign is rejected
    const campA = await a.agent.post(`/api/v1/w/${a.workspaceId}/campaigns`).set(h).send({ name: 'A' });
    expect((await a.agent.put(`/api/v1/w/${a.workspaceId}/campaigns/${campA.body.id}/lists`).set(h).send({ listIds: [listB.id] })).status).toBe(404);
    // Bulk actions silently ignore foreign IDs
    const bulk = await a.agent.post(`/api/v1/w/${a.workspaceId}/leads/bulk`).set(h).send({ ids: [leadB.id], action: 'delete' });
    expect(bulk.body.affected).toBe(0);
    expect(await db().lead.findUnique({ where: { id: leadB.id } })).not.toBeNull();
    expect((await db().lead.findUniqueOrThrow({ where: { id: leadB.id } })).firstName).toBe('Jane');
    // Lists in A don't include B's data
    const leadsA = await a.agent.get(`/api/v1/w/${a.workspaceId}/leads`);
    expect(leadsA.body.total).toBe(0);
  });
});
