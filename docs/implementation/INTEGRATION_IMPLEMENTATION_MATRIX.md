# Integration implementation matrix

“Implemented” means provider-specific request logic exists in source. It does not mean real connectivity is proven. Automated tests use deterministic mocks/fakes except local SMTP protocol tests.

| Provider | Source | Actual capability | Status/evidence |
|---|---|---|---|
| INT-01 OpenAI | `integrations/src/ai/openai.ts` | Structured Responses API, strict JSON schema | Mock adapter tests; credentials required; live BLOCKED |
| INT-02 Anthropic | `integrations/src/ai/anthropic.ts` | Messages API tool-use structured result | Mock adapter tests; credentials required; live BLOCKED |
| INT-03 Gmail OAuth/API | `integrations/src/email/gmail.ts` | PKCE OAuth/refresh, send, sync/history, reconciliation | Mock HTTP tests; live account/consent required |
| INT-04 Microsoft OAuth/Graph | `integrations/src/email/microsoft.ts` | OAuth, MIME send, delta sync, subscriptions | Mock HTTP tests; live tenant required |
| INT-05 SMTP/IMAP | `integrations/src/email/smtp-imap.ts` | SMTP send and IMAP sync | SMTP local protocol tests; no external mailbox |
| INT-06 Apollo | `integrations/src/providers/index.ts` | People search and enrich | Adapter implemented; mock; live key required |
| INT-07 MillionVerifier | `integrations/src/providers/index.ts` | Email verification | Adapter implemented; mock; live key/credits required |
| INT-08 ZeroBounce/NeverBounce | `integrations/src/providers/extra.ts` | Email verification waterfall | Adapters implemented; mock; live credentials required |
| INT-09 Hunter | `integrations/src/providers/extra.ts` | Email finder | Adapter implemented; mock; live key required |
| INT-10 Brave/Serper | `integrations/src/providers/index.ts` | Web search | Adapters implemented; mock; live key required |
| INT-11 Cloudflare | `integrations/src/providers/extra.ts` | Token, zone, list/create DNS records | Adapter implemented; mock; mutation retry regression now tested; no live DNS |
| INT-12 Local storage/S3 | `backend/src/core/storage.ts` | Filesystem/S3 object operations | Local/S3 adapter; mocks; no live bucket |
| INT-13 Stripe/Razorpay | `integrations/src/billing/gateways.ts` | Checkout/subscription/webhook signatures | Code + mocked tests; no real payment |
| INT-14 Smartlead | `integrations/src/providers/index.ts` | Lead export API | Adapter implemented; mocked; external operation not run |
| INT-15 System SMTP / Slack | `backend/src/core/mailer.ts; notification service` | Transactional notifications/channel webhooks | Configured in app/env; mock/fake paths; live sends prohibited |

## Shared adapter infrastructure

- `integrations/src/http.ts`: timeout, transient HTTP retry, Retry-After and typed ProviderError; malformed JSON currently throws parse error rather than a provider-specific parse error and is a known improvement item.
- `backend/src/core/container.ts`: production adapters wired centrally; tests replace via fakes.
- Secrets use application encryption keyring; external provider keys can be configured through workspace integrations.
- Send adapters explicitly avoid automatic send retries; DNS mutation now does too.
- Provider-specific pagination, consent, quotas, payload drift, and live error semantics remain blocked without controlled credentials.
