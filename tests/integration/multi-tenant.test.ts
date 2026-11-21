/**
 * Internal multi-tenant test-bed: Tenant A (single team), Tenant B (separate customer),
 * Tenant C (agency with several client workspaces) and platform staff.
 * Payments use internal gateway fixtures only — nothing here contacts a real provider.
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Job } from 'bullmq';
import { db } from '../../backend/src/core/db.js';
import { hashPassword } from '../../backend/src/services/auth.js';
import * as tenancy from '../../backend/src/services/tenancy.js';
import * as billing from '../../backend/src/services/billing.js';
import { recordUsage, currentUsage } from '../../backend/src/services/usage.js';
import { tenantState } from '../../backend/src/services/entitlements.js';
import { tenantGate } from '../../worker/src/processors.js';
import { StripeGateway, RazorpayGateway, setGatewaysForTests } from '../../integrations/src/billing/gateways.js';
import { canTransition } from '../../shared/src/tenancy.js';
import { sha256 } from '../../backend/src/core/crypto.js';
import { processorFor } from '../../worker/src/processors.js';
import { redis } from '../../backend/src/core/redis.js';
import { resetDb, installFakes, getApp } from '../helpers/harness.js';
import { routes } from '../../backend/src/http/router.js';

const PW = 'CorrectHorse123!';
type T = { agent: ReturnType<typeof request.agent>; csrf: string; userId: string; orgId: string; wsId: string; email: string };

async function signup(email: string, organizationName: string, extra: Record<string, unknown> = {}): Promise<T> {
  const agent = request.agent(getApp());
  const r = await agent.post('/api/v1/auth/signup').send({ name: email.split('@')[0], email, password: PW, organizationName, acceptTerms: true, ...extra });
  if (r.status !== 201 && r.status !== 200) throw new Error(`signup ${r.status} ${JSON.stringify(r.body)}`);
  return { agent, csrf: r.body.csrfToken, userId: r.body.user.id, orgId: r.body.organization.id, wsId: r.body.workspace.id, email };
}
async function login(email: string) {
  const agent = request.agent(getApp());
  const r = await agent.post('/api/v1/auth/login').send({ email, password: PW });
  if (r.status !== 200) throw new Error(`login ${r.status}`);
  return { agent, csrf: r.body.csrfToken as string };
}
async function staff(email: string, role: 'SUPER_ADMIN' | 'SUPPORT' | 'FINANCE') {
  const u = await db().user.create({ data: { email, name: role, passwordHash: await hashPassword(PW), platformRole: role, isPlatformAdmin: role === 'SUPER_ADMIN', emailVerifiedAt: new Date() } });
  return { ...(await login(email)), userId: u.id };
}
const lead = (t: { agent: T['agent']; csrf: string }, ws: string, email: string) => t.agent.post(`/api/v1/w/${ws}/leads`).set('x-csrf-token', t.csrf).send({ email });

let A: T, B: T, C: T, root: Awaited<ReturnType<typeof staff>>;

beforeEach(async () => {
  await resetDb(); installFakes();
  process.env.REGISTRATION_OPEN = 'true';
  root = await staff('root@emn.test', 'SUPER_ADMIN'); // first user: platform staff, not a customer
  A = await signup('owner@alpha.test', 'Alpha Corp');
  B = await signup('owner@beta.test', 'Beta Ltd');
  C = await signup('owner@agency.test', 'Gamma Agency');
  for (const t of [A, B, C]) await db().user.update({ where: { id: t.userId }, data: { emailVerifiedAt: new Date() } });
});
afterEach(() => { delete process.env.BILLING_ENABLED; delete process.env.REGISTRATION_OPEN; setGatewaysForTests(null); });

describe('provisioning', () => {
  it('sign-up creates exactly one organization, owner membership and workspace; customers are not platform staff', async () => {
    for (const t of [A, B, C]) {
      const org = await db().organization.findUniqueOrThrow({ where: { id: t.orgId }, include: { members: true, workspaces: true } });
      expect(org.ownerId).toBe(t.userId);
      expect(org.members).toEqual([expect.objectContaining({ userId: t.userId, role: 'OWNER' })]);
      expect(org.workspaces.map((w) => w.id)).toEqual([t.wsId]);
      expect(['ACTIVE', 'TRIAL']).toContain(org.status);
      const u = await db().user.findUniqueOrThrow({ where: { id: t.userId } });
      expect(u.platformRole).toBeNull();
      expect(u.termsAcceptedAt).not.toBeNull();
    }
    expect(await db().organization.count()).toBe(3);
  });

  it('terms must be accepted; duplicate emails are refused; a retried sign-up with the same key returns the same tenant', async () => {
    const agent = request.agent(getApp());
    expect((await agent.post('/api/v1/auth/signup').send({ name: 'x', email: 'd@delta.test', password: PW, organizationName: 'Delta', acceptTerms: false })).status).toBe(400);
    const body = { name: 'd', email: 'd@delta.test', password: PW, organizationName: 'Delta', acceptTerms: true, idempotencyKey: 'browser-retry-1234' };
    const r1 = await agent.post('/api/v1/auth/signup').send(body);
    const r2 = await request(getApp()).post('/api/v1/auth/signup').send(body);
    expect(r2.body.organization.id).toBe(r1.body.organization.id);
    expect(await db().organization.count({ where: { name: 'Delta' } })).toBe(1);
    expect((await request(getApp()).post('/api/v1/auth/signup').send({ ...body, idempotencyKey: undefined })).status).toBe(409);
  });

  it('concurrent provisioning with one registration key creates one tenant', async () => {
    const u = await db().user.create({ data: { email: 'race@x.test', name: 'r', passwordHash: 'x' } });
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => tenancy.provisionTenant({ userId: u.id, organizationName: 'Race Inc', registrationKey: 'race-key' })));
    const ids = new Set(results.filter((r) => r.status === 'fulfilled').map((r) => (r as PromiseFulfilledResult<{ organization: { id: string } }>).value.organization.id));
    expect(ids.size).toBe(1);
    expect(await db().organization.count({ where: { name: 'Race Inc' } })).toBe(1);
    expect(await db().workspace.count({ where: { organizationId: [...ids][0] } })).toBe(1);
  });

  it('registration can be closed', async () => {
    process.env.REGISTRATION_OPEN = 'false';
    const r = await request(getApp()).post('/api/v1/auth/signup').send({ name: 'z', email: 'z@z.test', password: PW, organizationName: 'Zed', acceptTerms: true });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('REGISTRATION_CLOSED');
  });
});

describe('email verification', () => {
  it('unverified users cannot invite in SaaS mode; a single-use token verifies the address', async () => {
    process.env.BILLING_ENABLED = 'true';
    await billing.startTrial(A.orgId, 'growth');
    await db().user.update({ where: { id: A.userId }, data: { emailVerifiedAt: null } });
    const inv = await A.agent.post(`/api/v1/w/${A.wsId}/invitations`).set('x-csrf-token', A.csrf).send({ email: 'x@alpha.test', role: 'MEMBER' });
    expect(inv.status).toBe(403);
    expect(inv.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    const token = 'v'.repeat(40);
    await db().passwordResetToken.create({ data: { userId: A.userId, kind: 'EMAIL_VERIFY', tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600_000) } });
    expect((await request(getApp()).post('/api/v1/auth/verify-email').send({ token })).status).toBe(200);
    expect((await request(getApp()).post('/api/v1/auth/verify-email').send({ token })).status).toBe(400); // single use
    expect((await A.agent.post(`/api/v1/w/${A.wsId}/invitations`).set('x-csrf-token', A.csrf).send({ email: 'x@alpha.test', role: 'MEMBER' })).status).toBe(201);
  });
});

describe('fair use in workers', () => {
  it('limits concurrent heavy jobs per organization without affecting other organizations', async () => {
    process.env.TENANT_JOB_SLOTS = '1';
    const now = Date.now();
    await redis().zadd(`tenant:slots:${A.orgId}:ai`, now, 'busy-job'); // A already has one AI job running
    const delayed: string[] = [];
    const job = (ws: string, id: string) => ({ id, name: 'ai.qualify', data: { workspaceId: ws, leadId: '00000000-0000-4000-8000-000000000000' }, attemptsMade: 0, opts: {}, moveToDelayed: async () => { delayed.push(id); } }) as unknown as Job<Record<string, unknown>>;
    await expect(processorFor('ai' as never)(job(A.wsId, 'a2'), 'tok')).rejects.toThrow(); // DelayedError: waits for a slot
    expect(delayed).toEqual(['a2']);
    // B is not blocked by A's load (its job runs and fails only because the lead does not exist)
    await processorFor('ai' as never)(job(B.wsId, 'b1'), 'tok').catch(() => undefined);
    expect(delayed).toEqual(['a2']);
    delete process.env.TENANT_JOB_SLOTS;
  });
});

describe('tenant isolation', () => {
  it('a tenant cannot read or write another tenant\'s workspace, organization, or records by guessing ids', async () => {
    const la = await lead(A, A.wsId, 'secret@prospect.test');
    expect(la.status).toBe(201);
    // B uses A's workspace id → indistinguishable from "does not exist"
    expect((await B.agent.get(`/api/v1/w/${A.wsId}/leads`)).status).toBe(404);
    expect((await lead(B, A.wsId, 'inject@x.test')).status).toBe(404);
    // B uses A's lead id inside B's own workspace → not found, never A's data
    expect((await B.agent.get(`/api/v1/w/${B.wsId}/leads/${la.body.id}`)).status).toBe(404);
    expect((await B.agent.get(`/api/v1/orgs/${A.orgId}`)).status).toBe(404);
    expect((await B.agent.patch(`/api/v1/orgs/${A.orgId}`).set('x-csrf-token', B.csrf).send({ name: 'pwned' })).status).toBe(404);
    expect((await B.agent.get(`/api/v1/orgs/${A.orgId}/billing`)).status).toBe(404);
    // listing endpoints show only one's own tenant
    const mine = await B.agent.get('/api/v1/orgs');
    expect(JSON.stringify(mine.body)).not.toContain(A.orgId);
    const leadsB = await B.agent.get(`/api/v1/w/${B.wsId}/leads`);
    expect(JSON.stringify(leadsB.body)).not.toContain('secret@prospect.test');
  });

  it('every workspace endpoint (read, write, export, files, credentials, analytics, jobs) refuses another tenant with 404', async () => {
    const someId = '00000000-0000-4000-8000-000000000000';
    const ws = routes.filter((r) => r.auth === 'workspace');
    expect(ws.length).toBeGreaterThan(200);
    const leaks: string[] = [];
    for (const r of ws) {
      const path = `/api/v1${r.path}`.replace(':workspaceId', B.wsId).replace(/:[a-zA-Z]+/g, someId);
      const req = (A.agent as unknown as Record<string, (u: string) => request.Test>)[r.method](path).set('x-csrf-token', A.csrf);
      const res = await (r.method === 'get' ? req : req.send({}));
      if (res.status !== 404) leaks.push(`${r.method.toUpperCase()} ${r.path} → ${res.status}`);
    }
    expect(leaks).toEqual([]);
    // and the reverse direction with B's own API key against A
    const k = await B.agent.post(`/api/v1/w/${B.wsId}/api-keys`).set('x-csrf-token', B.csrf).send({ name: 'b', role: 'ADMIN' });
    for (const p of ['leads', 'email-accounts', 'integrations', 'analytics/overview', 'export', 'jobs/history']) {
      expect((await request(getApp()).get(`/api/v1/w/${A.wsId}/${p}`).set('authorization', `Bearer ${k.body.token}`)).status).toBe(404);
    }
  });

  it('an API key is bound to its own workspace', async () => {
    const k = await A.agent.post(`/api/v1/w/${A.wsId}/api-keys`).set('x-csrf-token', A.csrf).send({ name: 'zap', role: 'MEMBER' });
    expect(k.status).toBe(201);
    const bearer = (path: string) => request(getApp()).get(path).set('authorization', `Bearer ${k.body.token}`);
    expect((await bearer(`/api/v1/w/${A.wsId}/leads`)).status).toBe(200);
    expect((await bearer(`/api/v1/w/${B.wsId}/leads`)).status).toBe(404);
    expect((await bearer(`/api/v1/orgs/${A.orgId}`)).status).toBe(401);
    expect((await bearer('/api/v1/platform/tenants')).status).toBe(401);
  });

  it('the database refuses cross-tenant references even if application code were wrong', async () => {
    const listB = await db().leadList.create({ data: { workspaceId: B.wsId, name: 'B list' } });
    const campA = await db().campaign.create({ data: { workspaceId: A.wsId, name: 'A campaign', sendingWindow: {} } });
    await expect(db().campaignList.create({ data: { workspaceId: A.wsId, campaignId: campA.id, listId: listB.id } })).rejects.toThrow(/tenant|workspace/i);
    await expect(db().workspace.update({ where: { id: A.wsId }, data: { organizationId: B.orgId } })).rejects.toThrow();
  });

  it('being invited into one workspace does not give access to the inviter\'s organization or other workspaces', async () => {
    const second = await A.agent.post(`/api/v1/orgs/${A.orgId}/workspaces`).set('x-csrf-token', A.csrf).send({ name: 'Alpha Private' });
    expect(second.status).toBe(201);
    const inv = await A.agent.post(`/api/v1/w/${A.wsId}/invitations`).set('x-csrf-token', A.csrf).send({ email: B.email, role: 'MEMBER' });
    expect(inv.status).toBe(201);
    const token = String(inv.body.inviteUrl).split('/invite/')[1];
    expect((await B.agent.post(`/api/v1/invitations/${token}/accept`).set('x-csrf-token', B.csrf).send({})).status).toBe(200);

    expect((await B.agent.get(`/api/v1/w/${A.wsId}/leads`)).status).toBe(200); // the invited workspace
    expect((await B.agent.get(`/api/v1/w/${second.body.id}/leads`)).status).toBe(404); // not the other one
    const m = await db().organizationMember.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: A.orgId, userId: B.userId } } });
    expect(m.role).toBe('MEMBER');
    expect((await B.agent.patch(`/api/v1/orgs/${A.orgId}`).set('x-csrf-token', B.csrf).send({ name: 'pwned' })).status).toBe(403);
    expect((await B.agent.post(`/api/v1/orgs/${A.orgId}/billing/checkout`).set('x-csrf-token', B.csrf).send({ planCode: 'growth', provider: 'stripe' })).status).toBe(403);
    expect((await B.agent.post(`/api/v1/orgs/${A.orgId}/deletion`).set('x-csrf-token', B.csrf).send({ confirmName: 'Alpha Corp' })).status).toBe(403);
    // B still owns B, and A gained nothing in B
    expect((await db().organization.findUniqueOrThrow({ where: { id: B.orgId } })).ownerId).toBe(B.userId);
    expect((await A.agent.get(`/api/v1/w/${B.wsId}/leads`)).status).toBe(404);
  });
});

describe('agency workspaces (Tenant C)', () => {
  it('agency plan allows client workspaces; starter does not; each client workspace is isolated from other tenants', async () => {
    process.env.BILLING_ENABLED = 'true';
    await billing.startTrial(A.orgId, 'starter');
    await billing.startTrial(C.orgId, 'agency');
    const a2 = await A.agent.post(`/api/v1/orgs/${A.orgId}/workspaces`).set('x-csrf-token', A.csrf).send({ name: 'Second' });
    expect(a2.status).toBe(402);
    const clients = [];
    for (const n of ['Client One', 'Client Two']) {
      const r = await C.agent.post(`/api/v1/orgs/${C.orgId}/workspaces`).set('x-csrf-token', C.csrf).send({ name: n });
      expect(r.status).toBe(201);
      clients.push(r.body.id as string);
    }
    // Agency owner reaches every client workspace without separate invitations
    for (const w of clients) expect((await lead(C, w, `p@${w.slice(0, 6)}.test`)).status).toBe(201);
    const ws = await C.agent.get(`/api/v1/orgs/${C.orgId}/workspaces`);
    expect(ws.body.length ?? ws.body.items?.length).toBe(3);
    for (const w of clients) expect((await A.agent.get(`/api/v1/w/${w}/leads`)).status).toBe(404);
  });
});

describe('usage metering', () => {
  it('is idempotent per event key, including under concurrency, and separated per tenant and period', async () => {
    await Promise.all(Array.from({ length: 20 }, () => recordUsage({ organizationId: A.orgId, metric: 'email_sends', quantity: 1, key: 'send:o1' })));
    await recordUsage({ organizationId: A.orgId, metric: 'email_sends', quantity: 1, key: 'send:o2' });
    await recordUsage({ workspaceId: B.wsId, metric: 'email_sends', quantity: 5, key: 'send:o1' }); // same key, other tenant
    const a = await currentUsage(A.orgId);
    const b = await currentUsage(B.orgId);
    expect(Number((a as Record<string, unknown> & { metered: Record<string, number> }).metered.email_sends)).toBe(2);
    expect(Number((b as Record<string, unknown> & { metered: Record<string, number> }).metered.email_sends)).toBe(5);
    const last = new Date(); last.setUTCMonth(last.getUTCMonth() - 1);
    await recordUsage({ organizationId: A.orgId, metric: 'email_sends', quantity: 100, key: 'send:old', at: last });
    expect(Number(((await currentUsage(A.orgId)) as unknown as { metered: Record<string, number> }).metered.email_sends)).toBe(2);
  });
});

describe('lifecycle', () => {
  it('only valid transitions are allowed', async () => {
    expect(canTransition('ACTIVE', 'SUSPENDED')).toBe(true);
    expect(canTransition('ACTIVE', 'DELETED')).toBe(false);
    expect(canTransition('DELETED', 'ACTIVE')).toBe(false);
    await expect(tenancy.setOrgStatus(A.orgId, 'DELETED', 'x', { system: true })).rejects.toThrow();
  });

  it('platform suspension makes one tenant read-only (billing and export still open) without touching others', async () => {
    const noReason = await root.agent.post(`/api/v1/platform/tenants/${A.orgId}/lifecycle`).set('x-csrf-token', root.csrf).send({ action: 'suspend', reason: '' });
    expect(noReason.status).toBe(400);
    const s = await root.agent.post(`/api/v1/platform/tenants/${A.orgId}/lifecycle`).set('x-csrf-token', root.csrf).send({ action: 'suspend', reason: 'Chargeback investigation #42' });
    expect(s.status).toBe(200);
    const blocked = await lead(A, A.wsId, 'n@x.test');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('TENANT_INACTIVE');
    expect((await A.agent.get(`/api/v1/w/${A.wsId}/leads`)).status).toBe(200);
    expect((await A.agent.get(`/api/v1/orgs/${A.orgId}/billing`)).status).toBe(200);
    expect((await A.agent.post(`/api/v1/orgs/${A.orgId}/export`).set('x-csrf-token', A.csrf)).status).toBe(200);
    expect((await lead(B, B.wsId, 'n@x.test')).status).toBe(201);
    // queued work for the suspended tenant is skipped by the worker; compliance jobs continue
    const job = (name: string, ws: string) => ({ name, data: { workspaceId: ws } }) as unknown as Job<Record<string, unknown>>;
    expect((await tenantGate(job('ai.qualify', A.wsId))).skip).toMatch(/inactive/);
    expect((await tenantGate(job('privacy.export', A.wsId))).skip).toBeUndefined();
    expect((await tenantGate(job('ai.qualify', B.wsId))).skip).toBeUndefined();
    // history + audit
    expect(await db().organizationStatusChange.count({ where: { organizationId: A.orgId, toStatus: 'SUSPENDED' } })).toBe(1);
    expect(await db().platformAuditEvent.count({ where: { organizationId: A.orgId, actorUserId: root.userId } })).toBeGreaterThan(0);
    await root.agent.post(`/api/v1/platform/tenants/${A.orgId}/lifecycle`).set('x-csrf-token', root.csrf).send({ action: 'reactivate', reason: 'Investigation closed' });
    expect((await lead(A, A.wsId, 'n@x.test')).status).toBe(201);
  });

  it('owner-requested deletion: name confirmation, grace period, cancel, then purge erases only that tenant', async () => {
    await lead(A, A.wsId, 'a@x.test'); await lead(B, B.wsId, 'b@x.test');
    expect((await A.agent.post(`/api/v1/orgs/${A.orgId}/deletion`).set('x-csrf-token', A.csrf).send({ confirmName: 'wrong' })).status).toBe(400);
    expect((await A.agent.post(`/api/v1/orgs/${A.orgId}/deletion`).set('x-csrf-token', A.csrf).send({ confirmName: 'Alpha Corp' })).status).toBe(200);
    expect((await db().organization.findUniqueOrThrow({ where: { id: A.orgId } })).status).toBe('DELETION_PENDING');
    expect((await A.agent.get(`/api/v1/w/${A.wsId}/leads`)).status).toBe(403); // closed while pending
    expect((await A.agent.delete(`/api/v1/orgs/${A.orgId}/deletion`).set('x-csrf-token', A.csrf)).status).toBe(200);
    expect((await A.agent.get(`/api/v1/w/${A.wsId}/leads`)).status).toBe(200);

    await A.agent.post(`/api/v1/orgs/${A.orgId}/deletion`).set('x-csrf-token', A.csrf).send({ confirmName: 'Alpha Corp' });
    await tenancy.purgeDueTenants(new Date(Date.now() + 1000)); // not yet due
    expect(await db().lead.count({ where: { workspaceId: A.wsId } })).toBe(1);
    await tenancy.purgeDueTenants(new Date(Date.now() + 30 * 86400_000));
    expect(await db().lead.count({ where: { workspaceId: A.wsId } })).toBe(0);
    expect(await db().workspace.count({ where: { organizationId: A.orgId } })).toBe(0);
    expect((await db().organization.findUniqueOrThrow({ where: { id: A.orgId } })).status).toBe('DELETED');
    expect(await db().lead.count({ where: { workspaceId: B.wsId } })).toBe(1);
    expect(await db().platformAuditEvent.count({ where: { organizationId: A.orgId } })).toBeGreaterThan(0); // audit survives
  });
});

describe('platform administration', () => {
  it('tenant owners cannot see the platform area; staff permissions are separated', async () => {
    for (const path of ['/api/v1/platform/tenants', '/api/v1/platform/metrics', '/api/v1/platform/plans', '/api/v1/platform/audit']) {
      expect((await A.agent.get(path)).status).toBe(404);
    }
    const sup = await staff('support@emn.test', 'SUPPORT');
    expect((await sup.agent.get('/api/v1/platform/tenants')).status).toBe(200);
    expect((await sup.agent.post(`/api/v1/platform/tenants/${A.orgId}/lifecycle`).set('x-csrf-token', sup.csrf).send({ action: 'suspend', reason: 'testing perms' })).status).toBe(404);
    const fin = await staff('finance@emn.test', 'FINANCE');
    expect((await fin.agent.get('/api/v1/platform/metrics')).status).toBe(200);
    const list = await root.agent.get('/api/v1/platform/tenants').query({ q: 'Beta' });
    expect(JSON.stringify(list.body)).toContain(B.orgId);
    expect(JSON.stringify(list.body)).not.toContain(A.orgId);
    const det = await root.agent.get(`/api/v1/platform/tenants/${A.orgId}`);
    expect(det.status).toBe(200);
    expect(JSON.stringify(det.body)).not.toMatch(/passwordHash|encrypted|secret/i);
  });

  it('plans are managed in the database and drive entitlements', async () => {
    process.env.BILLING_ENABLED = 'true';
    await billing.ensurePlans();
    const starter = await db().plan.findUniqueOrThrow({ where: { code: 'starter' } });
    const ent = { ...(starter.entitlements as Record<string, unknown>), maxWorkspaces: 2 };
    const r = await root.agent.put(`/api/v1/platform/plans/${starter.id}`).set('x-csrf-token', root.csrf).send({ code: 'starter', name: 'Starter', priceMonthlyCents: 4900, priceYearlyCents: 47000, currency: 'USD', trialDays: 14, isPublic: true, entitlements: ent });
    expect(r.status).toBe(200);
    await billing.startTrial(A.orgId, 'starter');
    expect((await tenantState(A.orgId)).entitlements.maxWorkspaces).toBe(2);
    expect((await A.agent.post(`/api/v1/orgs/${A.orgId}/workspaces`).set('x-csrf-token', A.csrf).send({ name: 'Two' })).status).toBe(201);
    const pub = await request(getApp()).get('/api/v1/public/plans');
    expect(pub.status).toBe(200);
    expect(JSON.stringify(pub.body)).not.toContain('providerPriceIds');
  });

  it('support access requires a reason, is read-only, expires, and every read is audited', async () => {
    await lead(A, A.wsId, 'cust@x.test');
    const sup = await staff('support@emn.test', 'SUPPORT');
    expect((await sup.agent.get(`/api/v1/w/${A.wsId}/leads`)).status).toBe(404); // no grant → no access
    expect((await sup.agent.post('/api/v1/platform/support/grants').set('x-csrf-token', sup.csrf).send({ organizationId: A.orgId, reason: 'short' })).status).toBe(400);
    const g = await sup.agent.post('/api/v1/platform/support/grants').set('x-csrf-token', sup.csrf).send({ organizationId: A.orgId, reason: 'Ticket #1881: import stuck at 40%', minutes: 30 });
    expect(g.status).toBe(201);
    expect((await sup.agent.get(`/api/v1/w/${A.wsId}/leads`)).status).toBe(200);
    expect((await lead(sup, A.wsId, 'x@x.test')).status).toBe(403);
    expect((await sup.agent.get(`/api/v1/w/${B.wsId}/leads`)).status).toBe(404); // grant is for A only
    expect(await db().platformAuditEvent.count({ where: { action: 'support.read', organizationId: A.orgId, actorUserId: sup.userId } })).toBeGreaterThan(0);
    expect(await db().auditLog.count({ where: { workspaceId: A.wsId, action: 'support.access_granted' } })).toBeGreaterThan(0); // visible to the customer
    await db().supportAccessGrant.update({ where: { id: g.body.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await sup.agent.get(`/api/v1/w/${A.wsId}/leads`)).status).toBe(404);
    // the platform audit trail is append-only
    await expect(db().platformAuditEvent.deleteMany({})).rejects.toThrow();
  });
});

describe('billing per organization (gateway fixtures, no real payments)', () => {
  it('a verified webhook activates only the tenant named in it; a browser redirect does not', async () => {
    process.env.BILLING_ENABLED = 'true';
    const secret = 'whsec_fixture';
    setGatewaysForTests({ stripe: new StripeGateway('sk_test_fixture', secret), razorpay: new RazorpayGateway('k', 's', 'r') });
    await billing.startTrial(A.orgId); await billing.startTrial(B.orgId);
    await db().subscription.update({ where: { organizationId: A.orgId }, data: { provider: 'stripe', providerCustomerId: 'cus_A' } });
    const growth = await db().plan.findUniqueOrThrow({ where: { code: 'growth' } });
    await db().plan.update({ where: { id: growth.id }, data: { providerPriceIds: { stripe_month: 'price_growth_m' } } });
    const body = JSON.stringify({ id: 'evt_A1', type: 'customer.subscription.updated', data: { object: { id: 'sub_A', customer: 'cus_A', status: 'active', metadata: { organizationId: A.orgId }, current_period_end: 1893456000, items: { data: [{ price: { id: 'price_growth_m' } }] } } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
    const r = await request(getApp()).post('/api/v1/webhooks/billing/stripe').set('stripe-signature', sig).set('content-type', 'application/json').send(body);
    expect(r.body).toEqual({ ok: true });
    const subA = await db().subscription.findUniqueOrThrow({ where: { organizationId: A.orgId }, include: { plan: true } });
    expect(subA.status).toBe('ACTIVE');
    expect(subA.plan.code).toBe('growth');
    expect((await db().subscription.findUniqueOrThrow({ where: { organizationId: B.orgId } })).status).toBe('TRIALING');
    expect((await db().organization.findUniqueOrThrow({ where: { id: A.orgId } })).status).toBe('ACTIVE');
    // The success redirect page carries no authority: there is no endpoint that activates on it.
    const routes = (await request(getApp()).get('/api/v1/openapi.json')).body?.paths ?? {};
    expect(Object.keys(routes).some((p: string) => /billing\/(success|confirm|activate)/.test(p))).toBe(false);
  });
});
