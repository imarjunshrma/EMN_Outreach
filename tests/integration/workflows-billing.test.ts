import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../../backend/src/core/db.js';
import { queue, QUEUES } from '../../backend/src/core/queues.js';
import * as wf from '../../backend/src/services/workflows.js';
import * as billing from '../../backend/src/services/billing.js';
import { StripeGateway, RazorpayGateway, setGatewaysForTests } from '../../integrations/src/billing/gateways.js';
import { GraphSchema } from '../../shared/src/workflow.js';
import { resetDb, installFakes, createUserSession, addLead, addMailbox, getApp } from '../helpers/harness.js';

beforeEach(async () => { await resetDb(); installFakes(); });
afterEach(() => { delete process.env.BILLING_ENABLED; setGatewaysForTests(null); });
const ACTOR = { type: 'SYSTEM' as const };

const graph = (blocks: unknown[]) => ({ blocks }) as never;
const tagIfIndia = graph([{ id: 'c1', kind: 'condition', all: [{ field: 'lead.country', op: 'eq', value: 'IN' }], then: [{ id: 'a1', kind: 'action', action: 'add_tag', params: { tag: 'india' } }], else: [{ id: 'a2', kind: 'action', action: 'add_tag', params: { tag: 'intl' } }] }]);

describe('visual workflow engine', () => {
  it('validates graphs: size, depth and unknown actions are rejected', () => {
    expect(GraphSchema.safeParse({ blocks: [] }).success).toBe(false);
    expect(GraphSchema.safeParse({ blocks: [{ id: 'x', kind: 'action', action: 'send_email', params: {} }] }).success).toBe(false);
    let deep: unknown = { id: 'leaf', kind: 'action', action: 'add_tag', params: { tag: 't' } };
    for (let i = 0; i < 5; i++) deep = { id: `c${i}`, kind: 'condition', all: [{ field: 'lead.status', op: 'exists' }], then: [deep], else: [] };
    expect(GraphSchema.safeParse({ blocks: [deep] }).success).toBe(false);
    expect(GraphSchema.safeParse(tagIfIndia).success).toBe(true);
  });

  it('branches on conditions, dry-runs in test mode, dedupes per event and honours the daily limit', async () => {
    const s = await createUserSession('o@x.com');
    const inLead = await addLead(s.workspaceId, 'a@in.co', { country: 'IN' });
    const usLead = await addLead(s.workspaceId, 'b@us.co', { country: 'US' });
    const w = await wf.saveWorkflow(s.workspaceId, null, { name: 'Tag by country', trigger: 'lead.created', graph: tagIfIndia, maxRunsPerDay: 2 }, ACTOR);
    // test mode never changes data
    const t = await wf.triggerManual(s.workspaceId, w.id, { leadId: inLead.id }, true, ACTOR);
    expect(t.status).toBe('COMPLETED');
    expect((t as { log: Array<{ detail: string }> }).log.some((l) => l.detail.startsWith('[test] would add_tag'))).toBe(true);
    expect((await db().lead.findUniqueOrThrow({ where: { id: inLead.id } })).tags).not.toContain('india');
    // live: branches correctly
    await wf.runWorkflow(s.workspaceId, w.id, 'evt-1', { leadId: inLead.id }, false);
    await wf.runWorkflow(s.workspaceId, w.id, 'evt-2', { leadId: usLead.id }, false);
    expect((await db().lead.findUniqueOrThrow({ where: { id: inLead.id } })).tags).toContain('india');
    expect((await db().lead.findUniqueOrThrow({ where: { id: usLead.id } })).tags).toContain('intl');
    // same event again → skipped (idempotent)
    expect(await wf.runWorkflow(s.workspaceId, w.id, 'evt-1', { leadId: inLead.id }, false)).toMatchObject({ skipped: 'already ran for this event' });
    // daily limit 2 reached
    expect(await wf.runWorkflow(s.workspaceId, w.id, 'evt-3', { leadId: inLead.id }, false)).toMatchObject({ skipped: expect.stringContaining('daily run limit') });
    expect(await db().workflowRun.count({ where: { workflowId: w.id, testMode: false } })).toBe(2);
    // versioning: a new save creates v2; restore v1 works
    const w2 = await wf.saveWorkflow(s.workspaceId, w.id, { name: 'Tag by country', trigger: 'lead.created', graph: graph([{ id: 'a', kind: 'action', action: 'add_tag', params: { tag: 'v2' } }]), maxRunsPerDay: 2 }, ACTOR);
    expect(w2.versions).toHaveLength(2);
    await wf.restoreVersion(s.workspaceId, w.id, w2.versions[1].id, ACTOR);
    expect((await db().workflow.findUniqueOrThrow({ where: { id: w.id } })).activeVersionId).toBe(w2.versions[1].id);
  });

  it('dispatches from domain events only for active workflows, and refuses to resume a safety-paused campaign', async () => {
    const s = await createUserSession('o@x.com');
    const w = await wf.saveWorkflow(s.workspaceId, null, { name: 'n', trigger: 'lead.created', graph: tagIfIndia, maxRunsPerDay: 100 }, ACTOR);
    expect(await wf.dispatch(s.workspaceId, 'lead.created', 'k1', {})).toBe(0);
    await wf.setActive(s.workspaceId, w.id, true, ACTOR);
    expect(await wf.dispatch(s.workspaceId, 'lead.created', 'k1', {})).toBe(1);
    expect(await wf.dispatch(s.workspaceId, 'lead.created', 'k1', {})).toBe(1);
    const jobs = await queue(QUEUES.automation).getJobs(['waiting', 'delayed', 'prioritized']);
    expect(jobs.filter((j) => j.name === 'workflow.run')).toHaveLength(1); // same event → one job

    const camp = await db().campaign.create({ data: { workspaceId: s.workspaceId, name: 'C', sendingWindow: {}, status: 'PAUSED', approvedContentHash: 'abc', pauseReason: 'Auto-paused: bounce rate 6%' } });
    const r = await wf.saveWorkflow(s.workspaceId, null, { name: 'resume', trigger: 'manual', graph: graph([{ id: 'r', kind: 'action', action: 'resume_campaign', params: { campaignId: camp.id } }]), maxRunsPerDay: 10 }, ACTOR);
    await wf.setActive(s.workspaceId, r.id, true, ACTOR);
    await expect(wf.triggerManual(s.workspaceId, r.id, {}, false, ACTOR)).rejects.toThrow(/Resume refused/);
    expect((await db().campaign.findUniqueOrThrow({ where: { id: camp.id } })).status).toBe('PAUSED');
    // references to other tenants' campaigns are rejected at save time
    const other = await createUserSession('p@y.com');
    await expect(wf.saveWorkflow(other.workspaceId, null, { name: 'x', trigger: 'manual', graph: graph([{ id: 'p', kind: 'action', action: 'pause_campaign', params: { campaignId: camp.id } }]), maxRunsPerDay: 10 }, ACTOR)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('inbound webhook requires the per-workflow token and never accepts another tenant\'s lead', async () => {
    const s = await createUserSession('o@x.com');
    const other = await createUserSession('p@y.com');
    const foreign = await addLead(other.workspaceId, 'z@z.co');
    const w = await wf.saveWorkflow(s.workspaceId, null, { name: 'hook', trigger: 'webhook.received', graph: tagIfIndia, maxRunsPerDay: 10 }, ACTOR);
    await wf.setActive(s.workspaceId, w.id, true, ACTOR);
    const res = await s.agent.post(`/api/v1/w/${s.workspaceId}/workflows/${w.id}/webhook-token`).set('x-csrf-token', s.csrf);
    expect(res.status).toBe(200);
    const app = getApp();
    expect((await request(app).post(`/api/v1/hooks/workflow/${w.id}`).send({})).status).toBe(403);
    expect((await request(app).post(`/api/v1/hooks/workflow/${w.id}`).set('x-emn-workflow-token', 'wrong').send({})).status).toBe(403);
    const ok = await request(app).post(`/api/v1/hooks/workflow/${w.id}`).set('x-emn-workflow-token', res.body.token).send({ leadId: foreign.id, source: 'zap' });
    expect(ok.status).toBe(202);
    // regression: editing workspace settings must not wipe the server-managed webhook token
    expect((await s.agent.patch(`/api/v1/w/${s.workspaceId}`).set('x-csrf-token', s.csrf).send({ settings: { replyMode: 'suggest' } })).status).toBe(200);
    expect((await request(app).post(`/api/v1/hooks/workflow/${w.id}`).set('x-emn-workflow-token', res.body.token).send({})).status).toBe(202);
    expect(JSON.stringify((await s.agent.get(`/api/v1/w/${s.workspaceId}`)).body)).not.toContain('workflowTokens');
    const job = (await queue(QUEUES.automation).getJobs(['waiting'])).find((j) => j.name === 'workflow.run' && j.data.payload.source === 'zap')!;
    expect(job.data.workspaceId).toBe(s.workspaceId);
    expect(job.data.payload.leadId).toBeUndefined();
    expect(job.data.payload.source).toBe('zap');
    // API: viewer cannot create workflows
    const viewer = await createUserSession('v@x.com', 'VIEWER', s.workspaceId);
    expect((await viewer.agent.post(`/api/v1/w/${s.workspaceId}/workflows`).set('x-csrf-token', viewer.csrf).send({ name: 'x', trigger: 'manual', graph: tagIfIndia })).status).toBe(403);
  });
});

describe('billing & entitlements', () => {
  it('self-hosted mode (default) is unlimited and enforces nothing', async () => {
    const s = await createUserSession('o@x.com');
    expect((await billing.billingState(s.workspaceId)).mode).toBe('self_hosted');
    await expect(billing.assertEntitled(s.workspaceId, 'mailboxes')).resolves.toBeUndefined();
    expect(await db().subscription.count()).toBe(0);
  });

  it('SaaS mode: trial on signup, quota enforcement, expired trial blocks, feature gates', async () => {
    process.env.BILLING_ENABLED = 'true';
    const s = await createUserSession('o@x.com');
    await billing.startTrial(s.organizationId); // createUserSession may bypass signup
    const st = await billing.billingState(s.workspaceId);
    expect(st).toMatchObject({ mode: 'saas', active: true, status: 'TRIALING', plan: { code: 'starter' } });
    for (let i = 0; i < 3; i++) await addMailbox(s.workspaceId, `m${i}@ourco.com`);
    await expect(billing.assertEntitled(s.workspaceId, 'mailboxes')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', status: 402 });
    await expect(billing.assertEntitled(s.workspaceId, 'feature:workflows')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    await expect(wf.saveWorkflow(s.workspaceId, null, { name: 'n', trigger: 'manual', graph: tagIfIndia, maxRunsPerDay: 1 }, ACTOR)).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });
    // API returns 402 for the mailbox quota
    const r = await s.agent.post(`/api/v1/w/${s.workspaceId}/email-accounts/smtp`).set('x-csrf-token', s.csrf).send({ emailAddress: 'n@ourco.com', smtpHost: 'smtp.ourco.com', smtpPort: 587, smtpSecure: false, imapHost: 'imap.ourco.com', imapPort: 993, imapSecure: true, username: 'n', password: 'p' });
    expect(r.status).toBe(402);
    await db().subscription.update({ where: { organizationId: s.organizationId }, data: { trialEndsAt: new Date(Date.now() - 1000) } });
    await expect(billing.assertEntitled(s.workspaceId, 'active')).rejects.toMatchObject({ code: 'SUBSCRIPTION_INACTIVE' });
  });

  it('Stripe webhooks are signature-verified, idempotent, and drive status / grace period / invoices', async () => {
    process.env.BILLING_ENABLED = 'true';
    const secret = 'whsec_test';
    setGatewaysForTests({ stripe: new StripeGateway('sk_test', secret), razorpay: new RazorpayGateway('k', 's', 'rzp_secret') });
    const s = await createUserSession('o@x.com');
    await billing.startTrial(s.organizationId);
    await db().subscription.update({ where: { organizationId: s.organizationId }, data: { provider: 'stripe', providerCustomerId: 'cus_1' } });
    const sign = (body: string) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`; };
    const app = getApp();
    const post = (body: string, sig: string) => request(app).post('/api/v1/webhooks/billing/stripe').set('stripe-signature', sig).set('content-type', 'application/json').send(body);

    const upd = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { workspaceId: s.workspaceId }, current_period_end: 1893456000, items: { data: [] } } } });
    expect((await post(upd, 't=1,v1=bad')).status).toBe(400);
    expect((await post(upd, sign(upd))).body).toEqual({ ok: true });
    expect((await post(upd, sign(upd))).body).toEqual({ duplicate: true });
    expect((await db().subscription.findUniqueOrThrow({ where: { organizationId: s.organizationId } })).status).toBe('ACTIVE');

    const fail = JSON.stringify({ id: 'evt_2', type: 'invoice.payment_failed', data: { object: { id: 'in_1', customer: 'cus_1', subscription: 'sub_1', amount_due: 4900, currency: 'usd' } } });
    await post(fail, sign(fail));
    const sub = await db().subscription.findUniqueOrThrow({ where: { organizationId: s.organizationId } });
    expect(sub.status).toBe('PAST_DUE');
    expect(sub.graceUntil!.getTime()).toBeGreaterThan(Date.now() + 6 * 86400_000);
    expect((await billing.billingState(s.workspaceId)).active).toBe(true); // within grace
    expect(await db().invoice.count({ where: { organizationId: s.organizationId, status: 'payment_failed' } })).toBe(1);
    await db().subscription.update({ where: { organizationId: s.organizationId }, data: { graceUntil: new Date(Date.now() - 1) } });
    expect((await billing.billingState(s.workspaceId)).active).toBe(false);
  });

  it('Razorpay webhook signature is HMAC of the raw body; platform-admin override only for platform admins', async () => {
    process.env.BILLING_ENABLED = 'true';
    const gw = new RazorpayGateway('k', 's', 'rzp_secret');
    const s = await createUserSession('o@x.com');
    const body = JSON.stringify({ event: 'subscription.activated', payload: { subscription: { entity: { id: 'sub_r', customer_id: 'c', notes: { workspaceId: s.workspaceId }, current_end: 1893456000 } } } });
    expect(() => gw.verifyAndParse(body, { 'x-razorpay-signature': 'nope' })).toThrow(/signature/);
    const ev = gw.verifyAndParse(body, { 'x-razorpay-signature': createHmac('sha256', 'rzp_secret').update(body).digest('hex'), 'x-razorpay-event-id': 'e1' });
    expect(ev).toMatchObject({ type: 'subscription.activated', workspaceId: s.workspaceId, status: 'ACTIVE' });

    // Platform routes are invisible (404) to tenant owners; only platform staff can override.
    expect((await s.agent.get('/api/v1/platform/tenants')).status).toBe(404);
    expect((await s.agent.post(`/api/v1/platform/tenants/${s.organizationId}/subscription`).set('x-csrf-token', s.csrf).send({ planCode: 'growth', status: 'ACTIVE', reason: 'sneaky self-upgrade' })).status).toBe(404);
    await db().user.update({ where: { id: s.userId }, data: { platformRole: 'SUPER_ADMIN' } });
    const o = await s.agent.post(`/api/v1/platform/tenants/${s.organizationId}/subscription`).set('x-csrf-token', s.csrf).send({ planCode: 'growth', status: 'ACTIVE', reason: 'Pilot customer upgrade' });
    expect(o.status).toBe(200);
    expect(await db().platformAuditEvent.count({ where: { organizationId: s.organizationId, action: { contains: 'subscription' } } })).toBeGreaterThan(0);
    expect((await billing.billingState(s.workspaceId)).entitlements.features.workflows).toBe(true);
    // checkout without configured gateway is a clear error, not a fake success
    setGatewaysForTests({ stripe: new StripeGateway('', ''), razorpay: gw });
    const c = await s.agent.post(`/api/v1/orgs/${s.organizationId}/billing/checkout`).set('x-csrf-token', s.csrf).send({ planCode: 'growth', provider: 'stripe' });
    expect(c.status).toBe(400);
    expect(c.body.error.code).toBe('PROVIDER_NOT_CONFIGURED');
  });
});
