import argon2 from 'argon2';
import type { Response } from 'express';
import { db } from '../core/db.js';
import { randomToken, sha256 } from '../core/crypto.js';
import { AppError, BadRequest, Unauthorized } from '../core/errors.js';
import { audit, type Actor } from '../core/audit.js';
import { CSRF_COOKIE, SESSION_COOKIE } from '../http/middleware.js';

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

export function hashPassword(pw: string) { return argon2.hash(pw, ARGON_OPTS); }
let dummyHash: Promise<string> | null = null;

export function validatePasswordStrength(pw: string) {
  if (pw.length < 12) throw BadRequest('WEAK_PASSWORD', 'Password must be at least 12 characters');
  if (!/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) throw BadRequest('WEAK_PASSWORD', 'Password must contain letters and numbers');
}

function cookieOpts(maxAgeMs: number, httpOnly: boolean) {
  const secure = (process.env.APP_URL ?? '').startsWith('https://');
  return { httpOnly, secure, sameSite: 'lax' as const, path: '/', maxAge: maxAgeMs };
}

export async function createSession(res: Response, userId: string, meta: { ip?: string; userAgent?: string }, activeWorkspaceId?: string) {
  const token = randomToken(32);
  const csrfToken = randomToken(24);
  const session = await db().session.create({
    data: { tokenHash: sha256(token), csrfToken, userId, activeWorkspaceId, ipAddress: meta.ip, userAgent: meta.userAgent?.slice(0, 300), expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
  });
  res.cookie(SESSION_COOKIE, token, cookieOpts(30 * 24 * 3600 * 1000, true));
  res.cookie(CSRF_COOKIE, csrfToken, cookieOpts(30 * 24 * 3600 * 1000, false));
  return { session, csrfToken };
}

export async function register(
  res: Response,
  input: { email: string; name: string; password: string; workspaceName: string },
  meta: { ip?: string; userAgent?: string },
) {
  validatePasswordStrength(input.password);
  const email = input.email.trim().toLowerCase();
  const passwordHash = await hashPassword(input.password);
  const tenancy = await import('./tenancy.js');
  const open = await tenancy.registrationOpen();
  const user = await db().$transaction(async (tx) => {
    // Serialize account creation so two simultaneous first registrations cannot both become admins.
    // Return a Prisma-decodable value: pg_advisory_xact_lock itself returns
    // PostgreSQL `void`, which Prisma 7's pg adapter cannot deserialize.
    await tx.$queryRaw`WITH registration_lock AS MATERIALIZED (SELECT pg_advisory_xact_lock(824623901174)) SELECT 1 FROM registration_lock`;
    const userCount = await tx.user.count();
    // Same policy as /auth/signup (REGISTRATION_OPEN, legacy PUBLIC_REGISTRATION, SaaS default).
    if (userCount > 0 && !open) throw new AppError('REGISTRATION_CLOSED', 'Registration is closed. Ask an admin for an invitation.', 403);
    if (await tx.user.findUnique({ where: { email } })) throw new AppError('CONFLICT', 'An account with this email already exists', 409);
    // First-run setup: the first account is the platform super-admin and owns the first tenant.
    const first = userCount === 0;
    return tx.user.create({ data: { email, name: input.name, passwordHash, isPlatformAdmin: first, platformRole: first ? 'SUPER_ADMIN' : null, emailVerifiedAt: first ? new Date() : null, termsAcceptedAt: new Date() } });
  });
  const { workspace } = await tenancy.provisionTenant({ userId: user.id, organizationName: input.workspaceName });
  const { csrfToken } = await createSession(res, user.id, meta, workspace.id);
  await audit(workspace.id, { type: 'USER', userId: user.id, ip: meta.ip }, 'auth.registered');
  return { user: publicUser(user), workspace, csrfToken };
}

export function publicUser(u: { id: string; email: string; name: string; isPlatformAdmin: boolean; createdAt: Date; mfaEnabled?: boolean; platformRole?: string | null; emailVerifiedAt?: Date | null }) {
  return { id: u.id, email: u.email, name: u.name, isPlatformAdmin: u.isPlatformAdmin || !!u.platformRole, platformRole: u.platformRole ?? null, createdAt: u.createdAt, mfaEnabled: !!u.mfaEnabled, emailVerified: !!u.emailVerifiedAt };
}

export async function login(res: Response, input: { email: string; password: string }, meta: { ip?: string; userAgent?: string }) {
  const email = input.email.trim().toLowerCase();
  const user = await db().user.findUnique({ where: { email } });
  // Always run a hash verification to keep timing similar for unknown users.
  dummyHash ??= hashPassword('dummy-password-for-timing-1');
  const ok = user ? await argon2.verify(user.passwordHash, input.password) : await argon2.verify(await dummyHash, input.password);
  if (!user || !ok || user.status !== 'ACTIVE') {
    await audit(null, { type: 'USER', ip: meta.ip }, 'auth.login_failed', undefined, { email });
    throw Unauthorized('Invalid email or password');
  }
  if (user.mfaEnabled) {
    // Password was right; a second factor is still required. No session yet.
    const { createMfaChallenge } = await import('./security.js');
    return { mfaRequired: true as const, challenge: await createMfaChallenge(user.id, meta.ip) };
  }
  const membership = await db().workspaceMember.findFirst({ where: { userId: user.id }, orderBy: { createdAt: 'asc' } });
  const { csrfToken } = await createSession(res, user.id, meta, membership?.workspaceId);
  await db().user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit(membership?.workspaceId ?? null, { type: 'USER', userId: user.id, ip: meta.ip }, 'auth.login');
  return { user: publicUser(user), csrfToken };
}

export async function logout(res: Response, sessionId: string | null) {
  if (sessionId) await db().session.update({ where: { id: sessionId }, data: { revokedAt: new Date() } }).catch(() => undefined);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.clearCookie(CSRF_COOKIE, { path: '/' });
}

export async function me(userId: string, sessionId: string | null) {
  const user = await db().user.findUnique({ where: { id: userId } });
  if (!user) throw Unauthorized();
  const tenancy = await import('./tenancy.js');
  const organizations = await tenancy.myOrganizations(userId);
  for (const o of organizations) if (o.status === 'PENDING_SETUP') await tenancy.ensureProvisioned(o.id, userId); // recover interrupted provisioning
  const session = sessionId ? await db().session.findUnique({ where: { id: sessionId } }) : null;
  return {
    user: publicUser(user),
    csrfToken: session?.csrfToken ?? null,
    organizations: organizations.map(({ workspaces, ...o }) => ({ ...o, workspaceIds: workspaces.map((w) => w.id) })),
    workspaces: organizations.flatMap((o) => o.workspaces.map((w) => ({ ...w, organizationId: o.id, organizationName: o.name, organizationStatus: o.status }))),
  };
}

export async function changePassword(userId: string, sessionId: string | null, input: { currentPassword: string; newPassword: string }, actor: Actor) {
  const user = await db().user.findUnique({ where: { id: userId } });
  if (!user || !(await argon2.verify(user.passwordHash, input.currentPassword))) throw BadRequest('INVALID_PASSWORD', 'Current password is incorrect');
  validatePasswordStrength(input.newPassword);
  await db().$transaction([
    db().user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(input.newPassword) } }),
    db().session.updateMany({ where: { userId, id: { not: sessionId ?? undefined }, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await audit(null, actor, 'auth.password_changed');
}

export async function listSessions(userId: string) {
  return db().session.findMany({ where: { userId, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, ipAddress: true, userAgent: true, createdAt: true, lastSeenAt: true }, orderBy: { lastSeenAt: 'desc' } });
}

export async function revokeSession(userId: string, id: string) {
  await db().session.updateMany({ where: { id, userId }, data: { revokedAt: new Date() } });
}
