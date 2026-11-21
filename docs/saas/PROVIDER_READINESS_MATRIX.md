# Provider readiness matrix — v1.4.0

Legend. **Impl** = real adapter code exists. **Unit** = covered by unit tests. **Mock** = exercised end to end against a fake provider in integration tests. **Sandbox** = verified against the provider's test/sandbox environment. **Real** = verified against a real account. **Prod** = verified in production.
No live or sandbox credentials were available in the build environment, so the Sandbox, Real and Prod columns are **not verified** for every provider. Nothing in this table is a claim of live verification.

| Provider | Impl | Unit | Mock | Sandbox | Real | Prod | Credentials needed | Known issues |
|---|---|---|---|---|---|---|---|---|
| Stripe (checkout, portal, webhooks, refunds, disputes, reconciliation) | Yes | Yes | Yes (FakeStripe; 8 v1.4 tests) | Not verified | Not verified | Not verified | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, price ids on each plan | Refund amounts in multi-currency setups untested |
| Razorpay (subscriptions, webhooks, refunds, disputes) | Yes | Yes | Fixtures only | Not verified | Not verified | Not verified | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, plan ids | Dispute event names follow Razorpay docs; untested live |
| System SMTP (verification, reset, notifications) | Yes | Yes | Yes (fake transport) | Not verified | Not verified | Not verified | `SYSTEM_SMTP_URL` | Without it users cannot verify email |
| Gmail OAuth mailboxes | Yes | Yes | Yes | Not verified | Not verified | Not verified | Google OAuth client id/secret; restricted-scope verification for public SaaS | Token revocation on tenant deletion not implemented |
| Microsoft 365 OAuth mailboxes | Yes | Yes | Yes | Not verified | Not verified | Not verified | Azure app registration id/secret | Same as Gmail |
| Generic SMTP/IMAP mailboxes | Yes | Yes | Yes | Not verified | Not verified | Not verified | Customer-supplied | — |
| Cloudflare DNS (list, create, edit, delete, verify) | Yes | Yes | Yes (FakeCloudflare incl. update/delete) | Not verified | Not verified | Not verified | Customer API token scoped to Zone:DNS:Edit | Only DNS provider implemented; others go through the `DnsProviderAdapter` interface |
| OpenAI / Anthropic (AI studio, copilot) | Yes | Yes | Yes | Not verified | Not verified | Not verified | Customer or platform API key | — |
| Apollo (prospecting) | Yes | Yes | Yes | Not verified | Not verified | Not verified | Customer key | — |
| Email verifiers | Yes | Yes | Yes | Not verified | Not verified | Not verified | Customer key | — |
| Web search enrichment | Yes | Yes | Yes | Not verified | Not verified | Not verified | Customer key | — |
| HubSpot / Pipedrive | **No** | — | — | — | — | — | — | Not implemented; webhooks + API are the integration path |
| Object storage (local disk adapter) | Yes | Yes | Yes | n/a | Verified in build VM | Not verified | none | No malware scanning of uploads |
| PostgreSQL / Redis | Yes | — | — | n/a | Verified in build VM (PG 16, Redis 7) | Not verified | `DATABASE_URL`, `REDIS_URL` | — |

## Safe live-testing checklist (do this in staging, not production)

1. Use **test-mode** keys only (Stripe `sk_test_…`, Razorpay test keys). Never point a staging deployment at live payment keys.
2. Create one test product/price per plan and paste the ids into the platform plan editor.
3. Point the webhook endpoint at staging (`/api/v1/webhooks/billing/stripe` or `/api/v1/webhooks/billing/razorpay`) and confirm the signature secret; send the provider's test events; confirm `BillingEvent` rows and subscription states in the tenant detail page.
4. Run a test checkout with a test card, then a test refund from the platform console, and confirm the invoice shows the refunded amount only after the webhook arrives.
5. Create a test dispute with the provider's dispute test card; confirm a lost dispute suspends the test organization.
6. For SMTP, use a sandbox inbox (for example a Mailtrap-style service) so verification mails never reach real people.
7. For mailbox OAuth, connect an internal test mailbox you own; send only to addresses you own. Do not import real prospects.
8. For DNS, use a throwaway test zone — **never production DNS** — and test create, edit (with the stale-edit check), and delete (with typed confirmation).
9. Record each verified provider, date and environment in this table; only then change "Not verified" to "Sandbox" or "Real".
