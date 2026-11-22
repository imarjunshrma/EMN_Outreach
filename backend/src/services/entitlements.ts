import { db } from '../core/db.js';
import { AppError } from '../core/errors.js';
import { orgIdOf } from '../core/tenant.js';
import { NONE, UNLIMITED, normalizeEntitlements, type Entitlements } from '../../../shared/src/plans.js';
import { ORG_ACCESS, type OrgStatus } from '../../../shared/src/tenancy.js';
import { currentUsage } from './usage.js';

// Central entitlement engine. Every feature gate, quota and usage limit in the API and the worker goes through here,
// so plan rules live in data (Plan.entitlements + Subscription.overrides) instead of being scattered in code.
//
// Modes: BILLING_ENABLED=true (commercial SaaS) → plans, trials, grace periods, limits.
//        otherwise (single-company self-hosted) → unlimited entitlements; tenant suspension still applies.

export const billingEnabled = () => process.env.BILLING_ENABLED === 'true';

export interface TenantState {
  organizationId: string; mode: 'self_hosted' | 'saas'; orgStatus: OrgStatus; subscriptionStatus: string | null;
  /** May the tenant do state-changing work right now? */
  operational: boolean; reason: string | null; entitlements: Entitlements; plan: { code: string; name: string } | null; source: 'unlimited' | 'plan' | 'trial' | 'grace' | 'none';
}

/**
 * Per-tenant module/limit overrides set by platform admins (Platform → Tenant → Modules & limits). Stored in
 * Organization.settings.adminOverrides, which tenants cannot write. Applied on top of the plan (SaaS) or on top
 * of "unlimited" (self-hosted), so admins can switch modules off or cap limits in both modes.
 */
export function applyAdminOverrides(ent: Entitlements, orgSettings: unknown): Entitlements {
  const o = ((orgSettings ?? {}) as { adminOverrides?: Partial<Entitlements> }).adminOverrides;
  if (!o || typeof o !== 'object') return ent;
  const { features, integrations, ...limits } = o;
  return normalizeEntitlements({ ...ent, ...limits, features: { ...ent.features, ...(features ?? {}) }, ...(Array.isArray(integrations) ? { integrations } : {}) });
}

export async function tenantState(organizationId: string, now = new Date()): Promise<TenantState> {
  const st = await tenantStateBase(organizationId, now);
  if (!st.operational) return st;
  const org = await db().organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  return { ...st, entitlements: applyAdminOverrides(st.entitlements, org?.settings) };
}

async function tenantStateBase(organizationId: string, now = new Date()): Promise<TenantState> {
  const org = await db().organization.findUniqueOrThrow({ where: { id: organizationId }, include: { subscription: { include: { plan: true } } } });
  const status = org.status as OrgStatus;
  const base = { organizationId, orgStatus: status, subscriptionStatus: org.subscription?.status ?? null, plan: org.subscription ? { code: org.subscription.plan.code, name: org.subscription.plan.name } : null };
  if (ORG_ACCESS[status] !== 'full') {
    return { ...base, mode: billingEnabled() ? 'saas' : 'self_hosted', operational: false, reason: org.statusReason ?? `Organization is ${status.toLowerCase().replace(/_/g, ' ')}`, entitlements: NONE, source: 'none' };
  }
  if (!billingEnabled()) return { ...base, mode: 'self_hosted', operational: true, reason: null, entitlements: UNLIMITED, source: 'unlimited' };
  const sub = org.subscription;
  if (!sub) return { ...base, mode: 'saas', operational: false, reason: 'No subscription — choose a plan', entitlements: NONE, source: 'none' };
  const ent = normalizeEntitlements({ ...(sub.plan.entitlements as Partial<Entitlements>), ...((sub.overrides ?? {}) as Partial<Entitlements>) });
  if (sub.status === 'ACTIVE') return { ...base, mode: 'saas', operational: true, reason: sub.cancelAtPeriodEnd && sub.currentPeriodEnd ? `Cancels on ${sub.currentPeriodEnd.toISOString().slice(0, 10)}` : null, entitlements: ent, source: 'plan' };
  if (sub.status === 'TRIALING') {
    if (!sub.trialEndsAt || sub.trialEndsAt > now) return { ...base, mode: 'saas', operational: true, reason: sub.trialEndsAt ? `Trial ends ${sub.trialEndsAt.toISOString().slice(0, 10)}` : null, entitlements: ent, source: 'trial' };
    return { ...base, mode: 'saas', operational: false, reason: 'Trial ended — choose a plan', entitlements: NONE, source: 'none' };
  }
  if (sub.status === 'PAST_DUE') {
    if (sub.graceUntil && sub.graceUntil > now) return { ...base, mode: 'saas', operational: true, reason: `Payment failed — update your payment method by ${sub.graceUntil.toISOString().slice(0, 10)}`, entitlements: ent, source: 'grace' };
    return { ...base, mode: 'saas', operational: false, reason: 'Payment overdue — subscription suspended', entitlements: NONE, source: 'none' };
  }
  return { ...base, mode: 'saas', operational: false, reason: sub.status === 'CANCELED' ? 'Subscription cancelled' : !sub.providerSubscriptionId && !sub.trialEndsAt ? 'Your free trial has already been used — choose a plan to start' : 'Subscription incomplete — finish checkout', entitlements: NONE, source: 'none' };
}

export const tenantStateForWorkspace = async (workspaceId: string) => tenantState(await orgIdOf(workspaceId));

export type QuotaKind = 'users' | 'workspaces' | 'mailboxes' | 'activeCampaigns' | 'leads';
export type FeatureKind = keyof Entitlements['features'];
const QUOTA_FIELD: Record<QuotaKind, keyof Entitlements> = { users: 'maxUsers', workspaces: 'maxWorkspaces', mailboxes: 'maxMailboxes', activeCampaigns: 'maxActiveCampaigns', leads: 'maxLeads' };
const QUOTA_LABEL: Record<QuotaKind, string> = { users: 'users', workspaces: 'workspaces', mailboxes: 'mailboxes', activeCampaigns: 'running campaigns', leads: 'leads' };
const METERED: Record<string, { field: keyof Entitlements; label: string; scale?: number }> = {
  email_sends: { field: 'monthlyEmailSends', label: 'emails this month' }, enrichments: { field: 'monthlyEnrichments', label: 'verifications/enrichments this month' },
  api_calls: { field: 'monthlyApiCalls', label: 'API calls this month' }, workflow_runs: { field: 'monthlyWorkflowRuns', label: 'workflow runs this month' },
  ai_cost_micro_usd: { field: 'monthlyAiUsd', label: 'USD of AI usage this month', scale: 1_000_000 },
};

function inactive(st: TenantState) {
  return new AppError(st.orgStatus && ORG_ACCESS[st.orgStatus] !== 'full' ? 'TENANT_INACTIVE' : 'SUBSCRIPTION_INACTIVE', st.reason ?? 'Subscription inactive', st.orgStatus && ORG_ACCESS[st.orgStatus] !== 'full' ? 403 : 402, { status: st.orgStatus });
}

/** May the tenant do state-changing work? */
export async function assertOperational(organizationId: string) {
  const st = await tenantState(organizationId);
  if (!st.operational) throw inactive(st);
  return st;
}

export async function assertFeature(organizationId: string, feature: FeatureKind) {
  const st = await assertOperational(organizationId);
  if (!st.entitlements.features[feature]) throw new AppError('QUOTA_EXCEEDED', `${feature} is not included in your ${st.plan?.name ?? ''} plan`.replace(/\s+plan/, ' plan'), 402, { feature });
  return st;
}

/** Count-based limit: the tenant's current total must be below the plan maximum before adding `adding` more. */
export async function assertQuota(organizationId: string, kind: QuotaKind, adding = 1) {
  const st = await assertOperational(organizationId);
  const max = st.entitlements[QUOTA_FIELD[kind]] as number;
  if (max >= 1e9) return st;
  const used = (await currentUsage(organizationId)).counts[kind === 'activeCampaigns' ? 'runningCampaigns' : kind];
  if (used + adding > max) throw new AppError('QUOTA_EXCEEDED', `Your ${st.plan?.name ?? ''} plan allows ${max} ${QUOTA_LABEL[kind]}. Upgrade to add more.`.replace('  ', ' '), 402, { limit: max, used, kind });
  return st;
}

/** Period-based limit: refuses work that would take the month's metered usage past the plan limit. */
export async function assertMetered(organizationId: string, metric: keyof typeof METERED, planned = 1) {
  const st = await assertOperational(organizationId);
  const m = METERED[metric];
  const max = (st.entitlements[m.field] as number) * (m.scale ?? 1);
  if (max >= 1e9 * (m.scale ?? 1)) return st;
  // Annual pooling (plan setting, yearly billing only): 12× the monthly allowance over the paid year.
  const sub = st.entitlements.allowancePeriod === 'annual_pooled' ? await db().subscription.findUnique({ where: { organizationId }, select: { interval: true, currentPeriodStart: true, createdAt: true } }) : null;
  if (sub?.interval === 'year') {
    const since = sub.currentPeriodStart ?? sub.createdAt;
    const monthStart = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), 1));
    const used = Number((await db().usageCounter.aggregate({ where: { organizationId, metric, periodStart: { gte: monthStart } }, _sum: { value: true } }))._sum.value ?? 0n);
    if (used + planned > max * 12) throw new AppError('QUOTA_EXCEEDED', `Yearly allowance reached: your plan includes ${m.scale ? ((max * 12) / m.scale).toFixed(2) : max * 12} ${m.label} per year`, 402, { metric, limit: max * 12, used, period: 'year' });
    return st;
  }
  const used = (await currentUsage(organizationId)).metered[metric as keyof Awaited<ReturnType<typeof currentUsage>>['metered']] ?? 0;
  if (used + planned > max) throw new AppError('QUOTA_EXCEEDED', `Monthly limit reached: your plan includes ${m.scale ? (max / m.scale).toFixed(2) : max} ${m.label}`, 402, { metric, limit: max, used });
  return st;
}

export async function assertIntegration(organizationId: string, type: string) {
  const st = await tenantState(organizationId);
  const allowed = st.entitlements.integrations;
  if (!allowed.includes('*') && !allowed.includes(type)) throw new AppError('QUOTA_EXCEEDED', `The ${type} integration is not included in your plan`, 402, { integration: type });
}

// Workspace-scoped convenience wrappers (most callers know the workspace, not the tenant).
export const ws = {
  operational: async (workspaceId: string) => assertOperational(await orgIdOf(workspaceId)),
  feature: async (workspaceId: string, f: FeatureKind) => assertFeature(await orgIdOf(workspaceId), f),
  quota: async (workspaceId: string, k: QuotaKind, adding = 1) => assertQuota(await orgIdOf(workspaceId), k, adding),
  metered: async (workspaceId: string, m: keyof typeof METERED, planned = 1) => assertMetered(await orgIdOf(workspaceId), m, planned),
  integration: async (workspaceId: string, type: string) => assertIntegration(await orgIdOf(workspaceId), type),
  state: tenantStateForWorkspace,
};
