---
title: Plans, usage & billing
section: Agencies & teams
order: 3
description: How trials, plans, limits, payments and cancellations work.
---
Billing lives at the organization level: **Organization settings → Billing**. Owners and members with the Billing role can change the plan, update the payment method and see invoices. Everyone else sees the plan and usage, but not invoices.

## Trial

New organizations start on a 14-day trial of the plan chosen at sign-up (Starter if none). When the trial ends without a paid plan, the organization becomes read-only: you can still sign in, read and export everything, and choose a plan.

Each person gets **one free trial**. A second organization created with the same email address (including Gmail addresses written with dots or a `+tag`) starts without a trial and asks for a plan. If you believe this is wrong, contact support — staff can grant a trial.

## Choose or change a plan

1. Open **Organization settings → Billing** and pick a plan and billing period.
2. Pay on the provider's secure page — Stripe for cards worldwide, Razorpay for India.
3. Your plan changes when the provider confirms the payment to our server. Returning to the app from the payment page is not, by itself, treated as proof of payment, so it can take up to a minute.

## Limits and allowances

| Kind | Examples | When reached |
|---|---|---|
| Limits | users, workspaces, mailboxes, running campaigns, leads | Adding one more is refused with `QUOTA_EXCEEDED`. |
| Monthly allowances | emails sent, AI spend, verifications, API calls, workflow runs | New work of that kind waits until the next month or an upgrade. |

Allowances reset on the first day of each calendar month (UTC), for monthly and yearly billing alike — unless your plan says its allowances are **pooled yearly**. On a pooled plan billed yearly, twelve months of allowance are available across the paid year, so a busy month can use more. **Organization settings → Usage** shows this month and the previous five.

### Storage

Files you upload (CSV imports, knowledge documents, exports) count toward your plan's storage, measured from the real file size. An upload that would go over the limit is refused with a clear message; delete old files or upgrade. Incoming email attachments and privacy-request exports are always stored, even when you are over the limit, so you never lose mail or miss a legal deadline.

### What counts

| Usage | Counted when |
|---|---|
| Email sent | The mailbox provider accepts the message. Failed attempts and retries do not count. |
| AI usage | A model call finishes; cost is estimated from the provider's token prices. |
| Verification | A provider returns a result for an address. |
| API call | A request authenticated with an API key reaches a workspace endpoint. |
| Workflow run | A workflow runs for real (test runs are free). |

## Failed payments

If a renewal fails, the organization becomes **Past due** and keeps working through a grace period (7 days by default). The provider retries the card. If payment does not arrive by the end of the grace period, the organization is suspended (read-only) until it is paid.

## Refunds

Refunds are issued by EMN billing staff on request, in full or in part, through the same payment provider you paid with. A refund shows on the invoice as soon as the provider confirms it. A full refund can also end the subscription immediately. Chargebacks (payment disputes) are recorded; if a dispute is lost, the organization becomes read-only until it is resolved with our billing team.

## Cancel

**Cancel subscription** stops renewal at the end of the paid period; you keep full access until then and can undo it. After it ends, the organization is read-only. To remove your data entirely, see [Export & deletion](/docs/data-export-deletion).
