import { z } from 'zod';
import type { Request, Response } from 'express';
import { db } from '../core/db.js';
import { AppError, NotFound } from '../core/errors.js';
import { randomToken, sha256 } from '../core/crypto.js';
import { audit } from '../core/audit.js';
import { platformAudit } from '../core/tenant.js';
import { cfg } from '../core/platform-config.js';
import { ADMIN_RETURN_COOKIE, CSRF_COOKIE, SESSION_COOKIE, parseCookies } from '../http/middleware.js';
import { cookieOpts } from './auth.js';

// "Log in as": a super admin opens a real, time-limited session as a customer user and can do anything that user can,
// except change the user's own password, two-factor or sessions. Every change is recorded in the platform audit trail
// (impersonation.write) and in the tenant's own audit log (metadata.impersonatedBy), the customer's audit log shows
// when staff signed in, and the admin's own session is put back when they leave.

type Admin = { userId: string; sessionId: string | null; ip?: string | null; userAgent?: string };

export const StartSchema = z.object({
  reason: z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(500),
  /** Minutes until the session ends by itself (capped by Global settings → Security). */
  minutes: z.number().int().min(5).max(480).optional(),
  /** Open this workspace (it must be one the user can open). */
  workspaceId: z.string().uuid().optional(),
});

/** Workspaces the user can open: memberships, plus every workspace of organizations they own or administer. */
async function workspacesOf(userId: string, organizationId?: string) {
  const [members, orgs] = await Promise.all([
    db().workspaceMember.findMany({ where: { userId, workspace: { archivedAt: null, organization: { status: { not: 'DELETED' } }, ...(organizationId ? { organizationId } : {}) } }, select: { workspaceId: true, workspace: { select: { organizationId: true } } }, orderBy: { createdAt: 'asc' } }),
    db().organizationMember.findMany({ where: { userId, role: { in: ['OWNER', 'ADMIN'] }, organization: { status: { not: 'DELETED' } }, ...(organizationId ? { organizationId } : {}) }, select: { organizationId: true } }),
  ]);
  const ids = members.map((m) => ({ id: m.workspaceId, organizationId: m.workspace.organizationId }));
  if (orgs.length) {
    const more = await db().workspace.findMany({ where: { organizationId: { in: orgs.map((o) => o.organizationId) }, archivedAt: null }, select: { id: true, organizationId: true }, orderBy: { createdAt: 'asc' } });
    for (const w of more) if (!ids.some((x) => x.id === w.id)) ids.push(w);
  }
  return ids;
}

export async function startImpersonation(req: Request, res: Response, targetUserId: string, input: z.infer<typeof StartSchema>, admin: Admin, organizationId?: string) {
  if (!admin.sessionId) throw new AppError('FORBIDDEN', 'Sign in with your own account in the browser to use "log in as"', 403);
  const current = await db().session.findUnique({ where: { id: admin.sessionId }, select: { impersonatorId: true } });
  if (current?.impersonatorId) throw new AppError('CONFLICT', 'Return to your own account first', 409);
  if (targetUserId === admin.userId) throw new AppError('VALIDATION_FAILED', 'That is your own account', 400);
  const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!raw) throw new AppError('FORBIDDEN', 'Sign in with your own account in the browser to use "log in as"', 403);

  const user = await db().user.findUnique({ where: { id: targetUserId }, select: { id: true, email: true, name: true, status: true, platformRole: true } });
  if (!user) throw NotFound('User');
  if (user.status !== 'ACTIVE') throw new AppError('CONFLICT', 'That account is disabled. Enable it first.', 409);
  if (user.platformRole) throw new AppError('FORBIDDEN', 'You cannot sign in as another staff member', 403);

  const max = cfg().security.impersonationMaxMinutes;
  const minutes = Math.min(input.minutes ?? max, max);
  const open = await workspacesOf(user.id, organizationId);
  if (organizationId && !open.length) throw new AppError('CONFLICT', 'That person cannot open any workspace in this organization', 409);
  const target = input.workspaceId ? open.find((w) => w.id === input.workspaceId) : open[0];
  if (input.workspaceId && !target) throw new AppError('VALIDATION_FAILED', 'That person cannot open this workspace', 400);

  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const expiresAt = new Date(Date.now() + minutes * 60_000);
  const session = await db().session.create({ data: {
    tokenHash: sha256(token), csrfToken, userId: user.id, activeWorkspaceId: target?.id ?? null, ipAddress: admin.ip ?? null,
    userAgent: admin.userAgent?.slice(0, 300), expiresAt, impersonatorId: admin.userId, impersonationReason: input.reason,
  } });
  const keep = minutes * 60_000 + 3600_000;
  res.cookie(ADMIN_RETURN_COOKIE, raw, cookieOpts(keep, true));
  res.cookie(SESSION_COOKIE, token, cookieOpts(keep, true));
  res.cookie(CSRF_COOKIE, csrfToken, cookieOpts(keep, false));

  const orgId = target?.organizationId ?? organizationId ?? null;
  await platformAudit({ actorUserId: admin.userId, action: 'impersonation.started', organizationId: orgId, targetType: 'user', targetId: user.id, reason: input.reason, ip: admin.ip, metadata: { email: user.email, minutes, sessionId: session.id, workspaceId: target?.id ?? null } });
  if (target) await audit(target.id, { type: 'USER', userId: admin.userId, ip: admin.ip }, 'support.signed_in_as_user', { type: 'user', id: user.id }, { reason: input.reason, minutes, staff: true });
  return { user: { id: user.id, email: user.email, name: user.name }, workspaceId: target?.id ?? null, redirectTo: target ? `/w/${target.id}` : '/app', expiresAt, csrfToken };
}

/**
 * Ends a "log in as" session (even an expired one) and puts the super admin's own session back when it is still valid.
 * Returns null when the current session is not a "log in as" session.
 */
export async function stopImpersonation(req: Request, res: Response) {
  const cookies = parseCookies(req.headers.cookie);
  const raw = cookies[SESSION_COOKIE];
  const session = raw ? await db().session.findUnique({ where: { tokenHash: sha256(raw) }, select: { id: true, userId: true, impersonatorId: true, activeWorkspaceId: true, revokedAt: true } }) : null;
  if (!session?.impersonatorId) return null;
  if (!session.revokedAt) await db().session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });

  const back = cookies[ADMIN_RETURN_COOKIE];
  const own = back ? await db().session.findUnique({ where: { tokenHash: sha256(back) }, include: { user: { select: { status: true } } } }) : null;
  const restored = !!own && !own.revokedAt && own.expiresAt > new Date() && own.userId === session.impersonatorId && own.user.status === 'ACTIVE' && !own.impersonatorId;
  res.clearCookie(ADMIN_RETURN_COOKIE, { path: '/' });
  if (restored) {
    res.cookie(SESSION_COOKIE, back!, cookieOpts(30 * 24 * 3600 * 1000, true));
    res.cookie(CSRF_COOKIE, own!.csrfToken, cookieOpts(30 * 24 * 3600 * 1000, false));
  } else {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.clearCookie(CSRF_COOKIE, { path: '/' });
  }
  await platformAudit({ actorUserId: session.impersonatorId, action: 'impersonation.ended', targetType: 'user', targetId: session.userId, ip: req.ip, metadata: { sessionId: session.id, restored } });
  if (session.activeWorkspaceId) await audit(session.activeWorkspaceId, { type: 'USER', userId: session.impersonatorId, ip: req.ip }, 'support.signed_out_of_user', { type: 'user', id: session.userId }, { staff: true });
  return { restored, csrfToken: restored ? own!.csrfToken : null, redirectTo: restored ? `/platform/users/${session.userId}` : '/login' };
}

/** Open "log in as" sessions across the platform. */
export async function activeImpersonations() {
  const rows = await db().session.findMany({
    where: { impersonatorId: { not: null }, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' },
    select: { id: true, createdAt: true, expiresAt: true, lastSeenAt: true, impersonationReason: true, impersonatorId: true, user: { select: { id: true, email: true, name: true } } },
  });
  const staff = await db().user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.impersonatorId!))] } }, select: { id: true, email: true, name: true } });
  return rows.map((r) => ({ ...r, impersonator: staff.find((s) => s.id === r.impersonatorId) ?? null }));
}

export async function endImpersonationSession(sessionId: string, admin: { userId: string; ip?: string | null }) {
  const s = await db().session.findUnique({ where: { id: sessionId }, select: { id: true, impersonatorId: true, userId: true, revokedAt: true } });
  if (!s?.impersonatorId) throw NotFound('Session');
  if (!s.revokedAt) await db().session.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
  await platformAudit({ actorUserId: admin.userId, action: 'impersonation.ended_by_admin', targetType: 'user', targetId: s.userId, ip: admin.ip, metadata: { sessionId: s.id, openedBy: s.impersonatorId } });
  return { ok: true };
}
