---
title: Core concepts
section: Getting started
order: 3
description: Organizations, workspaces, roles, statuses and plans — the model behind every screen.
---
## Organizations

An organization is one customer of the platform. It has an owner, a status, a subscription and its own settings: name, time zone, locale, currency and branding. Everything you create belongs to exactly one organization, and the server checks that on every request — an id typed into a URL never gives access by itself.

### Organization roles

| Role | Can do |
|---|---|
| Owner | Everything, including deleting the organization and transferring ownership. One per organization. |
| Admin | Manage members, workspaces and settings; open every workspace. |
| Billing | Manage the subscription, payment method and invoices. |
| Member | Work in the workspaces they were added to. Sees no other workspace. |

Owners and admins automatically have full access to all workspaces of their organization. Everyone else has only the workspaces they were invited to.

## Workspaces

A workspace holds the actual work: leads, companies, campaigns, mailboxes, domains, AI knowledge and rules, workflows, reports and integrations. Records never cross workspaces, and the database rejects any attempt to link records from two different workspaces.

### Workspace roles

| Role | Can do |
|---|---|
| Owner / Admin | Configure the workspace: mailboxes, AI providers, integrations, policies, team. |
| Manager | Run campaigns, approve drafts and replies, manage leads. |
| Member | Work with leads, drafts and the inbox. |
| Viewer | Read-only access. |

## Organization status

| Status | What you can do |
|---|---|
| Trial / Active | Everything your plan includes. |
| Past due | Everything, during the grace period after a failed payment. |
| Suspended | Read and export your data; pay or contact support. Sending and AI stop. |
| Cancelled | Same as suspended, until you resubscribe or delete. |
| Deletion pending | Workspaces are closed. The owner can cancel the deletion from Organization settings during the grace period. |
| Deleted | Data erased. |

> [!note]
> Billing pages and data export always stay available, so you can pay or leave at any time.

## Plans and limits

Your plan sets limits (users, workspaces, mailboxes, running campaigns, leads) and monthly allowances (emails sent, AI spend, verifications, API calls, workflow runs). Limits are enforced on the server. When one is reached, the action is refused with the error `QUOTA_EXCEEDED` and a clear message; nothing already running is lost. See [Plans, usage & billing](/docs/billing).
