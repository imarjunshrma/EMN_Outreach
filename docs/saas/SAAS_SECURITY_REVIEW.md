# SaaS security review

Reviewed against §14 of the brief. "Verified" means covered by an automated test in this repository; "Implemented" means code exists and was reviewed but has no dedicated automated test.

| Control | Status | Detail |
|---|---|---|
| Password hashing | Verified | Argon2id (64 MiB, t=3); ≥ 12 chars with letters and digits |
| Sessions | Verified | 32-byte random token, HTTP-only, SameSite=Lax, Secure in production, idle expiry with rolling refresh, revoked on logout and on password change |
| MFA | Verified | TOTP + single-use recovery codes, replay guard, per-workspace "require 2FA" (e2e enables, signs in with code, disables) |
| Password reset | Verified | Single-use hashed token, 1 hour, identical response for unknown accounts, signs out other sessions |
| Email verification | Verified | Single-use hashed 48-hour token; required for invitations and campaign start in SaaS mode |
| RBAC | Verified | Workspace roles, organization roles, platform permissions; route-level checks; exhaustive cross-tenant route sweep |
| Tenant isolation | Verified | See `TENANT_ISOLATION_DESIGN.md`; DB triggers tested |
| Credential encryption | Implemented (unit-tested crypto) | AES-256-GCM with key ring and rotation; secrets never returned by any route |
| Secret handling | Implemented | Platform secrets environment-only; reports and logs redact; `.env` never shipped |
| CSRF | Verified | Double-submit token header on all cookie-authenticated writes |
| CORS | Implemented | Same-origin only; cross-origin writes blocked in production |
| Security headers | Implemented | CSP (no `unsafe-eval` in production), X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy, no `X-Powered-By` |
| Rate limiting | Verified (login) / Implemented (others) | Per-route limits (sign-up 10/h/IP, verification resend 3/15 min/user, login, reset…), per-tenant API throughput |
| Webhook verification | Verified | Stripe and Razorpay signatures, event dedupe; booking webhooks HMAC with max age |
| Audit logs | Verified | Workspace `AuditLog`; append-only `PlatformAuditEvent` (delete refused by trigger — tested) |
| Data export | Verified | Workspace and organization JSON export (secrets excluded), available while suspended |
| Tenant deletion | Verified | Owner confirmation by name, 14-day grace, cancel, purge erases workspaces/records/files, tombstone + audit retained |
| Data retention | Implemented | Per-workspace retention job (`maintenance.retention`) |
| Backups | Documented only | Procedure in `/docs/self-hosting`; not automated by the application |
| Logs | Implemented | Structured logs with ids, not message bodies or secrets; errors stored per workspace |

## Privacy notes

- **AI research** stores only cited facts and links per lead; it is erased with the lead (privacy erasure) and with the tenant.
- **Contact data** is controller data of the tenant; erasure requests delete the lead, messages and research and add a do-not-contact suppression entry.
- **Email content** is retained per workspace retention settings; purged with the tenant.
- **Credentials** are deleted with the workspace on purge.
- **Backups** retain deleted data until they expire; customers are told so in the documentation.

## Residual risks

1. RLS is not used — isolation depends on application code + triggers (mitigated by the route sweep test and triggers).
2. Platform staff MFA is not enforced separately from workspace policies.
3. The SSE endpoint checks membership but not tenant status (a suspended tenant still receives its own notifications; no data from other tenants).
4. Legal documents are drafts requiring lawyer review.
5. No penetration test or load test has been performed.
