import type { Express, Request, Response } from 'express';
import { z, type ZodType } from 'zod';
import { hasRole, type Role } from '../../../shared/src/permissions.js';
import { AppError, Forbidden, NotFound, Unauthorized } from '../core/errors.js';
import { rateLimit } from '../core/redis.js';
import type { Actor } from '../core/audit.js';
import { db } from '../core/db.js';
import { platformAudit, platformMfaRequired } from '../core/tenant.js';
import { cfg } from '../core/platform-config.js';
import { ORG_ACCESS, PLATFORM_PERMISSIONS, orgCan, type OrgRole, type OrgStatus, type PlatformPermission, type PlatformRole } from '../../../shared/src/tenancy.js';

// Declarative route registry: one definition drives Express wiring, validation, RBAC,
// rate limiting and the generated OpenAPI document.

export type AuthMode = 'public' | 'user' | 'workspace' | 'org' | 'platform';
export type OrgPermission = 'view' | 'manage' | 'billing' | 'own';

export interface Ctx<B = unknown, Q = unknown> {
  req: Request;
  res: Response;
  body: B;
  query: Q;
  params: Record<string, string>;
  userId: string;
  workspaceId: string;
  role: Role;
  /** Tenant of the request, always derived server-side from membership — never from the client. */
  organizationId: string;
  orgRole: OrgRole | null;
  platformRole: PlatformRole | null;
  actor: Actor;
  requestId: string;
  sessionId: string | null;
}

export interface RouteDef<B = unknown, Q = unknown> {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string; // relative to /api/v1, e.g. "/w/:workspaceId/leads"
  tag: string;
  summary: string;
  auth: AuthMode;
  role?: Role;
  /** auth:'org' — required organization permission (default 'view'). */
  orgPermission?: OrgPermission;
  /** auth:'platform' — required platform permission. */
  platformPermission?: PlatformPermission;
  /** Allowed while the tenant is suspended/cancelled (read-only states): billing, export, account management. */
  allowWhenInactive?: boolean;
  /** Platform routes only: reachable by staff who have not turned on 2FA yet (so the console can tell them to). */
  allowWithoutMfa?: boolean;
  /** Personal AI subscriptions: only the configured owner account (AI_SUBSCRIPTION_OWNER_EMAILS). Everyone else gets 404; API keys never. */
  aiOwnerOnly?: boolean;
  body?: ZodType<B>;
  query?: ZodType<Q>;
  /** Optional parser run after authentication/tenant authorization and before body validation. */
  prepare?: (ctx: Ctx<any, any>) => Promise<void>;
  rateLimit?: { limit: number; windowSec: number; key?: 'ip' | 'user' | 'workspace'; timeoutMs?: number };
  /** If true the handler writes the response itself (streams, redirects, files). */
  raw?: boolean;
  status?: number;
  handler: (ctx: Ctx<B, Q>) => Promise<unknown>;
}

export const routes: RouteDef<any, any>[] = [];

/** Personal security settings stay with the person: a super admin signed in as them cannot change these. */
const IMPERSONATION_BLOCKED = new Set(['post /auth/password', 'post /auth/mfa/setup', 'post /auth/mfa/enable', 'post /auth/mfa/disable', 'delete /auth/sessions/:id']);
/** Still allowed in maintenance mode: signing in and out, and leaving a "log in as" session. */
const MAINTENANCE_ALLOWED = new Set(['/auth/login', '/auth/logout', '/auth/mfa/verify', '/auth/impersonation/stop', '/auth/password/forgot', '/auth/password/reset']);

export function route<B = unknown, Q = unknown>(def: RouteDef<B, Q>) {
  routes.push(def as RouteDef<any, any>);
  return def;
}

/** API-key scope for a route: "<tag>:read" for GET, "<tag>:write" otherwise (tag lower-cased, spaces → "-"). */
export function scopeOf(def: { tag: string; method: string }) {
  return `${def.tag.toLowerCase().replace(/[^a-z0-9]+/g, '-')}:${def.method === 'get' ? 'read' : 'write'}`;
}
export function scopeAllows(scopes: string[], def: { tag: string; method: string }) {
  const need = scopeOf(def);
  const [tag, op] = need.split(':');
  return scopes.some((s) => s === need || s === '*' || s === `*:${op}` || s === `${tag}:*` || (op === 'read' && (s === `${tag}:write` || s === '*:write')));
}

export function validationError(err: z.ZodError) {
  return new AppError('VALIDATION_FAILED', 'Validation failed', 400, err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
}

/** Path parameters that always name a database record (every model key is a UUID). */
const UUID_PARAMS = new Set(['id', 'batchId', 'leadId', 'memberId', 'organizationId', 'pid', 'userId', 'versionId', 'workspaceId']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A malformed record ID can never match a record: answer 404 instead of letting the database reject it (500). */
export function assertRecordParams(params: Record<string, string>) {
  for (const [k, v] of Object.entries(params)) if (UUID_PARAMS.has(k) && !UUID_RE.test(v)) throw NotFound('Resource');
}

export function mountRoutes(app: Express) {
  for (const def of routes) {
    const full = `/api/v1${def.path}`;
    app[def.method](full, async (req: Request, res: Response, next) => {
      try {
        const auth = res.locals.auth as { userId: string | null; sessionId: string | null; apiKeyWorkspaceId: string | null; apiKeyRole: Role | null; impersonatorId?: string | null } | undefined;
        const impersonatorId = auth?.impersonatorId ?? null;
        const requestId = String(res.locals.requestId ?? '');
        const ctx = {
          req, res, params: req.params as Record<string, string>, requestId,
          userId: auth?.userId ?? '', workspaceId: '', role: 'VIEWER' as Role, sessionId: auth?.sessionId ?? null,
          organizationId: '', orgRole: null as OrgRole | null, platformRole: (res.locals.platformRole ?? null) as PlatformRole | null,
          actor: { type: auth?.apiKeyWorkspaceId ? 'API' : 'USER', userId: auth?.userId ?? null, ip: req.ip, requestId, impersonatorUserId: impersonatorId } as Actor,
          body: undefined as unknown, query: undefined as unknown,
        };

        if (def.rateLimit) {
          const who = def.rateLimit.key === 'user' ? auth?.userId : def.rateLimit.key === 'workspace' ? String(req.params.workspaceId ?? '') : req.ip;
          const decision = rateLimit(`${def.method}:${def.path}:${who ?? req.ip}`, def.rateLimit.limit, def.rateLimit.windowSec);
          // Redis holds the counters. If it is unreachable, fail closed with a prompt 503 instead of waiting for it to
          // return (the client queues commands while reconnecting, so an unbounded wait hangs the request).
          const r = def.rateLimit.timeoutMs
            ? await boundedQuotaCheck(decision, def.rateLimit.timeoutMs, new AppError('IMPORT_ADMISSION_UNAVAILABLE', 'Upload admission is temporarily unavailable. Retry shortly.', 503))
            : await boundedQuotaCheck(decision, RATE_LIMIT_TIMEOUT_MS, new AppError('RATE_LIMIT_UNAVAILABLE', 'This action is temporarily unavailable. Retry shortly.', 503));
          res.setHeader('X-RateLimit-Remaining', String(Math.max(0, r.remaining)));
          if (!r.allowed) {
            res.setHeader('Retry-After', String(r.resetSec));
            throw new AppError('RATE_LIMITED', 'Too many requests, slow down', 429);
          }
        }

        if (def.auth !== 'public') {
          if (!auth?.userId && !auth?.apiKeyWorkspaceId) throw Unauthorized();
        }
        if (impersonatorId && IMPERSONATION_BLOCKED.has(`${def.method} ${def.path}`)) {
          throw new AppError('FORBIDDEN', "You are signed in as this person. Their password, two-factor and sessions can't be changed from here — use User accounts in the platform console.", 403);
        }
        // Maintenance mode: customers can look but not change anything. Staff, and staff signed in as a user, are not blocked.
        // Background work (sending, syncing, webhooks) is unaffected.
        const maintenance = cfg().maintenance;
        if (maintenance.enabled && def.method !== 'get' && !MAINTENANCE_ALLOWED.has(def.path) && !impersonatorId && !res.locals.platformRole
          && (def.auth !== 'public' || def.path.startsWith('/auth/'))) {
          throw new AppError('MAINTENANCE', maintenance.message || 'We are doing maintenance. You can look around, but changes are paused for a short while.', 503);
        }
        // API keys represent a workspace principal, even though authentication
        // stores their creator's user id for audit attribution. Never let that
        // attribution grant access to account, workspace-creation, or platform
        // administrator endpoints that require a user session.
        if (def.auth === 'user' && auth?.apiKeyWorkspaceId) throw Forbidden('API keys cannot access user-level endpoints');
        let viaSupport = false;
        if (def.auth === 'workspace') {
          const wsId = String(req.params.workspaceId ?? '');
          const membership = res.locals.resolveMembership ? await res.locals.resolveMembership(wsId) : null;
          if (!membership) throw new AppError('NOT_FOUND', 'Workspace not found', 404); // never reveal existence
          ctx.workspaceId = wsId;
          ctx.organizationId = membership.organizationId;
          ctx.role = membership.role;
          if (def.role && !hasRole(membership.role, def.role)) throw Forbidden();
          if (membership.mfaMissing) throw new AppError('MFA_REQUIRED', 'This workspace requires two-factor authentication. Turn it on under My account → Security.', 403);
          // Tenant lifecycle: suspended/cancelled tenants are read-only; tenants being deleted are closed.
          const access = ORG_ACCESS[membership.orgStatus as OrgStatus] ?? 'closed';
          const mutating = def.method !== 'get';
          if (access === 'closed' && !def.allowWhenInactive) throw new AppError('TENANT_INACTIVE', `This organization is ${String(membership.orgStatus).toLowerCase().replace(/_/g, ' ')}`, 403, { status: membership.orgStatus });
          if (access === 'readonly' && mutating && !def.allowWhenInactive) throw new AppError('TENANT_INACTIVE', `This organization is ${String(membership.orgStatus).toLowerCase()} — it is read-only until reactivated. Billing and exports remain available.`, 403, { status: membership.orgStatus });
          viaSupport = membership.via === 'support';
          if (membership.via === 'support') {
            if (mutating) throw new AppError('FORBIDDEN', 'Support access is read-only', 403);
            await platformAudit({ actorUserId: auth?.userId ?? null, action: 'support.read', organizationId: membership.organizationId, targetType: 'route', targetId: `${def.method.toUpperCase()} ${req.path}`.slice(0, 300), metadata: { grantId: membership.supportGrantId }, ip: req.ip });
          }
          const scopes = (res.locals.auth as { apiKeyScopes?: string[] } | undefined)?.apiKeyScopes;
          if (auth?.apiKeyWorkspaceId) await (await import('../services/billing.js')).countApiCall(wsId, requestId);
          if (scopes?.length && !scopeAllows(scopes, def)) throw new AppError('FORBIDDEN', `This API key lacks the scope ${scopeOf(def)}`, 403);
        }

        if (def.auth === 'org') {
          if (!auth?.userId || auth.apiKeyWorkspaceId) throw Unauthorized();
          const orgId = String(req.params.organizationId ?? '');
          const m = /^[0-9a-f-]{36}$/i.test(orgId) ? await db().organizationMember.findUnique({ where: { organizationId_userId: { organizationId: orgId, userId: auth.userId } }, include: { organization: { select: { status: true } } } }) : null;
          if (!m || m.organization.status === 'DELETED') throw new AppError('NOT_FOUND', 'Organization not found', 404);
          const role = m.role as OrgRole;
          const need = def.orgPermission ?? 'view';
          if (need !== 'view' && !orgCan[need](role)) throw Forbidden(need === 'billing' ? 'Only the owner or a billing manager can do this' : need === 'own' ? 'Only the organization owner can do this' : 'Only organization owners and admins can do this');
          const access = ORG_ACCESS[m.organization.status as OrgStatus];
          if (access !== 'full' && def.method !== 'get' && !def.allowWhenInactive) throw new AppError('TENANT_INACTIVE', `This organization is ${m.organization.status.toLowerCase().replace(/_/g, ' ')}`, 403, { status: m.organization.status });
          ctx.organizationId = orgId;
          ctx.orgRole = role;
        }
        if (def.auth === 'platform') {
          if (!auth?.userId || auth.apiKeyWorkspaceId) throw Unauthorized();
          const pr = res.locals.platformRole as PlatformRole | null;
          if (!pr || (def.platformPermission && !PLATFORM_PERMISSIONS[pr].includes(def.platformPermission))) throw new AppError('NOT_FOUND', 'Not found', 404); // platform area is invisible to tenants
          // Privileged staff must use two-factor sign-in unless PLATFORM_MFA_REQUIRED=false (private install, not production).
          if (!res.locals.mfaEnabled && !def.allowWithoutMfa && platformMfaRequired()) throw new AppError('MFA_REQUIRED', 'Platform staff must turn on two-factor authentication (My account → Security) before using the platform console.', 403, { platform: true });
          ctx.platformRole = pr;
        }

        if (def.aiOwnerOnly) {
          if (!auth?.userId || auth.apiKeyWorkspaceId || viaSupport) throw new AppError('NOT_FOUND', 'Not found', 404);
          const { isAiSubscriptionOwner } = await import('../services/ai-subscriptions.js');
          if (!(await isAiSubscriptionOwner(auth.userId))) throw new AppError('NOT_FOUND', 'Not found', 404);
        }

        // Every change made while signed in as someone else is recorded against the super admin.
        if (impersonatorId && def.method !== 'get') {
          await platformAudit({ actorUserId: impersonatorId, action: 'impersonation.write', organizationId: ctx.organizationId || null, targetType: 'route', targetId: `${def.method.toUpperCase()} ${req.path}`.slice(0, 300), metadata: { asUserId: auth?.userId ?? null }, ip: req.ip });
        }

        if (def.prepare) await def.prepare(ctx as Ctx<any, any>);

        assertRecordParams(ctx.params);
        if (def.body) {
          const parsed = def.body.safeParse(req.body ?? {});
          if (!parsed.success) throw validationError(parsed.error);
          ctx.body = parsed.data;
        }
        if (def.query) {
          const parsed = def.query.safeParse(req.query ?? {});
          if (!parsed.success) throw validationError(parsed.error);
          ctx.query = parsed.data;
        }

        const result = await def.handler(ctx as Ctx<any, any>);
        if (def.raw) return;
        res.status(def.status ?? (def.method === 'post' ? 201 : 200)).json(result ?? { ok: true });
      } catch (e) {
        next(e);
      }
    });
  }
}

/** Longest wait for a rate-limit decision before the request is refused with 503. */
const RATE_LIMIT_TIMEOUT_MS = 2_000;

async function boundedQuotaCheck(decision: ReturnType<typeof rateLimit>, timeoutMs: number, unavailable: AppError) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      decision.catch(() => { throw unavailable; }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Common query helpers
export const Paging = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export function paged<T>(items: T[], total: number, page: number, pageSize: number) {
  return { data: items, page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}

export const Uuid = z.string().uuid();
