# 13 — Risks, gaps and open questions (v1.0.0)

## Provider and platform risks
| Risk | Impact | Mitigation in the build | What you must do |
|---|---|---|---|
| Google restricted scope (`gmail.modify`) | External OAuth apps need verification + a security assessment | Works without verification for an **Internal** app in your own Workspace | Use Internal for your own domains. Budget time and money for verification before onboarding other organisations' mailboxes. |
| Microsoft tenant consent | Some tenants (incl. reseller-managed ones) block user consent | Clear OAuth error page; mailbox marked NEEDS_REAUTH on 401 | The tenant admin grants consent. Rotate the client secret before it expires. |
| Provider API changes (Apollo, MillionVerifier, Brave, Serper, Smartlead) | Adapters break | Adapters are isolated; Apollo search path is configurable; errors surface as `PROVIDER_ERROR` | Run "Test" in Settings → Integrations after any provider change. Check each provider's current terms. |
| AI model behaviour | Real models may produce schema-invalid output more often than the fakes | One repair retry, then fallback provider, then a clear failure (nothing is sent) | Live-test drafting with your keys. Keep the fact-check requirement on. |
| Deliverability | Low inbox placement, blocklisting | Conservative defaults, spacing, windows, auto-pause on bounces, DNS checks, one-click unsubscribe, no tracking by default | Authenticate domains (SPF/DKIM/DMARC). Use separate sending domains if you choose. Start small and watch the metrics. **Nothing guarantees inbox placement.** |
| Complaint visibility | Mailbox providers don't send feedback-loop reports for individual senders | Complaint keywords in replies, manual complaint entry, auto-pause on the first complaint | Watch Google Postmaster Tools for your domain. |
| Single server | Hardware or disk loss | Nightly backups, documented restore, release rollback | Copy backups off-server. Test a restore. |

## Legal (not legal advice)
- The compliance module enforces the rules you configure: country allow/deny, accepted lawful bases, postal address, unsubscribe link, suppression. Its defaults are conservative:
  - CA, AU and EU/EEA are **off**
  - unknown countries are blocked
  - US, UK and IN are on, each with its listed lawful bases
- These are technical safeguards. They do not decide whether a given campaign is lawful. A publicly listed business email does not by itself authorise marketing email in every jurisdiction.
- Data held: names, business emails, company data, public-web evidence, email content. Privacy export and erasure are built in, and erasure keeps a suppression hash so the person is never contacted again.
- Research respects robots.txt and site terms. It never logs in, never scrapes LinkedIn, and never bypasses access controls.

## Known gaps in 1.0.0
- No live third-party verification has been done from this build (see README). All adapter tests use fakes or recorded response shapes.
- No 2FA. No CSP header. No system email: invitations are shared as links, and a forgotten password is reset on the server with `npm run reset-password -- --email <email>`.
- Open/click tracking is optional and reported as estimates. Apple Mail Privacy Protection inflates opens.
- SMTP crash reconciliation depends on the server keeping a Sent copy. Many SMTP-only providers don't, so in that case an ambiguous SMTP failure is marked FAILED instead of risking a duplicate.
- No frontend automated tests. The UI is verified by type checking and the production build.
- OOO handling re-activates the sequence after 3 days. It does not parse the return date.

## Open questions for you
1. Will you connect only Elite Media Networks' own Google Workspace domains (Internal app, no verification), or also client mailboxes (requires verification)?
2. Which countries do you actually target first? Review those rules in Settings → Compliance with your advisor before enabling CA/AU/EU.
3. Should invitations and notifications be sent by email (this needs a transactional email provider), or are in-app notifications plus links enough?
