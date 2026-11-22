# Production readiness report — v1.3 product audit

## Verdict

**Ready for private, internal use on a self-hosted install** (the way it runs today: one owner, invited users, billing off).

**Not yet ready for a public SaaS launch.** Passing builds and tests do not make it production-ready on their own; the items below have not been verified and each one matters for paying customers.

## Evidence for internal use

- 278 unit and integration tests and 18 browser tests pass on a fresh database; type checks and lint have no errors; production dependencies have no known advisories; migrations match the schema.
- Tenant isolation, roles, CSRF, staff two-factor and audit trails are tested.
- The 13 defects found in this audit are fixed, including one high-severity security issue (OAuth login CSRF) and one data-loss issue (verification exports).

## Blocking a public launch

| Item | Why it matters | What closes it |
|---|---|---|
| Live provider verification (Google and Microsoft OAuth, SMTP, Stripe/Razorpay, Cloudflare, AI providers) | All tested against fakes only | Run each flow once with sandbox or real accounts; record results in `PROVIDER_READINESS_MATRIX.md` |
| External penetration test | Internal review only | Commission one before opening sign-up |
| Load and capacity test | No numbers beyond a single small VM | Load test sending, sync and the API at expected tenant counts |
| Backups and restore drill on the real servers | Not exercised | Scheduled backups plus one timed restore |
| Monitoring and alerts on the real servers | Configured in code (`/metrics`), not verified live | Connect alerting and trigger a test alert |
| Legal documents | Drafts | Lawyer review |
| Claude/Codex subscription connections | Anthropic's terms do not allow offering subscription logins to customers; the feature turns itself off when sign-up is open | Keep it off for public SaaS; use API keys there |

## Before the next deploy of this version

1. `npm install` in the root and in `frontend` (lockfiles changed for the security fixes).
2. `npm run db:migrate` — applies the verification repair and the platform settings migrations.
3. Restart the API and worker.
