# Integration configuration and verification

Provider credentials are configured through environment variables or workspace-scoped encrypted credentials as described below. Never print `.env` or include secret values in logs or reports.

| Provider family | Configuration source | Implemented behavior | Local evidence | Live status |
|---|---|---|---|---|
| OpenAI / Anthropic | Workspace AI provider credentials | Structured generation, model routing, usage mapping | Mock HTTP adapter tests | Not live tested |
| Google / Microsoft mail | OAuth client env + workspace mailbox tokens | OAuth, send, sync adapters | Fake-provider integration tests | Not live tested |
| SMTP / IMAP | Workspace mailbox credentials | SMTP send and IMAP sync | Local SMTP protocol test server | No real mailbox used |
| Apollo / Hunter / verifier / search | Workspace integrations and provider keys | Search, discovery, verification, research adapters | Mock adapter tests | Not live tested |
| Cloudflare DNS | Workspace integration credential | Token check, zone lookup, record read and explicit TXT/CNAME create | Mock request/retry tests | No live DNS calls |
| Stripe / Razorpay | Server environment configuration | Checkout/cancel/webhook mapping | Deterministic gateway tests | No live payments |
| Local disk / S3 compatible | Environment storage configuration | Workspace-prefixed keys, local and S3 adapters | Local storage path tests | No remote bucket tested |
| System notification SMTP / Slack | Server configuration and notification channels | Operational notices and reports | Fake mailer/transport tests | Not live tested |

Mocked contract behavior is not provider connectivity. The exact setting names and provider-specific limitations are listed in `INTEGRATION_IMPLEMENTATION_MATRIX.md`, `.env.example`, and `INSTALLATION.md`. OAuth redirect URLs must match the configured public app URL. Never perform DNS changes, payments, prospect searches, or real email sends in the test environment.

## Safe local verification

Use only test credentials and isolated service endpoints. Start with `npm run test:unit`; run provider contract suites with mocked fetch adapters. For database-dependent flows, use `TEST_ENVIRONMENT.md`. Live connectivity should be performed only with dedicated sandbox provider accounts and recorded separately from mock evidence.
