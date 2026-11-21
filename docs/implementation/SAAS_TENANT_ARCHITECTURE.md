# SaaS and workspace isolation architecture

## Current model

The current schema has `User`, `Workspace`, and `WorkspaceMember`. A workspace is the customer-data ownership boundary: workspace-owned records carry `workspaceId`, and users receive access through an explicit membership and role. The current schema does **not** define a separate `Tenant`/organization entity. `User.isPlatformAdmin` is the platform-operator flag.

This supports isolation between workspaces. It does not by itself express one paying tenant that owns multiple workspaces. Treating each workspace as a tenant is the current application boundary, not proof that the requested Platform → Tenant → Workspace hierarchy is complete. Coordinate any parent tenant/subscription model with the parallel SaaS transformation before changing schema.

## Request authorization

The shared API router authenticates session cookies or API keys. Workspace routes resolve a membership for the path `workspaceId`, hide inaccessible workspaces as 404, apply role/MFA checks, and enforce API-key workspace and scopes. API keys cannot call `auth: user` routes; their creator ID exists for audit attribution only. Services still need to scope each record query by the authorized workspace because route membership alone does not validate a resource ID.

## Database protections

- Prisma schema and migrations contain no RLS enablement or policies.
- PostgreSQL pooled connections do not establish a tenant session variable for row policies.
- Isolation is application-level through scoped Prisma queries and foreign keys. Do not claim database-enforced RLS.
- Tests use three independently provisioned workspaces and attempt cross-workspace access, including a mailbox ID substitution. The test result is in `TESTING_AND_VERIFICATION.md`.

## Jobs, cache, and storage

- Queue payloads generally carry `workspaceId`; processors pass it to workspace-aware services. Review each new job producer/consumer pair and never rely on a resource ID alone.
- BullMQ uses a configurable `QUEUE_PREFIX`. Separate environments must also use separate Redis DBs or instances.
- File storage keys begin with a validated workspace UUID and reject path traversal. Authorization must be checked before a stored key is read or deleted.
- Redis rate-limit keys are resource scoped where the route declares a workspace key. Do not add shared cache keys for tenant data without including workspace identity.

## Remaining architecture work

1. Agree whether customer tenants can own multiple workspaces and how users inherit tenant membership.
2. Model tenant billing, entitlements, support access and audit scope consistently with that decision.
3. If RLS is required, introduce policies and transaction-local tenant context in a reviewed migration; pooled context must be reset safely. No such mechanism exists today.
4. Audit all service queries, worker handlers, exports, webhooks and storage operations against the agreed tenant boundary.
