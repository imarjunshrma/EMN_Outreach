# SaaS target architecture (implemented in v1.3)

```
Platform (EMN)            plans, platform roles, billing config, platform audit, support grants
└── Organization          tenant: owner, status, subscription, usage, settings, branding
    ├── OrganizationMember   OWNER | ADMIN | BILLING | MEMBER
    └── Workspace         team / brand / agency client (1..n by plan)
        ├── WorkspaceMember  OWNER | ADMIN | MANAGER | MEMBER | VIEWER
        └── 76 workspace-owned models (leads, campaigns, mailboxes, domains, AI, …)
```

## Decisions

1. **Each pre-existing workspace became its own organization** (org id = workspace id, owner = first workspace owner). This preserved every existing customer boundary exactly; nothing was merged.
2. **Organization is the commercial unit.** Subscription, invoices, usage, limits and billing owner live on the organization. Workspaces are operational units inside it.
3. **Agency support is one organization with many workspaces**, gated by the `agencyWorkspaces` feature and `maxWorkspaces`. No nested commercial tenants are created.
4. **Access derivation:** organization OWNER/ADMIN get implicit OWNER/ADMIN on all workspaces of their organization; everyone else only on workspaces they are members of. Accepting a workspace invitation creates an organization MEMBER row — never a higher role, never access to other workspaces.
5. **Platform staff are not tenant users.** `User.platformRole` (SUPER_ADMIN, SUPPORT, FINANCE) grants platform permissions; access to tenant data requires a time-boxed, audited, read-only support grant.

## Status model

| Status | Access | Entered by |
|---|---|---|
| PENDING_SETUP | full | Provisioning started |
| TRIAL | full | Provisioning with billing on |
| ACTIVE | full | Payment, or self-hosted mode |
| PAST_DUE | full (grace) | Failed renewal |
| SUSPENDED | read-only | Grace/trial expiry, platform action |
| CANCELLED | read-only | Cancellation |
| DELETION_PENDING | closed (billing/export/cancel allowed) | Owner or platform |
| DELETED | none | Purge |

Transitions are defined in `shared/src/tenancy.ts` (`ORG_TRANSITIONS`) and enforced by `setOrgStatus`, which records `OrganizationStatusChange` and a platform audit event.

## Configuration precedence

| Level | Examples | Stored in | Applies to |
|---|---|---|---|
| Platform | Plans, model prices, payment provider keys, system SMTP, `BILLING_ENABLED` | DB (`Plan`, `AiModelPrice`), environment | All tenants |
| Organization | Name, time zone, locale, currency, branding, billing owner, subscription overrides | `Organization` | Defaults for its workspaces, billing |
| Workspace | Sender identity, postal address, AI knowledge/rules/models/budgets, mailboxes, domains, integrations, webhooks, policies, custom fields | `Workspace.settings` and workspace-owned tables | That workspace only |
| User | Theme, 2FA, notification reads | Browser storage, `User`, `Notification` | That user |

Lower levels override higher ones only where a lower setting exists (a workspace time zone wins over the organization's). Nothing is ever inherited between organizations; there is no shared tenant-level template.

## Components added

| Concern | Location |
|---|---|
| Tenancy constants & transitions | `shared/src/tenancy.ts` |
| Plans & entitlements shape | `shared/src/plans.ts` |
| Tenant resolution, platform audit | `backend/src/core/tenant.ts` |
| Provisioning, sign-up, verification, members, workspaces, onboarding, deletion, status sync | `backend/src/services/tenancy.ts` |
| Entitlement engine | `backend/src/services/entitlements.ts` |
| Usage metering | `backend/src/services/usage.ts` |
| Billing (org-level) | `backend/src/services/billing.ts` |
| Platform console services | `backend/src/services/platform.ts` |
| Routes | `backend/src/routes/saas.ts` (+ router auth modes `org`, `platform`) |
| Worker gate & fair share | `worker/src/processors.ts` |
| DB guards | `scripts/generate-tenant-guards.ts` → `prisma/sql/002_tenant_guards.sql` |
| Website, docs, onboarding, org settings, platform console | `frontend/app/{page,features,pricing,security,legal,signup,verify-email,docs,onboarding,org,platform}`, `frontend/content/` |
