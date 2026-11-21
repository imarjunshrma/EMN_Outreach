// Tenant (organization) lifecycle: statuses, allowed transitions and what each status permits.
// Shared by the API, the worker and the UI so the rules exist in exactly one place.

export const ORG_STATUSES = ['PENDING_SETUP', 'TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'DELETION_PENDING', 'DELETED'] as const;
export type OrgStatus = (typeof ORG_STATUSES)[number];

export const ORG_TRANSITIONS: Record<OrgStatus, OrgStatus[]> = {
  PENDING_SETUP: ['TRIAL', 'ACTIVE', 'CANCELLED', 'DELETION_PENDING'],
  TRIAL: ['ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELLED', 'DELETION_PENDING'],
  ACTIVE: ['PAST_DUE', 'SUSPENDED', 'CANCELLED', 'DELETION_PENDING', 'TRIAL'],
  PAST_DUE: ['ACTIVE', 'SUSPENDED', 'CANCELLED', 'DELETION_PENDING'],
  SUSPENDED: ['ACTIVE', 'TRIAL', 'PAST_DUE', 'CANCELLED', 'DELETION_PENDING'],
  CANCELLED: ['ACTIVE', 'TRIAL', 'SUSPENDED', 'DELETION_PENDING'],
  DELETION_PENDING: ['ACTIVE', 'CANCELLED', 'SUSPENDED', 'DELETED'],
  DELETED: [],
};

export const canTransition = (from: OrgStatus, to: OrgStatus) => from === to || ORG_TRANSITIONS[from].includes(to);

/**
 * Access level per status:
 *  - full:     everything the plan allows
 *  - readonly: read, export, billing and account management only — no sending, AI, imports or edits
 *  - closed:   only the owner may cancel a pending deletion or download an export
 */
export const ORG_ACCESS: Record<OrgStatus, 'full' | 'readonly' | 'closed'> = {
  PENDING_SETUP: 'full', TRIAL: 'full', ACTIVE: 'full', PAST_DUE: 'full',
  SUSPENDED: 'readonly', CANCELLED: 'readonly', DELETION_PENDING: 'closed', DELETED: 'closed',
};

export const ORG_ROLES = ['OWNER', 'ADMIN', 'BILLING', 'MEMBER'] as const;
export type OrgRole = (typeof ORG_ROLES)[number];
export const ORG_ROLE_RANK: Record<OrgRole, number> = { MEMBER: 0, BILLING: 1, ADMIN: 2, OWNER: 3 };
/** BILLING is a side permission: billing managers see billing but cannot administer the organization. */
export const orgCan = {
  manage: (r: OrgRole) => r === 'OWNER' || r === 'ADMIN',
  billing: (r: OrgRole) => r === 'OWNER' || r === 'BILLING',
  own: (r: OrgRole) => r === 'OWNER',
};

export const PLATFORM_ROLES = ['SUPER_ADMIN', 'SUPPORT', 'FINANCE'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
export type PlatformPermission = 'tenants:read' | 'tenants:lifecycle' | 'plans:write' | 'billing:read' | 'support:access' | 'audit:read' | 'metrics:read';
export const PLATFORM_PERMISSIONS: Record<PlatformRole, PlatformPermission[]> = {
  SUPER_ADMIN: ['tenants:read', 'tenants:lifecycle', 'plans:write', 'billing:read', 'support:access', 'audit:read', 'metrics:read'],
  SUPPORT: ['tenants:read', 'support:access', 'audit:read'],
  FINANCE: ['tenants:read', 'billing:read', 'metrics:read'],
};

/** Metered resources (period-based) and counted resources (current totals). */
export const USAGE_METRICS = ['email_sends', 'ai_requests', 'ai_tokens', 'ai_cost_micro_usd', 'enrichments', 'api_calls', 'workflow_runs', 'storage_bytes'] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

export const ONBOARDING_STEPS = [
  { id: 'organization', label: 'Organization details', optional: false },
  { id: 'business', label: 'Business profile', optional: false },
  { id: 'team', label: 'Invite your team', optional: true },
  { id: 'ai', label: 'AI provider', optional: true },
  { id: 'mailbox', label: 'Connect a mailbox', optional: true },
  { id: 'domain', label: 'Sending domain & DNS', optional: true },
  { id: 'leads', label: 'Import leads', optional: true },
  { id: 'campaign', label: 'First campaign', optional: true },
] as const;
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]['id'];
