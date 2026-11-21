import { createHmac, timingSafeEqual } from 'node:crypto';
import { httpJson, ProviderError, type FetchLike } from '../http.js';

// Payment gateway abstraction. Stripe (global) and Razorpay (India). Platform-level credentials from env.
// Written against each provider's public API docs; NOT exercised against live accounts from this codebase.

export interface NormalizedBillingEvent {
  id: string; type: 'subscription.activated' | 'subscription.updated' | 'subscription.canceled' | 'invoice.paid' | 'invoice.failed' | 'ignored';
  workspaceId?: string | null; customerId?: string | null; subscriptionId?: string | null;
  status?: 'ACTIVE' | 'PAST_DUE' | 'CANCELED' | 'TRIALING' | 'INCOMPLETE'; currentPeriodEnd?: Date | null; cancelAtPeriodEnd?: boolean; priceId?: string | null;
  invoice?: { id: string; amountCents: number; currency: string; status: string; hostedUrl?: string | null; periodStart?: Date | null; periodEnd?: Date | null };
  raw: unknown;
}

export interface PaymentGateway {
  readonly name: 'stripe' | 'razorpay';
  readonly configured: boolean;
  createCheckout(p: { workspaceId: string; email: string; priceId: string; customerId?: string | null; successUrl: string; cancelUrl: string }): Promise<{ url: string; customerId?: string | null; subscriptionId?: string | null }>;
  createPortal(p: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
  cancel(p: { subscriptionId: string; atPeriodEnd: boolean }): Promise<void>;
  verifyAndParse(rawBody: string, headers: Record<string, string | undefined>): NormalizedBillingEvent;
}

const eq = (a: string, b: string) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

export class StripeGateway implements PaymentGateway {
  readonly name = 'stripe' as const;
  constructor(private readonly secretKey = process.env.STRIPE_SECRET_KEY ?? '', private readonly webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? '', private readonly fetchImpl?: FetchLike, private readonly base = 'https://api.stripe.com/v1') {}
  get configured() { return !!this.secretKey && !!this.webhookSecret; }
  private post<T>(path: string, body: Record<string, string>) {
    return httpJson<T>(`${this.base}${path}`, { method: 'POST', headers: { authorization: `Bearer ${this.secretKey}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form(body) }, { provider: 'stripe', fetchImpl: this.fetchImpl });
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
    const status = (s: string) => (({ active: 'ACTIVE', trialing: 'TRIALING', past_due: 'PAST_DUE', unpaid: 'PAST_DUE', canceled: 'CANCELED', incomplete: 'INCOMPLETE', incomplete_expired: 'CANCELED' }) as Record<string, NormalizedBillingEvent['status']>)[s] ?? 'INCOMPLETE';
    switch (e.type) {
      case 'checkout.session.completed': return { id: e.id, type: 'subscription.activated', workspaceId: o.client_reference_id ?? null, customerId: o.customer ?? null, subscriptionId: o.subscription ?? null, status: 'ACTIVE', raw: e };
      case 'customer.subscription.updated': case 'customer.subscription.created': return { id: e.id, type: 'subscription.updated', workspaceId: o.metadata?.organizationId ?? o.metadata?.workspaceId ?? null, customerId: o.customer, subscriptionId: o.id, status: status(o.status), currentPeriodEnd: ts(o.current_period_end ?? o.items?.data?.[0]?.current_period_end), cancelAtPeriodEnd: !!o.cancel_at_period_end, priceId: o.items?.data?.[0]?.price?.id ?? null, raw: e };
      case 'customer.subscription.deleted': return { id: e.id, type: 'subscription.canceled', workspaceId: o.metadata?.organizationId ?? o.metadata?.workspaceId ?? null, customerId: o.customer, subscriptionId: o.id, status: 'CANCELED', raw: e };
      case 'invoice.paid': case 'invoice.payment_failed': return { id: e.id, type: e.type === 'invoice.paid' ? 'invoice.paid' : 'invoice.failed', customerId: o.customer, subscriptionId: o.subscription ?? o.parent?.subscription_details?.subscription ?? null, invoice: { id: o.id, amountCents: o.amount_paid || o.amount_due || 0, currency: String(o.currency ?? 'usd').toUpperCase(), status: e.type === 'invoice.paid' ? 'paid' : 'payment_failed', hostedUrl: o.hosted_invoice_url ?? null, periodStart: ts(o.period_start), periodEnd: ts(o.period_end) }, raw: e };
      default: return { id: e.id, type: 'ignored', raw: e };
    }
  }
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
    const base = { id, workspaceId: sub?.notes?.organizationId ?? sub?.notes?.workspaceId ?? null, subscriptionId: sub?.id ?? pay?.subscription_id ?? null, customerId: sub?.customer_id ?? null, raw: e };
    switch (e.event) {
      case 'subscription.activated': return { ...base, type: 'subscription.activated', status: 'ACTIVE', currentPeriodEnd: ts(sub?.current_end) };
      case 'subscription.charged': return { ...base, type: 'invoice.paid', status: 'ACTIVE', currentPeriodEnd: ts(sub?.current_end), invoice: { id: pay?.id ?? id, amountCents: pay?.amount ?? 0, currency: String(pay?.currency ?? 'INR'), status: 'paid', periodStart: ts(sub?.current_start), periodEnd: ts(sub?.current_end) } };
      case 'subscription.halted': case 'subscription.pending': return { ...base, type: 'invoice.failed', status: 'PAST_DUE', invoice: { id: `${id}-failed`, amountCents: 0, currency: 'INR', status: 'payment_failed' } };
      case 'subscription.cancelled': case 'subscription.completed': return { ...base, type: 'subscription.canceled', status: 'CANCELED' };
      default: return { ...base, type: 'ignored' };
    }
  }
}

let gateways: Record<string, PaymentGateway> | null = null;
export function paymentGateways() { gateways ??= { stripe: new StripeGateway(), razorpay: new RazorpayGateway() }; return gateways; }
export function setGatewaysForTests(g: Record<string, PaymentGateway> | null) { gateways = g; }
