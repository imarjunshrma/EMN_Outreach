import { z } from 'zod';
import { route, Paging, paged } from '../http/router.js';
import * as auth from '../services/auth.js';
import * as security from '../services/security.js';
import * as wsSvc from '../services/workspace.js';
import * as ops from '../services/ops.js';
import { ROLES } from '../../../shared/src/permissions.js';
import { ALL_QUEUE_NAMES, type QueueName } from '../core/queues.js';

const meta = (c: { req: { ip?: string; headers: Record<string, unknown> } }) => ({ ip: c.req.ip, userAgent: String(c.req.headers['user-agent'] ?? '') });
const RoleEnum = z.enum(ROLES as ['OWNER', 'ADMIN', 'MANAGER', 'MEMBER', 'VIEWER']);

// ---------------------------------------------------------------- auth
route({ method: 'get', path: '/auth/bootstrap', tag: 'Auth', summary: 'Whether the first admin account still needs to be created', auth: 'public',
  handler: async () => { const { db } = await import('../core/db.js'); const { registrationOpen } = await import('../services/tenancy.js'); return { needsSetup: (await db().user.count()) === 0, publicRegistration: await registrationOpen() }; } });
route({ method: 'post', path: '/auth/register', tag: 'Auth', summary: 'Create the first admin account (or register when public registration is enabled)', auth: 'public', rateLimit: { limit: 5, windowSec: 3600 },
  body: z.object({ email: z.string().email(), name: z.string().min(1).max(100), password: z.string().min(12).max(200), workspaceName: z.string().min(2).max(80) }),
  handler: (c) => auth.register(c.res, c.body, meta(c)) });
route({ method: 'post', path: '/auth/login', tag: 'Auth', summary: 'Log in with email + password (sets session cookie)', auth: 'public', rateLimit: { limit: 10, windowSec: 300 },
  body: z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), status: 200,
  handler: (c) => auth.login(c.res, c.body, meta(c)) });
route({ method: 'post', path: '/auth/mfa/verify', tag: 'Auth', summary: 'Second login step: TOTP or recovery code for an MFA challenge', auth: 'public', status: 200, rateLimit: { limit: 10, windowSec: 300 },
  body: z.object({ challenge: z.string().min(20).max(200), code: z.string().min(6).max(20) }), handler: (c) => security.completeMfaLogin(c.res, c.body.challenge, c.body.code, meta(c)) });
route({ method: 'post', path: '/auth/password/forgot', tag: 'Auth', summary: 'Email a single-use password reset link (same answer whether or not the account exists)', auth: 'public', status: 200, rateLimit: { limit: 5, windowSec: 900 },
  body: z.object({ email: z.string().email() }), handler: (c) => security.requestPasswordReset(c.body.email, c.req.ip) });
route({ method: 'post', path: '/auth/password/reset', tag: 'Auth', summary: 'Set a new password with a reset token (signs out all sessions)', auth: 'public', status: 200, rateLimit: { limit: 10, windowSec: 900 },
  body: z.object({ token: z.string().min(20).max(200), password: z.string().min(12).max(200) }), handler: (c) => security.resetPassword(c.body.token, c.body.password, c.req.ip) });
route({ method: 'get', path: '/auth/mfa', tag: 'Auth', summary: 'My two-factor status', auth: 'user', handler: (c) => security.mfaStatus(c.userId) });
route({ method: 'post', path: '/auth/mfa/setup', tag: 'Auth', summary: 'Start TOTP setup (secret + QR, not active until confirmed)', auth: 'user', status: 200, rateLimit: { limit: 10, windowSec: 900, key: 'user' }, handler: (c) => security.beginMfaSetup(c.userId) });
route({ method: 'post', path: '/auth/mfa/enable', tag: 'Auth', summary: 'Confirm TOTP setup with a code; returns recovery codes once', auth: 'user', status: 200, rateLimit: { limit: 10, windowSec: 900, key: 'user' },
  body: z.object({ code: z.string().length(6) }), handler: (c) => security.enableMfa(c.userId, c.body.code, c.actor) });
route({ method: 'post', path: '/auth/mfa/disable', tag: 'Auth', summary: 'Turn off two-factor (password + current code or recovery code)', auth: 'user', status: 200, rateLimit: { limit: 5, windowSec: 900, key: 'user' },
  body: z.object({ password: z.string().min(1), code: z.string().min(6).max(20) }), handler: (c) => security.disableMfa(c.userId, c.body.password, c.body.code, c.actor) });
route({ method: 'post', path: '/auth/logout', tag: 'Auth', summary: 'Log out (revokes session)', auth: 'user', status: 200, handler: async (c) => { await auth.logout(c.res, c.sessionId); return { ok: true }; } });
route({ method: 'get', path: '/auth/me', tag: 'Auth', summary: 'Current user, CSRF token and workspaces', auth: 'user', handler: (c) => auth.me(c.userId, c.sessionId) });
route({ method: 'post', path: '/auth/password', tag: 'Auth', summary: 'Change password (revokes other sessions)', auth: 'user', status: 200, rateLimit: { limit: 5, windowSec: 900, key: 'user' },
  body: z.object({ currentPassword: z.string(), newPassword: z.string().min(12).max(200) }),
  handler: async (c) => { await auth.changePassword(c.userId, c.sessionId, c.body, c.actor); return { ok: true }; } });
route({ method: 'get', path: '/auth/sessions', tag: 'Auth', summary: 'List my active sessions', auth: 'user', handler: (c) => auth.listSessions(c.userId) });
route({ method: 'delete', path: '/auth/sessions/:id', tag: 'Auth', summary: 'Revoke one of my sessions', auth: 'user', handler: async (c) => { await auth.revokeSession(c.userId, c.params.id); return { ok: true }; } });
route({ method: 'post', path: '/invitations/:token/accept', tag: 'Auth', summary: 'Accept a workspace invitation (creates account if needed)', auth: 'public', rateLimit: { limit: 10, windowSec: 600 }, status: 200,
  body: z.object({ name: z.string().max(100).optional(), password: z.string().max(200).optional() }),
  handler: async (c) => {
    const r = await wsSvc.acceptInvitation(c.params.token, c.body, c.userId || null);
    if (!c.userId) await auth.createSession(c.res, r.userId, meta(c), r.workspaceId);
    return r;
  } });

// ---------------------------------------------------------------- workspaces
route({ method: 'post', path: '/workspaces', tag: 'Workspaces', summary: 'Create a workspace', auth: 'user', body: z.object({ name: z.string().min(2).max(80) }), handler: (c) => wsSvc.createWorkspace(c.userId, c.body.name, c.actor) });
route({ method: 'get', path: '/w/:workspaceId', tag: 'Workspaces', summary: 'Workspace details & settings', auth: 'workspace', role: 'VIEWER', handler: (c) => wsSvc.getWorkspace(c.workspaceId) });
route({ method: 'patch', path: '/w/:workspaceId', tag: 'Workspaces', summary: 'Update workspace settings (sender identity, postal address, retention, providers)', auth: 'workspace', role: 'ADMIN', body: wsSvc.UpdateWorkspaceSchema, handler: (c) => wsSvc.updateWorkspace(c.workspaceId, c.body, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/dashboard', tag: 'Workspaces', summary: 'Overview dashboard counters', auth: 'workspace', role: 'VIEWER', handler: (c) => ops.dashboard(c.workspaceId) });
route({ method: 'get', path: '/w/:workspaceId/members', tag: 'Team', summary: 'Members and pending invitations', auth: 'workspace', role: 'VIEWER', handler: (c) => wsSvc.listMembers(c.workspaceId) });
route({ method: 'patch', path: '/w/:workspaceId/members/:memberId', tag: 'Team', summary: 'Change a member role', auth: 'workspace', role: 'ADMIN', body: z.object({ role: RoleEnum }), handler: (c) => wsSvc.changeRole(c.workspaceId, c.params.memberId, c.body.role, c.role, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/members/:memberId', tag: 'Team', summary: 'Remove a member', auth: 'workspace', role: 'ADMIN', handler: async (c) => { await wsSvc.removeMember(c.workspaceId, c.params.memberId, c.role, c.actor); return { ok: true }; } });
route({ method: 'post', path: '/w/:workspaceId/invitations', tag: 'Team', summary: 'Invite a member (returns a link to share)', auth: 'workspace', role: 'ADMIN', body: z.object({ email: z.string().email(), role: RoleEnum }), handler: (c) => wsSvc.createInvitation(c.workspaceId, c.body.email, c.body.role, c.role, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/invitations/:id', tag: 'Team', summary: 'Revoke an invitation', auth: 'workspace', role: 'ADMIN', handler: async (c) => { await wsSvc.revokeInvitation(c.workspaceId, c.params.id, c.actor); return { ok: true }; } });

// ---------------------------------------------------------------- API keys
route({ method: 'get', path: '/w/:workspaceId/api-keys', tag: 'API keys', summary: 'List API keys (secrets never returned)', auth: 'workspace', role: 'ADMIN', handler: (c) => wsSvc.listApiKeys(c.workspaceId) });
route({ method: 'post', path: '/w/:workspaceId/api-keys', tag: 'API keys', summary: 'Create an API key (shown once)', auth: 'workspace', role: 'ADMIN',
  body: z.object({ name: z.string().min(1).max(80), role: RoleEnum.default('MEMBER'), expiresInDays: z.number().int().min(1).max(730).optional(), scopes: z.array(z.string().regex(/^(\*|[a-z0-9-]+):(read|write|\*)$|^\*$/)).max(50).optional() }),
  handler: (c) => wsSvc.createApiKey(c.workspaceId, c.body, c.role, c.actor) });
route({ method: 'delete', path: '/w/:workspaceId/api-keys/:id', tag: 'API keys', summary: 'Revoke an API key', auth: 'workspace', role: 'ADMIN', handler: async (c) => { await wsSvc.revokeApiKey(c.workspaceId, c.params.id, c.actor); return { ok: true }; } });

// ---------------------------------------------------------------- notifications, logs, jobs
route({ method: 'get', path: '/w/:workspaceId/notifications', tag: 'Notifications', summary: 'My notifications', auth: 'workspace', role: 'VIEWER', handler: (c) => ops.listNotifications(c.workspaceId, c.userId) });
route({ method: 'post', path: '/w/:workspaceId/notifications/read', tag: 'Notifications', summary: 'Mark notifications read (all if ids omitted)', auth: 'workspace', role: 'VIEWER', status: 200, body: z.object({ ids: z.array(z.string().uuid()).optional() }), handler: async (c) => { await ops.markNotificationsRead(c.workspaceId, c.userId, c.body.ids); return { ok: true }; } });
route({ method: 'get', path: '/w/:workspaceId/audit-logs', tag: 'Logs', summary: 'Audit log', auth: 'workspace', role: 'ADMIN', query: Paging.extend({ action: z.string().optional(), actorUserId: z.string().uuid().optional(), entityType: z.string().optional() }),
  handler: async (c) => { const r = await ops.auditLogs(c.workspaceId, c.query); return paged(r.items, r.total, c.query.page, c.query.pageSize); } });
route({ method: 'get', path: '/w/:workspaceId/error-logs', tag: 'Logs', summary: 'Error log (API + worker)', auth: 'workspace', role: 'ADMIN', query: Paging.extend({ source: z.enum(['api', 'worker']).optional() }),
  handler: async (c) => { const r = await ops.errorLogs(c.workspaceId, c.query); return paged(r.items, r.total, c.query.page, c.query.pageSize); } });
route({ method: 'get', path: '/w/:workspaceId/jobs/queues', tag: 'Jobs', summary: 'Queue counts (all workspaces on this server)', auth: 'workspace', role: 'ADMIN', handler: () => ops.queueOverview() });
route({ method: 'get', path: '/w/:workspaceId/jobs/failed', tag: 'Jobs', summary: 'Failed jobs for a queue (this workspace)', auth: 'workspace', role: 'ADMIN', query: z.object({ queue: z.enum(ALL_QUEUE_NAMES as [QueueName, ...QueueName[]]) }), handler: (c) => ops.failedJobs(c.workspaceId, c.query.queue) });
route({ method: 'post', path: '/w/:workspaceId/jobs/retry', tag: 'Jobs', summary: 'Retry a failed job', auth: 'workspace', role: 'ADMIN', status: 200, body: z.object({ queue: z.enum(ALL_QUEUE_NAMES as [QueueName, ...QueueName[]]), jobId: z.string() }), handler: async (c) => { await ops.retryJob(c.workspaceId, c.body.queue, c.body.jobId, c.actor); return { ok: true }; } });
route({ method: 'get', path: '/w/:workspaceId/jobs/history', tag: 'Jobs', summary: 'Recorded job runs', auth: 'workspace', role: 'ADMIN', query: Paging.extend({ status: z.string().optional(), queue: z.string().optional() }),
  handler: async (c) => { const r = await ops.jobHistory(c.workspaceId, c.query); return paged(r.items, r.total, c.query.page, c.query.pageSize); } });

// ---------------------------------------------------------------- privacy & export
route({ method: 'get', path: '/w/:workspaceId/privacy/requests', tag: 'Privacy', summary: 'Data export / erasure requests', auth: 'workspace', role: 'ADMIN', handler: (c) => ops.listPrivacyRequests(c.workspaceId) });
route({ method: 'post', path: '/w/:workspaceId/privacy/requests', tag: 'Privacy', summary: 'Create an export or erasure request for one email address', auth: 'workspace', role: 'ADMIN', body: z.object({ type: z.enum(['EXPORT', 'ERASURE']), subjectEmail: z.string().email() }), handler: (c) => ops.createPrivacyRequest(c.workspaceId, c.body.type, c.body.subjectEmail, c.actor) });
route({ method: 'get', path: '/w/:workspaceId/privacy/requests/:id/download', tag: 'Privacy', summary: 'Download a completed export (JSON)', auth: 'workspace', role: 'ADMIN', raw: true,
  handler: async (c) => { const s = await ops.downloadPrivacyExport(c.workspaceId, c.params.id); c.res.setHeader('content-type', 'application/json'); c.res.setHeader('content-disposition', `attachment; filename="privacy-export-${c.params.id}.json"`); s.pipe(c.res); } });
route({ method: 'get', path: '/w/:workspaceId/export', tag: 'Privacy', summary: 'Full workspace data export (JSON)', auth: 'workspace', role: 'OWNER', raw: true, rateLimit: { limit: 3, windowSec: 3600, key: 'workspace' },
  handler: async (c) => { const data = await ops.workspaceExport(c.workspaceId, c.actor); c.res.setHeader('content-disposition', `attachment; filename="workspace-export.json"`); c.res.json(data); } });
