/**
 * Super-admin back office: staff roles, tenant creation, member management, per-tenant modules & limits,
 * permission matrix, global settings and the announcement banner. Every write needs a reason and is audited.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../../backend/src/core/db.js';
import { hashPassword } from '../../backend/src/services/auth.js';
import { resetDb, installFakes, getApp } from '../helpers/harness.js';

const PW = 'CorrectHorse123!';
type Agent = ReturnType<typeof request.agent>;
type S = { agent: Agent; csrf: string; userId: string };

async function login(email: string, password = PW): Promise<S & { status: number }> {
  const agent = request.agent(getApp());
  const r = await agent.post('/api/v1/auth/login').send({ email, password });
  return { agent, csrf: r.body.csrfToken, userId: r.body.user?.id, status: r.status };
}
async function staff(email: string, role: 'SUPER_ADMIN' | 'SUPPORT' | 'FINANCE'): Promise<S> {
  const u = await db().user.create({ data: { email, name: role, passwordHash: await hashPassword(PW), platformRole: role, isPlatformAdmin: role === 'SUPER_ADMIN', emailVerifiedAt: new Date() } });
  const s = await login(email);
  await db().user.update({ where: { id: u.id }, data: { mfaEnabled: true } });
  return { ...s, userId: u.id };
}
async function signup(email: string, organizationName: string) {
  const agent = request.agent(getApp());
  const r = await agent.post('/api/v1/auth/signup').send({ name: email.split('@')[0], email, password: PW, organizationName, acceptTerms: true });
  return { agent, csrf: r.body.csrfToken as string, userId: r.body.user?.id as string, orgId: r.body.organization?.id as string, wsId: r.body.workspace?.id as string, status: r.status };
}
const send = (s: S, method: 'get' | 'post' | 'put', path: string, body?: unknown) => {
  const req = s.agent[method](`/api/v1${path}`).set('x-csrf-token', s.csrf);
  return method === 'get' ? req : req.send(body ?? {});
};
const R = 'Ticket #4711 — customer request';

let root: S;
afterEach(() => { delete process.env.REGISTRATION_OPEN; });
beforeEach(async () => {
  process.env.REGISTRATION_OPEN = 'true'; // tenants sign up after the first (staff) account exists
  await resetDb();
  installFakes();
  root = await staff('root@emn.test', 'SUPER_ADMIN');
});

describe('access', () => {
  it('is invisible to tenants and read-only for support staff', async () => {
    const t = await signup('owner@alpha.test', 'Alpha');
    const support = await staff('help@emn.test', 'SUPPORT');
    for (const p of ['/platform/staff', '/platform/permissions', '/platform/settings', `/platform/tenants/${t.orgId}/members`, `/platform/tenants/${t.orgId}/modules`]) {
      expect((await t.agent.get(`/api/v1${p}`)).status, p).toBe(404);
    }
    expect((await send(support, 'get', `/platform/tenants/${t.orgId}/members`)).status).toBe(200);
    expect((await send(support, 'get', '/platform/permissions')).status).toBe(200);
    expect((await send(support, 'get', '/platform/staff')).status).toBe(404); // staff:manage is super-admin only
    expect((await send(support, 'put', '/platform/settings', { signupMode: 'closed', announcement: { enabled: false, level: 'info', message: '' }, reason: R })).status).toBe(404);
    expect((await send(support, 'post', '/platform/tenants', { organizationName: 'X', ownerEmail: 'x@x.test', reason: R })).status).toBe(404);
  });
});

describe('staff & roles', () => {
  it('grants, changes and removes platform roles with guard rails', async () => {
    const t = await signup('person@alpha.test', 'Alpha');
    const add = await send(root, 'post', '/platform/staff', { email: 'person@alpha.test', role: 'SUPPORT', reason: R });
    expect(add.status).toBe(200);
    expect((await db().user.findUniqueOrThrow({ where: { id: t.userId } })).platformRole).toBe('SUPPORT');
    expect((await send(root, 'post', '/platform/staff', { email: 'nobody@x.test', role: 'SUPPORT', reason: R })).status).toBe(404);
    expect((await send(root, 'post', '/platform/staff', { email: 'person@alpha.test', role: 'SUPPORT', reason: 'x' })).status).toBe(400); // reason required
    // Changing a role signs the person out so the new rights apply at once.
    expect(await db().session.count({ where: { userId: t.userId } })).toBe(1);
    await send(root, 'put', `/platform/staff/${t.userId}`, { role: 'FINANCE', reason: R });
    expect(await db().session.count({ where: { userId: t.userId } })).toBe(0);
    // You cannot change your own role, and the last super admin cannot be demoted.
    expect((await send(root, 'put', `/platform/staff/${root.userId}`, { role: null, reason: R })).status).toBe(403);
    const other = await staff('second@emn.test', 'SUPER_ADMIN');
    expect((await send(other, 'put', `/platform/staff/${root.userId}`, { role: 'SUPPORT', reason: R })).status).toBe(200);
    expect((await send(root, 'get', '/platform/staff')).status).toBe(401); // demoted → signed out everywhere
    expect((await send(other, 'put', `/platform/staff/${other.userId}`, { role: null, reason: R })).status).toBe(403);
    const list = await send(other, 'get', '/platform/staff');
    expect(Object.fromEntries(list.body.staff.map((x: { email: string; platformRole: string }) => [x.email, x.platformRole]))).toEqual({ 'second@emn.test': 'SUPER_ADMIN', 'root@emn.test': 'SUPPORT', 'person@alpha.test': 'FINANCE' });
    const audit = await db().platformAuditEvent.findMany({ where: { action: { startsWith: 'staff.' } } });
    expect(audit.every((a) => a.reason === R)).toBe(true);
  });
});

describe('tenants & members', () => {
  it('creates a tenant for a new owner who sets their own password through the link', async () => {
    const r = await send(root, 'post', '/platform/tenants', { organizationName: 'Gamma Clinics', ownerEmail: 'Dr.Gamma@Clinic.test', ownerName: 'Dr Gamma', reason: R });
    expect(r.status).toBe(201);
    expect(r.body.ownerCreated).toBe(true);
    expect(r.body.setup.mailed).toBe(false); // no system mail in tests → link shown once to the admin
    const token = String(r.body.setup.link).split('/reset-password/')[1];
    expect((await login('dr.gamma@clinic.test', 'whatever-password-1')).status).toBe(401);
    expect((await request(getApp()).post('/api/v1/auth/password/reset').send({ token, password: 'Fresh-password-12345' })).status).toBe(200);
    const owner = await login('dr.gamma@clinic.test', 'Fresh-password-12345');
    expect(owner.status).toBe(200);
    const m = await send(root, 'get', `/platform/tenants/${r.body.organizationId}/members`);
    expect(m.body.members).toHaveLength(1);
    expect(m.body.members[0].role).toBe('OWNER');
    expect(await db().platformAuditEvent.count({ where: { action: 'tenant.created_by_admin', organizationId: r.body.organizationId } })).toBe(1);
  });

  it('adds, re-roles, transfers ownership and removes members; seat limits still apply', async () => {
    const t = await signup('owner@beta.test', 'Beta');
    const add = await send(root, 'post', `/platform/tenants/${t.orgId}/members`, { email: 'new@beta.test', role: 'MEMBER', workspaceId: t.wsId, workspaceRole: 'MANAGER', reason: R });
    expect(add.status).toBe(201);
    const uid = add.body.userId as string;
    expect(await db().workspaceMember.findFirst({ where: { workspaceId: t.wsId, userId: uid } })).toMatchObject({ role: 'MANAGER' });
    expect((await send(root, 'post', `/platform/tenants/${t.orgId}/members`, { email: 'new@beta.test', role: 'MEMBER', reason: R })).status).toBe(409);
    expect((await send(root, 'put', `/platform/tenants/${t.orgId}/members/${uid}`, { role: 'ADMIN', reason: R })).status).toBe(200);
    // Ownership transfer: the new person becomes owner, then the old owner can be demoted.
    expect((await send(root, 'put', `/platform/tenants/${t.orgId}/members/${uid}`, { role: 'OWNER', reason: R })).status).toBe(200);
    expect((await db().organization.findUniqueOrThrow({ where: { id: t.orgId } })).ownerId).toBe(uid);
    expect((await send(root, 'put', `/platform/tenants/${t.orgId}/members/${t.userId}`, { role: 'ADMIN', reason: R })).status).toBe(200);
    // The last owner cannot be demoted or removed.
    expect((await send(root, 'put', `/platform/tenants/${t.orgId}/members/${uid}`, { role: 'MEMBER', reason: R })).status).toBe(409);
    expect((await send(root, 'post', `/platform/tenants/${t.orgId}/members/${uid}/remove`, { reason: R })).status).toBe(409);
    expect((await send(root, 'post', `/platform/tenants/${t.orgId}/members/${t.userId}/remove`, { reason: R })).status).toBe(200);
    expect(await db().workspaceMember.count({ where: { userId: t.userId, workspaceId: t.wsId } })).toBe(0);
    // Seat limit (set through Modules & limits) blocks additional members.
    await send(root, 'put', `/platform/tenants/${t.orgId}/modules`, { features: nullFeatures(), limits: { ...nullLimits(), maxUsers: 1 }, integrations: null, reason: R });
    const over = await send(root, 'post', `/platform/tenants/${t.orgId}/members`, { email: 'third@beta.test', role: 'MEMBER', reason: R });
    expect(over.status).toBe(402);
  });

  it('issues a password-reset link for a user', async () => {
    const t = await signup('forgot@beta.test', 'Beta');
    const r = await send(root, 'post', `/platform/users/${t.userId}/password-reset`, { reason: R });
    expect(r.status).toBe(200);
    const token = String(r.body.link).split('/reset-password/')[1];
    expect((await request(getApp()).post('/api/v1/auth/password/reset').send({ token, password: 'Another-password-123' })).status).toBe(200);
    expect((await login('forgot@beta.test', 'Another-password-123')).status).toBe(200);
  });
});

const nullFeatures = () => ({ copilot: null, workflows: null, autoReply: null, waterfall: null, apiAccess: null, agencyWorkspaces: null });
const nullLimits = () => ({ maxUsers: null, maxWorkspaces: null, maxMailboxes: null, maxActiveCampaigns: null, maxLeads: null, monthlyEmailSends: null, monthlyAiUsd: null, monthlyEnrichments: null, monthlyApiCalls: null, monthlyWorkflowRuns: null, storageMb: null, apiRequestsPerMinute: null });

describe('modules & limits', () => {
  it('turns single modules off, overrides limits, and returns to the plan when cleared', async () => {
    const t = await signup('owner@delta.test', 'Delta');
    const before = await send(root, 'get', `/platform/tenants/${t.orgId}/modules`);
    expect(before.status).toBe(200);
    expect(before.body.mode).toBe('self_hosted');
    expect(before.body.effective.features.copilot).toBe(true);
    const set = await send(root, 'put', `/platform/tenants/${t.orgId}/modules`, { features: { ...nullFeatures(), copilot: false }, limits: { ...nullLimits(), maxLeads: 123 }, integrations: null, reason: R });
    expect(set.status).toBe(200);
    expect(set.body.effective.features.copilot).toBe(false);
    expect(set.body.effective.features.workflows).toBe(true); // others inherit
    expect(set.body.effective.maxLeads).toBe(123);
    // Enforced, not just displayed: the tenant can no longer use the Copilot.
    const { assertFeature } = await import('../../backend/src/services/entitlements.js');
    await expect(assertFeature(t.orgId, 'copilot' as never)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    // The tenant itself cannot write the overrides through its own organization settings.
    const self = await t.agent.patch(`/api/v1/orgs/${t.orgId}`).set('x-csrf-token', t.csrf).send({ settings: { adminOverrides: {} } });
    expect((await db().organization.findUniqueOrThrow({ where: { id: t.orgId } })).settings).toMatchObject({ adminOverrides: { features: { copilot: false } } });
    void self;
    const cleared = await send(root, 'put', `/platform/tenants/${t.orgId}/modules`, { features: nullFeatures(), limits: nullLimits(), integrations: null, reason: R });
    expect(cleared.body.overrides).toEqual({});
    expect(cleared.body.effective.features.copilot).toBe(true);
    expect(await db().platformAuditEvent.count({ where: { action: 'tenant.modules_set', organizationId: t.orgId } })).toBe(2);
  });
});

describe('permission matrix & settings', () => {
  it('derives workspace permissions from the real route rules', async () => {
    const m = await send(root, 'get', '/platform/permissions');
    const leads = m.body.workspace.find((x: { module: string }) => x.module === 'Leads');
    expect(leads.byRole.VIEWER.view).toBe(true);
    expect(leads.byRole.VIEWER.change).toBe(false);
    expect(leads.byRole.OWNER.change).toBe(true);
    expect(m.body.platform.find((x: { role: string }) => x.role === 'SUPPORT').permissions).not.toContain('staff:manage');
  });

  it('sign-up mode and the announcement banner take effect for everyone', async () => {
    await signup('first@x.test', 'First'); // the very first account may always register
    const closed = await send(root, 'put', '/platform/settings', { signupMode: 'closed', announcement: { enabled: true, level: 'warning', message: 'Maintenance tonight 22:00 IST' }, reason: R });
    expect(closed.status).toBe(200);
    expect(closed.body.effective.registrationOpen).toBe(false);
    expect((await signup('late@x.test', 'Late')).status).toBe(403);
    const u = await login('first@x.test');
    expect((await u.agent.get('/api/v1/announcement')).body.announcement).toEqual({ level: 'warning', message: 'Maintenance tonight 22:00 IST' });
    await send(root, 'put', '/platform/settings', { signupMode: 'open', announcement: { enabled: false, level: 'info', message: '' }, reason: R });
    expect((await signup('late@x.test', 'Late')).status).toBe(201);
    expect((await u.agent.get('/api/v1/announcement')).body.announcement).toBeNull();
    expect((await send(root, 'put', '/platform/settings', { signupMode: 'env', announcement: { enabled: true, level: 'info', message: '' }, reason: R })).status).toBe(400);
  });
});
