# Integration and DNS design

## Credential ownership

| Credential | Owner | Storage |
|---|---|---|
| Gmail / Microsoft OAuth tokens, SMTP/IMAP passwords | Workspace (`EmailAccount`) | AES-256-GCM, never returned |
| OpenAI / Anthropic keys | Workspace (`AiProvider`) | Encrypted |
| Apollo, MillionVerifier, ZeroBounce, NeverBounce, Hunter, Brave, Serper, Smartlead, booking secret, Cloudflare token | Workspace (`Integration`) | Encrypted |
| Outbound webhook signing secrets | Workspace (`Webhook`) | Encrypted |
| Slack incoming-webhook URL | Workspace (notification channel) | Stored in channel config |
| Google/Microsoft OAuth **client** ids/secrets, Stripe/Razorpay keys, system SMTP, storage (S3) credentials | Platform | Environment only |

Every read of a tenant credential goes through `getSecret(workspaceId, type)` / scoped `findFirst`, so one tenant can never use another's credential. Plan allow-lists (`entitlements.integrations`) are checked when a credential is saved (`assertIntegration`). The platform console shows only type, enabled flag and last test result.

## Mailboxes

OAuth state is random, single-use, bound to the workspace and provider (`oauth:state:*`, 10 minutes). Tokens refresh under a per-account lock. The sending engine re-checks tenant status and monthly allowance before each send and meters on provider acceptance.

## DNS and domains

Domains belong to one workspace (`Domain.workspaceId`, unique per workspace).

| Capability | Implementation |
|---|---|
| Ownership verification | TXT `_emn-verify.<domain>` = `emn-verify=<token>`, checked against public resolvers |
| SPF / DKIM / DMARC / MX checks | `ops.runDomainCheck` (daily `domain.checkAll` job and on demand) |
| Recommended records | Per mailbox provider (Google, Microsoft, generic) |
| Cloudflare connection | Workspace integration `cloudflare` (token scoped to Zone:DNS:Edit) |
| Zone selection | Zone found by the domain name in that token's account |
| Record creation | `applyRecord`: only names inside the domain; placeholders refused; a second SPF record refused (409, with the existing one); explicit user action; audited `domain.dns_record_created` |
| Existing records | Never modified or deleted by the application |
| Propagation | `checkPropagation` queries 1.1.1.1, 8.8.8.8, 9.9.9.9 directly; acceptance by Cloudflare is not treated as propagation |
| Renewal reminders | Registrar and expiry date per domain, daily reminder job |

Not implemented: listing all records of a zone in the UI, editing existing records, providers other than Cloudflare, tracking-domain CNAME automation beyond the recommended record. See `UNRESOLVED_ISSUES.md`.

## Verification status

All provider adapters are real HTTP/SMTP/IMAP/DNS implementations; tests replace them with fakes **only** through `setAdapters` in the test harness. No live provider was contacted in this environment, so live behaviour is **not verified** here (requires credentials).
