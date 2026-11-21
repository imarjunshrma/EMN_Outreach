# Platform administration guide

The console is at `/platform`. Customer-facing documentation of the same features: `/docs/platform-admin`.

## Roles and permissions (`shared/src/tenancy.ts`)

| Permission | SUPER_ADMIN | SUPPORT | FINANCE |
|---|---|---|---|
| tenants:read | ✓ | ✓ | ✓ |
| tenants:lifecycle (suspend, reactivate, cancel, schedule/restore deletion, purge, subscription override) | ✓ | | |
| plans:write | ✓ | | |
| billing:read | ✓ | | ✓ |
| billing:refund | ✓ | | ✓ |
| support:access | ✓ | ✓ | |
| audit:read | ✓ | ✓ | |
| metrics:read | ✓ | | ✓ |

**Staff must have 2FA enabled.** Without it, every platform screen except the 2FA prompt is refused, and staff cannot turn 2FA off. Platform routes return **404** to anyone without the permission, including tenant owners. The first user of an installation becomes SUPER_ADMIN; more staff: `npm run create-admin -- --email … --name … --workspace …` (creates a SUPER_ADMIN who also owns an internal organization) or set `User.platformRole`.

## Screens

| Screen | Contents |
|---|---|
| Overview | Tenants by status, paying count, MRR/ARR per currency, manual MRR, collected (30 d), new/paid/churn (30 d), plan distribution, usage this month, failed jobs and errors (24 h), metric definitions |
| Tenants | Search (name, slug, owner email), status and plan filters, pagination |
| Tenant detail | Refund an invoice (FINANCE/SUPER_ADMIN), disputes, Status, reason, subscription, usage vs. limits, workspaces with counts, members (2FA / verification), integration and mailbox **status only**, status history, invoices, audit; lifecycle actions and subscription override (reason required) |
| Plans | Create/edit/archive; prices, currency, trial days, visibility, limits, features, integrations, provider price ids |
| Support access | Open a read-only grant (tenant, reason ≥ 10 chars, 15 min–4 h); list and end your grants; open the tenant's workspaces |
| User accounts | Search users across tenants; disable (signs them out everywhere) or re-enable, with a reason |
| Operations | Queue depth, failed jobs and dead letters; retry a failed job |
| Audit trail | Append-only platform events, filter by action prefix or organization |

## Metric definitions

Returned with every metrics response (`definitions`) and shown on the Overview. Summary: MRR counts ACTIVE subscriptions and PAST_DUE subscriptions within grace, on priced plans, from a payment provider, monthly price or yearly ÷ 12, per currency without conversion. Manual (admin-activated) subscriptions are reported separately and excluded from MRR and the paying count. Churn = tenants moved to CANCELLED in 30 days ÷ tenants that existed 30 days earlier in ACTIVE/PAST_DUE/SUSPENDED/CANCELLED. Nothing is estimated; an empty database shows zeros.

## Audited events

`tenant.registered`, `tenant.status.<status>`, `tenant.viewed`, `tenant.purge`, `organization.updated`, `organization.member_role_changed`, `organization.member_removed`, `organization.exported`, `workspace.created/archived`, `plan.created/updated/archived/unarchived`, `tenant.subscription_override`, `billing.webhook`, `support.grant_created/revoked`, `support.read` (one per request under a grant), `user.disabled/enabled`, `billing.refund_requested`, `tenant.trial_denied`, `domain.dns_record_created/updated/deleted` (workspace audit, with before/after). Deletion requests and cancellations appear as `tenant.status.deletion_pending` / `tenant.status.active` with the reason. The tenant also sees `support.access_granted` in its own audit log.

## Procedures

**Suspend for abuse:** Tenants → tenant → Suspend → reason. Running campaigns pause, the tenant becomes read-only, workers skip its costly jobs. Payment webhooks do not lift an admin suspension; use Reactivate.

**Investigate a ticket:** Support access → choose tenant, write ticket number and problem, pick the shortest duration → open the workspace link. Writes are blocked. End the grant when done.

**Pilot pricing:** Tenant → Override subscription → plan and status ACTIVE, reason. Appears as manual MRR.

**Refund:** Tenant → Invoices → Refund → amount and reason. The request is idempotent; the invoice shows the refund only after the provider's webhook confirms it. A lost dispute suspends the organization automatically.

**Disable a user:** User accounts → search → Disable → reason. All of the user's sessions end at once.

**Retry a failed job:** Operations → failed job → Retry. Jobs that time out are listed as dead letters.

**Delete on request:** Tenant → Schedule deletion (14-day grace) → Purge now only if the customer confirmed in writing.
