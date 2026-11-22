import { z } from 'zod';
import { route } from '../http/router.js';
import * as pa from '../services/platform-admin.js';

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
