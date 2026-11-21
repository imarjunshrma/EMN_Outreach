---
title: Platform administration
section: Security & operations
order: 3
description: For EMN staff — tenants, plans, metrics, support access and the audit trail.
---
The platform console at `/platform` is visible only to users with a platform role. To everyone else it does not exist (`404`). **Staff must turn on two-factor sign-in** before any console screen or customer support access works, and cannot turn it off while they hold a platform role.

| Role | Can |
|---|---|
| Super admin | Everything: tenant lifecycle and subscription overrides, user accounts, refunds, plans, metrics, operations, support access, audit |
| Support | Read tenants, open audited read-only support access, read the audit trail |
| Finance | Read tenants, billing state, refunds, SaaS metrics and operations |

The first account created on a new installation becomes Super admin. Create further staff accounts with `npm run create-admin -- --email … --name … --workspace …`, or set a user's `platformRole` in the database.

## Tenants

**Tenants** lists every organization with its status, plan, owner, workspace and member counts. Search by name, slug or owner email and filter by status or plan. A tenant's page shows subscription, usage, workspaces, members, which integrations are configured (never their secrets) and the audit history.

### Lifecycle actions

Every action needs a written reason, is checked against the allowed status transitions, and is recorded.

| Action | Effect |
|---|---|
| Suspend | Read-only; sending, AI and automation stop. Survives payment events until reactivated. |
| Reactivate | Back to Active. The subscription still decides what the plan allows, so an expired trial stays limited until it is paid or overridden. |
| Cancel | Ends the subscription; read-only. |
| Schedule deletion | Starts the 14-day deletion grace period. |
| Restore | Cancels a scheduled deletion. |
| Purge now | Erases a tenant in deletion pending immediately. Irreversible. |

### Subscription overrides

Change a tenant's plan, status, trial end or grace period, or override individual entitlements (for a pilot customer, say). Overrides apply immediately and are recorded with the reason.

## User accounts

**User accounts** finds a person across all organizations. **Disable** signs them out of every session immediately and blocks sign-in (with a reason, audited); their organizations and data stay untouched. Only a super admin can disable another staff member, and nobody can disable themselves.

## Refunds and disputes

On a tenant's page, Finance and Super admins can refund a paid invoice in full or in part, optionally ending the subscription. A refund is requested from the payment provider with an idempotency key, so a double click never refunds twice, and is marked succeeded only when the provider confirms it. Chargebacks appear with their status; a lost chargeback suspends the tenant until staff reactivate it.

## Operations

**Operations** shows queue depths, jobs that failed every retry (dead letters) with their error, and failure counters for the last 24 hours (job attempts, customer webhook deliveries, out-of-order payment events, billing reconciliation). Super admins can retry a dead-lettered job after fixing the cause; each retry needs a reason and is audited.

## Plans

Plans are stored in the database, not in code. Create or edit a plan's name, description, monthly and yearly price, currency, trial length, visibility, limits, monthly allowances, features and allowed integrations, and its Stripe and Razorpay price ids. Archived plans disappear from the pricing page but existing subscribers keep them.

## SaaS metrics

| Metric | Definition |
|---|---|
| Tenants by status | Count of organizations in each status; the total excludes deleted ones |
| MRR | Sum of the monthly price (yearly ÷ 12) of Active subscriptions, and Past-due subscriptions still in their grace period, on priced plans, from a payment provider. Per currency; never converted |
| ARR | MRR × 12 |
| Manual MRR | The same for subscriptions activated by an admin rather than a provider — reported separately and not in MRR |
| Paying tenants | Tenants counted in MRR |
| New paid (30 days) | Tenants that moved to Active from Trial, Pending setup, Suspended or Cancelled |
| Churn (30 days) | Tenants that moved to Cancelled ÷ tenants that existed 30 days ago and were active, past due, suspended or cancelled |
| Collected (30 days) | Sum of paid invoices, per currency |

All metrics are computed from live data at request time. Nothing is estimated or sampled.

## Support access

The customer can see every grant — who, why, when and how many pages were viewed — under **Organization settings → Support access log**. While you are inside a customer workspace a red banner reminds you that access is read-only and recorded.

Open **Support → New grant**, choose the organization, write the reason (a ticket number and the problem) and the duration (up to 4 hours). You can then open that organization's workspaces read-only. The customer sees the grant in their audit log. End it early with **Revoke**.
