# Billing and usage report — v1.4.0

Design references: `SUBSCRIPTION_AND_BILLING.md`, `USAGE_METERING_AND_ENTITLEMENTS.md`. All payment tests use signed fixtures or an in-process **mocked** gateway; no real payment, refund or provider call was made.

## Lifecycle coverage

| Capability | Status | Test |
|---|---|---|
| Trial on sign-up, one per person (Gmail dots/+tags normalised, survives deletion) | Implemented, integration-tested | billing-v14 › trial abuse |
| Organization cap per person (`MAX_ORGS_PER_USER`, staff exempt) | Implemented, tested | billing-v14 › trial abuse |
| Checkout (Stripe Checkout / Razorpay subscription link) | Implemented; live not verified | workflows-billing (not-configured path) |
| Activation only from verified webhook | Verified | multi-tenant › billing; no redirect endpoint |
| Monthly and yearly intervals | Implemented | — |
| Upgrade/downgrade | Via new checkout or Stripe portal; plan mapped from price id | workflows-billing |
| Renewal / payment failure / grace / suspension | Verified | workflows-billing |
| Scheduled and immediate cancellation, resume | Implemented | — |
| Out-of-order events | Verified: older events cannot roll state back (`lastEventAt`) | billing-v14 |
| Duplicate events | Verified: `BillingEvent` unique id | workflows-billing, billing-v14 |
| Reconciliation with provider (every 6 h) | Verified with mocked provider | billing-v14 |
| Refunds — full/partial, idempotent, bounded, webhook-confirmed, dashboard refunds recorded, optional cancellation | Verified with mocked provider | billing-v14 |
| Disputes / chargebacks — recorded; lost → suspended (payment events do not lift it) | Verified | billing-v14 |
| Invoices and payment history | Implemented; refunded amounts tracked | billing-v14 |
| Plan changes do not alter history | Invoices store amounts at payment time; plans edit entitlements only | review |

## Usage and enforcement

| Metric | Counted when | Enforced |
|---|---|---|
| Emails sent | Provider accepted | Monthly (or pooled yearly) allowance, engine defers |
| AI requests / tokens / cost | Model call returned | AI USD allowance + workspace budgets |
| Verifications / finder calls | Result stored / provider answered | Allowance |
| API calls | API-key request reached a workspace route | Per-minute + monthly |
| Workflow runs | Non-test run started | Allowance |
| Storage | Real bytes of each stored object (v1.4) | `storageMb`, under a per-organization advisory lock; uploads refused (402), inbound mail and privacy exports never refused; daily reconcile against actual storage |
| Users, workspaces, mailboxes, running campaigns, leads | Live counts | Quotas (402) |

Idempotency: every metered event has a unique key per organization; 20 concurrent duplicates count once (tested). Storage: 4 concurrent 400 KB uploads against 1 MB → exactly 2 accepted (tested).

**Allowance policy (explicit):** monthly billing resets every calendar month (UTC). Yearly billing follows the plan's `allowancePeriod`: `monthly` (default, resets monthly) or `annual_pooled` (12 × monthly over the paid year). **Overage policy:** block with a clear 402 and an upgrade path; nothing is billed as overage and no data is removed.

## Known limits

- Live Stripe/Razorpay flows (checkout, portal, refunds, disputes, reconciliation) are untested against real accounts.
- Seat-based pricing is not modelled (flat plan prices with user limits).
- Trial abuse controls rely on email identity; they do not detect a person using unrelated email addresses (documented; payment-method fingerprinting not implemented).
