/**
 * Super admin console, part 2: "log in as" (impersonation), the data explorer, user-account controls,
 * tenant profile/workspace edits and the expanded global settings (maintenance, security, sign-ups, branding).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../../backend/src/core/db.js';
import { hashPassword } from '../../backend/src/services/auth.js';
import { resetDb, installFakes, getApp } from '../helpers/harness.js';

const PW = 'CorrectHorse123!';
type Agent = ReturnType<typeof request.agent>;
type S = { agent: Agent; csrf: string; userId: string };

async function login(email: string, password = PW): Promise<S> {
  const agent = request.agent(getApp());
  const r = await agent.post('/api/v1/auth/login').send({ email, password });
  return { agent, csrf: r.body.csrfToken, userId: r.body.user?.id };
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
const send = (s: { agent: Agent; csrf: string }, method: 'get' | 'post' | 'put' | 'patch' | 'delete', path: string, body?: unknown) => {
  const req = s.agent[method](`/api/v1${path}`).set('x-csrf-token', s.csrf);
  return method === 'get' ? req : req.send(body ?? {});
};
const R = 'Ticket #5120 — customer asked for help';

let root: S;
afterEach(() => { delete process.env.REGISTRATION_OPEN; });
beforeEach(async () => {
  process.env.REGISTRATION_OPEN = 'true';
  await resetDb();
  installFakes();
  root = await staff('root@emn.test', 'SUPER_ADMIN');
});

describe('log in as (impersonation)', () => {
  it('opens a full-access session as the tenant owner, audits every change and returns the admin to their own account', async () => {
    const t = await signup('owner@alpha.test', 'Alpha');
    expect((await send(root, 'post', `/platform/tenants/${t.orgId}/impersonate`, { reason: 'x' })).status).toBe(400); // reason required

    const start = await send(root, 'post', `/platform/tenants/${t.orgId}/impersonate`, { reason: R, minutes: 30 });
    expect(start.status).toBe(200);
    expect(start.body.user.email).toBe('owner@alpha.test');
    expect(start.body.redirectTo).toBe(`/w/${t.wsId}`);
    const as = { agent: root.agent, csrf: start.body.csrfToken as string };

    const me = await send(as, 'get', '/auth/me');
    expect(me.body.user.email).toBe('owner@alpha.test');
    expect(me.body.impersonation.by.email).toBe('root@emn.test');
    expect(me.body.impersonation.reason).toBe(R);

    // Full access: the super admin can change things as the user.
    const lead = await send(as, 'post', `/w/${t.wsId}/leads`, { email: 'lead@prospect.test', firstName: 'Pat' });
    expect(lead.status).toBe(201);
    const writes = await db().platformAuditEvent.findMany({ where: { action: 'impersonation.write', actorUserId: root.userId } });
    expect(writes.some((w) => w.targetId === `POST /api/v1/w/${t.wsId}/leads` && w.organizationId === t.orgId)).toBe(true);
    const tenantLog = await db().auditLog.findMany({ where: { workspaceId: t.wsId } });
    expect(tenantLog.some((a) => a.action === 'support.signed_in_as_user')).toBe(true);
    expect(tenantLog.some((a) => (a.metadata as { impersonatedBy?: string }).impersonatedBy === root.userId)).toBe(true);

    // The person's own security settings stay theirs, and the console is not reachable as them.
    expect((await send(as, 'post', '/auth/password', { currentPassword: PW, newPassword: 'AnotherPass12345' })).status).toBe(403);
    expect((await send(as, 'post', '/auth/mfa/setup')).status).toBe(403);
    expect((await send(as, 'get', '/platform/me')).status).toBe(404);
    // Starting a second one from inside is refused (no platform role in this session).
    expect((await send(as, 'post', `/platform/tenants/${t.orgId}/impersonate`, { reason: R })).status).toBe(404);

    const open = await send(root, 'get', '/platform/impersonations');
    void open; // the root agent is currently the impersonated session; checked after returning

    const stop = await send(as, 'post', '/auth/impersonation/stop');
    expect(stop.status).toBe(200);
    expect(stop.body.restored).toBe(true);
    expect(stop.body.redirectTo).toBe(`/platform/users/${t.userId}`);
    const back = { agent: root.agent, csrf: stop.body.csrfToken as string };
    const me2 = await send(back, 'get', '/auth/me');
    expect(me2.body.user.email).toBe('root@emn.test');
    expect(me2.body.impersonation).toBeNull();
    expect((await send(back, 'get', '/platform/me')).status).toBe(200);
    expect(await db().session.count({ where: { impersonatorId: root.userId, revokedAt: null } })).toBe(0);
    const actions = (await db().platformAuditEvent.findMany({ where: { actorUserId: root.userId } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['impersonation.started', 'impersonation.write', 'impersonation.ended']));
  });

  it('logging out of a "log in as" session returns to the admin account; an expired one still returns', async () => {
    const t = await signup('owner@beta.test', 'Beta');
    const start = await send(root, 'post', `/platform/users/${t.userId}/impersonate`, { reason: R });
    expect(start.status).toBe(200);
    const out = await send({ agent: root.agent, csrf: start.body.csrfToken }, 'post', '/auth/logout');
    expect(out.body.restored).toBe(true);
    expect((await send({ agent: root.agent, csrf: out.body.csrfToken }, 'get', '/auth/me')).body.user.email).toBe('root@emn.test');

    const again = await send({ agent: root.agent, csrf: out.body.csrfToken }, 'post', `/platform/users/${t.userId}/impersonate`, { reason: R });
    expect(again.status).toBe(200);
    await db().session.updateMany({ where: { impersonatorId: root.userId, revokedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await root.agent.get('/api/v1/auth/me')).status).toBe(401);
    const stop = await root.agent.post('/api/v1/auth/impersonation/stop').send({});
    expect(stop.body.restored).toBe(true);
    expect((await root.agent.get('/api/v1/auth/me')).body.user.email).toBe('root@emn.test');
  });

  it('is super-admin only, never for staff accounts, and ends when the admin loses the role', async () => {
    const t = await signup('owner@gamma.test', 'Gamma');
    const support = await staff('help@emn.test', 'SUPPORT');
    expect((await send(support, 'post', `/platform/users/${t.userId}/impersonate`, { reason: R })).status).toBe(404);
    expect((await send(root, 'post', `/platform/users/${support.userId}/impersonate`, { reason: R })).status).toBe(403);
    expect((await send(root, 'post', `/platform/users/${root.userId}/impersonate`, { reason: R })).status).toBe(400);
    await db().user.update({ where: { id: t.userId }, data: { status: 'DISABLED' } });
    expect((await send(root, 'post', `/platform/users/${t.userId}/impersonate`, { reason: R })).status).toBe(409);
    await db().user.update({ where: { id: t.userId }, data: { status: 'ACTIVE' } });

    // The session is capped by Global settings → Security.
    await send(root, 'put', '/platform/settings', { security: { passwordMinLength: 12, sessionIdleDays: 7, requireMfaForAllUsers: false, impersonationMaxMinutes: 10 }, reason: R });
    const second = await staff('root2@emn.test', 'SUPER_ADMIN');
    const start = await send(second, 'post', `/platform/users/${t.userId}/impersonate`, { reason: R, minutes: 120 });
    expect(start.status).toBe(200);
    const mins = (new Date(start.body.expiresAt).getTime() - Date.now()) / 60_000;
    expect(mins).toBeLessThanOrEqual(10.1);

    // Listed for other super admins, who can end it.
    const list = await send(root, 'get', '/platform/impersonations');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].impersonator.email).toBe('root2@emn.test');

    // A demoted admin's "log in as" session stops working at once.
    await db().user.update({ where: { id: second.userId }, data: { platformRole: null, isPlatformAdmin: false } });
    expect((await second.agent.get('/api/v1/auth/me')).status).toBe(401);

    expect((await send(root, 'delete', `/platform/impersonations/${list.body[0].id}`)).status).toBe(200);
  });
});

describe('data explorer', () => {
  it('shows every table per tenant, hides secrets, edits with an audited reason and refuses unsafe changes', async () => {
    const a = await signup('owner@alpha.test', 'Alpha');
    const b = await signup('owner@bravo.test', 'Bravo');
    await send(a, 'post', `/w/${a.wsId}/leads`, { email: 'one@x.test' });
    await send(b, 'post', `/w/${b.wsId}/leads`, { email: 'two@x.test' });

    const support = await staff('help@emn.test', 'SUPPORT');
    expect((await send(support, 'get', '/platform/data')).status).toBe(404);
    expect((await a.agent.get('/api/v1/platform/data')).status).toBe(404);

    const models = await send(root, 'get', `/platform/data?organizationId=${a.orgId}`);
    expect(models.status).toBe(200);
    expect(models.body.models.length).toBeGreaterThan(100);
    expect(models.body.models.find((m: { name: string }) => m.name === 'Lead').count).toBe(1);

    const leads = await send(root, 'get', `/platform/data/Lead?organizationId=${a.orgId}`);
    expect(leads.body.total).toBe(1);
    expect(leads.body.data[0].email).toBe('one@x.test');
    const search = await send(root, 'get', '/platform/data/Lead?q=two@x');
    expect(search.body.total).toBe(1);

    const users = await send(root, 'get', `/platform/data/User?organizationId=${a.orgId}`);
    expect(users.body.total).toBe(1);
    expect(users.body.data[0].passwordHash).toBe('[hidden]');
    expect(users.body.model.fields.find((f: { name: string }) => f.name === 'passwordHash').editable).toBe(false);

    const ws = await send(root, 'get', `/platform/data/Workspace/${a.wsId}`);
    expect(ws.status).toBe(200);
    expect(ws.body.organizationId).toBe(a.orgId);
    expect(ws.body.children.find((c: { field: string }) => c.field === 'leads')).toMatchObject({ model: 'Lead', count: 1, filterField: 'workspaceId' });

    expect((await send(root, 'patch', `/platform/data/Workspace/${a.wsId}`, { changes: { name: 'Renamed' }, reason: 'x' })).status).toBe(400);
    const edit = await send(root, 'patch', `/platform/data/Workspace/${a.wsId}`, { changes: { name: 'Alpha HQ' }, reason: R });
    expect(edit.status).toBe(200);
    expect(edit.body.record.name).toBe('Alpha HQ');
    const ev = await db().platformAuditEvent.findFirst({ where: { action: 'data.updated', targetId: a.wsId } });
    expect(ev?.metadata).toMatchObject({ before: { name: 'Alpha' }, after: { name: 'Alpha HQ' } });

    expect((await send(root, 'patch', `/platform/data/Workspace/${a.wsId}`, { changes: { organizationId: b.orgId }, reason: R })).status).toBe(400);
    expect((await send(root, 'patch', `/platform/data/User/${a.userId}`, { changes: { passwordHash: 'x' }, reason: R })).status).toBe(400);
    expect((await send(root, 'patch', `/platform/data/User/${a.userId}`, { changes: { platformRole: 'SUPER_ADMIN' }, reason: R })).status).toBe(400);
    expect((await send(root, 'delete', `/platform/data/User/${a.userId}`, { reason: R })).status).toBe(403);

    const leadId = leads.body.data[0].id;
    expect((await send(root, 'delete', `/platform/data/Lead/${leadId}`, { reason: R })).status).toBe(200);
    expect(await db().lead.count({ where: { id: leadId } })).toBe(0);
    expect(await db().platformAuditEvent.count({ where: { action: 'data.deleted', targetId: leadId } })).toBe(1);
  });
});

describe('user accounts and tenant edits', () => {
  it('shows a full account view and can edit, reset two-factor and sign out everywhere', async () => {
    const t = await signup('owner@alpha.test', 'Alpha');
    await signup('other@alpha.test', 'Other');
    const d = await send(root, 'get', `/platform/users/${t.userId}`);
    expect(d.status).toBe(200);
    expect(d.body.user.orgMemberships[0].organization.id).toBe(t.orgId);
    expect(d.body.sessions.length).toBe(1);

    expect((await send(root, 'put', `/platform/users/${t.userId}`, { email: 'other@alpha.test', reason: R })).status).toBe(409);
    const e = await send(root, 'put', `/platform/users/${t.userId}`, { name: 'Olivia Owner', emailVerified: true, reason: R });
    expect(e.status).toBe(200);
    expect(e.body.user.name).toBe('Olivia Owner');
    expect(e.body.user.emailVerifiedAt).toBeTruthy();

    expect((await send(root, 'post', `/platform/users/${t.userId}/mfa-reset`, { reason: R })).status).toBe(409);
    await db().user.update({ where: { id: t.userId }, data: { mfaEnabled: true, mfaSecretEnc: 'enc' } });
    expect((await send(root, 'post', `/platform/users/${t.userId}/mfa-reset`, { reason: R })).status).toBe(200);
    expect((await db().user.findUnique({ where: { id: t.userId } }))!.mfaEnabled).toBe(false);

    const again = await login('owner@alpha.test');
    expect((await send(root, 'post', `/platform/users/${t.userId}/sessions/revoke`, { reason: R })).body.revoked).toBeGreaterThanOrEqual(1);
    expect((await again.agent.get('/api/v1/auth/me')).status).toBe(401);
  });

  it('renames a tenant and archives or restores its workspaces', async () => {
    const t = await signup('owner@alpha.test', 'Alpha');
    expect((await send(root, 'put', `/platform/tenants/${t.orgId}/profile`, { name: 'Alpha Corp', timezone: 'Asia/Kolkata', reason: R })).status).toBe(200);
    const o = await db().organization.findUnique({ where: { id: t.orgId } });
    expect(o).toMatchObject({ name: 'Alpha Corp', timezone: 'Asia/Kolkata' });
    // The last open workspace cannot be archived.
    expect((await send(root, 'put', `/platform/tenants/${t.orgId}/workspaces/${t.wsId}`, { archived: true, reason: R })).status).toBe(409);
    expect((await send(root, 'put', `/platform/tenants/${t.orgId}/workspaces/${t.wsId}`, { name: 'Main', reason: R })).status).toBe(200);
  });
});

describe('global settings', () => {
  it('maintenance mode pauses customer changes but not reading, staff or "log in as"', async () => {
    const t = await signup('owner@alpha.test', 'Alpha');
    const s = await send(root, 'put', '/platform/settings', { maintenance: { enabled: true, message: 'Upgrading — back at 10:00' }, reason: R });
    expect(s.status).toBe(200);
    expect(s.body.maintenance.enabled).toBe(true);
    expect((await request(getApp()).get('/api/v1/public/config')).body.maintenance.message).toBe('Upgrading — back at 10:00');

    expect((await send(t, 'get', `/w/${t.wsId}/leads`)).status).toBe(200);
    const blocked = await send(t, 'post', `/w/${t.wsId}/leads`, { email: 'a@b.test' });
    expect(blocked.status).toBe(503);
    expect(blocked.body.error.code).toBe('MAINTENANCE');
    expect((await request(getApp()).post('/api/v1/auth/signup').send({ name: 'n', email: 'new@x.test', password: PW, organizationName: 'New', acceptTerms: true })).status).toBe(503);
    expect((await login('owner@alpha.test')).csrf).toBeTruthy(); // signing in still works

    const start = await send(root, 'post', `/platform/tenants/${t.orgId}/impersonate`, { reason: R });
    expect((await send({ agent: root.agent, csrf: start.body.csrfToken }, 'post', `/w/${t.wsId}/leads`, { email: 'fix@b.test' })).status).toBe(201);
  });

  it('security, sign-up and branding settings take effect', async () => {
    const save = (body: object) => send(root, 'put', '/platform/settings', { ...body, reason: R });
    expect((await save({})).status).toBe(400); // nothing to save
    expect((await save({ security: { passwordMinLength: 4, sessionIdleDays: 7, requireMfaForAllUsers: false, impersonationMaxMinutes: 60 } })).status).toBe(400);

    expect((await save({ security: { passwordMinLength: 20, sessionIdleDays: 2, requireMfaForAllUsers: false, impersonationMaxMinutes: 60 } })).status).toBe(200);
    const short = await request(getApp()).post('/api/v1/auth/signup').send({ name: 'n', email: 'n@x.test', password: PW, organizationName: 'Nova', acceptTerms: true });
    expect(short.status).toBe(400);
    expect(JSON.stringify(short.body.error)).toContain('20 characters');
    expect((await request(getApp()).get('/api/v1/public/config')).body.passwordMinLength).toBe(20);
    const longPw = 'A much longer passphrase 99';
    const ok = await request.agent(getApp()).post('/api/v1/auth/signup').send({ name: 'n', email: 'n@x.test', password: longPw, organizationName: 'Nova', acceptTerms: true });
    expect(ok.status).toBe(201);
    const sess = await db().session.findFirst({ where: { user: { email: 'n@x.test' } } });
    expect((sess!.expiresAt.getTime() - Date.now()) / 86_400_000).toBeLessThan(2.01);

    // Everyone must use two-factor: workspaces refuse until they turn it on.
    const t = await signup('owner@mfa.test', 'Mfa'); // signed up while the rule was off? No — still 20 chars rule
    expect(t.status).toBe(400);
    await save({ security: { passwordMinLength: 12, sessionIdleDays: 7, requireMfaForAllUsers: true, impersonationMaxMinutes: 60 } });
    const u = await signup('owner@mfa.test', 'Mfa');
    const r = await send(u, 'get', `/w/${u.wsId}/leads`);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('MFA_REQUIRED');

    // Sign-ups: organizations per person.
    await save({ security: { passwordMinLength: 12, sessionIdleDays: 7, requireMfaForAllUsers: false, impersonationMaxMinutes: 60 }, signups: { defaultPlanCode: '', maxOrgsPerUser: 1 } });
    const second = await send(root, 'post', '/platform/tenants', { organizationName: 'Second org', ownerEmail: 'owner@mfa.test', reason: R });
    expect(second.status).toBe(402);
    expect(second.body.error.message).toContain('1 organizations');
    await save({ signups: { defaultPlanCode: '', maxOrgsPerUser: null } });
    expect((await send(root, 'post', '/platform/tenants', { organizationName: 'Second org', ownerEmail: 'owner@mfa.test', reason: R })).status).toBe(201);

    const b = await save({ branding: { appName: 'Acme Outreach', supportEmail: 'help@acme.test' } });
    expect(b.body.branding.appName).toBe('Acme Outreach');
    expect((await request(getApp()).get('/api/v1/public/config')).body).toMatchObject({ appName: 'Acme Outreach', supportEmail: 'help@acme.test', maintenance: null });
    const audit = await db().platformAuditEvent.findFirst({ where: { action: 'platform.settings_saved' }, orderBy: { createdAt: 'desc' } });
    expect(audit?.metadata).toMatchObject({ changed: ['branding'], after: { branding: { appName: 'Acme Outreach' } } });
  });

  it('keeps the original settings body working (sign-up mode + announcement)', async () => {
    const r = await send(root, 'put', '/platform/settings', { signupMode: 'closed', announcement: { enabled: true, level: 'warning', message: 'Heads up' }, reason: R });
    expect(r.status).toBe(200);
    expect(r.body.signupMode).toBe('closed');
    expect(r.body.effective.registrationOpen).toBe(false);
    expect(r.body.security.passwordMinLength).toBe(12); // defaults fill in untouched groups
  });
});
