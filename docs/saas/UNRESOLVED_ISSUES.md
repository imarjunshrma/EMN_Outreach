# Unresolved issues and limitations

Honest list of what is not done, not verified, or deliberately out of scope. Ordered by importance for a commercial launch.

## Requires live credentials (code exists, not verified live here)

| Item | What is needed |
|---|---|
| Stripe checkout, portal and webhooks | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, prices created, price ids entered on each plan; run a test-mode purchase end to end |
| Razorpay subscriptions and webhooks | `RAZORPAY_*` keys, plans created, plan ids on each plan |
| Verification / password-reset / notification emails | `SYSTEM_SMTP_URL` (transactional provider). Without it, verification links are not delivered and users stay unverified (SaaS mode blocks invitations/campaigns) |
| Gmail / Microsoft 365 mailboxes | OAuth client ids/secrets and app verification (Google restricted scopes require a security assessment for public SaaS) |
| Cloudflare DNS | Customer tokens; tested only with a fake adapter |
| OpenAI / Anthropic, Apollo, verifiers, search | Customer keys; tested with fakes |

## Incomplete

1. **Storage metering** — `storage_bytes` is defined and the storage adapters can measure usage, but nothing records it and `storageMb` is not enforced.
2. **Refunds** — refund/chargeback webhook events are ignored; no refunded state on invoices.
3. **Annual usage periods** — allowances are monthly for every plan; no annual pooling. Overage is a hard stop, not billed.
4. **Trial abuse** — a signed-in user can create additional organizations (`POST /workspaces` without an organization, or a new sign-up with another email), each with a new trial. Needs a per-user organization cap or trial-once policy.
5. **Seat billing** — plans limit users but price is flat per plan.
6. **Platform staff MFA** — not enforced for platform routes.
7. **DNS** — no zone record browser, no editing of existing records, Cloudflare only. Tracking-domain automation limited to the recommended CNAME.
8. **CRM connectors** — no native HubSpot/Pipedrive sync; webhooks + API are the integration path.
9. **Legal documents** — Terms, Privacy and AUP are drafts marked for lawyer review on the live pages.
10. **Organization-level custom roles** — four fixed roles; no custom roles.
11. **SSE** ignores tenant status (still membership-gated).
12. **Backups** — documented procedure only; no automated backup job or restore test.

## Not implemented (out of scope for this pass)

- Row-level security (evaluated, rejected — see the assessment).
- Load testing and capacity numbers. No claim of scale is made.
- External penetration test.
- Data residency choices per tenant.
- Moving a workspace between organizations (deliberately blocked by a trigger).

## Environment notes

- Runtime verification was performed in the Linux build VM (PostgreSQL 16, Redis 7, Chrome). The user's Mac runs the same code via `scripts/mac-dev.sh`; the new migration is applied there by `bash scripts/mac-dev.sh setup` or `npm run db:migrate`.
