---
title: Platform administration
section: Security & operations
order: 3
description: For Outvexa staff — tenants, plans, metrics, support access and the audit trail.
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

## Log in as a customer

Super admins can sign in as any customer account and do everything that person can: change settings, edit leads, build and launch campaigns, answer replies. Use it to fix something for a customer or to see exactly what they see.

- **Tenants → a tenant → Log in as owner** opens the owner's account. **Members → Log in as** opens any member, and **Workspaces → Open** opens one workspace. The same button is on **User accounts** and on each person's account page.
- Every time you need a **reason** and a **length** (15 minutes to 8 hours, capped by **Global settings → Security**). The session ends by itself; it is never extended.
- A **red bar** stays at the top while you are signed in as them. **Return to console**, or signing out, brings you back to your own account. That works even after the session ended.
- Their **password, two-factor and sessions** cannot be changed from inside; use their account page instead. The platform console is not reachable while you are signed in as someone else.
- Staff accounts and disabled accounts cannot be opened this way.
- **What is recorded:** the start, every change you make (`impersonation.write`, with the request) and the end go into the platform audit trail. The customer's own audit log shows that staff signed in, and every change carries `impersonatedBy`. If you lose the super admin role, open sessions stop working at once. **User accounts** lists open sessions, and any super admin can end them.

Use **Support access** instead when read-only viewing is enough.

## Account pages

Click a person in **User accounts** to see everything about their account: organizations and roles, workspace memberships, signed-in sessions with device and IP, API keys they created, their recent activity and every staff action on the account. From there you can:

- edit name, email, language and the email-verified flag
- send a password reset link
- turn off two-factor for someone who lost their device (they are signed out and can set it up again)
- end one session, or sign them out everywhere
- disable or enable the account
- log in as them

## Data explorer

**Data explorer** shows every table in the database with record counts, for all tenants or filtered to one tenant (or one workspace). Open a table to search, filter by any column, sort and page through records. Open a record to see every field, the records it belongs to and the related records pointing at it, and follow those links. A tenant's **All data** tab lists that tenant's tables and counts.

- **Edit** any field of a record and give a reason; the old and new values are recorded (`data.updated`). JSON fields and lists are edited as JSON.
- **Delete** a record with a reason; a copy of its values is kept in the audit trail (`data.deleted`). The delete is refused while other records still point at it.
- Viewing a single record is recorded too (`data.viewed`).
- **Never shown and never editable:** password hashes, session and reset tokens, API key hashes, encrypted mailbox and AI credentials, webhook secrets and two-factor secrets. Secret-looking keys inside JSON are masked.
- **Locked:** ids, the tenant a record belongs to, staff roles, two-factor and account status (use their own screens). Audit records cannot be changed. Users, organizations and workspaces cannot be deleted here; use tenant lifecycle and account screens.

Only super admins have the data explorer (`data:read`, `data:write`).

## Tenant profile and workspaces

On a tenant's page, **Edit** renames the organization or changes its time zone. In **Workspaces**, **Edit** renames, archives or restores a workspace (an organization always keeps one open workspace). Both need a reason.

## Global settings

Every group is saved with a reason, and the audit trail keeps the old and new values.

| Group | Setting | Effect |
|---|---|---|
| Branding | Product name, support email | Shown in the console, banners and notices |
| Sign-ups | Who can sign up | Server setting, open, or closed (staff can always create tenants) |
| | Plan for new organizations | Used when someone signs up without picking a plan (billing on) |
| | Organizations one person may own | Overrides `MAX_ORGS_PER_USER`; staff are exempt |
| Security | Minimum password length (8–128) | Applies to new passwords |
| | Idle days before sign-out (1–90) | Applies from each person's next sign-in |
| | Everyone must use two-factor | Workspaces refuse people without it until they set it up |
| | Longest "log in as" session | Caps every super admin "log in as" |
| Banners | Announcement | Banner for every signed-in user |
| | Maintenance mode | Customers can sign in and look but cannot change, send or import anything. Staff and "log in as" sessions are not blocked; sending queues and webhooks keep running |
