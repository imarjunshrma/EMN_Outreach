import { z } from 'zod';
import { route } from '../http/router.js';
import * as tenancy from '../services/tenancy.js';
import * as billing from '../services/billing.js';
import * as platform from '../services/platform.js';
import { currentUsage, usageHistory } from '../services/usage.js';
import { ONBOARDING_STEPS, ORG_ROLES } from '../../../shared/src/tenancy.js';
import { db } from '../core/db.js';
import * as ops from '../services/ops.js';
import { platformAudit } from '../core/tenant.js';

const meta = (c: { req: { ip?: string; headers: Record<string, unknown> } }) => ({ ip: c.req.ip, userAgent: String(c.req.headers['user-agent'] ?? '') });
const admin = (c: { userId: string; req: { ip?: string } }) => ({ userId: c.userId, ip: c.req.ip ?? null });

// ---------------------------------------------------------------- public: sign-up, plans, verification
route({ method: 'get', path: '/public/plans', tag: 'Public', summary: 'Public plan catalogue (prices, limits, features) for the pricing page', auth: 'public', rateLimit: { limit: 120, windowSec: 60 },
  handler: async () => ({ billingEnabled: billing.billingEnabled(), registrationOpen: await tenancy.registrationOpen(), plans: (await billing.listPlans()).map(({ providerPriceIds: _p, ...p }) => p) }) });
route({ method: 'post', path: '/auth/signup', tag: 'Auth', summary: 'Create an account and a new organization (tenant) with its first workspace and trial', auth: 'public', rateLimit: { limit: 10, windowSec: 3600 },
  body: tenancy.SignupSchema, handler: (c) => tenancy.signup(c.res, c.body, meta(c)) });
route({ method: 'post', path: '/auth/verify-email', tag: 'Auth', summary: 'Confirm an email address with the token from the verification email', auth: 'public', status: 200, rateLimit: { limit: 20, windowSec: 900 },
  body: z.object({ token: z.string().min(20).max(200) }), handler: (c) => tenancy.verifyEmail(c.body.token) });
route({ method: 'post', path: '/auth/verify-email/resend', tag: 'Auth', summary: 'Send the verification email again', auth: 'user', status: 200, rateLimit: { limit: 3, windowSec: 900, key: 'user' }, handler: (c) => tenancy.sendVerificationEmail(c.userId) });

// ---------------------------------------------------------------- organizations (tenant-scoped; tenant derived from membership)
route({ method: 'get', path: '/orgs', tag: 'Organizations', summary: 'Organizations I belong to, with the workspaces I can open', auth: 'user', handler: (c) => tenancy.myOrganizations(c.userId) });
route({ method: 'get', path: '/orgs/:organizationId', tag: 'Organizations', summary: 'Organization profile, status, plan, entitlements and usage', auth: 'org', handler: (c) => tenancy.getOrganization(c.organizationId) });
route({ method: 'patch', path: '/orgs/:organizationId', tag: 'Organizations', summary: 'Update name, time zone, locale, currency, branding, billing owner', auth: 'org', orgPermission: 'manage', body: tenancy.OrgUpdateSchema, handler: (c) => tenancy.updateOrganization(c.organizationId, c.body, c.actor) });
route({ method: 'get', path: '/orgs/:organizationId/members', tag: 'Organizations', summary: 'Organization members, roles and workspace access', auth: 'org', handler: (c) => tenancy.listMembers(c.organizationId) });
route({ method: 'patch', path: '/orgs/:organizationId/members/:userId', tag: 'Organizations', summary: 'Change a member\'s organization role', auth: 'org', orgPermission: 'manage', status: 200,
  body: z.object({ role: z.enum(ORG_ROLES) }), handler: async (c) => { await tenancy.setMemberRole(c.organizationId, c.params.userId, c.body.role, c.orgRole!, c.actor); return { ok: true }; } });
route({ method: 'delete', path: '/orgs/:organizationId/members/:userId', tag: 'Organizations', summary: 'Remove a member from the organization (and all its workspaces)', auth: 'org', orgPermission: 'manage', status: 200,
  handler: async (c) => { await tenancy.removeMember(c.organizationId, c.params.userId, c.orgRole!, c.actor); return { ok: true }; } });
route({ method: 'get', path: '/orgs/:organizationId/workspaces', tag: 'Organizations', summary: 'Workspaces I can open in this organization', auth: 'org', handler: (c) => tenancy.accessibleWorkspaces(c.organizationId, c.userId, c.orgRole!) });
route({ method: 'post', path: '/orgs/:organizationId/workspaces', tag: 'Organizations', summary: 'Create a workspace (team, client or brand) — counts against the plan', auth: 'org', orgPermission: 'manage', body: tenancy.WorkspaceCreateSchema, handler: (c) => tenancy.createOrgWorkspace(c.organizationId, c.body, c.actor) });
route({ method: 'post', path: '/orgs/:organizationId/workspaces/:workspaceId/archive', tag: 'Organizations', summary: 'Archive a workspace (data kept; hidden from members)', auth: 'org', orgPermission: 'manage', status: 200,
  handler: async (c) => { await tenancy.archiveWorkspace(c.organizationId, c.params.workspaceId, c.actor); return { ok: true }; } });
route({ method: 'get', path: '/orgs/:organizationId/onboarding', tag: 'Organizations', summary: 'Setup checklist computed from real configuration', auth: 'org', handler: (c) => tenancy.onboardingStatus(c.organizationId) });
route({ method: 'post', path: '/orgs/:organizationId/onboarding/:step/skip', tag: 'Organizations', summary: 'Skip (or un-skip) an optional setup step', auth: 'org', orgPermission: 'manage', status: 200,
  body: z.object({ skip: z.boolean().default(true) }), handler: (c) => tenancy.skipOnboardingStep(c.organizationId, c.params.step as (typeof ONBOARDING_STEPS)[number]['id'], c.body.skip) });
route({ method: 'get', path: '/orgs/:organizationId/support-access', tag: 'Organizations', summary: 'When Outvexa support accessed this organization, why, and how many pages they viewed', auth: 'org', orgPermission: 'manage', allowWhenInactive: true,
  handler: (c) => platform.supportAccessForOrg(c.organizationId) });
route({ method: 'get', path: '/w/:workspaceId/access', tag: 'Workspaces', summary: 'How the caller is accessing this workspace (member, organization admin, or audited support access) and the tenant status', auth: 'workspace', allowWhenInactive: true,
  handler: async (c) => {
    const m = await c.res.locals.resolveMembership(c.workspaceId);
    const grant = m?.supportGrantId ? await db().supportAccessGrant.findUnique({ where: { id: m.supportGrantId }, select: { expiresAt: true, reason: true } }) : null;
    const ws = await db().workspace.findUniqueOrThrow({ where: { id: c.workspaceId }, select: { name: true, organization: { select: { name: true } } } });
    return { role: c.role, via: m?.via ?? 'member', workspaceName: ws.name, organizationId: c.organizationId, organizationName: ws.organization.name, orgStatus: m?.orgStatus, support: grant };
  } });
route({ method: 'get', path: '/orgs/:organizationId/usage', tag: 'Organizations', summary: 'Usage this period and the last 6 months', auth: 'org', allowWhenInactive: true,
  handler: async (c) => ({ current: await currentUsage(c.organizationId), history: await usageHistory(c.organizationId, 6) }) });

// Billing (OWNER or BILLING role). Allowed while suspended/cancelled so a customer can always pay or leave.
route({ method: 'get', path: '/orgs/:organizationId/billing', tag: 'Billing', summary: 'Plan, subscription, usage, invoices and available plans', auth: 'org', allowWhenInactive: true,
  handler: (c) => billing.overview(c.organizationId, { includeInvoices: c.orgRole === 'OWNER' || c.orgRole === 'BILLING' }) });
route({ method: 'post', path: '/orgs/:organizationId/billing/checkout', tag: 'Billing', summary: 'Start hosted checkout for a plan (Stripe or Razorpay); activation only via verified webhook', auth: 'org', orgPermission: 'billing', allowWhenInactive: true, status: 200, rateLimit: { limit: 20, windowSec: 600, key: 'user' },
  body: billing.CheckoutSchema, handler: (c) => billing.checkout(c.organizationId, c.body, c.actor) });
route({ method: 'post', path: '/orgs/:organizationId/billing/portal', tag: 'Billing', summary: 'Open the Stripe customer portal (payment method, invoices)', auth: 'org', orgPermission: 'billing', allowWhenInactive: true, status: 200, handler: (c) => billing.portal(c.organizationId) });
route({ method: 'post', path: '/orgs/:organizationId/billing/cancel', tag: 'Billing', summary: 'Cancel the subscription (default: at the end of the period)', auth: 'org', orgPermission: 'billing', allowWhenInactive: true, status: 200,
  body: z.object({ atPeriodEnd: z.boolean().default(true) }), handler: async (c) => { await billing.cancel(c.organizationId, c.body.atPeriodEnd, c.actor); return { ok: true }; } });
route({ method: 'post', path: '/orgs/:organizationId/billing/resume', tag: 'Billing', summary: 'Undo a scheduled cancellation (Stripe)', auth: 'org', orgPermission: 'billing', allowWhenInactive: true, status: 200,
  handler: async (c) => { await billing.resume(c.organizationId, c.actor); return { ok: true }; } });

// Data export & deletion (owner)
route({ method: 'post', path: '/orgs/:organizationId/export', tag: 'Organizations', summary: 'Download a JSON export of the organization and all its workspaces (secrets excluded)', auth: 'org', orgPermission: 'manage', allowWhenInactive: true, raw: true, rateLimit: { limit: 3, windowSec: 3600, key: 'user' },
  handler: async (c) => {
    const org = await tenancy.getOrganization(c.organizationId);
    const ws = await db().workspace.findMany({ where: { organizationId: c.organizationId }, select: { id: true } });
    await platformAudit({ actorUserId: c.userId, action: 'organization.exported', organizationId: c.organizationId, ip: c.req.ip });
    // Streamed one workspace at a time: holding every workspace in memory could exhaust the API process.
    await ops.streamJsonDownload(c.res, 'organization-export.json', async (sink) => {
      await sink(`{"exportedAt":${JSON.stringify(new Date().toISOString())},"organization":${JSON.stringify(org)},"workspaces":[`);
      for (const [index, w] of ws.entries()) {
        if (index) await sink(',');
        await ops.writeWorkspaceExport(w.id, c.actor, sink);
      }
      await sink(']}');
    });
  } });
route({ method: 'post', path: '/orgs/:organizationId/deletion', tag: 'Organizations', summary: 'Schedule permanent deletion of the organization (grace period, then erased)', auth: 'org', orgPermission: 'own', allowWhenInactive: true, status: 200,
  body: z.object({ confirmName: z.string().min(1).max(80) }), handler: (c) => tenancy.requestDeletion(c.organizationId, c.actor, c.body.confirmName) });
route({ method: 'delete', path: '/orgs/:organizationId/deletion', tag: 'Organizations', summary: 'Cancel a scheduled deletion', auth: 'org', orgPermission: 'own', allowWhenInactive: true, status: 200,
  handler: async (c) => { await tenancy.cancelDeletion(c.organizationId, c.actor); return { ok: true }; } });

// ---------------------------------------------------------------- platform administration (Outvexa staff; invisible to tenants)
route({ method: 'get', path: '/platform/me', tag: 'Platform', summary: 'My platform role, permissions, whether 2FA is on and whether this install requires it for staff', auth: 'platform', allowWithoutMfa: true,
  handler: async (c) => ({ role: c.platformRole, mfaEnabled: !!c.res.locals.mfaEnabled, mfaRequired: (await import('../core/tenant.js')).platformMfaRequired(), permissions: (await import('../../../shared/src/tenancy.js')).PLATFORM_PERMISSIONS[c.platformRole!] }) });
route({ method: 'get', path: '/platform/users', tag: 'Platform', summary: 'Find user accounts by email or name', auth: 'platform', platformPermission: 'tenants:read', query: platform.UserQuery, handler: (c) => platform.searchUsers(c.query) });
route({ method: 'post', path: '/platform/users/:id/status', tag: 'Platform', summary: 'Disable (signs out everywhere) or re-enable a user account; reason required', auth: 'platform', platformPermission: 'tenants:lifecycle', status: 200,
  body: platform.UserStatusSchema, handler: (c) => platform.setUserStatus(c.params.id, c.body, { ...admin(c), role: c.platformRole! }) });
route({ method: 'get', path: '/platform/metrics', tag: 'Platform', summary: 'SaaS metrics: tenants by status, MRR/ARR, churn, plan and usage distribution, operations', auth: 'platform', platformPermission: 'metrics:read', handler: () => platform.saasMetrics() });
route({ method: 'get', path: '/platform/tenants', tag: 'Platform', summary: 'Search and filter tenants', auth: 'platform', platformPermission: 'tenants:read', query: platform.TenantQuery, handler: (c) => platform.listTenants(c.query) });
route({ method: 'get', path: '/platform/tenants/:id', tag: 'Platform', summary: 'Tenant detail: subscription, usage, workspaces, users, integration status (no secrets), audit', auth: 'platform', platformPermission: 'tenants:read',
  handler: async (c) => { await platformAudit({ actorUserId: c.userId, action: 'tenant.viewed', organizationId: c.params.id, ip: c.req.ip }); return platform.tenantDetail(c.params.id); } });
route({ method: 'post', path: '/platform/tenants/:id/lifecycle', tag: 'Platform', summary: 'Suspend, reactivate, cancel, schedule deletion, restore or purge (reason required)', auth: 'platform', platformPermission: 'tenants:lifecycle', status: 200,
  body: platform.LifecycleSchema, handler: (c) => platform.tenantLifecycle(c.params.id, c.body, admin(c)) });
route({ method: 'post', path: '/platform/tenants/:id/subscription', tag: 'Platform', summary: 'Override plan, status, trial, grace or entitlements (reason required)', auth: 'platform', platformPermission: 'tenants:lifecycle', status: 200,
  body: platform.SubscriptionOverrideSchema, handler: (c) => platform.overrideSubscription(c.params.id, c.body, admin(c)) });
route({ method: 'post', path: '/platform/tenants/:id/refunds', tag: 'Platform', summary: 'Refund all or part of a paid invoice (optionally cancelling the subscription); idempotent on requestKey', auth: 'platform', platformPermission: 'billing:refund', status: 200, rateLimit: { limit: 20, windowSec: 3600, key: 'user' },
  body: billing.RefundSchema, handler: (c) => billing.requestRefund(c.params.id, c.body, admin(c)) });
route({ method: 'get', path: '/platform/tenants/:id/billing', tag: 'Platform', summary: 'Invoices, refunds and disputes of a tenant (no payment secrets)', auth: 'platform', platformPermission: 'billing:read',
  handler: async (c) => ({
    invoices: await db().invoice.findMany({ where: { organizationId: c.params.id }, orderBy: { createdAt: 'desc' }, take: 100 }),
    refunds: await db().refund.findMany({ where: { organizationId: c.params.id }, orderBy: { createdAt: 'desc' }, take: 100 }),
    disputes: await db().billingDispute.findMany({ where: { organizationId: c.params.id }, orderBy: { createdAt: 'desc' }, take: 100 }),
  }) });
route({ method: 'get', path: '/platform/plans', tag: 'Platform', summary: 'All plans including archived, with subscriber counts', auth: 'platform', platformPermission: 'tenants:read', handler: () => platform.adminPlans() });
route({ method: 'post', path: '/platform/plans', tag: 'Platform', summary: 'Create a plan', auth: 'platform', platformPermission: 'plans:write', body: platform.PlanSchema, handler: (c) => platform.savePlan(null, c.body, admin(c)) });
route({ method: 'put', path: '/platform/plans/:id', tag: 'Platform', summary: 'Update a plan (prices, limits, features, provider price ids)', auth: 'platform', platformPermission: 'plans:write', body: platform.PlanSchema, handler: (c) => platform.savePlan(c.params.id, c.body, admin(c)) });
route({ method: 'post', path: '/platform/plans/:id/archive', tag: 'Platform', summary: 'Archive / unarchive a plan', auth: 'platform', platformPermission: 'plans:write', status: 200, body: z.object({ archived: z.boolean() }), handler: (c) => platform.archivePlan(c.params.id, c.body.archived, admin(c)) });
route({ method: 'get', path: '/platform/operations', tag: 'Platform', summary: 'Queue depths, dead-lettered jobs and failure counters (last 24 h)', auth: 'platform', platformPermission: 'metrics:read', handler: () => platform.operations() });
route({ method: 'post', path: '/platform/operations/retry', tag: 'Platform', summary: 'Retry one dead-lettered job (reason required, audited)', auth: 'platform', platformPermission: 'tenants:lifecycle', status: 200, body: platform.RetrySchema, handler: (c) => platform.retryDeadLetter(c.body, admin(c)) });
route({ method: 'get', path: '/platform/support/grants', tag: 'Platform', summary: 'My active support-access grants', auth: 'platform', platformPermission: 'support:access', handler: (c) => platform.myGrants(c.userId) });
route({ method: 'post', path: '/platform/support/grants', tag: 'Platform', summary: 'Open time-limited, read-only, audited access to one tenant (reason required)', auth: 'platform', platformPermission: 'support:access', body: platform.GrantSchema, handler: (c) => platform.createSupportGrant(c.body, admin(c)) });
route({ method: 'delete', path: '/platform/support/grants/:id', tag: 'Platform', summary: 'End a support-access grant', auth: 'platform', platformPermission: 'support:access', status: 200, handler: async (c) => { await platform.revokeSupportGrant(c.params.id, admin(c)); return { ok: true }; } });
route({ method: 'get', path: '/platform/audit', tag: 'Platform', summary: 'Platform audit trail (append-only)', auth: 'platform', platformPermission: 'audit:read',
  query: z.object({ organizationId: z.string().uuid().optional(), action: z.string().max(60).optional(), page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(50) }), handler: (c) => platform.platformAuditLog(c.query) });
