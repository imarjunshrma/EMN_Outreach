/**
 * A payment webhook whose processing fails must not be recorded as handled: the provider's retry of the same event has to
 * apply it. The failure is real (a temporary PostgreSQL trigger rejects the subscription update), not a mocked service.
 * Payment providers are replaced by an in-process gateway with real Stripe signature parsing (MOCKED) — no money moves.
 */
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../../backend/src/core/db.js';
import * as billing from '../../backend/src/services/billing.js';
import { StripeGateway, setGatewaysForTests, type PaymentGateway } from '../../integrations/src/billing/gateways.js';
import { resetDb, installFakes, getApp, createUserSession } from '../helpers/harness.js';

const SECRET = 'whsec_fixture_retry';

const hook = (obj: unknown) => {
  const body = JSON.stringify(obj);
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}`;
  return request(getApp()).post('/api/v1/webhooks/billing/stripe').set('stripe-signature', sig).set('content-type', 'application/json').send(body);
};

async function failSubscriptionUpdates() {
  await db().$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_reject_subscription_update() RETURNS trigger AS $$
    BEGIN RAISE EXCEPTION 'injected subscription write failure'; END $$ LANGUAGE plpgsql`);
  await db().$executeRawUnsafe('CREATE TRIGGER test_reject_subscription_update BEFORE UPDATE ON "Subscription" FOR EACH ROW EXECUTE FUNCTION test_reject_subscription_update()');
}
async function restoreSubscriptionUpdates() {
  await db().$executeRawUnsafe('DROP TRIGGER IF EXISTS test_reject_subscription_update ON "Subscription"');
  await db().$executeRawUnsafe('DROP FUNCTION IF EXISTS test_reject_subscription_update()');
}

beforeEach(async () => {
  await resetDb();
  installFakes();
  process.env.BILLING_ENABLED = 'true';
  const gateway = new StripeGateway('sk_test_fake', SECRET) as unknown as PaymentGateway;
  setGatewaysForTests({ stripe: gateway, razorpay: gateway });
});
afterEach(async () => {
  await restoreSubscriptionUpdates();
  delete process.env.BILLING_ENABLED;
  setGatewaysForTests(null);
});

describe('payment webhook retries (MOCKED provider)', () => {
  it('applies a redelivered event after its first processing attempt failed', async () => {
    const s = await createUserSession('retry-owner@x.com');
    await billing.startTrial(s.organizationId, 'growth');
    await db().subscription.update({ where: { organizationId: s.organizationId }, data: { provider: 'stripe', providerCustomerId: 'cus_retry', providerSubscriptionId: 'sub_retry', status: 'ACTIVE' } });
    const event = {
      id: 'evt_retry_failed_payment', type: 'invoice.payment_failed', created: Math.floor(Date.now() / 1000),
      data: { object: { id: 'in_retry', customer: 'cus_retry', subscription: 'sub_retry', amount_due: 4900, currency: 'usd', status: 'open' } },
    };

    await failSubscriptionUpdates();
    const first = await hook(event);
    expect(first.status).toBe(500);
    await restoreSubscriptionUpdates();
    expect((await db().subscription.findUniqueOrThrow({ where: { organizationId: s.organizationId } })).status).toBe('ACTIVE');

    const retry = await hook(event);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ ok: true });
    const subscription = await db().subscription.findUniqueOrThrow({ where: { organizationId: s.organizationId } });
    expect(subscription.status).toBe('PAST_DUE');
    expect(subscription.graceUntil).not.toBeNull();

    // A genuine duplicate after success is still ignored.
    expect((await hook(event)).body).toEqual({ duplicate: true });
    expect(await db().billingEvent.count({ where: { provider: 'stripe', eventId: event.id } })).toBe(1);
  });
});
