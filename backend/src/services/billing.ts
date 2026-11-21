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
  const st = await assertFeature(org, 'apiAccess').catch(async (e) => { if (!billingEnabled()) return tenantState(org); throw e; });
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
  // Gateways carry our id in metadata as "workspaceId" (older checkouts) — accept either an organization or a workspace id.
  let orgFromMeta: string | null = null;
  if (ev.workspaceId) orgFromMeta = (await db().organization.findUnique({ where: { id: ev.workspaceId }, select: { id: true } }))?.id ?? (await db().workspace.findUnique({ where: { id: ev.workspaceId }, select: { organizationId: true } }))?.organizationId ?? null;
  const sub = await db().subscription.findFirst({ where: { OR: [...(ev.subscriptionId ? [{ providerSubscriptionId: ev.subscriptionId }] : []), ...(orgFromMeta ? [{ organizationId: orgFromMeta }] : []), ...(ev.customerId ? [{ providerCustomerId: ev.customerId }] : [])] } });
  if (!sub) return { unmatched: true };
  const data: Prisma.SubscriptionUpdateInput = { provider };
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
  if (ev.invoice) await db().invoice.upsert({ where: { providerInvoiceId: ev.invoice.id }, update: { status: ev.invoice.status }, create: { organizationId: sub.organizationId, provider, providerInvoiceId: ev.invoice.id, amountCents: ev.invoice.amountCents, currency: ev.invoice.currency, status: ev.invoice.status, hostedUrl: ev.invoice.hostedUrl ?? null, periodStart: ev.invoice.periodStart ?? null, periodEnd: ev.invoice.periodEnd ?? null } });
  await (await import('./tenancy.js')).syncFromSubscription(sub.organizationId);
  await platformAudit({ action: 'billing.webhook', organizationId: sub.organizationId, metadata: { provider, type: ev.type, status: (data.status as string) ?? null, eventId: ev.id } });
  return { ok: true };
}

// ------------------------------------------------------------------ legacy workspace audit helper (kept for older callers)
export async function auditBilling(workspaceId: string, actor: Actor, action: string, meta?: Record<string, unknown>) { await audit(workspaceId, actor, action, undefined, meta); }
export const entitlements = entWs;
