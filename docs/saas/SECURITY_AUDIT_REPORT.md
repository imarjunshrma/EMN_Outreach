# Security audit report — v1.4.0

Supersedes `SAAS_SECURITY_REVIEW.md` (kept as a pointer). Audited 2026-11-21 on the build machine. "Verified" = an automated test in this repository exercises it; "Implemented" = reviewed in code, no dedicated test.

**Not a penetration test.** No professional or external penetration test has been performed. The checklist at the end is what such a test should cover.

## Scans executed

| Scan | Command | Result |
|---|---|---|
| Dependency audit (backend, all deps) | `npm audit --json` | 3 high: `prisma` → `@prisma/config` → `effect` (ReDoS in `Schema.TemplateLiteral`). Used only by the Prisma CLI config loader at build/migrate time, never on request input. Fix requires downgrading Prisma to 6.x (major) — **accepted, tracked**. 0 critical. |
| Dependency audit (frontend) | `npm --prefix frontend audit --json` | 1 high (`postcss` < 8.5.23 bundled inside `next`), 1 moderate (`next` via that postcss). Build-time CSS processing of our own stylesheets only. Fix requires Next 16 (major) — **accepted, tracked**. 0 critical. |
| Secret scan | regex scan for Stripe/AWS/GitHub/Slack/Google/OpenAI/Anthropic/Razorpay keys and private keys, excluding `node_modules` and build output | 0 findings. `.env` is git-ignored and excluded from archives. |
| Static analysis | `npm run lint` (ESLint + typescript-eslint), `tsc --noEmit` backend and frontend | 0 errors (8 `no-explicit-any` warnings in UI code) |
| Cross-tenant sweep | `tests/integration/multi-tenant.test.ts` | All 262 workspace routes refuse another tenant with 404, every method |

## Controls

| Area | Status | Evidence |
|---|---|---|
| Password hashing | Verified | Argon2id m=64 MiB t=3; ≥12 chars, letters + digits |
| Brute force | Verified | Login 10/5 min/IP; MFA verify 10/5 min; reset and sign-up limited; timing-equalised unknown-user path |
| Account enumeration | Verified | Reset request answers identically (e2e); login error generic |
| Sessions | Verified | New random session per sign-in (no fixation); HTTP-only, SameSite=Lax, Secure in production; idle expiry; revoked on logout, password change and **account disable** (v1.4) |
| Privilege changes | Implemented | Roles are read from the database on every request (no privilege cached in the session), so a demotion is effective on the next request without rotation |
| MFA | Verified | TOTP + recovery codes; workspace "require 2FA"; **mandatory for platform staff** (v1.4): console routes and support grants refuse staff without 2FA; staff cannot disable it |
| Account disable | Verified | Platform action, reason required, sessions revoked, sign-in refused, audited |
| RBAC | Verified | Deny-by-default router: every route declares auth mode; workspace/organization/platform permissions tested; API keys refused on user/org/platform routes |
| Tenant isolation | Verified | See `TENANT_ISOLATION_REPORT.md` |
| Support access | Verified | Reason ≥10 chars, ≤4 h, read-only, per-request audit, customer-visible log with page counts, red banner for staff (v1.4) |
| CSRF / CORS / headers | Verified (CSRF) / Implemented | Double-submit header; same-origin; strict CSP (no `unsafe-eval` in production), frame DENY, nosniff, referrer policy |
| Webhook signatures | Verified | Stripe HMAC + 5-min tolerance, Razorpay HMAC; dedupe by event id; out-of-order protection (v1.4); booking webhooks HMAC with max age; outbound webhooks signed, SSRF-checked (`assertPublicUrl`, no redirects) |
| Payment integrity | Verified | Entitlements only from verified webhooks; refunds idempotent and bounded; lost disputes suspend |
| Credential encryption | Verified (unit) | AES-256-GCM key ring with rotation; never serialised to clients |
| File security | Verified | Tenant-prefixed keys, prefix re-checked on download, path traversal refused, authenticated download only, storage accounted and limited (v1.4) |
| Error exposure | Verified | Uniform error envelope with request id; `/readyz` no longer returns internal error text (v1.4) |
| Logging | Implemented | pino with redaction paths for secrets/tokens/passwords; request ids |
| Monitoring | Verified | `/metrics` (token-gated Prometheus), `/readyz`, operations console |

## Penetration-test checklist (for an external tester)

1. Authentication: credential stuffing, MFA bypass, recovery-code reuse, session fixation, cookie flags.
2. Authorization: IDOR on every `/w/:id/*`, `/orgs/:id/*`, `/platform/*` route with every role; API key scopes; support grant scope and expiry.
3. Tenant isolation: cross-tenant ids in bodies and query strings, bulk actions, exports, attachments, SSE stream, webhook targets.
4. Billing: forged/ replayed webhooks, checkout tampering, refund abuse, trial reuse.
5. Injection: SQL via filters/sort, stored XSS in lead fields, email templates, docs search; CSV formula injection on export.
6. SSRF: outbound webhooks, research fetcher, booking URLs, DNS provider calls.
7. File upload: type confusion, zip bombs, oversized files, path traversal.
8. Infrastructure: TLS, headers on Nginx, Redis/PostgreSQL exposure, secrets on disk, backup storage access.
