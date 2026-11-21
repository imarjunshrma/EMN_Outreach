# SaaS database design

Migration: `prisma/migrations/20261121120000_v1_3_saas_tenancy/migration.sql` (additive) + `prisma/sql/002_tenant_guards.sql` (idempotent, re-applied by `npm run db:migrate`).

## New enums

| Enum | Values |
|---|---|
| `OrgStatus` | PENDING_SETUP, TRIAL, ACTIVE, PAST_DUE, SUSPENDED, CANCELLED, DELETION_PENDING, DELETED |
| `OrgRole` | OWNER, ADMIN, BILLING, MEMBER |
| `PlatformRole` | SUPER_ADMIN, SUPPORT, FINANCE |

## New tables

| Table | Key columns | Constraints / indexes |
|---|---|---|
| `Organization` | id, name, slug, status, statusReason, ownerId, billingOwnerId, timezone, locale, currency, branding (json), settings (json), onboarding (json), registrationKey, deletionRequestedAt, deletionScheduledFor, deletedAt | `slug` unique, `registrationKey` unique (sign-up idempotency), index on status |
| `OrganizationMember` | organizationId, userId, role | unique (organizationId, userId); cascade on organization delete |
| `OrganizationStatusChange` | organizationId, fromStatus, toStatus, reason, actorUserId, createdAt | append-only (UPDATE refused by trigger) |
| `UsageCounter` | organizationId, metric, periodStart, periodEnd, value (bigint) | unique (organizationId, metric, periodStart) |
| `UsageEvent` | organizationId, workspaceId?, metric, quantity, idempotencyKey, occurredAt | unique (organizationId, idempotencyKey) |
| `SupportAccessGrant` | organizationId, adminUserId, reason, scope, expiresAt, revokedAt | index (organizationId, expiresAt) |
| `PlatformAuditEvent` | actorUserId?, organizationId?, action, targetType, targetId, reason, metadata, ip, createdAt | append-only (UPDATE/DELETE refused unless the purge flag is set) |

## Changed tables

| Table | Change |
|---|---|
| `Workspace` | + `organizationId` NOT NULL (FK, immutable), `branding`, `archivedAt`; index on organizationId |
| `User` | + `termsAcceptedAt`, `termsVersion`, `platformRole`, `locale` (`isPlatformAdmin` kept for compatibility, mapped to SUPER_ADMIN) |
| `Plan` | + `description`, `isActive`, `sortOrder`, `archivedAt` |
| `Subscription` | + `organizationId` unique (one subscription per tenant), `scheduledPlanId`, `canceledAt`; `workspaceId` now optional (SET NULL) |
| `Invoice` | + `organizationId` NOT NULL; `workspaceId` optional; index (organizationId, createdAt) |

## Backfill (inside the migration, before NOT NULL)

1. One `Organization` per existing workspace: `id = workspace.id`, name and slug copied, owner = the first OWNER member, status from the workspace subscription (TRIALING→TRIAL, ACTIVE→ACTIVE, PAST_DUE→PAST_DUE, CANCELED→CANCELLED, none→ACTIVE).
2. `OrganizationMember` from `WorkspaceMember` (OWNER→OWNER, ADMIN→ADMIN, others→MEMBER).
3. `Subscription.organizationId` and `Invoice.organizationId` = workspaceId.
4. `User.platformRole = SUPER_ADMIN` where `isPlatformAdmin`.
5. A status-history row per organization ("migrated from v1.2").
6. `SET NOT NULL` on `Workspace.organizationId` and `Invoice.organizationId`.

Verified on the development database: 1 organization created, 0 workspaces without an organization, existing data untouched. The migration only adds columns/tables and fills them; no column or table is dropped.

## Guard triggers

See `TENANT_ISOLATION_DESIGN.md` §3. 40 tables, 72 guarded references. The generator reads the Prisma schema, so new relations are covered by re-running `node --import tsx scripts/generate-tenant-guards.ts`; a unit test fails if the SQL file is stale.

## Rollback

The migration is additive. To roll back the application to v1.2 the new tables and columns can stay in place (v1.2 ignores them), except that v1.2 expects `Invoice.workspaceId` to be filled, which it is for all migrated rows; invoices created by v1.3 for organizations with several workspaces carry no workspaceId.
