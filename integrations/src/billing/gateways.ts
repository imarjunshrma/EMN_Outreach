import { createHmac, timingSafeEqual } from 'node:crypto';
import { httpJson, ProviderError, type FetchLike } from '../http.js';

// Payment gateway abstraction. Stripe (global) and Razorpay (India). Platform-level credentials from env.
// Written against each provider's public API docs; NOT exercised against live accounts from this codebase.

export interface NormalizedBillingEvent {
  id: string; type: 'subscription.activated' | 'subscription.updated' | 'subscription.canceled' | 'invoice.paid' | 'invoice.failed' | 'refund.updated' | 'dispute.updated' | 'ignored';
  /** Provider-side event time; used to ignore events that arrive out of order. */
  occurredAt?: Date | null;
  workspaceId?: string | null; customerId?: string | null; subscriptionId?: string | null;
  status?: 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'TRIALING' | 'INCOMPLETE'; currentPeriodEnd?: Date | null; currentPeriodStart?: Date | null; cancelAtPeriodEnd?: boolean; priceId?: string | null;
  invoice?: { id: string; amountCents: number; currency: string; status: string; hostedUrl?: string | null; periodStart?: Date | null; periodEnd?: Date | null; paymentId?: string | null };
  refund?: { id: string; paymentId: string | null; amountCents: number; currency: string; status: 'pending' | 'succeeded' | 'failed' | 'canceled'; metadataRefundId?: string | null };
  dispute?: { id: string; paymentId: string | null; amountCents: number; currency: string; status: 'open' | 'won' | 'lost' | 'closed'; reason?: string | null };
  raw: unknown;
}

/** Provider-side view of a subscription, for reconciliation. */
export interface ProviderSubscription { status: NonNullable<NormalizedBillingEvent['status']>; currentPeriodEnd: Date | null; currentPeriodStart: Date | null; cancelAtPeriodEnd: boolean; priceId: string | null }

export interface PaymentGateway {
  readonly name: 'stripe' | 'razorpay';
  readonly configured: boolean;
  createCheckout(p: { workspaceId: string; email: string; priceId: string; customerId?: string | null; successUrl: string; cancelUrl: string }): Promise<{ url: string; customerId?: string | null; subscriptionId?: string | null }>;
  createPortal(p: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  cancel(p: { subscriptionId: string; atPeriodEnd: boolean }): Promise<void>;
  verifyAndParse(rawBody: string, headers: Record<string, string | undefined>): NormalizedBillingEvent;
  /** Requests a refund. Full refund when amountCents is omitted. The idempotency key makes retries safe. */
  refund(p: { paymentId: string; amountCents?: number; idempotencyKey: string; reason?: string }): Promise<{ id: string; status: string }>;
  fetchSubscription(subscriptionId: string): Promise<ProviderSubscription>;
}

const eq = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

export class StripeGateway implements PaymentGateway {
  readonly name = 'stripe' as const;
  constructor(private readonly secretKey = process.env.STRIPE_SECRET_KEY ?? '', private readonly webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? '', private readonly fetchImpl?: FetchLike, private readonly base = 'https://api.stripe.com/v1') {}
  get configured() { return !!this.secretKey && !!this.webhookSecret; }
  private post<T>(path: string, body: Record<string, string>, extraHeaders: Record<string, string> = {}) {
    return httpJson<T>(`${this.base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${this.secretKey}`, 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders }, body: form(body) }, { provider: 'stripe', fetchImpl: this.fetchImpl });
  }
  async refund(p: { paymentId: string; amountCents?: number; idempotencyKey: string; reason?: string }) {
    const body: Record<string, string> = { [p.paymentId.startsWith('ch_') ? 'charge' : 'payment_intent']: p.paymentId, 'metadata[emnRefundKey]': p.idempotencyKey };
    if (p.amountCents) body.amount = String(p.amountCents);
    const r = await this.post<{ id: string; status: string }>('/refunds', body, { 'idempotency-key': p.idempotencyKey });
    return { id: r.id, status: r.status };
  }
  async fetchSubscription(subscriptionId: string): Promise<ProviderSubscription> {
    const o = await httpJson<Record<string, any>>(`${this.base}/subscriptions/${subscriptionId}`, { headers: { authorization: `Bearer ${this.secretKey}` } }, { provider: 'stripe', fetchImpl: this.fetchImpl }); // eslint-disable-line @typescript-eslint/no-explicit-any
    const ts = (n: unknown) => (typeof n === 'number' ? new Date(n * 1000) : null);
    return { status: stripeStatus(o.status), currentPeriodEnd: ts(o.current_period_end ?? o.items?.data?.[0]?.current_period_end), currentPeriodStart: ts(o.current_period_start ?? o.items?.data?.[0]?.current_period_start), cancelAtPeriodEnd: !!o.cancel_at_period_end, priceId: o.items?.data?.[0]?.price?.id ?? null };
  }
  async createCheckout(p: { workspaceId: string; email: string; priceId: string; customerId?: string | null; successUrl: string; cancelUrl: string }) {
    let customer = p.customerId;
    if (!customer) customer = (await this.post<{ id: string }>('/customers', { email: p.email, 'metadata[workspaceId]': p.workspaceId, 'metadata[organizationId]': p.workspaceId })).id;
    const s = await this.post<{ url: string }>('/checkout/sessions', { mode: 'subscription', customer, 'line_items[0][price]': p.priceId, 'line_items[0][quantity]': '1', success_url: p.successUrl, cancel_url: p.cancelUrl, client_reference_id: p.workspaceId, 'subscription_data[metadata][workspaceId]': p.workspaceId, 'subscription_data[metadata][organizationId]': p.workspaceId });
    return { url: s.url, customerId: customer };
  }
  async createPortal(p: { customerId: string; returnUrl: string }) { return { url: (await this.post<{ url: string }>('/billing_portal/sessions', { customer: p.customerId, return_url: p.returnUrl })).url }; }
  async cancel(p: { subscriptionId: string; atPeriodEnd: boolean }) {
    if (p.atPeriodEnd) await this.post(`/subscriptions/${p.subscriptionId}`, { cancel_at_period_end: 'true' });
    else await httpJson(`${this.base}/subscriptions/${p.subscriptionId}`, { method: 'DELETE', headers: { authorization: `Bearer ${this.secretKey}` } }, { provider: 'stripe', fetchImpl: this.fetchImpl });
  }
  verifyAndParse(rawBody: string, headers: Record<string, string | undefined>, nowSec = Math.floor(Date.now() / 1000)): NormalizedBillingEvent {
    const sig = headers['stripe-signature'] ?? '';
    const parts = Object.fromEntries(sig.split(',').map((x) => x.split('=', 2)));
    const t = Number(parts.t);
    const expected = createHmac('sha256', this.webhookSecret).update(`${parts.t}.${rawBody}`).digest('hex');
    const v1s = sig.split(',').filter((x) => x.startsWith('v1=')).map((x) => x.slice(3));
    if (!this.webhookSecret || !t || Math.abs(nowSec - t) > 300 || !v1s.some((v) => eq(v, expected))) throw new ProviderError('stripe', 'Invalid webhook signature', 400);
    const e = JSON.parse(rawBody) as { id: string; type: string; data: { object: Record<string, any> } }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const o = e.data.object;
    const ts = (n: unknown) => (typeof n === 'number' ? new Date(n * 1000) : null);
    const status = stripeStatus;
    const occurredAt = ts((e as { created?: number }).created);
    const refundStatus = (s: string) => (({ succeeded: 'succeeded', failed: 'failed', canceled: 'canceled' }) as Record<string, 'succeeded' | 'failed' | 'canceled'>)[s] ?? 'pending';
    const disputeStatus = (s: string) => (s === 'won' ? 'won' : s === 'lost' ? 'lost' : 'open') as 'open' | 'won' | 'lost';
    switch (e.type) {
      case 'refund.created': case 'refund.updated': case 'refund.failed': case 'charge.refund.updated':
        return { id: e.id, occurredAt, type: 'refund.updated', refund: { id: o.id, paymentId: o.payment_intent ?? o.charge ?? null, amountCents: o.amount ?? 0, currency: String(o.currency ?? 'usd').toUpperCase(), status: refundStatus(o.status), metadataRefundId: o.metadata?.emnRefundKey ?? null }, raw: e };
      case 'charge.refunded': {
        const r = o.refunds?.data?.[0];
        if (!r) return { id: e.id, occurredAt, type: 'ignored', raw: e };
        return { id: e.id, occurredAt, type: 'refund.updated', refund: { id: r.id, paymentId: o.payment_intent ?? o.id, amountCents: r.amount ?? 0, currency: String(r.currency ?? 'usd').toUpperCase(), status: refundStatus(r.status), metadataRefundId: r.metadata?.emnRefundKey ?? null }, raw: e };
      }
      case 'charge.dispute.created': case 'charge.dispute.updated': case 'charge.dispute.closed':
        return { id: e.id, occurredAt, type: 'dispute.updated', dispute: { id: o.id, paymentId: o.payment_intent ?? o.charge ?? null, amountCents: o.amount ?? 0, currency: String(o.currency ?? 'usd').toUpperCase(), status: disputeStatus(o.status), reason: o.reason ?? null }, raw: e };
      case 'checkout.session.completed': return { id: e.id, occurredAt, type: 'subscription.activated', workspaceId: o.client_reference_id ?? null, customerId: o.customer ?? null, subscriptionId: o.subscription ?? null, status: 'ACTIVE', raw: e };
      case 'customer.subscription.updated': case 'customer.subscription.created': return { id: e.id, occurredAt, type: 'subscription.updated', currentPeriodStart: ts(o.current_period_start ?? o.items?.data?.[0]?.current_period_start), workspaceId: o.metadata?.organizationId ?? o.metadata?.workspaceId ?? null, customerId: o.customer, subscriptionId: o.id, status: status(o.status), currentPeriodEnd: ts(o.current_period_end ?? o.items?.data?.[0]?.current_period_end), cancelAtPeriodEnd: !!o.cancel_at_period_end, priceId: o.items?.data?.[0]?.price?.id ?? null, raw: e };
      case 'customer.subscription.deleted': return { id: e.id, occurredAt, type: 'subscription.canceled', workspaceId: o.metadata?.organizationId ?? o.metadata?.workspaceId ?? null, customerId: o.customer, subscriptionId: o.id, status: 'CANCELED', raw: e };
      case 'invoice.paid': case 'invoice.payment_failed': return { id: e.id, occurredAt, type: e.type === 'invoice.paid' ? 'invoice.paid' : 'invoice.failed', customerId: o.customer, subscriptionId: o.subscription ?? o.parent?.subscription_details?.subscription ?? null, invoice: { id: o.id, amountCents: o.amount_paid || o.amount_due || 0, currency: String(o.currency ?? 'usd').toUpperCase(), status: e.type === 'invoice.paid' ? 'paid' : 'payment_failed', hostedUrl: o.hosted_invoice_url ?? null, periodStart: ts(o.period_start), periodEnd: ts(o.period_end), paymentId: o.payment_intent ?? o.charge ?? null }, raw: e };
      default: return { id: e.id, occurredAt, type: 'ignored', raw: e };
    }
  }
}

function stripeStatus(s: string): NonNullable<NormalizedBillingEvent['status']> {
  return (({ active: 'ACTIVE', trialing: 'TRIALING', past_due: 'PAST_DUE', unpaid: 'PAST_DUE', canceled: 'CANCELED', incomplete: 'INCOMPLETE', incomplete_expired: 'CANCELED' }) as Record<string, NonNullable<NormalizedBillingEvent['status']>>)[s] ?? 'INCOMPLETE';
}

export class RazorpayGateway implements PaymentGateway {
  readonly name = 'razorpay' as const;
  constructor(private readonly keyId = process.env.RAZORPAY_KEY_ID ?? '', private readonly keySecret = process.env.RAZORPAY_KEY_SECRET ?? '', private readonly webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET ?? '', private readonly fetchImpl?: FetchLike, private readonly base = 'https://api.razorpay.com/v1') {}
  get configured() { return !!this.keyId && !!this.keySecret && !!this.webhookSecret; }
  private auth() { return `Basic ${Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64')}`; }
  async createCheckout(p: { workspaceId: string; email: string; priceId: string }) {
    // Razorpay "plan_id" is stored in Plan.providerPriceIds.razorpay. Returns the hosted payment link.
    const s = await httpJson<{ id: string; short_url: string }>(`${this.base}/subscriptions`, { method: 'POST', headers: { authorization: this.auth(), 'content-type': 'application/json' }, body: JSON.stringify({ plan_id: p.priceId, total_count: 120, customer_notify: 1, notes: { workspaceId: p.workspaceId, organizationId: p.workspaceId, email: p.email } }) }, { provider: 'razorpay', fetchImpl: this.fetchImpl });
    return { url: s.short_url, subscriptionId: s.id };
  }
  async createPortal(): Promise<{ url: string }> { throw new ProviderError('razorpay', 'Razorpay has no hosted customer portal; manage or cancel from the Billing page', 400); }
  async refund(p: { paymentId: string; amountCents?: number; idempotencyKey: string; reason?: string }) {
    // Razorpay deduplicates on `receipt` per payment; the key doubles as our receipt.
    const r = await httpJson<{ id: string; status: string }>(`${this.base}/payments/${p.paymentId}/refund`, { method: 'POST', headers: { authorization: this.auth(), 'content-type': 'application/json' }, body: JSON.stringify({ ...(p.amountCents ? { amount: p.amountCents } : {}), receipt: p.idempotencyKey.slice(0, 40), notes: { emnRefundKey: p.idempotencyKey, reason: p.reason ?? '' } }) }, { provider: 'razorpay', fetchImpl: this.fetchImpl, retries: 0 });
    return { id: r.id, status: r.status };
  }
  async fetchSubscription(subscriptionId: string): Promise<ProviderSubscription> {
    const o = await httpJson<Record<string, any>>(`${this.base}/subscriptions/${subscriptionId}`, { headers: { authorization: this.auth() } }, { provider: 'razorpay', fetchImpl: this.fetchImpl }); // eslint-disable-line @typescript-eslint/no-explicit-any
    const ts = (n: unknown) => (typeof n === 'number' ? new Date(n * 1000) : null);
    const st = (({ active: 'ACTIVE', authenticated: 'INCOMPLETE', created: 'INCOMPLETE', pending: 'PAST_DUE', halted: 'PAST_DUE', cancelled: 'CANCELED', completed: 'CANCELED', expired: 'CANCELED' }) as Record<string, NonNullable<NormalizedBillingEvent['status']>>)[String(o.status)] ?? 'INCOMPLETE';
    return { status: st, currentPeriodEnd: ts(o.current_end), currentPeriodStart: ts(o.current_start), cancelAtPeriodEnd: false, priceId: o.plan_id ?? null };
  }
  async cancel(p: { subscriptionId: string; atPeriodEnd: boolean }) {
    await httpJson(`${this.base}/subscriptions/${p.subscriptionId}/cancel`, { method: 'POST', headers: { authorization: this.auth(), 'content-type': 'application/json' }, body: JSON.stringify({ cancel_at_cycle_end: p.atPeriodEnd ? 1 : 0 }) }, { provider: 'razorpay', fetchImpl: this.fetchImpl });
  }
  verifyAndParse(rawBody: string, headers: Record<string, string | undefined>): NormalizedBillingEvent {
    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
    if (!this.webhookSecret || !eq(headers['x-razorpay-signature'] ?? '', expected)) throw new ProviderError('razorpay', 'Invalid webhook signature', 400);
    const e = JSON.parse(rawBody) as { event: string; payload: Record<string, { entity: Record<string, any> }> }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const id = headers['x-razorpay-event-id'] ?? createHmac('sha256', 'id').update(rawBody).digest('hex').slice(0, 32);
    const sub = e.payload.subscription?.entity;
    const pay = e.payload.payment?.entity;
    const ts = (n: unknown) => (typeof n === 'number' ? new Date(n * 1000) : null);
    const base = { id, occurredAt: ts((e as { created_at?: number }).created_at), workspaceId: sub?.notes?.organizationId ?? sub?.notes?.workspaceId ?? null, subscriptionId: sub?.id ?? pay?.subscription_id ?? null, customerId: sub?.customer_id ?? null, raw: e };
    const ref = e.payload.refund?.entity;
    const dis = e.payload.dispute?.entity;
    switch (e.event) {
      case 'refund.created': case 'refund.processed': case 'refund.failed':
        return { ...base, type: 'refund.updated', refund: { id: ref?.id, paymentId: ref?.payment_id ?? null, amountCents: ref?.amount ?? 0, currency: String(ref?.currency ?? 'INR'), status: e.event === 'refund.processed' ? 'succeeded' : e.event === 'refund.failed' ? 'failed' : 'pending', metadataRefundId: ref?.notes?.emnRefundKey ?? null } };
      case 'payment.dispute.created': case 'payment.dispute.won': case 'payment.dispute.lost': case 'payment.dispute.closed': case 'payment.dispute.under_review': case 'payment.dispute.action_required':
        return { ...base, type: 'dispute.updated', dispute: { id: dis?.id, paymentId: dis?.payment_id ?? null, amountCents: dis?.amount ?? 0, currency: String(dis?.currency ?? 'INR'), status: e.event.endsWith('won') ? 'won' : e.event.endsWith('lost') ? 'lost' : e.event.endsWith('closed') ? 'closed' : 'open', reason: dis?.reason_code ?? null } };
      case 'subscription.activated': return { ...base, type: 'subscription.activated', status: 'ACTIVE', currentPeriodEnd: ts(sub?.current_end) };
      case 'subscription.charged': return { ...base, type: 'invoice.paid', status: 'ACTIVE', currentPeriodEnd: ts(sub?.current_end), currentPeriodStart: ts(sub?.current_start), invoice: { id: pay?.id ?? id, amountCents: pay?.amount ?? 0, currency: String(pay?.currency ?? 'INR'), status: 'paid', periodStart: ts(sub?.current_start), periodEnd: ts(sub?.current_end), paymentId: pay?.id ?? null } };
      case 'subscription.halted': case 'subscription.pending': return { ...base, type: 'invoice.failed', status: 'PAST_DUE', invoice: { id: `${id}-failed`, amountCents: 0, currency: 'INR', status: 'payment_failed' } };
      case 'subscription.cancelled': case 'subscription.completed': return { ...base, type: 'subscription.canceled', status: 'CANCELED' };
      default: return { ...base, type: 'ignored' };
    }
  }
}

let gateways: Record<string, PaymentGateway> | null = null;
export function paymentGateways() { gateways ??= { stripe: new StripeGateway(), razorpay: new RazorpayGateway() }; return gateways; }
export function setGatewaysForTests(g: Record<string, PaymentGateway> | null) { gateways = g; }
