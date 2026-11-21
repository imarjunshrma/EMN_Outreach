import { z } from 'zod';
import { db, Prisma } from '../core/db.js';
import { randomToken, sha256, keyring, signPayload } from '../core/crypto.js';
import { AppError, BadRequest, Forbidden, NotFound } from '../core/errors.js';
import { audit, type Actor } from '../core/audit.js';
import { DEFAULT_COMPLIANCE_RULES } from '../../../shared/src/compliance.js';
import { DEFAULT_PROMPTS } from '../../../shared/src/prompts.js';
import { AI_TASKS } from '../../../shared/src/ai-schemas.js';
import { hasRole, type Role } from '../../../shared/src/permissions.js';

export const WorkspaceSettingsSchema = z.object({
  bookingLink: z.string().url().nullable().default(null),
  offerFacts: z.string().max(4000).default(''), // trusted facts about OUR offer, used by the AI writer
  retentionDays: z.object({
    aiOutputs: z.number().int().min(7).max(3650).default(90),
    importFiles: z.number().int().min(1).max(365).default(30),
    domainChecks: z.number().int().min(7).max(3650).default(90),
    auditLogs: z.number().int().min(90).max(3650).default(730),
  }).default({ aiOutputs: 90, importFiles: 30, domainChecks: 90, auditLogs: 730 }),
  searchProvider: z.enum(['none', 'brave', 'serper']).default('none'),
  leadProvider: z.enum(['none', 'apollo']).default('none'),
  verifierProvider: z.enum(['none', 'millionverifier']).default('none'),
  trackingBaseUrl: z.string().url().nullable().default(null),
  aiMonthlyBudgetUsd: z.number().min(0).max(100000).nullable().default(null),
  aiMaxCostPerLeadUsd: z.number().min(0).max(100).nullable().default(null),
  requireMfa: z.boolean().default(false),
  replyMode: z.enum(['suggest', 'draft', 'auto_narrow']).default('draft'),
  autoReplyCategories: z.array(z.string()).default([]),
  verifierOrder: z.array(z.enum(['millionverifier', 'zerobounce', 'neverbounce'])).default(['millionverifier']),
  finderOrder: z.array(z.enum(['hunter'])).default([]),
  stageProbabilities: z.partialRecord(z.enum(['NEW', 'QUALIFIED', 'MEETING', 'PROPOSAL']), z.number().min(0).max(1)).default({}),
});

// Server-managed keys kept in the same JSON column but never exposed or overwritten by settings edits.
const INTERNAL_SETTINGS_KEYS = ['workflowTokens'] as const;
export type WorkspaceSettings = z.infer<typeof WorkspaceSettingsSchema>;

export function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'workspace';
}

export function readSettings(raw: unknown): WorkspaceSettings {
  return WorkspaceSettingsSchema.parse(raw ?? {});
}

/** Seed compliance rules and version-1 prompts for a new workspace. Idempotent. */
export async function initWorkspaceDefaults(workspaceId: string) {
  for (const r of DEFAULT_COMPLIANCE_RULES) {
    await db().complianceRule.upsert({
      where: { workspaceId_countryCode: { workspaceId, countryCode: r.countryCode } },
      update: {},
      create: { workspaceId, ...r },
    });
  }
  for (const task of AI_TASKS) {
    const p = DEFAULT_PROMPTS[task];
    await db().promptTemplate.upsert({
      where: { workspaceId_task_version: { workspaceId, task, version: 1 } },
      update: {},
      create: { workspaceId, task, version: 1, systemPrompt: p.system, userPromptTemplate: p.user, isActive: true, changeNote: 'Built-in default' },
    });
  }
  await db().workspace.update({ where: { id: workspaceId }, data: { settings: WorkspaceSettingsSchema.parse({}) as Prisma.InputJsonValue } }).catch(() => undefined);
}

export async function getWorkspace(workspaceId: string) {
  const ws = await db().workspace.findUnique({ where: { id: workspaceId } });
  if (!ws) throw NotFound('Workspace');
  return { ...ws, settings: readSettings(ws.settings) };
}

export const UpdateWorkspaceSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  timezone: z.string().optional(),
  senderLegalName: z.string().max(200).nullable().optional(),
  postalAddress: z.string().max(500).nullable().optional(),
  settings: WorkspaceSettingsSchema.partial().optional(),
});

export async function updateWorkspace(workspaceId: string, input: z.infer<typeof UpdateWorkspaceSchema>, actor: Actor) {
  const ws = await getWorkspace(workspaceId);
  const settings = input.settings ? WorkspaceSettingsSchema.parse({ ...ws.settings, ...input.settings }) : ws.settings;
  const raw = ((await db().workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { settings: true } })).settings ?? {}) as Record<string, unknown>;
  const internal = Object.fromEntries(INTERNAL_SETTINGS_KEYS.filter((k) => raw[k] !== undefined).map((k) => [k, raw[k]]));
  const updated = await db().workspace.update({
    where: { id: workspaceId },
    data: { name: input.name, timezone: input.timezone, senderLegalName: input.senderLegalName, postalAddress: input.postalAddress, settings: { ...settings, ...internal } as Prisma.InputJsonValue },
  });
  await audit(workspaceId, actor, 'workspace.updated', { type: 'workspace', id: workspaceId }, { fields: Object.keys(input) });
  return { ...updated, settings };
}

/**
 * "New workspace" from the workspace switcher. It is created inside an organization the user administers
 * (plan limits apply); someone with no such organization gets a new organization of their own instead.
 */
export async function createWorkspace(userId: string, name: string, actor: Actor, organizationId?: string) {
  const tenancy = await import('./tenancy.js');
  const admin = await db().organizationMember.findFirst({ where: { userId, role: { in: ['OWNER', 'ADMIN'] }, ...(organizationId ? { organizationId } : {}), organization: { status: { notIn: ['DELETED', 'DELETION_PENDING'] } } }, orderBy: { createdAt: 'asc' } });
  if (organizationId && !admin) throw Forbidden('You can only add workspaces to an organization you administer');
  if (admin) return tenancy.createOrgWorkspace(admin.organizationId, { name }, actor);
  const { workspace } = await tenancy.provisionTenant({ userId, organizationName: name });
  return workspace;
}

// ---------------------------------------------------------------- members & invitations

export async function listMembers(workspaceId: string) {
  const members = await db().workspaceMember.findMany({ where: { workspaceId }, include: { user: { select: { id: true, email: true, name: true, lastLoginAt: true, status: true } } }, orderBy: { createdAt: 'asc' } });
  const invitations = await db().workspaceInvitation.findMany({ where: { workspaceId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, email: true, role: true, expiresAt: true, createdAt: true } });
  return { members, invitations };
}

export async function changeRole(workspaceId: string, memberId: string, role: Role, actorRole: Role, actor: Actor) {
  const m = await db().workspaceMember.findFirst({ where: { id: memberId, workspaceId } });
  if (!m) throw NotFound('Member');
  if ((role === 'OWNER' || m.role === 'OWNER') && actorRole !== 'OWNER') throw Forbidden('Only owners can grant or change the owner role');
  if (m.role === 'OWNER' && role !== 'OWNER') {
    const owners = await db().workspaceMember.count({ where: { workspaceId, role: 'OWNER' } });
    if (owners <= 1) throw BadRequest('LAST_OWNER', 'A workspace must keep at least one owner');
  }
  const updated = await db().workspaceMember.update({ where: { id: m.id }, data: { role } });
  await audit(workspaceId, actor, 'member.role_changed', { type: 'member', id: m.id }, { from: m.role, to: role });
  return updated;
}

export async function removeMember(workspaceId: string, memberId: string, actorRole: Role, actor: Actor) {
  const m = await db().workspaceMember.findFirst({ where: { id: memberId, workspaceId } });
  if (!m) throw NotFound('Member');
  if (m.role === 'OWNER') {
    if (actorRole !== 'OWNER') throw Forbidden();
    const owners = await db().workspaceMember.count({ where: { workspaceId, role: 'OWNER' } });
    if (owners <= 1) throw BadRequest('LAST_OWNER', 'A workspace must keep at least one owner');
  }
  await db().workspaceMember.delete({ where: { id: m.id } });
  await audit(workspaceId, actor, 'member.removed', { type: 'member', id: m.id });
}

export async function createInvitation(workspaceId: string, email: string, role: Role, actorRole: Role, actor: Actor) {
  await (await import('./billing.js')).assertEntitled(workspaceId, 'users');
  await (await import('./tenancy.js')).assertEmailVerified(actor.userId);
  if (role === 'OWNER' && actorRole !== 'OWNER') throw Forbidden('Only owners can invite owners');
  const token = randomToken(24);
  const inv = await db().workspaceInvitation.create({
    data: { workspaceId, email: email.toLowerCase(), role, tokenHash: sha256(token), invitedById: actor.userId!, expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000) },
  });
  await audit(workspaceId, actor, 'member.invited', { type: 'invitation', id: inv.id }, { email, role });
  // The link is shown to the admin to share; no system mailer is required.
  return { id: inv.id, inviteUrl: `${process.env.APP_URL}/invite/${token}`, expiresAt: inv.expiresAt };
}

export async function revokeInvitation(workspaceId: string, id: string, actor: Actor) {
  await db().workspaceInvitation.updateMany({ where: { id, workspaceId }, data: { revokedAt: new Date() } });
  await audit(workspaceId, actor, 'member.invitation_revoked', { type: 'invitation', id });
}

export async function acceptInvitation(token: string, input: { name?: string; password?: string }, sessionUserId: string | null) {
  const inv = await db().workspaceInvitation.findUnique({ where: { tokenHash: sha256(token) } });
  if (!inv || inv.acceptedAt || inv.revokedAt || inv.expiresAt < new Date()) throw new AppError('INVITATION_INVALID', 'This invitation is invalid or expired', 400);
  let userId = sessionUserId;
  if (!userId) {
    const existing = await db().user.findUnique({ where: { email: inv.email } });
    if (existing) throw new AppError('LOGIN_REQUIRED', 'An account exists for this email. Log in first, then open the invitation link again.', 400);
    if (!input.name || !input.password) throw BadRequest('VALIDATION_FAILED', 'Name and password are required to create your account');
    const { validatePasswordStrength, hashPassword } = await import('./auth.js');
    validatePasswordStrength(input.password);
    const user = await db().user.create({ data: { email: inv.email, name: input.name, passwordHash: await hashPassword(input.password) } });
    userId = user.id;
  } else {
    const u = await db().user.findUnique({ where: { id: userId } });
    if (u?.email !== inv.email) throw new AppError('INVITATION_EMAIL_MISMATCH', `This invitation was sent to ${inv.email}`, 400);
  }
  const ws = await db().workspace.findUniqueOrThrow({ where: { id: inv.workspaceId }, select: { organizationId: true } });
  await db().$transaction([
    db().workspaceMember.upsert({ where: { workspaceId_userId: { workspaceId: inv.workspaceId, userId } }, update: { role: inv.role }, create: { workspaceId: inv.workspaceId, userId, role: inv.role } }),
    // Joining a workspace adds the person to that organization as a MEMBER only — it never grants other workspaces or tenants.
    db().organizationMember.upsert({ where: { organizationId_userId: { organizationId: ws.organizationId, userId } }, update: {}, create: { organizationId: ws.organizationId, userId, role: 'MEMBER' } }),
    db().workspaceInvitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date() } }),
  ]);
  await audit(inv.workspaceId, { type: 'USER', userId }, 'member.joined');
  return { workspaceId: inv.workspaceId, userId };
}

// ---------------------------------------------------------------- API keys

export async function createApiKey(workspaceId: string, input: { name: string; role: Role; expiresInDays?: number; scopes?: string[] }, actorRole: Role, actor: Actor) {
  if (!hasRole(actorRole, input.role)) throw Forbidden('Cannot create a key with a higher role than your own');
  const prefix = randomToken(6).replace(/[^a-zA-Z0-9]/g, 'x');
  const secret = randomToken(32).replace(/_/g, 'Z');
  const key = await db().apiKey.create({
    data: { workspaceId, name: input.name, prefix, keyHash: sha256(secret), role: input.role, scopes: [...new Set(input.scopes ?? [])], createdById: actor.userId ?? null, expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86400_000) : null },
  });
  await audit(workspaceId, actor, 'api_key.created', { type: 'api_key', id: key.id }, { name: input.name, role: input.role });
  return { id: key.id, name: key.name, role: key.role, token: `emn_${prefix}_${secret}`, note: 'Copy this key now. It will not be shown again.' };
}

export async function listApiKeys(workspaceId: string) {
  return db().apiKey.findMany({ where: { workspaceId }, select: { id: true, name: true, prefix: true, role: true, scopes: true, lastUsedAt: true, expiresAt: true, revokedAt: true, createdAt: true }, orderBy: { createdAt: 'desc' } });
}

export async function revokeApiKey(workspaceId: string, id: string, actor: Actor) {
  const r = await db().apiKey.updateMany({ where: { id, workspaceId, revokedAt: null }, data: { revokedAt: new Date() } });
  if (r.count === 0) throw NotFound('API key');
  await audit(workspaceId, actor, 'api_key.revoked', { type: 'api_key', id });
}

// ---------------------------------------------------------------- helpers shared with other services

export function encryptSecret(plain: string) { return keyring().encrypt(plain); }
export function decryptSecret(env: string) { return keyring().decrypt(env); }

export function unsubscribeToken(workspaceId: string, email: string, leadId?: string) {
  return signPayload(process.env.SESSION_SECRET ?? '', { w: workspaceId, e: email.toLowerCase(), l: leadId ?? null, t: Date.now() });
}
