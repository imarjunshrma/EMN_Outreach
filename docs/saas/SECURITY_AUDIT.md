# Security audit — v1.3 product audit

Scope: the API, the frontend, background jobs, dependencies and the repository. Method: code review of authentication, authorization and tenant boundaries; targeted tests for each control; dependency and secret scans. This is an internal review, not an external penetration test (none has taken place).

## Findings fixed in this audit

| Finding | Severity | Status |
|---|---|---|
| OAuth login CSRF: a mailbox consent link could be finished by a different signed-in user, connecting their mailbox to the initiator's workspace | High | Fixed; callback bound to the initiating user and their current workspace access; tested |
| Malformed record IDs produced 500 errors on every `:id` route (no data exposed, but noisy and a probing signal) | Medium | Fixed; 404 after access checks; tested |
| Another workspace's verification export returned 500 instead of 404 | Medium | Fixed; tested |
| Five production dependency advisories (Prisma CLI `effect`, Next.js `postcss`) | High (build tooling) | Fixed with same-major overrides; `npm audit` clean |
| Admin module switches ineffective without billing, so a tenant could keep API access or automatic replies an admin had turned off | Medium | Fixed; tested |

## Controls verified by tests

| Control | Evidence |
|---|---|
| Hardening headers on every API response (`nosniff`, `DENY` framing, `default-src 'none'` CSP, referrer policy, no `x-powered-by`) | `security-baseline.test.ts` |
| CSRF token required for cookie-authenticated changes (missing or wrong token → 403) | `security-baseline.test.ts` |
| Session required for workspace and platform routes (401); platform routes invisible to customers (404) | `security-baseline.test.ts`, `platform-admin.test.ts` |
| Error responses carry a code, message and request ID only: no stack traces, SQL or Prisma details | `security-baseline.test.ts` |
| Platform staff need two-factor sign-in; changing a staff role revokes their sessions and support grants; the last super admin cannot be removed; nobody can change their own role | `platform-admin.test.ts`, `saas` e2e |
| Every admin action needs a written reason and is recorded in the platform audit trail | `platform-admin.test.ts` |
| Tenants cannot write their own admin overrides | `platform-admin.test.ts` |
| Mailbox tokens stored encrypted and never returned by the API; provider error details not echoed to the client | `mailboxes.test.ts` |
| Spreadsheet formula injection neutralised in CSV exports | `email-verification-flow.test.ts` |
| Rate limits on sign-in, verification and diagnostics | existing `auth-isolation`, `security-v12` |
| Role checks: Viewer cannot upload, Member cannot manage mailboxes | `email-verification-flow.test.ts`, `mailboxes.test.ts` |

## Scans

| Scan | Result |
|---|---|
| `npm audit --omit=dev` (root, frontend) | 0 vulnerabilities |
| Secret patterns in the repository (Anthropic/OpenAI keys, AWS, Google API, GitHub, Slack, Stripe live keys and webhooks, private keys, database URLs with passwords) | Only deliberate fake tokens in tests. No real secret found. |
| `.env`, `.ai-subscriptions/`, `.local-dev/` | Git-ignored; never included in the merge |

## Not covered

External penetration test; load-based denial of service; malware scanning of uploads (not implemented); live verification of Google/Microsoft/Stripe/Razorpay security flows (needs real credentials). The frontend Content-Security-Policy allows `'unsafe-inline'` scripts because Next.js injects inline bootstrap scripts; a nonce-based policy would remove that.
