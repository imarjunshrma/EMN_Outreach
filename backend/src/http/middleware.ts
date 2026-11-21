import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { db } from '../core/db.js';
import { safeEqual, sha256 } from '../core/crypto.js';
import { AppError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { logError } from '../core/audit.js';
import type { Role } from '../../../shared/src/permissions.js';

export const SESSION_COOKIE = 'emn_session';
export const CSRF_COOKIE = 'emn_csrf';
const SESSION_IDLE_MS = 7 * 24 * 3600 * 1000;

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function requestId(req: Request, res: Response, next: NextFunction) {
  const id = (req.headers['x-request-id'] as string) || randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  // The API never serves HTML pages; deny everything a browser might try to execute from a response.
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  next();
}

/**
 * Resolves the caller from either the session cookie or an API key, enforces CSRF for
 * cookie-authenticated state-changing requests, and installs a membership resolver.
 */
export function authenticate(appUrl: string) {
  const allowedOrigin = new URL(appUrl).origin;
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.locals.auth = { userId: null, sessionId: null, apiKeyWorkspaceId: null, apiKeyRole: null };
      const authz = req.headers.authorization;
      if (authz?.startsWith('Bearer emn_')) {
        const token = authz.slice(7);
        const [, prefix, secret] = token.split('_');
        const key = prefix ? await db().apiKey.findUnique({ where: { prefix } }) : null;
        if (!key || !secret || key.revokedAt || (key.expiresAt && key.expiresAt < new Date()) || !safeEqual(key.keyHash, sha256(secret))) {
          throw new AppError('UNAUTHENTICATED', 'Invalid API key', 401);
        }
        res.locals.auth = { userId: key.createdById, sessionId: null, apiKeyWorkspaceId: key.workspaceId, apiKeyRole: key.role as Role, apiKeyScopes: key.scopes };
        res.locals.resolveMembership = async (wsId: string) => {
          if (wsId !== key.workspaceId) return null;
          const ws = await db().workspace.findUnique({ where: { id: wsId }, select: { organizationId: true, archivedAt: true, organization: { select: { status: true } } } });
          if (!ws || ws.archivedAt) return null;
          return { role: key.role as Role, organizationId: ws.organizationId, orgStatus: ws.organization.status, via: 'api_key' };
        };
        void db().apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);
        return next();
      }

      const cookies = parseCookies(req.headers.cookie);
      const raw = cookies[SESSION_COOKIE];
      if (raw) {
        const session = await db().session.findUnique({ where: { tokenHash: sha256(raw) }, include: { user: true } });
        const now = new Date();
        if (session && !session.revokedAt && session.expiresAt > now && session.user.status === 'ACTIVE') {
          // CSRF: double-submit header must match the session's token for unsafe methods.
          if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
            const header = String(req.headers['x-csrf-token'] ?? '');
            if (!header || !safeEqual(header, session.csrfToken)) throw new AppError('CSRF_FAILED', 'CSRF token missing or invalid', 403);
            const origin = req.headers.origin;
            if (origin && origin !== allowedOrigin && process.env.NODE_ENV === 'production') throw new AppError('CSRF_FAILED', 'Cross-origin request blocked', 403);
          }
          res.locals.auth = { userId: session.userId, sessionId: session.id, apiKeyWorkspaceId: null, apiKeyRole: null };
          // Access to a workspace comes ONLY from (1) a workspace membership, (2) being owner/admin of the
          // workspace's own organization, or (3) an active, audited support grant for that organization.
          // A workspace id in the URL is never proof of access by itself.
          res.locals.resolveMembership = async (wsId: string) => {
            if (!/^[0-9a-f-]{36}$/i.test(wsId)) return null;
            const ws = await db().workspace.findUnique({ where: { id: wsId }, select: { settings: true, organizationId: true, archivedAt: true, organization: { select: { status: true } } } });
            if (!ws) return null;
            const base = { organizationId: ws.organizationId, orgStatus: ws.organization.status, mfaMissing: !!(ws.settings as { requireMfa?: boolean } | null)?.requireMfa && !session.user.mfaEnabled };
            const m = await db().workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId: wsId, userId: session.userId } } });
            const om = await db().organizationMember.findUnique({ where: { organizationId_userId: { organizationId: ws.organizationId, userId: session.userId } } });
            if (ws.archivedAt && !(om && (om.role === 'OWNER' || om.role === 'ADMIN'))) return null;
            if (m) return { ...base, role: m.role as Role, via: 'member' };
            if (om?.role === 'OWNER') return { ...base, role: 'OWNER' as Role, via: 'org_owner' };
            if (om?.role === 'ADMIN') return { ...base, role: 'ADMIN' as Role, via: 'org_admin' };
            if (session.user.platformRole === 'SUPPORT' || session.user.platformRole === 'SUPER_ADMIN') {
              const grant = await db().supportAccessGrant.findFirst({ where: { organizationId: ws.organizationId, adminUserId: session.userId, revokedAt: null, expiresAt: { gt: new Date() } } });
              if (grant) return { ...base, role: 'VIEWER' as Role, via: 'support', supportGrantId: grant.id, mfaMissing: false };
            }
            return null;
          };
          res.locals.platformRole = session.user.platformRole ?? null;
          // Rolling expiry, at most once per hour
          if (now.getTime() - session.lastSeenAt.getTime() > 3600_000) {
            void db().session.update({ where: { id: session.id }, data: { lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_IDLE_MS) } }).catch(() => undefined);
          }
        }
      }
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = String(res.locals.requestId ?? '');
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details, requestId } });
    return;
  }
  const e = err as { code?: string; type?: string; status?: number; message?: string; name?: string; provider?: string };
  if (e?.name === 'ProviderError') {
    // External provider / URL-safety failures: never a 500, never leak credentials (messages are sanitized upstream).
    const invalidUrl = e.provider === 'fetcher';
    res.status(invalidUrl ? 400 : 502).json({ error: { code: invalidUrl ? 'VALIDATION_FAILED' : 'PROVIDER_ERROR', message: e.message, requestId } });
    return;
  }
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Malformed JSON body', requestId } });
    return;
  }
  if (e?.type === 'entity.too.large' || e?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: { code: 'VALIDATION_FAILED', message: 'Payload too large', requestId } });
    return;
  }
  if (e?.code === 'P2002') {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'A record with these values already exists', requestId } });
    return;
  }
  if (e?.code === 'P2025') {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource not found', requestId } });
    return;
  }
  logger.error({ err, requestId, path: req.path }, 'unhandled error');
  void logError('api', 'INTERNAL', (err as Error)?.message ?? 'unknown', { requestId, workspaceId: typeof req.params?.workspaceId === 'string' ? req.params.workspaceId : null, context: { path: req.path, method: req.method } });
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Unexpected server error', requestId } });
}
