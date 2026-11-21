---
title: Platform administration
section: Security & operations
order: 3
description: For EMN staff — tenants, plans, metrics, support access and the audit trail.
---
The platform console at `/platform` is visible only to users with a platform role. To everyone else it does not exist (`404`).

| Role | Can |
|---|---|
| Super admin | Everything: tenant lifecycle and subscription overrides, plans, metrics, support access, audit |
| Support | Read tenants, open audited read-only support access, read the audit trail |
| Finance | Read tenants, billing state and SaaS metrics |

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

Open **Support → New grant**, choose the organization, write the reason (a ticket number and the problem) and the duration (up to 4 hours). You can then open that organization's workspaces read-only. The customer sees the grant in their audit log. End it early with **Revoke**.
