import { z } from 'zod';
import { db, Prisma } from '../core/db.js';
import { AppError, NotFound } from '../core/errors.js';
import { audit, notifyWorkspace, type Actor } from '../core/audit.js';
import { redis } from '../core/redis.js';
import { orgIdOf, platformAudit } from '../core/tenant.js';
import { DEFAULT_PLANS, normalizeEntitlements, type Entitlements } from '../../../shared/src/plans.js';
import { paymentGateways } from '../../../integrations/src/billing/gateways.js';
import { assertFeature, assertMetered, assertQuota, billingEnabled, tenantState, ws as entWs, type FeatureKind, type QuotaKind } from './entitlements.js';
import { currentUsage, meter, usageHistory } from './usage.js';

// Subscriptions & payments, per ORGANIZATION (tenant). Card data never touches this server: checkout and
// payment-method management happen on the provider's hosted pages; state changes arrive only through
// signature-verified webhooks (a browser redirect is never treated as proof of payment).

export { billingEnabled };
const GRACE_DAYS = () => Number(process.env.BILLING_GRACE_DAYS ?? 7);

/** Seeds the default catalogue once. Existing plans (edited by platform admins) are never overwritten. */
export async function ensurePlans() {
  for (const p of DEFAULT_PLANS) await db().plan.upsert({ where: { code: p.code }, update: {}, create: { ...p, entitlements: p.entitlements as unknown as Prisma.InputJsonValue } });
}

export async function listPlans(includeHidden = false) {
  await ensurePlans();
  const plans = await db().plan.findMany({ where: includeHidden ? {} : { isPublic: true, isActive: true, archivedAt: null }, orderBy: [{ sortOrder: 'asc' }, { priceMonthlyCents: 'asc' }] });
  return plans.map((p) => ({ ...p, entitlements: normalizeEntitlements(p.entitlements as Partial<Entitlements>), providerPriceIds: includeHidden ? p.providerPriceIds : undefined }));
}

export async function startTrial(organizationId: string, planCode = 'starter') {
  if (!billingEnabled()) return null;
  await ensurePlans();
  const plan = await db().plan.findUniqueOrThrow({ where: { code: planCode } });
  return db().subscription.upsert({ where: { organizationId }, update: {}, create: { organizationId, planId: plan.id, status: 'TRIALING', trialEndsAt: new Date(Date.now() + plan.trialDays * 86400_000) } });
}

// ------------------------------------------------------------------ compatibility helpers (workspace-scoped callers)

export async function billingState(workspaceId: string) {
  const st = await tenantState(await orgIdOf(workspaceId));
  return { mode: st.mode, active: st.operational, reason: st.reason, entitlements: st.entitlements, plan: st.plan, status: st.subscriptionStatus, orgStatus: st.orgStatus };
}

type Legacy = 'users' | 'mailboxes' | 'activeCampaigns' | 'workspaces' | 'leads' | `feature:${FeatureKind}` | 'active';
/** Throws QUOTA_EXCEEDED / SUBSCRIPTION_INACTIVE / TENANT_INACTIVE. */
export async function assertEntitled(workspaceId: string, what: Legacy) {
  const org = await orgIdOf(workspaceId);
  if (what === 'active') return void (await (await import('./entitlements.js')).assertOperational(org));
  if (what.startsWith('feature:')) return void (await assertFeature(org, what.slice(8) as FeatureKind));
  await assertQuota(org, what as QuotaKind);
}

/** API-key traffic: per-tenant per-minute fair-use limit plus the monthly API-call allowance; every call is metered. */
export async function countApiCall(workspaceId: string, requestId: string) {
  const org = await orgIdOf(workspaceId);
  const st = await assertFeature(org, 'apiAccess').catch(async (e) => { if (!billingEnabled() && (e as { code?: string }).code !== 'QUOTA_EXCEEDED') return tenantState(org); throw e; }); // an admin can switch API access off in either mode
  const minute = Math.floor(Date.now() / 60_000);
  const k = `rl:tenant:${org}:api:${minute}`;
  const n = await redis().incr(k);
  if (n === 1) await redis().expire(k, 90);
  if (n > st.entitlements.apiRequestsPerMinute) throw new AppError('RATE_LIMITED', `Your plan allows ${st.entitlements.apiRequestsPerMinute} API requests per minute`, 429);
  await assertMetered(org, 'api_calls');
  meter({ organizationId: org, workspaceId, metric: 'api_calls', quantity: 1, key: `api:${requestId}` });
}

// ------------------------------------------------------------------ overview

export async function overview(organizationId: string, opts: { includeInvoices: boolean }) {
  const [st, sub, invoices, usage, history, plans] = await Promise.all([
    tenantState(organizationId), db().subscription.findUnique({ where: { organizationId }, include: { plan: true } }),
    opts.includeInvoices ? db().invoice.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 50 }) : Promise.resolve([]),
    currentUsage(organizationId), usageHistory(organizationId, 6), listPlans(),
  ]);
  return {
    mode: st.mode, active: st.operational, reason: st.reason, status: st.subscriptionStatus, orgStatus: st.orgStatus, plan: st.plan, entitlements: st.entitlements, source: st.source,
    subscription: sub ? { status: sub.status, interval: sub.interval, provider: sub.provider, currentPeriodEnd: sub.currentPeriodEnd, trialEndsAt: sub.trialEndsAt, graceUntil: sub.graceUntil, cancelAtPeriodEnd: sub.cancelAtPeriodEnd, planCode: sub.plan.code } : null,
    invoices, usage: { ...usage.counts, ...usage.metered, aiUsdThisMonth: (usage.metered.ai_cost_micro_usd ?? 0) / 1_000_000, period: usage.period }, history, plans,
    gateways: Object.fromEntries(Object.entries(paymentGateways()).map(([k, g]) => [k, g.configured])),
    canManageBilling: opts.includeInvoices,
  };
}

// ------------------------------------------------------------------ checkout / plan change / cancel

export const CheckoutSchema = z.object({ planCode: z.string().min(1).max(40), interval: z.enum(['month', 'year']).default('month'), provider: z.enum(['stripe', 'razorpay']) });

export async function checkout(organizationId: string, input: z.infer<typeof CheckoutSchema>, actor: Actor) {
  if (!billingEnabled()) throw new AppError('VALIDATION_FAILED', 'Billing is disabled on this installation (self-hosted mode)', 400);
  const g = paymentGateways()[input.provider];
  if (!g.configured) throw new AppError('PROVIDER_NOT_CONFIGURED', `${input.provider} is not configured on this server`, 400);
  const plan = await db().plan.findFirst({ where: { code: input.planCode, isActive: true, archivedAt: null } });
  if (!plan) throw NotFound('Plan');
  const priceId = ((plan.providerPriceIds ?? {}) as Record<string, string>)[`${input.provider}_${input.interval}`];
  if (!priceId) throw new AppError('PROVIDER_NOT_CONFIGURED', `No ${input.provider} price configured for ${plan.code}/${input.interval}`, 400);
  const org = await db().organization.findUniqueOrThrow({ where: { id: organizationId } });
  const billingUser = await db().user.findUnique({ where: { id: org.billingOwnerId ?? org.ownerId ?? actor.userId ?? '' } });
  const sub = await db().subscription.findUnique({ where: { organizationId } });
  const back = `${process.env.APP_URL}/org/${organizationId}`; // the success page only shows a notice; activation comes from the verified webhook
  const r = await g.createCheckout({ workspaceId: organizationId, email: billingUser?.email ?? '', priceId, customerId: sub?.provider === input.provider ? sub.providerCustomerId : null, successUrl: `${back}?tab=billing&checkout=success`, cancelUrl: `${back}?tab=billing&checkout=cancel` });
  // The plan is NOT switched here — only a verified webhook activates or changes the subscription.
  await db().subscription.upsert({ where: { organizationId }, update: { provider: input.provider, providerCustomerId: r.customerId ?? undefined, providerSubscriptionId: r.subscriptionId ?? undefined, interval: input.interval, scheduledPlanId: plan.id },
    create: { organizationId, planId: plan.id, status: 'INCOMPLETE', provider: input.provider, providerCustomerId: r.customerId ?? null, providerSubscriptionId: r.subscriptionId ?? null, interval: input.interval } });
  await platformAudit({ actorUserId: actor.userId, action: 'billing.checkout_started', organizationId, metadata: { plan: plan.code, provider: input.provider, interval: input.interval } });
  return { url: r.url };
}

export async function portal(organizationId: string) {
  const sub = await db().subscription.findUnique({ where: { organizationId } });
  if (!sub?.providerCustomerId) throw new AppError('VALIDATION_FAILED', 'No payment customer yet', 400);
  return paymentGateways()[sub.provider].createPortal({ customerId: sub.providerCustomerId, returnUrl: `${process.env.APP_URL}/org/${organizationId}?tab=billing` });
}

export async function cancel(organizationId: string, atPeriodEnd: boolean, actor: Actor) {
  const sub = await db().subscription.findUnique({ where: { organizationId } });
  if (!sub) throw NotFound('Subscription');
  if (sub.providerSubscriptionId && sub.provider !== 'manual') await paymentGateways()[sub.provider].cancel({ subscriptionId: sub.providerSubscriptionId, atPeriodEnd });
  await db().subscription.update({ where: { organizationId }, data: atPeriodEnd ? { cancelAtPeriodEnd: true } : { status: 'CANCELED', canceledAt: new Date() } });
  if (!atPeriodEnd) await (await import('./tenancy.js')).syncFromSubscription(organizationId);
  await platformAudit({ actorUserId: actor.userId, action: 'billing.canceled', organizationId, metadata: { atPeriodEnd } });
}

export async function resume(organizationId: string, actor: Actor) {
  const sub = await db().subscription.findUnique({ where: { organizationId } });
  if (!sub?.cancelAtPeriodEnd) throw new AppError('CONFLICT', 'Nothing to resume', 409);
  if (sub.provider === 'stripe' && sub.providerSubscriptionId) {
    // Stripe: clearing cancel_at_period_end. Razorpay has no "undo cancel" — a new checkout is needed.
    const g = paymentGateways().stripe as unknown as { resume?: (id: string) => Promise<void> };
    if (g.resume) await g.resume(sub.providerSubscriptionId);
  } else if (sub.provider === 'razorpay') throw new AppError('CONFLICT', 'Razorpay subscriptions cannot be un-cancelled; start a new checkout before the period ends', 409);
  await db().subscription.update({ where: { organizationId }, data: { cancelAtPeriodEnd: false } });
  await platformAudit({ actorUserId: actor.userId, action: 'billing.resumed', organizationId });
}

// ------------------------------------------------------------------ webhooks

/** Payment-provider webhook: signature-verified, idempotent (BillingEvent unique), mapped onto the tenant. */
export async function handleWebhook(provider: 'stripe' | 'razorpay', rawBody: string, headers: Record<string, string | undefined>) {
  let ev;
  try { ev = paymentGateways()[provider].verifyAndParse(rawBody, headers); } catch (e) { throw new AppError('INVALID_SIGNATURE', (e as Error).message, 400); }
  try { await db().billingEvent.create({ data: { provider, eventId: ev.id, type: ev.type, payload: ev.raw as Prisma.InputJsonValue } }); } catch (e) { if ((e as { code?: string }).code === 'P2002') return { duplicate: true }; throw e; }
  if (ev.type === 'ignored') return { ignored: true };
  if (ev.type === 'refund.updated') return applyRefundEvent(provider, ev);
  if (ev.type === 'dispute.updated') return applyDisputeEvent(provider, ev);
  // Gateways carry our id in metadata as "workspaceId" (older checkouts) — accept either an organization or a workspace id.
  let orgFromMeta: string | null = null;
  if (ev.workspaceId) orgFromMeta = (await db().organization.findUnique({ where: { id: ev.workspaceId }, select: { id: true } }))?.id ?? (await db().workspace.findUnique({ where: { id: ev.workspaceId }, select: { organizationId: true } }))?.organizationId ?? null;
  const sub = await db().subscription.findFirst({ where: { OR: [...(ev.subscriptionId ? [{ providerSubscriptionId: ev.subscriptionId }] : []), ...(orgFromMeta ? [{ organizationId: orgFromMeta }] : []), ...(ev.customerId ? [{ providerCustomerId: ev.customerId }] : [])] } });
  if (!sub) return { unmatched: true };
  // Out-of-order delivery: an event older than the newest one already applied must not roll state back.
  // Its invoice (if any) is still recorded, because invoices are facts that do not depend on order.
  const stale = !!(ev.occurredAt && sub.lastEventAt && ev.occurredAt < sub.lastEventAt);
  if (stale) {
    if (ev.invoice) await upsertInvoice(provider, sub.organizationId, ev.invoice);
    await platformAudit({ action: 'billing.webhook_stale', organizationId: sub.organizationId, metadata: { provider, type: ev.type, eventId: ev.id, occurredAt: ev.occurredAt?.toISOString() } });
    return { ok: true, stale: true };
  }
  const data: Prisma.SubscriptionUpdateInput = { provider };
  if (ev.occurredAt) data.lastEventAt = ev.occurredAt;
  if (ev.currentPeriodStart) data.currentPeriodStart = ev.currentPeriodStart;
  if (ev.subscriptionId) data.providerSubscriptionId = ev.subscriptionId;
  if (ev.customerId) data.providerCustomerId = ev.customerId;
  if (ev.currentPeriodEnd) data.currentPeriodEnd = ev.currentPeriodEnd;
  if (ev.cancelAtPeriodEnd !== undefined) data.cancelAtPeriodEnd = ev.cancelAtPeriodEnd;
  if (ev.priceId) { const plans = await db().plan.findMany(); const p = plans.find((x) => Object.values((x.providerPriceIds ?? {}) as Record<string, string>).includes(ev.priceId!)); if (p) { data.plan = { connect: { id: p.id } }; data.scheduledPlanId = null; } }
  else if (ev.type === 'subscription.activated' && sub.scheduledPlanId) { data.plan = { connect: { id: sub.scheduledPlanId } }; data.scheduledPlanId = null; }
  if (ev.type === 'invoice.failed') {
    data.status = 'PAST_DUE'; data.graceUntil = new Date(Date.now() + GRACE_DAYS() * 86400_000);
    const w = await db().workspace.findFirst({ where: { organizationId: sub.organizationId }, orderBy: { createdAt: 'asc' } });
    if (w) await notifyWorkspace(w.id, 'OWNER', { type: 'billing.payment_failed', title: `Payment failed — update your payment method within ${GRACE_DAYS()} days`, link: '/billing' });
  } else if (ev.status) { data.status = ev.status; if (ev.status === 'ACTIVE') data.graceUntil = null; if (ev.status === 'CANCELED') data.canceledAt = new Date(); }
  await db().subscription.update({ where: { id: sub.id }, data });
  if (ev.invoice) await upsertInvoice(provider, sub.organizationId, ev.invoice);
  await (await import('./tenancy.js')).syncFromSubscription(sub.organizationId);
  await platformAudit({ action: 'billing.webhook', organizationId: sub.organizationId, metadata: { provider, type: ev.type, status: (data.status as string) ?? null, eventId: ev.id } });
  return { ok: true };
}

// ------------------------------------------------------------------ legacy workspace audit helper (kept for older callers)
export async function auditBilling(workspaceId: string, actor: Actor, action: string, meta?: Record<string, unknown>) { await audit(workspaceId, actor, action, undefined, meta); }
export const entitlements = entWs;

// ------------------------------------------------------------------ invoices, refunds, disputes, reconciliation

type EvInvoice = NonNullable<import('../../../integrations/src/billing/gateways.js').NormalizedBillingEvent['invoice']>;
async function upsertInvoice(provider: string, organizationId: string, inv: EvInvoice) {
  await db().invoice.upsert({
    where: { providerInvoiceId: inv.id },
    update: { status: inv.status, ...(inv.paymentId ? { providerPaymentId: inv.paymentId } : {}) },
    create: { organizationId, provider, providerInvoiceId: inv.id, providerPaymentId: inv.paymentId ?? null, amountCents: inv.amountCents, currency: inv.currency, status: inv.status, hostedUrl: inv.hostedUrl ?? null, periodStart: inv.periodStart ?? null, periodEnd: inv.periodEnd ?? null },
  });
}

/** Re-derives an invoice's refunded total from succeeded refunds (idempotent, never double-counts). */
async function recomputeInvoiceRefunds(invoiceId: string) {
  const inv = await db().invoice.findUnique({ where: { id: invoiceId } });
  if (!inv) return;
  const sum = (await db().refund.aggregate({ where: { invoiceId, status: 'succeeded' }, _sum: { amountCents: true } }))._sum.amountCents ?? 0;
  const status = sum <= 0 ? (inv.status.includes('refund') ? 'paid' : inv.status) : sum >= inv.amountCents ? 'refunded' : 'partially_refunded';
  await db().invoice.update({ where: { id: invoiceId }, data: { amountRefundedCents: Math.min(sum, inv.amountCents), status } });
}

type Ev = import('../../../integrations/src/billing/gateways.js').NormalizedBillingEvent;
async function applyRefundEvent(provider: 'stripe' | 'razorpay', ev: Ev) {
  const r = ev.refund!;
  const invoice = r.paymentId ? await db().invoice.findFirst({ where: { providerPaymentId: r.paymentId } }) : null;
  let refund = await db().refund.findFirst({ where: { OR: [{ providerRefundId: r.id }, ...(r.metadataRefundId ? [{ idempotencyKey: r.metadataRefundId }] : [])] } });
  if (!refund) {
    if (!invoice) { await platformAudit({ action: 'billing.refund_unmatched', metadata: { provider, refundId: r.id, paymentId: r.paymentId } }); return { unmatched: true }; }
    // Refund made in the provider's dashboard: record it.
    refund = await db().refund.create({ data: { organizationId: invoice.organizationId, invoiceId: invoice.id, provider, providerRefundId: r.id, providerPaymentId: r.paymentId, amountCents: r.amountCents, currency: r.currency, status: r.status, reason: 'Issued in the payment provider dashboard', idempotencyKey: `provider:${provider}:${r.id}` } });
  } else {
    refund = await db().refund.update({ where: { id: refund.id }, data: { providerRefundId: r.id, status: r.status, amountCents: r.amountCents || refund.amountCents } });
  }
  if (refund.invoiceId) await recomputeInvoiceRefunds(refund.invoiceId);
  await platformAudit({ action: `billing.refund_${r.status}`, organizationId: refund.organizationId, targetType: 'refund', targetId: refund.id, metadata: { provider, amountCents: refund.amountCents, currency: refund.currency } });
  return { ok: true, refund: refund.status };
}

async function applyDisputeEvent(provider: 'stripe' | 'razorpay', ev: Ev) {
  const d = ev.dispute!;
  const invoice = d.paymentId ? await db().invoice.findFirst({ where: { providerPaymentId: d.paymentId } }) : null;
  const existing = await db().billingDispute.findUnique({ where: { providerDisputeId: d.id } });
  const organizationId = existing?.organizationId ?? invoice?.organizationId;
  if (!organizationId) { await platformAudit({ action: 'billing.dispute_unmatched', metadata: { provider, disputeId: d.id, paymentId: d.paymentId } }); return { unmatched: true }; }
  await db().billingDispute.upsert({ where: { providerDisputeId: d.id }, update: { status: d.status, reason: d.reason ?? undefined }, create: { organizationId, provider, providerDisputeId: d.id, providerPaymentId: d.paymentId, amountCents: d.amountCents, currency: d.currency, status: d.status, reason: d.reason ?? null } });
  await platformAudit({ action: `billing.dispute_${d.status}`, organizationId, targetType: 'dispute', targetId: d.id, metadata: { provider, amountCents: d.amountCents, reason: d.reason } });
  // Policy: a lost chargeback suspends the organization (read-only, data kept) until staff review it.
  // Payment events do not lift this suspension; staff reactivate after resolving it with the customer.
  if (d.status === 'lost') {
    const org = await db().organization.findUniqueOrThrow({ where: { id: organizationId } });
    if (['TRIAL', 'ACTIVE', 'PAST_DUE', 'PENDING_SETUP'].includes(org.status)) {
      const { setOrgStatus } = await import('./tenancy.js');
      await setOrgStatus(organizationId, 'SUSPENDED', `Payment dispute ${d.id} was lost — contact billing support`, { system: true });
      await db().organization.update({ where: { id: organizationId }, data: { settings: { ...((org.settings ?? {}) as object), adminSuspended: true } as Prisma.InputJsonValue } });
    }
  }
  return { ok: true, dispute: d.status };
}

export const RefundSchema = z.object({
  invoiceId: z.string().uuid(), amountCents: z.number().int().positive().optional(), reason: z.string().trim().min(5).max(500),
  cancelSubscription: z.boolean().default(false), requestKey: z.string().uuid(),
});

/**
 * Staff-initiated refund. Idempotent on `requestKey` (a double-click or retry returns the same refund).
 * The provider call uses the same key as its idempotency key. The refund is only marked succeeded when
 * the provider confirms it by verified webhook.
 */
export async function requestRefund(organizationId: string, input: z.infer<typeof RefundSchema>, admin: { userId: string; ip?: string | null }) {
  const idempotencyKey = `staff:${input.requestKey}`;
  const prior = await db().refund.findUnique({ where: { idempotencyKey } });
  if (prior) return prior;
  const inv = await db().invoice.findFirst({ where: { id: input.invoiceId, organizationId } });
  if (!inv) throw NotFound('Invoice');
  if (!['paid', 'partially_refunded'].includes(inv.status)) throw new AppError('CONFLICT', `Only paid invoices can be refunded (this one is ${inv.status})`, 409);
  if (!inv.providerPaymentId) throw new AppError('CONFLICT', 'This invoice has no provider payment reference to refund against', 409);
  const pending = (await db().refund.aggregate({ where: { invoiceId: inv.id, status: { in: ['pending', 'succeeded'] } }, _sum: { amountCents: true } }))._sum.amountCents ?? 0;
  const amount = input.amountCents ?? inv.amountCents - pending;
  if (amount <= 0 || pending + amount > inv.amountCents) throw new AppError('VALIDATION_FAILED', `At most ${(inv.amountCents - pending) / 100} ${inv.currency} can still be refunded on this invoice`, 400);
  const g = paymentGateways()[inv.provider as 'stripe' | 'razorpay'];
  if (!g?.configured) throw new AppError('PROVIDER_NOT_CONFIGURED', `${inv.provider} is not configured on this server`, 400);
  const refund = await db().refund.create({ data: { organizationId, invoiceId: inv.id, provider: inv.provider, providerPaymentId: inv.providerPaymentId, amountCents: amount, currency: inv.currency, status: 'pending', reason: input.reason, requestedById: admin.userId, idempotencyKey } });
  try {
    const r = await g.refund({ paymentId: inv.providerPaymentId, amountCents: amount === inv.amountCents ? undefined : amount, idempotencyKey, reason: input.reason });
    await db().refund.update({ where: { id: refund.id }, data: { providerRefundId: r.id, status: r.status === 'succeeded' || r.status === 'processed' ? 'succeeded' : r.status === 'failed' ? 'failed' : 'pending' } });
  } catch (e) {
    await db().refund.update({ where: { id: refund.id }, data: { status: 'failed' } });
    await platformAudit({ actorUserId: admin.userId, action: 'billing.refund_request_failed', organizationId, targetType: 'refund', targetId: refund.id, reason: input.reason, ip: admin.ip ?? null, metadata: { error: (e as Error).message.slice(0, 300) } });
    throw e;
  }
  await recomputeInvoiceRefunds(inv.id);
  if (input.cancelSubscription) {
    const sub = await db().subscription.findUnique({ where: { organizationId } });
    if (sub?.providerSubscriptionId && sub.provider === inv.provider) await g.cancel({ subscriptionId: sub.providerSubscriptionId, atPeriodEnd: false });
    if (sub) await db().subscription.update({ where: { id: sub.id }, data: { status: 'CANCELED', canceledAt: new Date() } });
    await (await import('./tenancy.js')).syncFromSubscription(organizationId);
  }
  await platformAudit({ actorUserId: admin.userId, action: 'billing.refund_requested', organizationId, targetType: 'refund', targetId: refund.id, reason: input.reason, ip: admin.ip ?? null, metadata: { amountCents: amount, currency: inv.currency, cancelSubscription: input.cancelSubscription } });
  return db().refund.findUniqueOrThrow({ where: { id: refund.id } });
}

/** Compares local subscription state with the provider and repairs drift (missed webhooks). Runs every 6 hours. */
export async function reconcileSubscriptions() {
  const subs = await db().subscription.findMany({ where: { provider: { in: ['stripe', 'razorpay'] }, providerSubscriptionId: { not: null }, status: { not: 'CANCELED' } } });
  let checked = 0; let repaired = 0; let failed = 0;
  for (const sub of subs) {
    const g = paymentGateways()[sub.provider as 'stripe' | 'razorpay'];
    if (!g?.configured) continue;
    try {
      const remote = await g.fetchSubscription(sub.providerSubscriptionId!);
      checked++;
      const drift = remote.status !== sub.status || remote.cancelAtPeriodEnd !== sub.cancelAtPeriodEnd || (remote.currentPeriodEnd?.getTime() ?? null) !== (sub.currentPeriodEnd?.getTime() ?? null);
      if (!drift) continue;
      await db().subscription.update({ where: { id: sub.id }, data: { status: remote.status, cancelAtPeriodEnd: remote.cancelAtPeriodEnd, currentPeriodEnd: remote.currentPeriodEnd, currentPeriodStart: remote.currentPeriodStart, ...(remote.status === 'ACTIVE' ? { graceUntil: null } : {}) } });
      await (await import('./tenancy.js')).syncFromSubscription(sub.organizationId);
      await platformAudit({ action: 'billing.reconciled', organizationId: sub.organizationId, metadata: { provider: sub.provider, from: sub.status, to: remote.status } });
      repaired++;
    } catch (e) {
      failed++;
      await platformAudit({ action: 'billing.reconcile_failed', organizationId: sub.organizationId, metadata: { provider: sub.provider, error: (e as Error).message.slice(0, 200) } });
    }
  }
  return { checked, repaired, failed };
}
