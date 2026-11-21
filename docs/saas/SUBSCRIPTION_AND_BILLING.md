# Subscription and billing

Billing belongs to the **organization**. `BILLING_ENABLED=true` turns on SaaS billing; otherwise the installation is self-hosted (unlimited entitlements, tenant status still enforced).

## Lifecycle

| Event | Subscription | Organization |
|---|---|---|
| Sign-up | TRIALING, `trialEndsAt = now + plan.trialDays` | TRIAL |
| Checkout started | `scheduledPlanId` set only | unchanged |
| Verified webhook: checkout completed / subscription active | ACTIVE, plan from the price id (or the scheduled plan), period end | ACTIVE |
| Upgrade / downgrade | New checkout or the Stripe portal; plan changes when the webhook's price id maps to a plan | unchanged |
| Renewal (`invoice.paid`) | ACTIVE, grace cleared, invoice upserted | ACTIVE |
| Payment failure (`invoice.payment_failed`) | PAST_DUE, `graceUntil = now + BILLING_GRACE_DAYS` (7), owner notified | PAST_DUE |
| Grace or trial expiry (`tenant.sync`, every 15 min) | unchanged | SUSPENDED (read-only) |
| Scheduled cancellation | `cancelAtPeriodEnd = true` (Stripe); resume possible | unchanged |
| Cancellation (immediate or at period end via webhook) | CANCELED | CANCELLED |
| Reactivation | ACTIVE via payment, or platform override | ACTIVE |
| Admin suspension | unchanged | SUSPENDED with `settings.adminSuspended` (payment webhooks do not lift it) |

`syncFromSubscription` maps subscription state to organization status after every webhook. Refunds are **not** modelled (see `UNRESOLVED_ISSUES.md`).

## Payment providers

| Provider | Checkout | Webhook verification | Dedupe |
|---|---|---|---|
| Stripe | Checkout Session (`mode=subscription`), customer portal | `Stripe-Signature` `t=…,v1=…` HMAC-SHA256 of `t.body`, 5-minute tolerance | `BillingEvent(provider, eventId)` unique |
| Razorpay | Subscriptions API (`short_url`) | `X-Razorpay-Signature` HMAC-SHA256 of the raw body | `x-razorpay-event-id` / payload id |

Both send our organization id in metadata (`organizationId`, and `workspaceId` for older checkouts). Webhooks are mounted before the JSON parser to keep the raw body, and are rate-limited per IP.

**A browser redirect is never proof of payment.** The success URL (`/org/<id>?tab=billing&checkout=success`) only shows a notice; there is no endpoint that activates a plan from a redirect (asserted in `multi-tenant.test.ts`).

## Billing ownership and access

- `Organization.billingOwnerId` (defaults to the owner) receives payment emails.
- Checkout, portal, cancel and resume require org role OWNER or BILLING. Invoices are returned only to those roles. Other members see plan, status and usage.
- Platform FINANCE/SUPER_ADMIN see billing state, invoices and subscription data; provider secrets are environment-only and never exposed.

## Tests (fixtures only — no live payment)

`tests/integration/workflows-billing.test.ts` (Stripe signature, dedupe, PAST_DUE grace, invoice, Razorpay HMAC, platform override, PROVIDER_NOT_CONFIGURED), `tests/integration/multi-tenant.test.ts` (webhook activates only the named tenant). Gateways are constructed with fixture secrets via `setGatewaysForTests`; no network call is made.

## Live setup (requires credentials)

Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RAZORPAY_*`, create prices in the providers, and enter their ids on each plan in the platform console. Not verified live in this environment.
