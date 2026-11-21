import { z } from 'zod';
import { db, Prisma } from '../core/db.js';
import { AppError, NotFound } from '../core/errors.js';
import { platformAudit } from '../core/tenant.js';
import { normalizeEntitlements, UNLIMITED, type Entitlements } from '../../../shared/src/plans.js';
import { ORG_STATUSES, type OrgStatus } from '../../../shared/src/tenancy.js';
import { ensurePlans } from './billing.js';
import { tenantState } from './entitlements.js';
import { currentUsage, usageHistory } from './usage.js';
import { purgeTenant, setOrgStatus } from './tenancy.js';

// Platform administration (EMN staff only). Every write here records an append-only PlatformAuditEvent
// with the acting admin and a reason. Nothing here returns a tenant's secrets.

type Admin = { userId: string; ip?: string | null };

// ------------------------------------------------------------------ tenants

export const TenantQuery = z.object({
  q: z.string().max(100).optional(), status: z.enum(ORG_STATUSES).optional(), plan: z.string().max(40).optional(),
  page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['createdAt', 'name']).default('createdAt'),
});

export async function listTenants(q: z.infer<typeof TenantQuery>) {
  const where: Prisma.OrganizationWhereInput = {
    ...(q.status ? { status: q.status } : { status: { not: 'DELETED' } }),
    ...(q.plan ? { subscription: { plan: { code: q.plan } } } : {}),
    ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { slug: { contains: q.q.toLowerCase() } }, { members: { some: { user: { email: { contains: q.q.toLowerCase() } } } } }] } : {}),
  };
  const [rows, total] = await Promise.all([
    db().organization.findMany({ where, orderBy: q.sort === 'name' ? { name: 'asc' } : { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize, include: { subscription: { include: { plan: true } }, _count: { select: { members: true, workspaces: true } } } }),
    db().organization.count({ where }),
  ]);
  const owners = await db().user.findMany({ where: { id: { in: rows.map((r) => r.ownerId).filter(Boolean) as string[] } }, select: { id: true, email: true, name: true } });
  return {
    data: rows.map((o) => ({ id: o.id, name: o.name, slug: o.slug, status: o.status, createdAt: o.createdAt, owner: owners.find((u) => u.id === o.ownerId) ?? null, plan: o.subscription?.plan.code ?? null, subscriptionStatus: o.subscription?.status ?? null, members: o._count.members, workspaces: o._count.workspaces, deletionScheduledFor: o.deletionScheduledFor })),
    total, page: q.page, pageSize: q.pageSize, totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
  };
}

export async function tenantDetail(organizationId: string) {
  const org = await db().organization.findUnique({ where: { id: organizationId }, include: { subscription: { include: { plan: true } }, statusHistory: { orderBy: { createdAt: 'desc' }, take: 50 } } });
  if (!org) throw NotFound('Organization');
  const workspaces = await db().workspace.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' }, include: { _count: { select: { leads: true, campaigns: true, emailAccounts: true, members: true } } } });
  const members = await db().organizationMember.findMany({ where: { organizationId }, include: { user: { select: { id: true, email: true, name: true, mfaEnabled: true, emailVerifiedAt: true, lastLoginAt: true } } } });
  const wsIds = workspaces.map((w) => w.id);
  // Integration STATUS only (type, enabled, last test) — never credentials.
  const integrations = await db().integration.findMany({ where: { workspaceId: { in: wsIds } }, select: { workspaceId: true, type: true, isEnabled: true, lastTestedAt: true, lastTestOk: true } });
  const mailboxes = await db().emailAccount.findMany({ where: { workspaceId: { in: wsIds } }, select: { workspaceId: true, provider: true, status: true, emailAddress: true } });
  const [state, usage, history, invoices, audit, grants] = await Promise.all([
    tenantState(organizationId), currentUsage(organizationId), usageHistory(organizationId, 6),
    db().invoice.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 24 }),
    db().platformAuditEvent.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 100 }),
    db().supportAccessGrant.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);
  const { registrationKey: _r, ...safe } = org;
  return {
    organization: { ...safe, subscription: org.subscription ? { ...org.subscription, plan: { code: org.subscription.plan.code, name: org.subscription.plan.name } } : null },
    state: { operational: state.operational, reason: state.reason, source: state.source, entitlements: state.entitlements },
    workspaces: workspaces.map((w) => ({ id: w.id, name: w.name, archivedAt: w.archivedAt, createdAt: w.createdAt, counts: w._count })),
    members: members.map((m) => ({ role: m.role, user: m.user })), integrations, mailboxes, usage, history, invoices, audit, supportGrants: grants,
  };
}

const ADMIN_TRANSITIONS: Record<string, OrgStatus> = { suspend: 'SUSPENDED', reactivate: 'ACTIVE', cancel: 'CANCELLED', schedule_deletion: 'DELETION_PENDING', restore: 'ACTIVE' };
export const LifecycleSchema = z.object({ action: z.enum(['suspend', 'reactivate', 'cancel', 'schedule_deletion', 'restore', 'purge_now']), reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(500) });

export async function tenantLifecycle(organizationId: string, input: z.infer<typeof LifecycleSchema>, admin: Admin) {
  const org = await db().organization.findUnique({ where: { id: organizationId } });
  if (!org) throw NotFound('Organization');
  const settings = (org.settings ?? {}) as Record<string, unknown>;
  if (input.action === 'purge_now') {
    if (org.status !== 'DELETION_PENDING') throw new AppError('CONFLICT', 'Only a tenant already scheduled for deletion can be purged', 409);
    await platformAudit({ actorUserId: admin.userId, action: 'tenant.purge', organizationId, reason: input.reason, ip: admin.ip });
    await purgeTenant(organizationId);
    return { status: 'DELETED' };
  }
  const to = ADMIN_TRANSITIONS[input.action];
  await setOrgStatus(organizationId, to, `${input.action}: ${input.reason}`, { userId: admin.userId, ip: admin.ip });
  const extra: Prisma.OrganizationUpdateInput = {};
  if (input.action === 'suspend') { extra.settings = { ...settings, adminSuspended: true } as Prisma.InputJsonValue; await db().campaign.updateMany({ where: { workspace: { organizationId }, status: 'RUNNING' }, data: { status: 'PAUSED', pauseReason: 'Organization suspended by platform administrator', pausedAt: new Date() } }); }
  if (input.action === 'reactivate' || input.action === 'restore') extra.settings = { ...settings, adminSuspended: false } as Prisma.InputJsonValue;
  if (input.action === 'schedule_deletion') { extra.deletionRequestedAt = new Date(); extra.deletionScheduledFor = new Date(Date.now() + Number(process.env.TENANT_DELETION_GRACE_DAYS ?? 14) * 86400_000); }
  if (input.action === 'restore') { extra.deletionRequestedAt = null; extra.deletionScheduledFor = null; }
  if (Object.keys(extra).length) await db().organization.update({ where: { id: organizationId }, data: extra });
  if (input.action === 'cancel') await db().subscription.updateMany({ where: { organizationId }, data: { status: 'CANCELED', canceledAt: new Date() } });
  return { status: to };
}

export const SubscriptionOverrideSchema = z.object({
  planCode: z.string().max(40).optional(), status: z.enum(['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'INCOMPLETE']).optional(),
  trialEndsAt: z.coerce.date().nullable().optional(), graceUntil: z.coerce.date().nullable().optional(),
  overrides: z.record(z.string(), z.unknown()).optional(), reason: z.string().trim().min(5).max(500),
});

export async function overrideSubscription(organizationId: string, input: z.infer<typeof SubscriptionOverrideSchema>, admin: Admin) {
  await ensurePlans();
  const org = await db().organization.findUnique({ where: { id: organizationId } });
  if (!org) throw NotFound('Organization');
  const plan = input.planCode ? await db().plan.findUnique({ where: { code: input.planCode } }) : null;
  if (input.planCode && !plan) throw NotFound('Plan');
  const existing = await db().subscription.findUnique({ where: { organizationId } });
  const fallback = plan ?? (existing ? null : await db().plan.findFirstOrThrow({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }));
  const data = { ...(fallback ? { planId: fallback.id } : {}), ...(input.status ? { status: input.status } : {}), ...(input.trialEndsAt !== undefined ? { trialEndsAt: input.trialEndsAt } : {}), ...(input.graceUntil !== undefined ? { graceUntil: input.graceUntil } : {}), ...(input.overrides ? { overrides: input.overrides as Prisma.InputJsonValue } : {}) };
  const sub = existing ? await db().subscription.update({ where: { organizationId }, data }) : await db().subscription.create({ data: { organizationId, planId: fallback!.id, provider: 'manual', status: input.status ?? 'ACTIVE', ...data } as Prisma.SubscriptionUncheckedCreateInput });
  await platformAudit({ actorUserId: admin.userId, action: 'tenant.subscription_override', organizationId, reason: input.reason, ip: admin.ip, metadata: { planCode: input.planCode ?? null, status: input.status ?? null, overrides: input.overrides ?? null } });
  await (await import('./tenancy.js')).syncFromSubscription(organizationId);
  return sub;
}

// ------------------------------------------------------------------ plans

const EntSchema = z.object({
  maxUsers: z.number().int().min(0), maxWorkspaces: z.number().int().min(1), maxMailboxes: z.number().int().min(0), maxActiveCampaigns: z.number().int().min(0), maxLeads: z.number().int().min(0),
  monthlyEmailSends: z.number().int().min(0), monthlyAiUsd: z.number().min(0), monthlyEnrichments: z.number().int().min(0), monthlyApiCalls: z.number().int().min(0), monthlyWorkflowRuns: z.number().int().min(0), storageMb: z.number().int().min(0),
  apiRequestsPerMinute: z.number().int().min(1),
  features: z.object({ copilot: z.boolean(), workflows: z.boolean(), autoReply: z.boolean(), waterfall: z.boolean(), apiAccess: z.boolean(), agencyWorkspaces: z.boolean() }),
  integrations: z.array(z.string().max(40)).max(50),
  allowancePeriod: z.enum(['monthly', 'annual_pooled']).default('monthly'),
});
export const PlanSchema = z.object({
  code: z.string().regex(/^[a-z0-9-]{2,40}$/), name: z.string().trim().min(2).max(60), description: z.string().max(500).default(''),
  priceMonthlyCents: z.number().int().min(0), priceYearlyCents: z.number().int().min(0), currency: z.string().length(3).toUpperCase().default('USD'),
  trialDays: z.number().int().min(0).max(90).default(14), isPublic: z.boolean().default(true), isActive: z.boolean().default(true), sortOrder: z.number().int().default(0),
  providerPriceIds: z.record(z.string().regex(/^(stripe|razorpay)_(month|year)$/), z.string().max(100)).default({}),
  entitlements: EntSchema,
});

export async function adminPlans() {
  await ensurePlans();
  const plans = await db().plan.findMany({ orderBy: [{ archivedAt: 'asc' }, { sortOrder: 'asc' }], include: { _count: { select: { subscriptions: true } } } });
  return plans.map((p) => ({ ...p, entitlements: normalizeEntitlements(p.entitlements as Partial<Entitlements>), subscribers: p._count.subscriptions }));
}

export async function savePlan(id: string | null, input: z.infer<typeof PlanSchema>, admin: Admin) {
  const data = { ...input, entitlements: input.entitlements as unknown as Prisma.InputJsonValue, providerPriceIds: input.providerPriceIds as Prisma.InputJsonValue };
  const plan = id ? await db().plan.update({ where: { id }, data }) : await db().plan.create({ data });
  await platformAudit({ actorUserId: admin.userId, action: id ? 'plan.updated' : 'plan.created', targetType: 'plan', targetId: plan.id, ip: admin.ip, metadata: { code: plan.code } });
  return plan;
}

/** Archiving hides a plan from new customers; existing subscribers keep it until they change plan. */
export async function archivePlan(id: string, archived: boolean, admin: Admin) {
  const plan = await db().plan.update({ where: { id }, data: { archivedAt: archived ? new Date() : null, isActive: !archived } });
  await platformAudit({ actorUserId: admin.userId, action: archived ? 'plan.archived' : 'plan.unarchived', targetType: 'plan', targetId: id, ip: admin.ip });
  return plan;
}

// ------------------------------------------------------------------ SaaS metrics (definitions in docs/saas/PLATFORM_ADMIN_GUIDE.md)

export async function saasMetrics(now = new Date()) {
  const since30 = new Date(now.getTime() - 30 * 86400_000);
  const byStatus = await db().organization.groupBy({ by: ['status'], _count: { _all: true } });
  const count = (s: string) => byStatus.find((x) => x.status === s)?._count._all ?? 0;
  const subs = await db().subscription.findMany({ include: { plan: true, organization: { select: { status: true } } } });
  // MRR: ACTIVE and PAST_DUE-in-grace subscriptions on a priced plan, yearly normalised to /12, per currency.
  // Trials, cancelled, incomplete and free plans contribute 0. Manual (admin-granted) subscriptions are reported separately.
  const mrr: Record<string, number> = {}; const mrrManual: Record<string, number> = {};
  let paying = 0;
  for (const s of subs) {
    const inGrace = s.status === 'PAST_DUE' && s.graceUntil && s.graceUntil > now;
    if (!(s.status === 'ACTIVE' || inGrace) || ['DELETED', 'DELETION_PENDING'].includes(s.organization.status)) continue;
    const monthly = s.interval === 'year' ? s.plan.priceYearlyCents / 12 : s.plan.priceMonthlyCents;
    if (monthly <= 0) continue;
    const target = s.provider === 'manual' ? mrrManual : mrr;
    target[s.plan.currency] = (target[s.plan.currency] ?? 0) + monthly;
    if (s.provider !== 'manual') paying++;
  }
  const revenue30 = await db().invoice.groupBy({ by: ['currency'], where: { status: 'paid', createdAt: { gte: since30 } }, _sum: { amountCents: true } });
  const changes = await db().organizationStatusChange.findMany({ where: { createdAt: { gte: since30 } } });
  const newPaid = new Set(changes.filter((c) => c.toStatus === 'ACTIVE' && c.fromStatus && ['TRIAL', 'PENDING_SETUP', 'SUSPENDED', 'CANCELLED'].includes(c.fromStatus)).map((c) => c.organizationId)).size;
  const churned = new Set(changes.filter((c) => c.toStatus === 'CANCELLED').map((c) => c.organizationId)).size;
  const newTenants = await db().organization.count({ where: { createdAt: { gte: since30 } } });
  const activeAtStart = await db().organization.count({ where: { createdAt: { lt: since30 }, status: { in: ['ACTIVE', 'PAST_DUE', 'CANCELLED', 'SUSPENDED'] } } });
  // Trial conversion: of the trials that ended (left TRIAL) in the last 30 days, the share that became ACTIVE.
  const trialExits = changes.filter((c) => c.fromStatus === 'TRIAL');
  const trialConverted = new Set(trialExits.filter((c) => c.toStatus === 'ACTIVE').map((c) => c.organizationId)).size;
  const trialEnded = new Set(trialExits.map((c) => c.organizationId)).size;
  const paymentFailures30d = await db().invoice.count({ where: { status: 'payment_failed', createdAt: { gte: since30 } } });
  const refunds30 = await db().refund.groupBy({ by: ['currency'], where: { status: 'succeeded', updatedAt: { gte: since30 } }, _sum: { amountCents: true } });
  const openDisputes = await db().billingDispute.count({ where: { status: 'open' } });
  // Growth: new organizations per calendar month (UTC), last 6 months.
  const sixAgo = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));
  const created = await db().organization.findMany({ where: { createdAt: { gte: sixAgo } }, select: { createdAt: true } });
  const growth = Array.from({ length: 6 }, (_, i) => { const d = new Date(Date.UTC(sixAgo.getUTCFullYear(), sixAgo.getUTCMonth() + i, 1)); const key = d.toISOString().slice(0, 7); return { month: key, newTenants: created.filter((c) => c.createdAt.toISOString().slice(0, 7) === key).length }; });
  const planDist = await db().subscription.groupBy({ by: ['planId', 'status'], _count: { _all: true } });
  const plans = await db().plan.findMany({ select: { id: true, code: true, name: true } });
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const usage = await db().usageCounter.groupBy({ by: ['metric'], where: { periodStart }, _sum: { value: true }, _count: { _all: true } });
  const [failedJobs24h, errors24h] = await Promise.all([
    db().jobRun.count({ where: { status: 'FAILED', createdAt: { gte: new Date(now.getTime() - 86400_000) } } }).catch(() => 0),
    db().errorLog.count({ where: { createdAt: { gte: new Date(now.getTime() - 86400_000) } } }).catch(() => 0),
  ]);
  const round = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)]));
  return {
    generatedAt: now,
    tenants: { total: byStatus.filter((x) => x.status !== 'DELETED').reduce((s, x) => s + x._count._all, 0), active: count('ACTIVE'), trial: count('TRIAL'), pastDue: count('PAST_DUE'), suspended: count('SUSPENDED'), cancelled: count('CANCELLED'), deletionPending: count('DELETION_PENDING'), pendingSetup: count('PENDING_SETUP'), paying },
    revenue: { mrrCents: round(mrr), arrCents: Object.fromEntries(Object.entries(round(mrr)).map(([k, v]) => [k, v * 12])), manualMrrCents: round(mrrManual), collectedLast30dCents: Object.fromEntries(revenue30.map((r) => [r.currency, r._sum.amountCents ?? 0])) },
    movement30d: { newTenants, newPaidSubscriptions: newPaid, churnedTenants: churned, churnRatePct: activeAtStart ? +(100 * churned / activeAtStart).toFixed(2) : null, trialsEnded: trialEnded, trialsConverted: trialConverted, trialConversionPct: trialEnded ? +(100 * trialConverted / trialEnded).toFixed(1) : null, paymentFailures: paymentFailures30d, refundedCents: Object.fromEntries(refunds30.map((r) => [r.currency, r._sum.amountCents ?? 0])), openDisputes },
    growth,
    planDistribution: planDist.map((p) => ({ plan: plans.find((x) => x.id === p.planId)?.code ?? p.planId, status: p.status, tenants: p._count._all })),
    usageThisMonth: usage.map((u) => ({ metric: u.metric, total: Number(u._sum.value ?? 0), tenants: u._count._all })),
    operations: { failedJobs24h, errors24h },
    definitions: {
      mrr: 'Sum of monthly price (yearly ÷ 12) of ACTIVE subscriptions and PAST_DUE subscriptions still in grace, on priced plans, from payment providers. Per currency, no FX conversion.',
      paying: 'Tenants counted in MRR (excludes manual/admin-granted subscriptions).',
      churn: 'Tenants that moved to CANCELLED in the last 30 days ÷ tenants that existed 30 days ago and were active, past due, suspended or cancelled.',
      newPaid: 'Tenants that moved to ACTIVE from TRIAL, PENDING_SETUP, SUSPENDED or CANCELLED in the last 30 days.',
      trialConversion: 'Of tenants that left TRIAL in the last 30 days, the share whose next status was ACTIVE.',
      paymentFailures: 'Invoices recorded as payment_failed by verified provider webhooks in the last 30 days.',
      usage: 'Sums of idempotent usage counters for the current calendar month (UTC). AI cost is estimated from provider token prices (micro-USD); emails count provider-accepted sends.',
      growth: 'New organizations created per calendar month (UTC).',
    },
  };
}

// ------------------------------------------------------------------ support access

export const GrantSchema = z.object({ organizationId: z.string().uuid(), reason: z.string().trim().min(10, 'Describe why access is needed (ticket number, problem)').max(500), minutes: z.number().int().min(5).max(240).default(60) });

export async function createSupportGrant(input: z.infer<typeof GrantSchema>, admin: Admin) {
  const org = await db().organization.findUnique({ where: { id: input.organizationId } });
  if (!org || org.status === 'DELETED') throw NotFound('Organization');
  const g = await db().supportAccessGrant.create({ data: { organizationId: input.organizationId, adminUserId: admin.userId, reason: input.reason, scope: 'read', expiresAt: new Date(Date.now() + input.minutes * 60_000) } });
  await platformAudit({ actorUserId: admin.userId, action: 'support.grant_created', organizationId: input.organizationId, targetType: 'support_grant', targetId: g.id, reason: input.reason, ip: admin.ip, metadata: { minutes: input.minutes } });
  // The tenant can see that support accessed their data (their own audit log).
  const ws = await db().workspace.findMany({ where: { organizationId: input.organizationId }, select: { id: true } });
  for (const w of ws) await db().auditLog.create({ data: { workspaceId: w.id, actorType: 'SYSTEM', action: 'support.access_granted', metadata: { reason: input.reason, expiresAt: g.expiresAt } as Prisma.InputJsonValue } }).catch(() => undefined);
  return { ...g, workspaces: (await db().workspace.findMany({ where: { organizationId: input.organizationId }, select: { id: true, name: true } })) };
}

export async function revokeSupportGrant(id: string, admin: Admin) {
  const g = await db().supportAccessGrant.findUnique({ where: { id } });
  if (!g) throw NotFound('Grant');
  await db().supportAccessGrant.update({ where: { id }, data: { revokedAt: new Date() } });
  await platformAudit({ actorUserId: admin.userId, action: 'support.grant_revoked', organizationId: g.organizationId, targetType: 'support_grant', targetId: id, ip: admin.ip });
}

export async function myGrants(adminUserId: string) {
  return db().supportAccessGrant.findMany({ where: { adminUserId, revokedAt: null, expiresAt: { gt: new Date() } }, include: { organization: { select: { name: true, workspaces: { select: { id: true, name: true } } } } }, orderBy: { createdAt: 'desc' } });
}

export async function platformAuditLog(q: { organizationId?: string; action?: string; page: number; pageSize: number }) {
  const where: Prisma.PlatformAuditEventWhereInput = { ...(q.organizationId ? { organizationId: q.organizationId } : {}), ...(q.action ? { action: { startsWith: q.action } } : {}) };
  const [rows, total] = await Promise.all([db().platformAuditEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }), db().platformAuditEvent.count({ where })]);
  const actors = await db().user.findMany({ where: { id: { in: rows.map((r) => r.actorUserId).filter(Boolean) as string[] } }, select: { id: true, email: true } });
  return { data: rows.map((r) => ({ ...r, actorEmail: actors.find((a) => a.id === r.actorUserId)?.email ?? null })), total, page: q.page, pageSize: q.pageSize, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) };
}

export const PLATFORM_ADMIN_ENTITLEMENTS = UNLIMITED;

// ------------------------------------------------------------------ user accounts (disable / enable)

export const UserQuery = z.object({ q: z.string().trim().min(2).max(100), page: z.coerce.number().int().min(1).default(1) });
export async function searchUsers(q: z.infer<typeof UserQuery>) {
  const where: Prisma.UserWhereInput = { OR: [{ email: { contains: q.q.toLowerCase() } }, { name: { contains: q.q, mode: 'insensitive' } }] };
  const rows = await db().user.findMany({ where, take: 25, skip: (q.page - 1) * 25, orderBy: { createdAt: 'desc' }, select: { id: true, email: true, name: true, status: true, platformRole: true, mfaEnabled: true, emailVerifiedAt: true, lastLoginAt: true, createdAt: true, orgMemberships: { select: { role: true, organization: { select: { id: true, name: true } } } } } });
  return { data: rows };
}

export const UserStatusSchema = z.object({ status: z.enum(['ACTIVE', 'DISABLED']), reason: z.string().trim().min(5).max(500) });
/** Disabling an account signs it out everywhere immediately (all sessions revoked) and blocks sign-in. */
export async function setUserStatus(userId: string, input: z.infer<typeof UserStatusSchema>, admin: Admin & { role: string }) {
  if (userId === admin.userId) throw new AppError('CONFLICT', 'You cannot change your own account status', 409);
  const u = await db().user.findUnique({ where: { id: userId } });
  if (!u) throw NotFound('User');
  if (u.platformRole && admin.role !== 'SUPER_ADMIN') throw new AppError('FORBIDDEN', 'Only a super admin can change a staff account', 403);
  await db().$transaction([
    db().user.update({ where: { id: userId }, data: { status: input.status } }),
    ...(input.status === 'DISABLED' ? [db().session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } })] : []),
  ]);
  const orgs = await db().organizationMember.findMany({ where: { userId }, select: { organizationId: true } });
  for (const o of orgs.length ? orgs : [{ organizationId: null as string | null }]) {
    await platformAudit({ actorUserId: admin.userId, action: input.status === 'DISABLED' ? 'user.disabled' : 'user.enabled', organizationId: o.organizationId, targetType: 'user', targetId: userId, reason: input.reason, ip: admin.ip });
  }
  return { status: input.status };
}

// ------------------------------------------------------------------ customer-visible support access history

export async function supportAccessForOrg(organizationId: string) {
  const grants = await db().supportAccessGrant.findMany({ where: { organizationId }, orderBy: { createdAt: 'desc' }, take: 100 });
  const staff = await db().user.findMany({ where: { id: { in: grants.map((g) => g.adminUserId) } }, select: { id: true, name: true } });
  const now = new Date();
  // Number of pages viewed under each grant (from the append-only platform audit trail).
  const reads = await db().platformAuditEvent.findMany({ where: { organizationId, action: 'support.read', createdAt: { gte: grants.at(-1)?.createdAt ?? now } }, select: { metadata: true } });
  const count = (id: string) => reads.filter((r) => (r.metadata as { grantId?: string } | null)?.grantId === id).length;
  return grants.map((g) => ({ pagesViewed: count(g.id), id: g.id, staffName: staff.find((s) => s.id === g.adminUserId)?.name ?? 'EMN support', reason: g.reason, scope: g.scope, createdAt: g.createdAt, expiresAt: g.expiresAt, revokedAt: g.revokedAt, active: !g.revokedAt && g.expiresAt > now }));
}

// ------------------------------------------------------------------ operations (queues, dead letters, failures)

export async function operations() {
  const { queueOverview } = await import('./ops.js');
  const { queue } = await import('../core/queues.js');
  const queues = await queueOverview();
  const deadLetters: Array<{ queue: string; id: string | undefined; name: string; failedReason: string; attemptsMade: number; finishedOn?: number; workspaceId: string | null }> = [];
  for (const q of queues) {
    if (!q.counts.failed) continue;
    const jobs = await queue(q.name as never).getFailed(0, 19);
    for (const j of jobs) deadLetters.push({ queue: q.name, id: j.id, name: j.name, failedReason: String(j.failedReason ?? '').slice(0, 300), attemptsMade: j.attemptsMade, finishedOn: j.finishedOn, workspaceId: (j.data as { workspaceId?: string })?.workspaceId ?? null });
  }
  const since = new Date(Date.now() - 86400_000);
  const [failuresByQueue, webhookFailures, staleEvents, reconcileFailures] = await Promise.all([
    db().jobRun.groupBy({ by: ['queue'], where: { status: 'FAILED', createdAt: { gte: since } }, _count: { _all: true } }),
    db().webhookDelivery.count({ where: { status: 'FAILED', createdAt: { gte: since } } }).catch(() => 0),
    db().platformAuditEvent.count({ where: { action: 'billing.webhook_stale', createdAt: { gte: since } } }),
    db().platformAuditEvent.count({ where: { action: 'billing.reconcile_failed', createdAt: { gte: since } } }),
  ]);
  return { queues, deadLetters, last24h: { failuresByQueue: failuresByQueue.map((f) => ({ queue: f.queue, failed: f._count._all })), outboundWebhookFailures: webhookFailures, staleBillingEvents: staleEvents, billingReconcileFailures: reconcileFailures } };
}

export const RetrySchema = z.object({ queue: z.string().max(40), jobId: z.string().max(200), reason: z.string().trim().min(5).max(300) });
export async function retryDeadLetter(input: z.infer<typeof RetrySchema>, admin: Admin) {
  const { queue, ALL_QUEUE_NAMES } = await import('../core/queues.js');
  if (!(ALL_QUEUE_NAMES as readonly string[]).includes(input.queue)) throw NotFound('Queue');
  const job = await queue(input.queue as never).getJob(input.jobId);
  if (!job || !(await job.isFailed())) throw NotFound('Failed job');
  await job.retry();
  await platformAudit({ actorUserId: admin.userId, action: 'ops.job_retried', targetType: 'job', targetId: `${input.queue}/${input.jobId}`, reason: input.reason, ip: admin.ip });
  return { retried: true };
}
