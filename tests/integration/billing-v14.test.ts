/**
 * v1.4: refunds, disputes, out-of-order payment events, reconciliation, one trial per person,
 * organization cap, annual pooled allowances and storage limits.
 * Payment providers are replaced by an in-process fake gateway (labelled MOCKED) — no real money moves.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../../backend/src/core/db.js';
import { hashPassword } from '../../backend/src/services/auth.js';
import * as billing from '../../backend/src/services/billing.js';
import { tenantState } from '../../backend/src/services/entitlements.js';
import { putTracked, deleteTracked, storageBytes, reconcileStorage } from '../../backend/src/services/storage-accounting.js';
import { recordUsage } from '../../backend/src/services/usage.js';
import { trialIdentity } from '../../backend/src/services/tenancy.js';
import { StripeGateway, setGatewaysForTests, type PaymentGateway, type ProviderSubscription } from '../../integrations/src/billing/gateways.js';
import { resetDb, installFakes, getApp, createUserSession } from '../helpers/harness.js';

const PW = 'CorrectHorse123!';
const SECRET = 'whsec_fixture_v14';

/** MOCKED gateway: real Stripe signature parsing, fake refund / fetch calls recorded in memory. */
class FakeStripe extends StripeGateway {
  refunds: Array<{ paymentId: string; amountCents?: number; idempotencyKey: string }> = [];
  remote: ProviderSubscription | null = null;
  constructor() { super('sk_test_fake', SECRET); }
  override async refund(p: { paymentId: string; amountCents?: number; idempotencyKey: string }) { this.refunds.push(p); return { id: `re_${this.refunds.length}`, status: 'pending' }; }
  override async fetchSubscription(): Promise<ProviderSubscription> { return this.remote!; }
  override async cancel() { /* recorded by state change only */ }
}
let gw: FakeStripe;

const signed = (obj: unknown) => {
  const body = JSON.stringify(obj);
  const t = Math.floor(Date.now() / 1000);
  return { body, sig: `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}` };
};
const hook = async (obj: unknown) => { const { body, sig } = signed(obj); return request(getApp()).post('/api/v1/webhooks/billing/stripe').set('stripe-signature', sig).set('content-type', 'application/json').send(body); };

async function staff() {
  const u = await db().user.create({ data: { email: 'fin@emn.test', name: 'Finance', passwordHash: await hashPassword(PW), platformRole: 'FINANCE', emailVerifiedAt: new Date() } });
  const agent = request.agent(getApp());
  const r = await agent.post('/api/v1/auth/login').send({ email: 'fin@emn.test', password: PW });
  await db().user.update({ where: { id: u.id }, data: { mfaEnabled: true } }); // staff 2FA (TOTP flow covered by e2e)
  return { agent, csrf: r.body.csrfToken as string };
}

beforeEach(async () => { await resetDb(); installFakes(); process.env.BILLING_ENABLED = 'true'; gw = new FakeStripe(); setGatewaysForTests({ stripe: gw as unknown as PaymentGateway, razorpay: gw as unknown as PaymentGateway }); });
afterEach(() => { delete process.env.BILLING_ENABLED; delete process.env.REGISTRATION_OPEN; delete process.env.MAX_ORGS_PER_USER; setGatewaysForTests(null); });

async function paidTenant(email = 'o@x.com') {
  const s = await createUserSession(email);
  await billing.startTrial(s.organizationId, 'growth');
  await db().subscription.update({ where: { organizationId: s.organizationId }, data: { provider: 'stripe', providerCustomerId: `cus_${email}`, providerSubscriptionId: `sub_${email}`, status: 'ACTIVE' } });
  const inv = await hook({ id: `evt_inv_${email}`, type: 'invoice.paid', created: Math.floor(Date.now() / 1000), data: { object: { id: `in_${email}`, customer: `cus_${email}`, subscription: `sub_${email}`, amount_paid: 14900, currency: 'usd', payment_intent: `pi_${email}` } } });
  expect(inv.body).toEqual({ ok: true });
  const invoice = await db().invoice.findUniqueOrThrow({ where: { providerInvoiceId: `in_${email}` } });
  expect(invoice.providerPaymentId).toBe(`pi_${email}`);
  return { s, invoice };
}

describe('refunds (MOCKED provider)', () => {
  it('staff refund is idempotent, bounded, confirmed only by webhook, and recorded on the invoice', async () => {
    const { s, invoice } = await paidTenant();
    const f = await staff();
    const requestKey = randomUUID();
    const body = { invoiceId: invoice.id, amountCents: 4900, reason: 'Customer asked for partial credit', requestKey };
    const r1 = await f.agent.post(`/api/v1/platform/tenants/${s.organizationId}/refunds`).set('x-csrf-token', f.csrf).send(body);
    const r2 = await f.agent.post(`/api/v1/platform/tenants/${s.organizationId}/refunds`).set('x-csrf-token', f.csrf).send(body);
    expect(r1.status).toBe(200);
    expect(r2.body.id).toBe(r1.body.id); // double-click → same refund, one provider call
    expect(gw.refunds).toHaveLength(1);
    expect(gw.refunds[0]).toMatchObject({ paymentId: `pi_o@x.com`, amountCents: 4900 });
    expect(r1.body.status).toBe('pending');
    // cannot refund more than what is left
    const over = await f.agent.post(`/api/v1/platform/tenants/${s.organizationId}/refunds`).set('x-csrf-token', f.csrf).send({ ...body, amountCents: 12000, requestKey: randomUUID() });
    expect(over.status).toBe(400);
    // provider confirms
    await hook({ id: 'evt_ref_1', type: 'refund.updated', created: Math.floor(Date.now() / 1000), data: { object: { id: 're_1', payment_intent: 'pi_o@x.com', amount: 4900, currency: 'usd', status: 'succeeded', metadata: { emnRefundKey: `staff:${requestKey}` } } } });
    const inv = await db().invoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(inv).toMatchObject({ amountRefundedCents: 4900, status: 'partially_refunded' });
    expect((await db().refund.findFirstOrThrow({ where: { id: r1.body.id } })).status).toBe('succeeded');
    // duplicate webhook is ignored
    expect((await hook({ id: 'evt_ref_1', type: 'refund.updated', data: { object: {} } })).body).toEqual({ duplicate: true });
    // tenant owners cannot refund themselves
    expect((await s.agent.post(`/api/v1/platform/tenants/${s.organizationId}/refunds`).set('x-csrf-token', s.csrf).send({ ...body, requestKey: randomUUID() })).status).toBe(404);
  });

  it('a refund issued in the provider dashboard is recorded; a full refund with cancellation ends entitlements', async () => {
    const { s, invoice } = await paidTenant();
    await hook({ id: 'evt_dash', type: 'charge.refunded', created: Math.floor(Date.now() / 1000), data: { object: { id: 'ch_1', payment_intent: 'pi_o@x.com', refunds: { data: [{ id: 're_dash', amount: 1000, currency: 'usd', status: 'succeeded' }] } } } });
    expect(await db().refund.count({ where: { organizationId: s.organizationId, providerRefundId: 're_dash' } })).toBe(1);
    const f = await staff();
    const r = await f.agent.post(`/api/v1/platform/tenants/${s.organizationId}/refunds`).set('x-csrf-token', f.csrf).send({ invoiceId: invoice.id, reason: 'Full refund within 14 days', cancelSubscription: true, requestKey: randomUUID() });
    expect(r.status).toBe(200);
    expect(r.body.amountCents).toBe(13900); // remaining after the dashboard refund
    expect((await db().subscription.findUniqueOrThrow({ where: { organizationId: s.organizationId } })).status).toBe('CANCELED');
    expect((await tenantState(s.organizationId)).operational).toBe(false);
    expect((await db().organization.findUniqueOrThrow({ where: { id: s.organizationId } })).status).toBe('CANCELLED');
  });
});

describe('disputes, ordering and reconciliation (MOCKED provider)', () => {
  it('a lost chargeback suspends the tenant and payment events do not lift it; a won dispute changes nothing', async () => {
    const { s } = await paidTenant();
    const { s: other } = await paidTenant('b@x.com');
    await hook({ id: 'evt_d1', type: 'charge.dispute.created', created: 1, data: { object: { id: 'dp_1', payment_intent: 'pi_b@x.com', amount: 14900, currency: 'usd', status: 'needs_response', reason: 'fraudulent' } } });
    await hook({ id: 'evt_d2', type: 'charge.dispute.closed', created: 2, data: { object: { id: 'dp_1', payment_intent: 'pi_b@x.com', amount: 14900, currency: 'usd', status: 'won' } } });
    expect((await db().organization.findUniqueOrThrow({ where: { id: other.organizationId } })).status).toBe('ACTIVE');
    await hook({ id: 'evt_d3', type: 'charge.dispute.created', created: 3, data: { object: { id: 'dp_2', payment_intent: 'pi_o@x.com', amount: 14900, currency: 'usd', status: 'needs_response', reason: 'fraudulent' } } });
    await hook({ id: 'evt_d4', type: 'charge.dispute.closed', created: 4, data: { object: { id: 'dp_2', payment_intent: 'pi_o@x.com', amount: 14900, currency: 'usd', status: 'lost' } } });
    expect((await db().organization.findUniqueOrThrow({ where: { id: s.organizationId } })).status).toBe('SUSPENDED');
    expect((await db().billingDispute.findUniqueOrThrow({ where: { providerDisputeId: 'dp_2' } })).status).toBe('lost');
    await hook({ id: 'evt_after', type: 'invoice.paid', created: Math.floor(Date.now() / 1000) + 5, data: { object: { id: 'in_after', customer: 'cus_o@x.com', subscription: 'sub_o@x.com', amount_paid: 14900, currency: 'usd' } } });
    expect((await db().organization.findUniqueOrThrow({ where: { id: s.organizationId } })).status).toBe('SUSPENDED');
  });

  it('an older event delivered late does not roll back newer subscription state', async () => {
    const { s } = await paidTenant();
    const now = Math.floor(Date.now() / 1000);
    await hook({ id: 'evt_new', type: 'customer.subscription.deleted', created: now, data: { object: { id: 'sub_o@x.com', customer: 'cus_o@x.com', status: 'canceled', metadata: { organizationId: s.organizationId } } } });
    const late = await hook({ id: 'evt_old', type: 'customer.subscription.updated', created: now - 600, data: { object: { id: 'sub_o@x.com', customer: 'cus_o@x.com', status: 'active', metadata: { organizationId: s.organizationId }, items: { data: [] } } } });
    expect(late.body).toEqual({ ok: true, stale: true });
    expect((await db().subscription.findUniqueOrThrow({ where: { organizationId: s.organizationId } })).status).toBe('CANCELED');
  });

  it('reconciliation repairs drift from a missed webhook', async () => {
    const { s } = await paidTenant();
    await db().subscription.update({ where: { organizationId: s.organizationId }, data: { status: 'PAST_DUE', graceUntil: new Date(Date.now() - 1000) } });
    gw.remote = { status: 'ACTIVE', currentPeriodEnd: new Date(Date.now() + 20 * 86400_000), currentPeriodStart: new Date(), cancelAtPeriodEnd: false, priceId: null };
    expect(await billing.reconcileSubscriptions()).toMatchObject({ checked: 1, repaired: 1 });
    expect((await db().subscription.findUniqueOrThrow({ where: { organizationId: s.organizationId } })).status).toBe('ACTIVE');
    expect(await billing.reconcileSubscriptions()).toMatchObject({ checked: 1, repaired: 0 });
  });
});

describe('trial abuse controls', () => {
  it('one free trial per person (Gmail dots and +tags normalised), a cap on owned organizations', async () => {
    process.env.REGISTRATION_OPEN = 'true';
    expect(trialIdentity('Jane.Doe+x@gmail.com')).toBe(trialIdentity('janedoe@googlemail.com'));
    expect(trialIdentity('a+b@corp.com')).toBe(trialIdentity('a@corp.com'));
    expect(trialIdentity('a.b@corp.com')).not.toBe(trialIdentity('ab@corp.com'));
    const sign = (email: string, org: string) => request.agent(getApp()).post('/api/v1/auth/signup').send({ name: 'n', email, password: PW, organizationName: org, acceptTerms: true });
    const first = await sign('jane.doe@gmail.com', 'Jane One');
    expect(first.body.trialGranted).toBe(true);
    const again = await sign('janedoe+2@gmail.com', 'Jane Two');
    expect(again.status).toBe(201);
    expect(again.body.trialGranted).toBe(false);
    const st = await tenantState(again.body.organization.id);
    expect(st.operational).toBe(false);
    expect(st.reason).toMatch(/free trial has already been used/);
    // the grant survives deletion of the first organization
    await db().organization.update({ where: { id: first.body.organization.id }, data: { status: 'DELETED' } });
    expect((await sign('j.a.n.e.d.o.e@gmail.com', 'Jane Three')).body.trialGranted).toBe(false);
    // organization cap
    process.env.MAX_ORGS_PER_USER = '1';
    const a = request.agent(getApp());
    const reg = await a.post('/api/v1/auth/signup').send({ name: 'n', email: 'cap@corp.com', password: PW, organizationName: 'Cap One', acceptTerms: true });
    const extra = await a.post('/api/v1/workspaces').set('x-csrf-token', reg.body.csrfToken).send({ name: 'Second org' });
    expect(extra.status).toBe(402);
  });
});

describe('annual pooled allowances', () => {
  it('yearly billing with annual pooling allows 12× the monthly allowance over the year', async () => {
    const s = await createUserSession('y@x.com');
    await billing.startTrial(s.organizationId, 'starter');
    const plan = await db().plan.findUniqueOrThrow({ where: { code: 'starter' } });
    const ent = { ...(plan.entitlements as Record<string, unknown>), monthlyWorkflowRuns: 10, allowancePeriod: 'annual_pooled' };
    await db().plan.update({ where: { id: plan.id }, data: { entitlements: ent } });
    const { assertMetered } = await import('../../backend/src/services/entitlements.js');
    await db().subscription.update({ where: { organizationId: s.organizationId }, data: { status: 'ACTIVE', interval: 'month' } });
    await recordUsage({ organizationId: s.organizationId, metric: 'workflow_runs', quantity: 10, key: 'wf:bulk' });
    await expect(assertMetered(s.organizationId, 'workflow_runs')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' }); // monthly billing: 10/month
    await db().subscription.update({ where: { organizationId: s.organizationId }, data: { interval: 'year', currentPeriodStart: new Date(Date.now() - 40 * 86400_000) } });
    await expect(assertMetered(s.organizationId, 'workflow_runs')).resolves.toBeTruthy(); // yearly pooled: 120/year
    await recordUsage({ organizationId: s.organizationId, metric: 'workflow_runs', quantity: 110, key: 'wf:bulk2' });
    await expect(assertMetered(s.organizationId, 'workflow_runs')).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', details: { period: 'year' } });
  });
});

describe('storage accounting and limits', () => {
  it('counts real bytes per organization, enforces the plan limit under concurrency, and releases on delete', async () => {
    const a = await createUserSession('s@x.com');
    const b = await createUserSession('t@x.com');
    await billing.startTrial(a.organizationId, 'starter');
    const plan = await db().plan.findUniqueOrThrow({ where: { code: 'starter' } });
    await db().plan.update({ where: { id: plan.id }, data: { entitlements: { ...(plan.entitlements as Record<string, unknown>), storageMb: 1 } } });
    const half = Buffer.alloc(400 * 1024, 1);
    const results = await Promise.allSettled([1, 2, 3, 4].map(() => putTracked(a.workspaceId, 'imports', half, 'csv', { enforce: true })));
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok).toHaveLength(2); // 2 × 400 KB fit in 1 MB, never 3
    expect(results.filter((r) => r.status === 'rejected').every((r) => (r as PromiseRejectedResult).reason.code === 'QUOTA_EXCEEDED')).toBe(true);
    expect(await storageBytes(a.organizationId)).toBe(800 * 1024);
    expect(await storageBytes(b.organizationId)).toBe(0); // tenant-scoped
    // compliance writes are recorded but never refused
    await expect(putTracked(a.workspaceId, 'privacy', half, 'json', { enforce: false })).resolves.toBeTruthy();
    await deleteTracked((ok[0] as PromiseFulfilledResult<string>).value);
    expect(await storageBytes(a.organizationId)).toBe(800 * 1024);
    // the API refuses an import upload over the limit with 402
    const big = Buffer.alloc(600 * 1024, 65);
    const up = await a.agent.post(`/api/v1/w/${a.workspaceId}/imports`).set('x-csrf-token', a.csrf).attach('file', big, { filename: 'big.csv', contentType: 'text/csv' });
    expect(up.status).toBe(402);
    // reconcile: objects that exist in storage but were never tracked are covered by a baseline row
    expect((await reconcileStorage()).workspaces).toBeGreaterThan(0);
    expect(await storageBytes(a.organizationId)).toBeGreaterThanOrEqual(800 * 1024);
    // a StoredObject cannot claim another organization's workspace
    await expect(db().storedObject.create({ data: { organizationId: b.organizationId, workspaceId: a.workspaceId, key: 'x/forged', kind: 'x', bytes: 1n } })).rejects.toThrow(/tenant guard/);
  });
});
