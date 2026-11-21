# Integrations review

| Integration | Source | Current classification |
|---|---|---|
| OpenAI | `integrations/src/ai/openai.ts` | Implemented, mock tested in adapter suite; real key/service not tested; credentials required |
| Anthropic | `integrations/src/ai/anthropic.ts` | Implemented, mock tested; real service not tested; credentials required |
| Gmail API / OAuth | `integrations/src/email/gmail.ts` | Implemented; mock HTTP tests; real OAuth/account not tested; credentials and consent required |
| Microsoft Graph / OAuth | `integrations/src/email/microsoft.ts` | Implemented; mock HTTP tests; real tenant not tested; credentials/consent required |
| SMTP/IMAP | `integrations/src/email/smtp-imap.ts` | Implemented; SMTP protocol tests use an in-process server, not live provider; IMAP live behavior not verified |
| Apollo | `integrations/src/providers/index.ts` | Adapter implemented; mock/fake tests; live API and plan requirements not verified |
| MillionVerifier / ZeroBounce / NeverBounce | `providers/index.ts`, `providers/extra.ts` | Adapters implemented; mock tests; credentials and live contract validation required |
| Hunter | `providers/extra.ts` | Adapter implemented; mock tests; live provider unverified |
| Brave / Serper | `providers/index.ts` | Search adapters implemented; live provider unverified |
| Smartlead | `providers/index.ts` | Export adapter implemented; live provider unverified |
| Cloudflare DNS | `providers/extra.ts` | DNS API adapter implemented; fake test coverage; no DNS writes performed |
| S3-compatible storage | `backend/src/core/storage.ts` | Adapter implemented; mock client coverage; no live bucket operation |
| Stripe / Razorpay | `integrations/src/billing/gateways.ts` | Gateway/webhook code implemented; mock tests; no live transaction (prohibited for this audit) |
| Local disk | `backend/src/core/storage.ts` | Implemented; filesystem runtime path not exercised here |

`integrations/src/http.ts` provides timeout, Retry-After and transient retry handling. Specific send methods use zero automatic retries to avoid duplicate sends. This is an adapter-level source observation, not a provider compatibility guarantee. No paid calls, outbound messages, DNS changes, or live credentials were used.
