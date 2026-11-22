import { z } from 'zod';
import { db, Prisma } from '../core/db.js';
import { AppError, NotFound } from '../core/errors.js';
import { platformAudit } from '../core/tenant.js';
import { randomToken, sha256 } from '../core/crypto.js';
import { systemMailer, trySendSystemMail } from '../core/mailer.js';
import { routes } from '../http/router.js';
import { ROLES, hasRole, type Role } from '../../../shared/src/permissions.js';
import { ORG_ROLES, PLATFORM_PERMISSIONS, PLATFORM_ROLES, type OrgRole, type PlatformRole } from '../../../shared/src/tenancy.js';

// Super-admin ("ERP back office") operations that complement services/platform.ts: staff roles,
// creating tenants, managing a tenant's members, per-tenant modules/limits, the permission matrix
// and global settings. Every write is reason-required and recorded in the append-only platform audit.

type Admin = { userId: string; ip?: string | null };
const Reason = z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(500);

// ------------------------------------------------------------------ staff & platform roles

export async function listStaff() {
  const users = await db().user.findMany({
    where: { platformRole: { not: null } }, orderBy: [{ platformRole: 'asc' }, { email: 'asc' }],
    select: { id: true, email: true, name: true, platformRole: true, mfaEnabled: true, status: true, lastLoginAt: true, createdAt: true },
  });
  return { staff: users, roles: PLATFORM_ROLES.map((r) => ({ role: r, permissions: PLATFORM_PERMISSIONS[r] })) };
}

export const StaffRoleSchema = z.object({ role: z.enum(PLATFORM_ROLES).nullable(), reason: Reason });
export const StaffAddSchema = z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(PLATFORM_ROLES), reason: Reason });

export async function setStaffRole(targetUserId: string, input: { role: PlatformRole | null; reason: string }, admin: Admin) {
  if (targetUserId === admin.userId) throw new AppError('FORBIDDEN', 'You cannot change your own platform role. Ask another super admin.', 403);
  const u = await db().user.findUnique({ where: { id: targetUserId }, select: { id: true, email: true, platformRole: true } });
  if (!u) throw NotFound('User');
  if (u.platformRole === 'SUPER_ADMIN' && input.role !== 'SUPER_ADMIN') {
    const supers = await db().user.count({ where: { platformRole: 'SUPER_ADMIN', status: 'ACTIVE' } });
    if (supers <= 1) throw new AppError('CONFLICT', 'There must always be at least one active super admin', 409);
  }
  await db().$transaction(async (tx) => {
    await tx.user.update({ where: { id: u.id }, data: { platformRole: input.role, isPlatformAdmin: input.role === 'SUPER_ADMIN' } });
    // Losing or changing a staff role ends open support access and signs the person out, so new rights apply at once.
    if (u.platformRole && u.platformRole !== input.role) {
      await tx.supportAccessGrant.updateMany({ where: { adminUserId: u.id, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.session.deleteMany({ where: { userId: u.id } });
    }
  });
  await platformAudit({ actorUserId: admin.userId, action: input.role ? 'staff.role_set' : 'staff.role_removed', targetType: 'user', targetId: u.id, reason: input.reason, ip: admin.ip, metadata: { email: u.email, from: u.platformRole, to: input.role } });
  return { id: u.id, platformRole: input.role };
}

export async function addStaff(input: z.infer<typeof StaffAddSchema>, admin: Admin) {
  const u = await db().user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (!u) throw new AppError('NOT_FOUND', 'No account uses that email. The person must sign up (or be added to a tenant) first.', 404);
  return setStaffRole(u.id, { role: input.role, reason: input.reason }, admin);
}

// ------------------------------------------------------------------ account set-up / reset links

const SETUP_TTL_MS = 7 * 86_400_000;

/** One live reset token per user. The link is mailed when system mail is configured; otherwise returned once to the admin. */
async function issueSetupLink(userId: string, email: string, purpose: 'invite' | 'reset', admin: Admin) {
  await db().passwordResetToken.updateMany({ where: { userId, kind: 'RESET', usedAt: null }, data: { usedAt: new Date() } });
  const token = randomToken(32);
  await db().passwordResetToken.create({ data: { userId, kind: 'RESET', tokenHash: sha256(token), expiresAt: new Date(Date.now() + SETUP_TTL_MS), ip: admin.ip ?? null } });
  const link = `${process.env.APP_URL}/reset-password/${token}`;
  const subject = purpose === 'invite' ? 'Your EMN Outreach OS account is ready' : 'Reset your EMN Outreach OS password';
  const text = purpose === 'invite'
    ? `An administrator created an EMN Outreach OS account for ${email}.\n\nChoose your password here (valid for 7 days, single use):\n${link}\n`
    : `An administrator started a password reset for ${email}.\n\nChoose a new password here (valid for 7 days, single use):\n${link}\n\nIf you did not expect this, contact your administrator.`;
  const mailed = systemMailer().configured ? await trySendSystemMail({ to: email, subject, text }) : false;
  return { mailed, link: mailed ? null : link };
}

export const ResetSchema = z.object({ reason: Reason });
export async function adminPasswordReset(userId: string, input: { reason: string }, admin: Admin) {
  const u = await db().user.findUnique({ where: { id: userId }, select: { id: true, email: true, status: true } });
  if (!u) throw NotFound('User');
  if (u.status !== 'ACTIVE') throw new AppError('CONFLICT', 'Re-enable the account before resetting its password', 409);
  const r = await issueSetupLink(u.id, u.email, 'reset', admin);
  await platformAudit({ actorUserId: admin.userId, action: 'user.password_reset_issued', targetType: 'user', targetId: u.id, reason: input.reason, ip: admin.ip, metadata: { mailed: r.mailed } });
  return r;
}

/** Find a user by email, or create one with no usable password plus a set-password link. */
async function userForEmail(email: string, name: string | undefined, admin: Admin) {
  const existing = await db().user.findUnique({ where: { email }, select: { id: true, email: true, status: true } });
  if (existing) {
    if (existing.status !== 'ACTIVE') throw new AppError('CONFLICT', 'That account is disabled. Re-enable it first.', 409);
    return { userId: existing.id, created: false, setup: null as null | { mailed: boolean; link: string | null } };
  }
  const { hashPassword } = await import('./auth.js');
  const user = await db().user.create({ data: { email, name: name?.trim() || email.split('@')[0], passwordHash: await hashPassword(randomToken(48)), termsAcceptedAt: null } });
  const setup = await issueSetupLink(user.id, email, 'invite', admin);
  return { userId: user.id, created: true, setup };
}

// ------------------------------------------------------------------ create tenant

export const CreateTenantSchema = z.object({
  organizationName: z.string().trim().min(2).max(120),
  ownerEmail: z.string().trim().toLowerCase().email(),
  ownerName: z.string().trim().max(120).optional(),
  planCode: z.string().trim().max(40).optional(),
  reason: Reason,
});

export async function createTenant(input: z.infer<typeof CreateTenantSchema>, admin: Admin) {
  const owner = await userForEmail(input.ownerEmail, input.ownerName, admin);
  const { provisionTenant } = await import('./tenancy.js');
  const r = await provisionTenant({ userId: owner.userId, organizationName: input.organizationName, planCode: input.planCode });
  await platformAudit({ actorUserId: admin.userId, action: 'tenant.created_by_admin', organizationId: r.organization.id, reason: input.reason, ip: admin.ip, metadata: { ownerEmail: input.ownerEmail, ownerCreated: owner.created, planCode: input.planCode ?? null } });
  return { organizationId: r.organization.id, workspaceId: r.workspace.id, ownerCreated: owner.created, setup: owner.setup };
}

// ------------------------------------------------------------------ tenant members

export async function tenantMembers(organizationId: string) {
  const org = await db().organization.findUnique({ where: { id: organizationId }, select: { id: true, ownerId: true } });
  if (!org) throw NotFound('Organization');
  const { listMembers } = await import('./tenancy.js');
  const members = await listMembers(organizationId);
  const status = await db().user.findMany({ where: { id: { in: members.map((m) => m.user.id) } }, select: { id: true, status: true, platformRole: true } });
  const workspaces = await db().workspace.findMany({ where: { organizationId, archivedAt: null }, select: { id: true, name: true }, orderBy: { createdAt: 'asc' } });
  return { members: members.map((m) => ({ ...m, user: { ...m.user, ...status.find((x) => x.id === m.user.id) } })), workspaces, orgRoles: ORG_ROLES, workspaceRoles: ROLES };
}

export const MemberRoleSchema = z.object({ role: z.enum(ORG_ROLES), reason: Reason });
export async function setTenantMemberRole(organizationId: string, userId: string, input: z.infer<typeof MemberRoleSchema>, admin: Admin) {
  const { setMemberRole } = await import('./tenancy.js');
  // Platform admins act with owner authority (ownership transfer included), always audited with the reason.
  await setMemberRole(organizationId, userId, input.role as OrgRole, 'OWNER', { type: 'USER', userId: admin.userId, ip: admin.ip ?? undefined });
  await platformAudit({ actorUserId: admin.userId, action: 'tenant.member_role_set_by_admin', organizationId, targetType: 'user', targetId: userId, reason: input.reason, ip: admin.ip, metadata: { role: input.role } });
  return { ok: true };
}

export async function removeTenantMember(organizationId: string, userId: string, input: { reason: string }, admin: Admin) {
  const { removeMember } = await import('./tenancy.js');
  await removeMember(organizationId, userId, 'OWNER', { type: 'USER', userId: admin.userId, ip: admin.ip ?? undefined });
  await platformAudit({ actorUserId: admin.userId, action: 'tenant.member_removed_by_admin', organizationId, targetType: 'user', targetId: userId, reason: input.reason, ip: admin.ip });
  return { ok: true };
}

export const AddMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email(), name: z.string().trim().max(120).optional(),
  role: z.enum(ORG_ROLES), workspaceId: z.string().uuid().nullable().optional(),
  workspaceRole: z.enum(ROLES as [Role, ...Role[]]).default('MEMBER'), reason: Reason,
});

export async function addTenantMember(organizationId: string, input: z.infer<typeof AddMemberSchema>, admin: Admin) {
  const org = await db().organization.findUnique({ where: { id: organizationId }, select: { id: true, status: true } });
  if (!org || org.status === 'DELETED') throw NotFound('Organization');
  if (input.role === 'OWNER') throw new AppError('VALIDATION_FAILED', 'Add the person first, then make them owner (ownership transfer)', 400);
  if (input.workspaceId && !(await db().workspace.findFirst({ where: { id: input.workspaceId, organizationId }, select: { id: true } }))) throw NotFound('Workspace');
  const u = await userForEmail(input.email, input.name, admin);
  if (await db().organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId: u.userId } } })) throw new AppError('CONFLICT', 'That person is already a member of this organization', 409);
  // Seats are a plan limit like any other: adding a member beyond it is refused (raise it under Modules & limits).
  // (A suspended tenant has no usable plan, so only an explicit seat limit blocks; inactivity does not.)
  try { await (await import('./entitlements.js')).assertQuota(organizationId, 'users'); }
  catch (e) { if ((e as { code?: string }).code === 'QUOTA_EXCEEDED') throw e; }
  await db().$transaction(async (tx) => {
    await tx.organizationMember.create({ data: { organizationId, userId: u.userId, role: input.role } });
    if (input.workspaceId) await tx.workspaceMember.create({ data: { workspaceId: input.workspaceId, userId: u.userId, role: input.workspaceRole } });
  });
  await platformAudit({ actorUserId: admin.userId, action: 'tenant.member_added_by_admin', organizationId, targetType: 'user', targetId: u.userId, reason: input.reason, ip: admin.ip, metadata: { role: input.role, workspaceId: input.workspaceId ?? null, created: u.created } });
  return { userId: u.userId, created: u.created, setup: u.setup };
}

// ------------------------------------------------------------------ modules & limits per tenant

export const FEATURE_KEYS = ['copilot', 'workflows', 'autoReply', 'waterfall', 'apiAccess', 'agencyWorkspaces'] as const;
export const LIMIT_KEYS = ['maxUsers', 'maxWorkspaces', 'maxMailboxes', 'maxActiveCampaigns', 'maxLeads', 'monthlyEmailSends', 'monthlyAiUsd', 'monthlyEnrichments', 'monthlyApiCalls', 'monthlyWorkflowRuns', 'storageMb', 'apiRequestsPerMinute'] as const;

export const ModulesSchema = z.object({
  /** null = inherit from the plan */
  features: z.object(Object.fromEntries(FEATURE_KEYS.map((k) => [k, z.boolean().nullable()])) as Record<typeof FEATURE_KEYS[number], z.ZodNullable<z.ZodBoolean>>),
  limits: z.object(Object.fromEntries(LIMIT_KEYS.map((k) => [k, z.number().min(0).max(1_000_000_000).nullable()])) as Record<typeof LIMIT_KEYS[number], z.ZodNullable<z.ZodNumber>>),
  integrations: z.array(z.string().trim().max(40)).max(50).nullable(),
  reason: Reason,
});

export async function tenantModules(organizationId: string) {
  const org = await db().organization.findUnique({ where: { id: organizationId }, select: { settings: true, subscription: { include: { plan: true } } } });
  if (!org) throw NotFound('Organization');
  const { tenantState, billingEnabled } = await import('./entitlements.js');
  const { UNLIMITED } = await import('../../../shared/src/plans.js');
  const state = await tenantState(organizationId);
  const sub = org.subscription;
  const base = billingEnabled() ? (sub ? { ...(sub.plan.entitlements as object), ...((sub.overrides ?? {}) as object) } : null) : UNLIMITED;
  return {
    mode: billingEnabled() ? 'saas' : 'self_hosted',
    plan: sub ? { code: sub.plan.code, name: sub.plan.name } : null,
    base, overrides: ((org.settings ?? {}) as { adminOverrides?: object }).adminOverrides ?? {},
    effective: state.entitlements, operational: state.operational, reason: state.reason,
    featureKeys: FEATURE_KEYS, limitKeys: LIMIT_KEYS,
  };
}

/** Saves per-module choices as Organization.settings.adminOverrides (null = inherit). Works with and without billing. */
export async function setTenantModules(organizationId: string, input: z.infer<typeof ModulesSchema>, admin: Admin) {
  const org = await db().organization.findUnique({ where: { id: organizationId }, select: { settings: true } });
  if (!org) throw NotFound('Organization');
  const overrides: Record<string, unknown> = {};
  const features = Object.fromEntries(Object.entries(input.features).filter(([, v]) => v !== null));
  if (Object.keys(features).length) overrides.features = features;
  for (const [k, v] of Object.entries(input.limits)) if (v !== null) overrides[k] = v;
  if (input.integrations !== null) overrides.integrations = input.integrations;
  await db().organization.update({ where: { id: organizationId }, data: { settings: { ...((org.settings ?? {}) as object), adminOverrides: overrides } as Prisma.InputJsonValue } });
  await platformAudit({ actorUserId: admin.userId, action: 'tenant.modules_set', organizationId, reason: input.reason, ip: admin.ip, metadata: { overrides } });
  return tenantModules(organizationId);
}

// ------------------------------------------------------------------ permission matrix (derived from the real route rules)

export function permissionMatrix() {
  const byTag = new Map<string, { read: Role | null; write: Role | null; ops: number }>();
  const rank = (r: Role) => ROLES.length - ROLES.indexOf(r); // VIEWER lowest
  for (const r of routes) {
    if (r.auth !== 'workspace') continue;
    const need = (r.role ?? 'VIEWER') as Role;
    const row = byTag.get(r.tag) ?? { read: null, write: null, ops: 0 };
    row.ops++;
    const key = r.method === 'get' ? 'read' : 'write';
    if (!row[key] || rank(need) < rank(row[key] as Role)) row[key] = need;
    byTag.set(r.tag, row);
  }
  const workspace = [...byTag.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([module, v]) => ({
    module, operations: v.ops, minRoleToView: v.read, minRoleToChange: v.write,
    byRole: Object.fromEntries(ROLES.map((role) => [role, { view: v.read ? hasRole(role, v.read) : false, change: v.write ? hasRole(role, v.write) : false }])),
  }));
  const organization = [
    { action: 'View organization, workspaces and usage', roles: ['OWNER', 'ADMIN', 'BILLING', 'MEMBER'] },
    { action: 'Manage members, workspaces and settings', roles: ['OWNER', 'ADMIN'] },
    { action: 'Billing, plan and invoices', roles: ['OWNER', 'BILLING'] },
    { action: 'Transfer ownership, delete organization', roles: ['OWNER'] },
    { action: 'Access every workspace of the organization', roles: ['OWNER', 'ADMIN'] },
  ];
  const platform = PLATFORM_ROLES.map((role) => ({ role, permissions: PLATFORM_PERMISSIONS[role] }));
  return { workspaceRoles: ROLES, workspace, organization, platform };
}

// ------------------------------------------------------------------ global settings

export const SETTING_KEYS = ['signupMode', 'announcement'] as const;
export const SettingsSchema = z.object({
  /** 'env' keeps REGISTRATION_OPEN / billing default; 'open' / 'closed' override it. */
  signupMode: z.enum(['env', 'open', 'closed']),
  announcement: z.object({ enabled: z.boolean(), level: z.enum(['info', 'warning', 'danger']), message: z.string().trim().max(500) }),
  reason: Reason,
});
const DEFAULTS = { signupMode: 'env', announcement: { enabled: false, level: 'info', message: '' } } as const;

export async function getSetting<K extends typeof SETTING_KEYS[number]>(key: K): Promise<(typeof DEFAULTS)[K] | Record<string, unknown> | string> {
  const row = await db().platformSetting.findUnique({ where: { key } });
  return (row?.value as never) ?? DEFAULTS[key];
}

export async function platformSettings() {
  const rows = await db().platformSetting.findMany({ where: { key: { in: [...SETTING_KEYS] } } });
  const value = (k: typeof SETTING_KEYS[number]) => rows.find((r) => r.key === k)?.value ?? DEFAULTS[k];
  const { registrationOpen } = await import('./tenancy.js');
  return { signupMode: value('signupMode'), announcement: value('announcement'), effective: { registrationOpen: await registrationOpen(), envRegistration: process.env.REGISTRATION_OPEN ?? process.env.PUBLIC_REGISTRATION ?? null } };
}

export async function savePlatformSettings(input: z.infer<typeof SettingsSchema>, admin: Admin) {
  if (input.announcement.enabled && !input.announcement.message) throw new AppError('VALIDATION_FAILED', 'Write the announcement message before turning it on', 400);
  await db().$transaction([
    db().platformSetting.upsert({ where: { key: 'signupMode' }, update: { value: input.signupMode, updatedById: admin.userId }, create: { key: 'signupMode', value: input.signupMode, updatedById: admin.userId } }),
    db().platformSetting.upsert({ where: { key: 'announcement' }, update: { value: input.announcement, updatedById: admin.userId }, create: { key: 'announcement', value: input.announcement, updatedById: admin.userId } }),
  ]);
  await platformAudit({ actorUserId: admin.userId, action: 'platform.settings_saved', targetType: 'platform_settings', reason: input.reason, ip: admin.ip, metadata: { signupMode: input.signupMode, announcement: input.announcement.enabled } });
  return platformSettings();
}

/** For every signed-in user: the active announcement, if any. */
export async function activeAnnouncement() {
  const a = await getSetting('announcement') as { enabled?: boolean; level?: string; message?: string };
  return a?.enabled && a.message ? { level: a.level ?? 'info', message: a.message } : null;
}
