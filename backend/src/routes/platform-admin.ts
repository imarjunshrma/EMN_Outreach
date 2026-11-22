import { z } from 'zod';
import { route } from '../http/router.js';
import * as pa from '../services/platform-admin.js';
import * as imp from '../services/impersonation.js';
import * as dx from '../services/data-explorer.js';

// Super-admin back office: staff roles, tenant creation, tenant members, modules & limits, permission
// matrix, global settings. All writes require a reason and are recorded in the platform audit trail.

const tag = 'Platform';
const admin = (c: { userId: string; req: { ip?: string } }) => ({ userId: c.userId, ip: c.req.ip ?? null });
const ReasonBody = z.object({ reason: z.string().trim().min(5).max(500) });

route({ method: 'get', path: '/platform/staff', tag, summary: 'Platform staff and what each staff role may do', auth: 'platform', platformPermission: 'staff:manage', handler: () => pa.listStaff() });
route({ method: 'post', path: '/platform/staff', tag, summary: 'Give an existing account a platform role (reason required)', auth: 'platform', platformPermission: 'staff:manage', status: 200, body: pa.StaffAddSchema, handler: (c) => pa.addStaff(c.body, admin(c)) });
route({ method: 'put', path: '/platform/staff/:userId', tag, summary: 'Change or remove a platform role (not your own; the last super admin stays)', auth: 'platform', platformPermission: 'staff:manage', body: pa.StaffRoleSchema, handler: (c) => pa.setStaffRole(c.params.userId, c.body, admin(c)) });

route({ method: 'post', path: '/platform/tenants', tag, summary: 'Create a tenant: organization, first workspace and owner (new owners get a set-password link)', auth: 'platform', platformPermission: 'tenants:lifecycle', body: pa.CreateTenantSchema, rateLimit: { limit: 60, windowSec: 3600, key: 'user' }, handler: (c) => pa.createTenant(c.body, admin(c)) });
route({ method: 'get', path: '/platform/tenants/:id/members', tag, summary: 'Members of a tenant with organization and workspace roles', auth: 'platform', platformPermission: 'tenants:read', handler: (c) => pa.tenantMembers(c.params.id) });
route({ method: 'post', path: '/platform/tenants/:id/members', tag, summary: 'Add a person to a tenant (creates the account if needed)', auth: 'platform', platformPermission: 'tenants:lifecycle', body: pa.AddMemberSchema, handler: (c) => pa.addTenantMember(c.params.id, c.body, admin(c)) });
route({ method: 'put', path: '/platform/tenants/:id/members/:userId', tag, summary: "Change a member's organization role, including ownership transfer", auth: 'platform', platformPermission: 'tenants:lifecycle', body: pa.MemberRoleSchema, handler: (c) => pa.setTenantMemberRole(c.params.id, c.params.userId, c.body, admin(c)) });
route({ method: 'post', path: '/platform/tenants/:id/members/:userId/remove', tag, summary: 'Remove a member from a tenant', auth: 'platform', platformPermission: 'tenants:lifecycle', status: 200, body: ReasonBody, handler: (c) => pa.removeTenantMember(c.params.id, c.params.userId, c.body, admin(c)) });
route({ method: 'get', path: '/platform/tenants/:id/modules', tag, summary: 'Plan entitlements, overrides and effective modules/limits of a tenant', auth: 'platform', platformPermission: 'tenants:read', handler: (c) => pa.tenantModules(c.params.id) });
route({ method: 'put', path: '/platform/tenants/:id/modules', tag, summary: 'Turn modules on/off and override limits for one tenant (null = inherit plan)', auth: 'platform', platformPermission: 'tenants:lifecycle', body: pa.ModulesSchema, handler: (c) => pa.setTenantModules(c.params.id, c.body, admin(c)) });
route({ method: 'post', path: '/platform/users/:id/password-reset', tag, summary: 'Issue a password reset link for a user (mailed, or returned once when system mail is off)', auth: 'platform', platformPermission: 'tenants:lifecycle', status: 200, body: pa.ResetSchema, rateLimit: { limit: 30, windowSec: 3600, key: 'user' }, handler: (c) => pa.adminPasswordReset(c.params.id, c.body, admin(c)) });

route({ method: 'get', path: '/platform/permissions', tag, summary: 'Permission matrix: workspace roles per module (from the route rules), organization roles, staff roles', auth: 'platform', platformPermission: 'tenants:read', handler: async () => pa.permissionMatrix() });
route({ method: 'get', path: '/platform/settings', tag, summary: 'Global settings: sign-up mode and announcement banner', auth: 'platform', platformPermission: 'tenants:read', handler: () => pa.platformSettings() });
route({ method: 'put', path: '/platform/settings', tag, summary: 'Save global settings (reason required)', auth: 'platform', platformPermission: 'settings:write', body: pa.SettingsSchema, handler: (c) => pa.savePlatformSettings(c.body, admin(c)) });

route({ method: 'get', path: '/announcement', tag: 'Account', summary: 'Platform-wide announcement to show to signed-in users, if any', auth: 'user', handler: async () => ({ announcement: await pa.activeAnnouncement() }) });

// ------------------------------------------------------------------ public configuration
route({ method: 'get', path: '/public/config', tag: 'Account', summary: 'Product name, support email, password rule and maintenance notice (public)', auth: 'public', handler: () => pa.publicConfig() });

// ------------------------------------------------------------------ user accounts (360° view)
const adminS = (c: { userId: string; sessionId: string | null; req: { ip?: string } }) => ({ userId: c.userId, ip: c.req.ip ?? null, sessionId: c.sessionId });
route({ method: 'get', path: '/platform/users/:id', tag, summary: 'Everything about one account: memberships, sessions, API keys, activity and staff actions', auth: 'platform', platformPermission: 'tenants:read', handler: (c) => pa.userDetail(c.params.id) });
route({ method: 'put', path: '/platform/users/:id', tag, summary: 'Edit name, email, language or email-verified flag (reason required)', auth: 'platform', platformPermission: 'users:manage', body: pa.UserEditSchema, handler: (c) => pa.editUser(c.params.id, c.body, admin(c)) });
route({ method: 'post', path: '/platform/users/:id/mfa-reset', tag, summary: 'Turn off two-factor for a person who lost their device (signs them out)', auth: 'platform', platformPermission: 'users:manage', status: 200, body: pa.ReasonSchema, handler: (c) => pa.resetUserMfa(c.params.id, c.body, admin(c)) });
route({ method: 'post', path: '/platform/users/:id/sessions/revoke', tag, summary: 'Sign a person out of every browser', auth: 'platform', platformPermission: 'users:manage', status: 200, body: pa.ReasonSchema, handler: (c) => pa.revokeUserSessions(c.params.id, c.body, admin(c)) });
route({ method: 'post', path: '/platform/sessions/:id/revoke', tag, summary: 'End one session of any user', auth: 'platform', platformPermission: 'users:manage', status: 200, body: pa.ReasonSchema, handler: (c) => pa.revokeOneSession(c.params.id, c.body, adminS(c)) });

// ------------------------------------------------------------------ tenant profile and workspaces
route({ method: 'put', path: '/platform/tenants/:id/profile', tag, summary: 'Rename an organization or change its time zone (reason required)', auth: 'platform', platformPermission: 'tenants:lifecycle', body: pa.TenantProfileSchema, handler: (c) => pa.editTenantProfile(c.params.id, c.body, admin(c)) });
route({ method: 'put', path: '/platform/tenants/:id/workspaces/:workspaceId', tag, summary: 'Rename, archive or restore a workspace of a tenant (reason required)', auth: 'platform', platformPermission: 'tenants:lifecycle', body: pa.WorkspaceEditSchema, handler: (c) => pa.editTenantWorkspace(c.params.id, c.params.workspaceId, c.body, admin(c)) });

// ------------------------------------------------------------------ "log in as"
const meta = (c: { userId: string; sessionId: string | null; req: { ip?: string; headers: Record<string, unknown> } }) => ({ userId: c.userId, sessionId: c.sessionId, ip: c.req.ip ?? null, userAgent: String(c.req.headers['user-agent'] ?? '') });
route({ method: 'post', path: '/platform/users/:id/impersonate', tag, summary: 'Log in as this user: a time-limited session with full access, every change audited (reason required)', auth: 'platform', platformPermission: 'impersonate', status: 200, rateLimit: { limit: 60, windowSec: 3600, key: 'user' },
  body: imp.StartSchema, handler: (c) => imp.startImpersonation(c.req, c.res, c.params.id, c.body, meta(c)) });
route({ method: 'post', path: '/platform/tenants/:id/impersonate', tag, summary: 'Log in to a tenant as its owner (or the member given in userId)', auth: 'platform', platformPermission: 'impersonate', status: 200, rateLimit: { limit: 60, windowSec: 3600, key: 'user' },
  body: imp.StartSchema.extend({ userId: z.string().uuid().optional() }), handler: async (c) => {
    const org = await (await import('../core/db.js')).db().organization.findUnique({ where: { id: c.params.id }, select: { ownerId: true, status: true } });
    if (!org || org.status === 'DELETED') throw (await import('../core/errors.js')).NotFound('Organization');
    const userId = c.body.userId ?? org.ownerId;
    if (!userId) throw new (await import('../core/errors.js')).AppError('CONFLICT', 'This organization has no owner. Pick a member to log in as.', 409);
    return imp.startImpersonation(c.req, c.res, userId, c.body, meta(c), c.params.id);
  } });
route({ method: 'get', path: '/platform/impersonations', tag, summary: 'Open "log in as" sessions', auth: 'platform', platformPermission: 'impersonate', handler: () => imp.activeImpersonations() });
route({ method: 'delete', path: '/platform/impersonations/:id', tag, summary: 'End a "log in as" session', auth: 'platform', platformPermission: 'impersonate', handler: (c) => imp.endImpersonationSession(c.params.id, admin(c)) });
route({ method: 'post', path: '/auth/impersonation/stop', tag: 'Auth', summary: 'Leave a "log in as" session and return to your own account', auth: 'public', status: 200, rateLimit: { limit: 60, windowSec: 300 },
  handler: async (c) => (await imp.stopImpersonation(c.req, c.res)) ?? { restored: false, redirectTo: '/app', notImpersonating: true } });

// ------------------------------------------------------------------ data explorer
route({ method: 'get', path: '/platform/data', tag, summary: 'Every table with record counts, optionally for one tenant or workspace', auth: 'platform', platformPermission: 'data:read', query: dx.ModelsQuery, handler: (c) => dx.listModels(c.query) });
route({ method: 'get', path: '/platform/data/:model', tag, summary: 'Records of one table: search, filter by column, sort, page (secrets hidden)', auth: 'platform', platformPermission: 'data:read', query: dx.RowsQuery, handler: (c) => dx.listRows(c.params.model, c.query) });
route({ method: 'get', path: '/platform/data/:model/:recordId', tag, summary: 'One record with links to related records (viewing is audited)', auth: 'platform', platformPermission: 'data:read', handler: (c) => dx.getRow(c.params.model, c.params.recordId, admin(c)) });
route({ method: 'patch', path: '/platform/data/:model/:recordId', tag, summary: 'Change fields of a record (reason required; before/after audited)', auth: 'platform', platformPermission: 'data:write', body: dx.UpdateSchema, handler: (c) => dx.updateRow(c.params.model, c.params.recordId, c.body, admin(c)) });
route({ method: 'delete', path: '/platform/data/:model/:recordId', tag, summary: 'Delete a record (reason required; the record is kept in the audit trail)', auth: 'platform', platformPermission: 'data:write', body: dx.DeleteSchema, handler: (c) => dx.deleteRow(c.params.model, c.params.recordId, c.body, admin(c)) });
