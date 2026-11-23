import { z } from 'zod';
import { db, Prisma } from '../core/db.js';
import { AppError, Forbidden, NotFound } from '../core/errors.js';
import { audit, notifyWorkspace, type Actor } from '../core/audit.js';
import { randomToken, sha256 } from '../core/crypto.js';
import { trySendSystemMail } from '../core/mailer.js';
import { logger } from '../core/logger.js';
import { platformAudit } from '../core/tenant.js';
import { store } from '../core/storage.js';
import { canTransition, ONBOARDING_STEPS, orgCan, type OnboardingStepId, type OrgRole, type OrgStatus } from '../../../shared/src/tenancy.js';
import { billingEnabled, assertQuota, tenantState } from './entitlements.js';
import { currentUsage } from './usage.js';
import { cfg } from '../core/platform-config.js';

// Tenants (organizations): provisioning, lifecycle, membership, workspaces, onboarding and deletion.

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'org';
const DELETION_GRACE_DAYS = () => Number(process.env.TENANT_DELETION_GRACE_DAYS ?? 14);

async function uniqueSlug(table: 'organization' | 'workspace', base: string, tx: Prisma.TransactionClient = db()) {
  let slug = slugify(base);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  while (await (tx[table] as any).findUnique({ where: { slug } })) slug = `${slugify(base).slice(0, 32)}-${randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
  return slug;
}

// ------------------------------------------------------------------ lifecycle

export async function setOrgStatus(organizationId: string, to: OrgStatus, reason: string | null, actor: { userId?: string | null; ip?: string | null; system?: boolean }) {
  const org = await db().organization.findUnique({ where: { id: organizationId } });
  if (!org) throw NotFound('Organization');
  const from = org.status as OrgStatus;
  if (from === to) return org;
  if (!canTransition(from, to)) throw new AppError('INVALID_TRANSITION', `An organization cannot go from ${from} to ${to}`, 409, { from, to });
  const updated = await db().$transaction(async (tx) => {
    const u = await tx.organization.update({ where: { id: organizationId }, data: { status: to, statusReason: reason, statusChangedAt: new Date() } });
    await tx.organizationStatusChange.create({ data: { organizationId, fromStatus: from, toStatus: to, reason, actorUserId: actor.userId ?? null } });
    return u;
  });
  await platformAudit({ actorUserId: actor.userId ?? null, action: `tenant.status.${to.toLowerCase()}`, organizationId, targetType: 'organization', targetId: organizationId, reason, ip: actor.ip ?? null, metadata: { from, to, system: !!actor.system } });
  return updated;
}

// ------------------------------------------------------------------ provisioning

export interface ProvisionInput { userId: string; organizationName: string; workspaceName?: string; planCode?: string; registrationKey?: string | null; timezone?: string }

/**
 * Creates tenant + owner membership + default workspace + trial subscription + onboarding state in ONE transaction,
 * then seeds workspace defaults (idempotent). A repeated request with the same registrationKey returns the
 * existing tenant instead of creating a second one. If seeding fails the tenant stays PENDING_SETUP and
 * ensureProvisioned() finishes it on the next sign-in.
 */
/** Normalises an email to the person behind it for trial accounting: lowercase, drop +tags, and drop dots for Gmail. */
export function trialIdentity(email: string) {
  const [local0, domain0] = email.trim().toLowerCase().split('@');
  const domain = domain0 === 'googlemail.com' ? 'gmail.com' : domain0;
  let local = (local0 ?? '').split('+')[0];
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return sha256(`trial:${local}@${domain}`);
}
/** Platform → Global settings → Sign-ups wins over the MAX_ORGS_PER_USER server setting (default 5). */
const MAX_ORGS_PER_USER = () => cfg().signups.maxOrgsPerUser ?? Number(process.env.MAX_ORGS_PER_USER ?? 5);

export async function provisionTenant(input: ProvisionInput) {
  if (input.registrationKey) {
    const existing = await db().organization.findUnique({ where: { registrationKey: input.registrationKey }, include: { workspaces: { orderBy: { createdAt: 'asc' }, take: 1 } } });
    if (existing) return { organization: existing, workspace: existing.workspaces[0], created: false };
  }
  const plans = billingEnabled() ? await (await import('./billing.js')).ensurePlans() : null;
  void plans;
  const plan = billingEnabled() ? await db().plan.findFirst({ where: { code: input.planCode ?? (cfg().signups.defaultPlanCode || 'starter'), isActive: true, archivedAt: null } }) ?? await db().plan.findFirstOrThrow({ where: { isActive: true }, orderBy: { sortOrder: 'asc' } }) : null;
  const owner = await db().user.findUniqueOrThrow({ where: { id: input.userId }, select: { email: true, platformRole: true } });
  let result;
  let trialGranted = false;
  try {
    result = await db().$transaction(async (tx) => {
      // Abuse limits: a person can own a limited number of organizations, and gets one free trial ever
      // (keyed by normalised email, kept even after deletion). Staff and platform overrides are exempt.
      if (!owner.platformRole && (await tx.organization.count({ where: { ownerId: input.userId, status: { notIn: ['DELETED', 'DELETION_PENDING'] } } })) >= MAX_ORGS_PER_USER()) {
        throw new AppError('QUOTA_EXCEEDED', `You already own ${MAX_ORGS_PER_USER()} organizations. Add workspaces to an existing organization instead, or contact support.`, 402);
      }
      const organization = await tx.organization.create({ data: {
        name: input.organizationName, slug: await uniqueSlug('organization', input.organizationName, tx), status: 'PENDING_SETUP', ownerId: input.userId, billingOwnerId: input.userId,
        registrationKey: input.registrationKey ?? null, timezone: input.timezone ?? 'UTC',
        onboarding: { steps: {}, startedAt: new Date().toISOString() } as Prisma.InputJsonValue,
        members: { create: { userId: input.userId, role: 'OWNER' } },
      } });
      await tx.organizationStatusChange.create({ data: { organizationId: organization.id, fromStatus: null, toStatus: 'PENDING_SETUP', reason: 'Registered', actorUserId: input.userId } });
      const workspace = await tx.workspace.create({ data: { organizationId: organization.id, name: input.workspaceName ?? input.organizationName, slug: await uniqueSlug('workspace', input.workspaceName ?? input.organizationName, tx), timezone: input.timezone ?? 'UTC', members: { create: { userId: input.userId, role: 'OWNER' } } } });
      if (plan) {
        const granted = await tx.$queryRaw<Array<{ id: string }>>`INSERT INTO "TrialGrant" (id, "identityHash", "organizationId", "planCode") VALUES (gen_random_uuid(), ${trialIdentity(owner.email)}, ${organization.id}::uuid, ${plan.code}) ON CONFLICT ("identityHash") DO NOTHING RETURNING id`;
        trialGranted = granted.length > 0 && plan.trialDays > 0;
        await tx.subscription.create({ data: trialGranted
          ? { organizationId: organization.id, planId: plan.id, status: 'TRIALING', trialEndsAt: new Date(Date.now() + plan.trialDays * 86400_000) }
          : { organizationId: organization.id, planId: plan.id, status: 'INCOMPLETE', overrides: {} } });
      }
      return { organization, workspace };
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002' && input.registrationKey) {
      const existing = await db().organization.findUnique({ where: { registrationKey: input.registrationKey }, include: { workspaces: { orderBy: { createdAt: 'asc' }, take: 1 } } });
      if (existing) return { organization: existing, workspace: existing.workspaces[0], created: false };
    }
    throw e;
  }
  const organization = await ensureProvisioned(result.organization.id, input.userId);
  await audit(result.workspace.id, { type: 'USER', userId: input.userId }, 'tenant.provisioned', { type: 'organization', id: result.organization.id }, { plan: plan?.code ?? null });
  if (plan && !trialGranted) await platformAudit({ actorUserId: input.userId, action: 'tenant.trial_denied', organizationId: organization.id, reason: 'Free trial already used by this person' });
  return { organization, workspace: result.workspace, created: true, trialGranted };
}

/** Finishes provisioning (idempotent): workspace defaults, then PENDING_SETUP → TRIAL/ACTIVE. */
export async function ensureProvisioned(organizationId: string, actorUserId?: string) {
  const org = await db().organization.findUniqueOrThrow({ where: { id: organizationId }, include: { workspaces: true, subscription: true } });
  if (org.status !== 'PENDING_SETUP') return org;
  const { initWorkspaceDefaults } = await import('./workspace.js');
  try {
    for (const w of org.workspaces) await initWorkspaceDefaults(w.id);
  } catch (e) {
    logger.error({ err: (e as Error).message, organizationId }, 'tenant provisioning incomplete — will retry');
    return org;
  }
  return setOrgStatus(organizationId, org.subscription?.status === 'TRIALING' ? 'TRIAL' : 'ACTIVE', 'Provisioning complete', { userId: actorUserId ?? null, system: true });
}

// ------------------------------------------------------------------ registration (public sign-up)

export const SignupSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
  organizationName: z.string().trim().min(2).max(80),
  planCode: z.string().max(40).optional(),
  acceptTerms: z.literal(true, { message: 'You must accept the Terms of Service and Privacy Policy' }),
  termsVersion: z.string().max(40).default('2026-11'),
  timezone: z.string().max(60).optional(),
  idempotencyKey: z.string().min(8).max(100).optional(),
});

/** First user always; then REGISTRATION_OPEN (true/false) wins; default open in SaaS mode, closed self-hosted. */
export const registrationOpen = async () => {
  if ((await db().user.count()) === 0) return true;
  // Super admins can override the environment from Platform → Settings.
  const mode = (await db().platformSetting.findUnique({ where: { key: 'signupMode' } }))?.value;
  if (mode === 'open') return true;
  if (mode === 'closed') return false;
  const flag = process.env.REGISTRATION_OPEN ?? process.env.PUBLIC_REGISTRATION;
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return billingEnabled();
};

export async function signup(res: import('express').Response, input: z.infer<typeof SignupSchema>, meta: { ip?: string; userAgent?: string }) {
  const { validatePasswordStrength, hashPassword, createSession, publicUser } = await import('./auth.js');
  if (!(await registrationOpen())) throw new AppError('REGISTRATION_CLOSED', 'Registration is closed. Ask an administrator for an invitation.', 403);
  validatePasswordStrength(input.password);
  const email = input.email.trim().toLowerCase();
  const key = input.idempotencyKey ? sha256(`signup:${email}:${input.idempotencyKey}`) : null;
  const passwordHash = await hashPassword(input.password);
  const user = await db().$transaction(async (tx) => {
    // Same lock as auth.register: concurrent first sign-ups cannot both become platform admin.
    await tx.$queryRaw`WITH registration_lock AS MATERIALIZED (SELECT pg_advisory_xact_lock(824623901174)) SELECT 1 FROM registration_lock`;
    const existing = await tx.user.findUnique({ where: { email } });
    if (existing) {
      // Same browser retrying the same sign-up (double click, network retry): return the tenant it already created.
      const prior = key ? await tx.organization.findUnique({ where: { registrationKey: key } }) : null;
      if (!prior || prior.ownerId !== existing.id) throw new AppError('CONFLICT', 'An account with this email already exists. Sign in instead, or reset your password.', 409);
      return existing;
    }
    const first = (await tx.user.count()) === 0;
    // Re-check under the lock: a concurrent first sign-up may have just closed registration.
    if (!first && !(await registrationOpen())) throw new AppError('REGISTRATION_CLOSED', 'Registration is closed. Ask an administrator for an invitation.', 403);
    return tx.user.create({ data: { email, name: input.name, passwordHash, isPlatformAdmin: first, platformRole: first ? 'SUPER_ADMIN' : null, termsAcceptedAt: new Date(), termsVersion: input.termsVersion, emailVerifiedAt: first ? new Date() : null } });
  });
  const prov = await provisionTenant({ userId: user.id, organizationName: input.organizationName, planCode: input.planCode, registrationKey: key, timezone: input.timezone });
  const { organization, workspace, created } = prov;
  if (created && !user.emailVerifiedAt) await sendVerificationEmail(user.id);
  const { csrfToken } = await createSession(res, user.id, meta, workspace.id);
  await platformAudit({ actorUserId: user.id, action: 'tenant.registered', organizationId: organization.id, ip: meta.ip ?? null, metadata: { plan: input.planCode ?? null, created } });
  return { user: publicUser(user), organization: { id: organization.id, name: organization.name, status: organization.status }, workspace: { id: workspace.id, name: workspace.name }, csrfToken, emailVerificationRequired: !user.emailVerifiedAt, trialGranted: (prov as { trialGranted?: boolean }).trialGranted ?? false };
}

// ------------------------------------------------------------------ email verification

export async function sendVerificationEmail(userId: string) {
  const user = await db().user.findUniqueOrThrow({ where: { id: userId } });
  if (user.emailVerifiedAt) return { alreadyVerified: true };
  await db().passwordResetToken.updateMany({ where: { userId, kind: 'EMAIL_VERIFY', usedAt: null }, data: { usedAt: new Date() } });
  const token = randomToken(32);
  await db().passwordResetToken.create({ data: { userId, kind: 'EMAIL_VERIFY', tokenHash: sha256(token), expiresAt: new Date(Date.now() + 48 * 3600_000) } });
  const sent = await trySendSystemMail({ to: user.email, subject: 'Confirm your email for Outvexa', text: `Hi ${user.name},\n\nConfirm your email address to finish setting up your account (link valid for 48 hours):\n${process.env.APP_URL}/verify-email/${token}\n\nIf you did not sign up, ignore this email.` });
  return { sent };
}

export async function verifyEmail(token: string) {
  const t = await db().passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
  if (!t || t.kind !== 'EMAIL_VERIFY' || t.usedAt || t.expiresAt < new Date()) throw new AppError('INVALID_TOKEN', 'This verification link is invalid or has expired. Request a new one from your account.', 400);
  const claimed = await db().passwordResetToken.updateMany({ where: { id: t.id, usedAt: null }, data: { usedAt: new Date() } });
  if (!claimed.count) throw new AppError('INVALID_TOKEN', 'This verification link was already used.', 400);
  await db().user.update({ where: { id: t.userId }, data: { emailVerifiedAt: new Date() } });
  return { verified: true };
}

/** In SaaS mode, actions that reach the outside world (sending, inviting) require a verified email. */
export async function assertEmailVerified(userId: string | null | undefined) {
  if (!userId || !(billingEnabled() || process.env.REQUIRE_EMAIL_VERIFICATION === 'true')) return;
  const u = await db().user.findUnique({ where: { id: userId }, select: { emailVerifiedAt: true } });
  if (u && !u.emailVerifiedAt) throw new AppError('EMAIL_NOT_VERIFIED', 'Confirm your email address first — we sent you a link (you can resend it from My account).', 403);
}

// ------------------------------------------------------------------ organization access & settings

export async function membershipOf(organizationId: string, userId: string) {
  return db().organizationMember.findUnique({ where: { organizationId_userId: { organizationId, userId } } });
}

export async function myOrganizations(userId: string) {
  const ms = await db().organizationMember.findMany({ where: { userId, organization: { status: { not: 'DELETED' } } }, include: { organization: true }, orderBy: { createdAt: 'asc' } });
  return Promise.all(ms.map(async (m) => {
    const workspaces = await accessibleWorkspaces(m.organizationId, userId, m.role as OrgRole);
    return { id: m.organization.id, name: m.organization.name, slug: m.organization.slug, status: m.organization.status, role: m.role, branding: m.organization.branding, workspaces };
  }));
}

/** Org owners/admins see every workspace of their organization; everyone else only the ones they were added to. */
export async function accessibleWorkspaces(organizationId: string, userId: string, role: OrgRole) {
  const where: Prisma.WorkspaceWhereInput = orgCan.manage(role) ? { organizationId, archivedAt: null } : { organizationId, archivedAt: null, members: { some: { userId } } };
  const ws = await db().workspace.findMany({ where, orderBy: { createdAt: 'asc' }, include: { members: { where: { userId }, select: { role: true } } } });
  return ws.map((w) => ({ id: w.id, name: w.name, slug: w.slug, role: w.members[0]?.role ?? (role === 'OWNER' ? 'OWNER' : 'ADMIN') }));
}

export async function getOrganization(organizationId: string) {
  const org = await db().organization.findUnique({ where: { id: organizationId } });
  if (!org) throw NotFound('Organization');
  const [state, usage] = await Promise.all([tenantState(organizationId), currentUsage(organizationId)]);
  const { registrationKey: _k, ...rest } = org;
  return { ...rest, state: { operational: state.operational, reason: state.reason, plan: state.plan, mode: state.mode, entitlements: state.entitlements }, usage };
}

export const OrgUpdateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  timezone: z.string().max(60).optional(),
  locale: z.string().max(10).optional(),
  currency: z.string().length(3).toUpperCase().optional(),
  branding: z.object({ displayName: z.string().max(80).optional(), primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(), logoUrl: z.string().url().max(500).optional().or(z.literal('')), website: z.string().url().max(300).optional().or(z.literal('')) }).optional(),
  billingOwnerId: z.string().uuid().optional(),
});

export async function updateOrganization(organizationId: string, input: z.infer<typeof OrgUpdateSchema>, actor: Actor) {
  if (input.billingOwnerId && !(await membershipOf(organizationId, input.billingOwnerId))) throw NotFound('Member');
  const org = await db().organization.update({ where: { id: organizationId }, data: { ...input, branding: input.branding as Prisma.InputJsonValue | undefined } });
  await platformAudit({ actorUserId: actor.userId, action: 'organization.updated', organizationId, metadata: { fields: Object.keys(input) }, ip: actor.ip ?? null });
  return org;
}

// ------------------------------------------------------------------ members

export async function listMembers(organizationId: string) {
  const ms = await db().organizationMember.findMany({ where: { organizationId }, include: { user: { select: { id: true, name: true, email: true, mfaEnabled: true, emailVerifiedAt: true, lastLoginAt: true } } }, orderBy: { createdAt: 'asc' } });
  const wsm = await db().workspaceMember.findMany({ where: { workspace: { organizationId } }, include: { workspace: { select: { id: true, name: true } } } });
  return ms.map((m) => ({ id: m.id, role: m.role, user: m.user, workspaces: wsm.filter((w) => w.userId === m.userId).map((w) => ({ id: w.workspace.id, name: w.workspace.name, role: w.role })) }));
}

export async function setMemberRole(organizationId: string, userId: string, role: OrgRole, actorRole: OrgRole, actor: Actor) {
  const m = await membershipOf(organizationId, userId);
  if (!m) throw NotFound('Member');
  if ((role === 'OWNER' || m.role === 'OWNER') && actorRole !== 'OWNER') throw Forbidden('Only the owner can change ownership');
  if (m.role === 'OWNER' && role !== 'OWNER' && (await db().organizationMember.count({ where: { organizationId, role: 'OWNER' } })) <= 1) throw new AppError('CONFLICT', 'An organization needs at least one owner. Make someone else owner first.', 409);
  await db().organizationMember.update({ where: { id: m.id }, data: { role } });
  if (role === 'OWNER') await db().organization.update({ where: { id: organizationId }, data: { ownerId: userId } });
  await platformAudit({ actorUserId: actor.userId, action: 'organization.member_role_changed', organizationId, targetType: 'user', targetId: userId, metadata: { from: m.role, to: role } });
}

export async function removeMember(organizationId: string, userId: string, actorRole: OrgRole, actor: Actor) {
  const m = await membershipOf(organizationId, userId);
  if (!m) throw NotFound('Member');
  if (m.role === 'OWNER') throw new AppError('CONFLICT', 'Transfer ownership before removing the owner', 409);
  if (m.role === 'ADMIN' && actorRole !== 'OWNER') throw Forbidden('Only the owner can remove an administrator');
  await db().$transaction([
    db().workspaceMember.deleteMany({ where: { userId, workspace: { organizationId } } }),
    db().organizationMember.delete({ where: { id: m.id } }),
    db().session.updateMany({ where: { userId, activeWorkspaceId: { in: (await db().workspace.findMany({ where: { organizationId }, select: { id: true } })).map((w) => w.id) } }, data: { activeWorkspaceId: null } }),
  ]);
  await platformAudit({ actorUserId: actor.userId, action: 'organization.member_removed', organizationId, targetType: 'user', targetId: userId });
}

/** Called when someone accepts a workspace invitation: they join the organization as MEMBER (seat counted). */
export async function ensureOrgMember(organizationId: string, userId: string) {
  await db().organizationMember.upsert({ where: { organizationId_userId: { organizationId, userId } }, update: {}, create: { organizationId, userId, role: 'MEMBER' } });
}

// ------------------------------------------------------------------ workspaces (agency / multi-team)

export const WorkspaceCreateSchema = z.object({ name: z.string().trim().min(2).max(80), timezone: z.string().max(60).optional() });

export async function createOrgWorkspace(organizationId: string, input: z.infer<typeof WorkspaceCreateSchema>, actor: Actor) {
  const st = await assertQuota(organizationId, 'workspaces');
  const count = await db().workspace.count({ where: { organizationId, archivedAt: null } });
  if (count >= 1 && !st.entitlements.features.agencyWorkspaces && st.entitlements.maxWorkspaces <= 1) throw new AppError('QUOTA_EXCEEDED', 'Multiple workspaces are not included in your plan', 402);
  const ws = await db().workspace.create({ data: { organizationId, name: input.name, slug: await uniqueSlug('workspace', input.name), timezone: input.timezone ?? 'UTC', members: { create: { userId: actor.userId!, role: 'OWNER' } } } });
  const { initWorkspaceDefaults } = await import('./workspace.js');
  await initWorkspaceDefaults(ws.id);
  await audit(ws.id, actor, 'workspace.created', { type: 'workspace', id: ws.id });
  await platformAudit({ actorUserId: actor.userId, action: 'workspace.created', organizationId, targetType: 'workspace', targetId: ws.id });
  return ws;
}

export async function archiveWorkspace(organizationId: string, workspaceId: string, actor: Actor) {
  const ws = await db().workspace.findFirst({ where: { id: workspaceId, organizationId } });
  if (!ws) throw NotFound('Workspace');
  if ((await db().workspace.count({ where: { organizationId, archivedAt: null } })) <= 1) throw new AppError('CONFLICT', 'An organization needs at least one active workspace', 409);
  const running = await db().campaign.count({ where: { workspaceId, status: 'RUNNING' } });
  if (running) throw new AppError('CONFLICT', `Pause the ${running} running campaign(s) in this workspace first`, 409);
  await db().workspace.update({ where: { id: workspaceId }, data: { archivedAt: new Date() } });
  await platformAudit({ actorUserId: actor.userId, action: 'workspace.archived', organizationId, targetType: 'workspace', targetId: workspaceId });
}

// ------------------------------------------------------------------ onboarding

/** Real setup status per step, computed from data — never a stored "done" flag the UI can't back up. */
export async function onboardingStatus(organizationId: string) {
  const org = await db().organization.findUniqueOrThrow({ where: { id: organizationId }, include: { workspaces: { where: { archivedAt: null }, orderBy: { createdAt: 'asc' } } } });
  const wsIds = org.workspaces.map((w) => w.id);
  const first = org.workspaces[0];
  const [members, ai, mailboxes, domains, verifiedDomains, leads, campaigns, kb] = await Promise.all([
    db().organizationMember.count({ where: { organizationId } }), db().aiProvider.count({ where: { workspaceId: { in: wsIds }, isEnabled: true } }),
    db().emailAccount.count({ where: { workspaceId: { in: wsIds }, status: 'CONNECTED' } }), db().domain.count({ where: { workspaceId: { in: wsIds } } }),
    db().domain.count({ where: { workspaceId: { in: wsIds }, verifiedAt: { not: null } } }), db().lead.count({ where: { workspaceId: { in: wsIds } } }),
    db().campaign.count({ where: { workspaceId: { in: wsIds } } }), db().aiConfigVersion.count({ where: { workspaceId: { in: wsIds }, kind: 'KNOWLEDGE' } }).catch(() => 0),
  ]);
  const ws = first ? (first.settings ?? {}) as { offerFacts?: string } : {};
  const done: Record<OnboardingStepId, boolean> = {
    organization: !!org.name && org.timezone !== '' && !!first?.postalAddress,
    business: kb > 0 || !!(ws.offerFacts && ws.offerFacts.trim().length > 20),
    team: members > 1, ai: ai > 0, mailbox: mailboxes > 0, domain: domains > 0 && verifiedDomains > 0, leads: leads > 0, campaign: campaigns > 0,
  };
  const skipped = ((org.onboarding ?? {}) as { skipped?: string[] }).skipped ?? [];
  const steps = ONBOARDING_STEPS.map((s) => ({ ...s, done: done[s.id], skipped: !done[s.id] && skipped.includes(s.id) }));
  const required = steps.filter((s) => !s.optional);
  return { steps, complete: required.every((s) => s.done) && steps.every((s) => s.done || s.skipped), firstWorkspaceId: first?.id ?? null, details: { members, ai, mailboxes, domains, verifiedDomains, leads, campaigns } };
}

export async function skipOnboardingStep(organizationId: string, step: OnboardingStepId, skip: boolean) {
  const def = ONBOARDING_STEPS.find((s) => s.id === step);
  if (!def) throw NotFound('Onboarding step');
  if (!def.optional && skip) throw new AppError('VALIDATION_FAILED', 'This step is required', 400);
  const org = await db().organization.findUniqueOrThrow({ where: { id: organizationId } });
  const ob = (org.onboarding ?? {}) as { skipped?: string[] };
  const skipped = new Set(ob.skipped ?? []);
  if (skip) skipped.add(step); else skipped.delete(step);
  await db().organization.update({ where: { id: organizationId }, data: { onboarding: { ...ob, skipped: [...skipped] } as Prisma.InputJsonValue } });
  return onboardingStatus(organizationId);
}

// ------------------------------------------------------------------ deletion workflow

export async function requestDeletion(organizationId: string, actor: Actor, confirmName: string) {
  const org = await db().organization.findUniqueOrThrow({ where: { id: organizationId } });
  if (confirmName.trim() !== org.name) throw new AppError('VALIDATION_FAILED', 'Type the organization name exactly to confirm', 400);
  const when = new Date(Date.now() + DELETION_GRACE_DAYS() * 86400_000);
  await setOrgStatus(organizationId, 'DELETION_PENDING', `Deletion requested; data will be erased on ${when.toISOString().slice(0, 10)}`, { userId: actor.userId, ip: actor.ip });
  await db().organization.update({ where: { id: organizationId }, data: { deletionRequestedAt: new Date(), deletionScheduledFor: when, settings: { ...((org.settings ?? {}) as object), statusBeforeDeletion: org.status } as Prisma.InputJsonValue } });
  // Stop all outbound activity immediately.
  await db().campaign.updateMany({ where: { workspace: { organizationId }, status: 'RUNNING' }, data: { status: 'PAUSED', pauseReason: 'Organization scheduled for deletion', pausedAt: new Date() } });
  const sub = await db().subscription.findUnique({ where: { organizationId } });
  if (sub && sub.status !== 'CANCELED') await (await import('./billing.js')).cancel(organizationId, true, actor).catch((e) => logger.warn({ err: (e as Error).message }, 'could not cancel subscription during deletion request'));
  const owner = org.ownerId ? await db().user.findUnique({ where: { id: org.ownerId } }) : null;
  if (owner) await trySendSystemMail({ to: owner.email, subject: `${org.name} is scheduled for deletion`, text: `All data for ${org.name} will be permanently erased on ${when.toISOString().slice(0, 10)}.\nYou can cancel this until then from Organization settings, and download an export.` });
  return { scheduledFor: when };
}

export async function cancelDeletion(organizationId: string, actor: Actor) {
  const org = await db().organization.findUniqueOrThrow({ where: { id: organizationId } });
  if (org.status !== 'DELETION_PENDING') throw new AppError('CONFLICT', 'No deletion is pending', 409);
  const back = (((org.settings ?? {}) as { statusBeforeDeletion?: OrgStatus }).statusBeforeDeletion ?? 'ACTIVE') as OrgStatus;
  const target: OrgStatus = ['ACTIVE', 'CANCELLED', 'SUSPENDED'].includes(back) ? back : 'ACTIVE';
  await setOrgStatus(organizationId, target, 'Deletion cancelled', { userId: actor.userId, ip: actor.ip });
  await db().organization.update({ where: { id: organizationId }, data: { deletionRequestedAt: null, deletionScheduledFor: null } });
}

/** Daily job: permanently erase tenants whose deletion grace period has passed. Keeps a tombstone row + platform audit. */
export async function purgeDueTenants(now = new Date()) {
  const due = await db().organization.findMany({ where: { status: 'DELETION_PENDING', deletionScheduledFor: { lte: now } } });
  for (const org of due) await purgeTenant(org.id);
  return { purged: due.length };
}

export async function purgeTenant(organizationId: string) {
  const wss = await db().workspace.findMany({ where: { organizationId }, select: { id: true } });
  for (const w of wss) {
    await store().deletePrefix(w.id).catch((e: Error) => logger.warn({ err: e.message }, 'storage purge failed'));
  }
  await db().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('emn.allow_audit_delete', 'on', true)`;
    await tx.workspace.deleteMany({ where: { organizationId } }); // cascades every workspace-owned record
    await tx.organizationMember.deleteMany({ where: { organizationId } });
    await tx.usageEvent.deleteMany({ where: { organizationId } });
    await tx.supportAccessGrant.deleteMany({ where: { organizationId } });
    await tx.storedObject.deleteMany({ where: { organizationId } }); // files were removed from storage above
    await tx.organization.update({ where: { id: organizationId }, data: { name: 'Deleted organization', slug: `deleted-${organizationId.slice(0, 8)}`, branding: {}, settings: {}, onboarding: {}, registrationKey: null, ownerId: null, billingOwnerId: null, deletedAt: new Date() } });
  });
  await setOrgStatus(organizationId, 'DELETED', 'Data erased after deletion grace period', { system: true });
}

// ------------------------------------------------------------------ status synchronisation (daily + after billing events)

/** Moves tenants whose trial or payment grace ran out to SUSPENDED (unless an admin decided otherwise). */
export async function syncTenantStatuses(now = new Date()) {
  if (!billingEnabled()) return { suspended: 0 };
  const orgs = await db().organization.findMany({ where: { status: { in: ['TRIAL', 'ACTIVE', 'PAST_DUE'] } }, include: { subscription: true } });
  let suspended = 0;
  for (const o of orgs) {
    const s = o.subscription;
    const expiredTrial = s?.status === 'TRIALING' && s.trialEndsAt && s.trialEndsAt <= now;
    const graceOver = s?.status === 'PAST_DUE' && (!s.graceUntil || s.graceUntil <= now);
    if (expiredTrial || graceOver || !s) {
      await setOrgStatus(o.id, 'SUSPENDED', expiredTrial ? 'Trial ended without a paid plan' : graceOver ? 'Payment overdue after grace period' : 'No subscription', { system: true });
      const ws = await db().workspace.findFirst({ where: { organizationId: o.id } });
      if (ws) await notifyWorkspace(ws.id, 'OWNER', { type: 'billing.suspended', title: 'Your organization is suspended — choose a plan to continue', link: '/billing' });
      suspended++;
    }
  }
  return { suspended };
}

/** Billing → tenant status. Never lifts a suspension a platform admin imposed. */
export async function syncFromSubscription(organizationId: string) {
  const org = await db().organization.findUniqueOrThrow({ where: { id: organizationId }, include: { subscription: true } });
  const adminHold = ((org.settings ?? {}) as { adminSuspended?: boolean }).adminSuspended;
  const s = org.subscription;
  if (!s || ['DELETION_PENDING', 'DELETED', 'PENDING_SETUP'].includes(org.status)) return;
  const target: OrgStatus | null = s.status === 'ACTIVE' ? 'ACTIVE' : s.status === 'TRIALING' ? 'TRIAL' : s.status === 'PAST_DUE' ? 'PAST_DUE' : s.status === 'CANCELED' ? 'CANCELLED' : null;
  if (!target || (adminHold && target !== 'CANCELLED')) return;
  if (canTransition(org.status as OrgStatus, target)) await setOrgStatus(organizationId, target, `Subscription ${s.status.toLowerCase()}`, { system: true });
}

export const verifyTokenHash = sha256;
