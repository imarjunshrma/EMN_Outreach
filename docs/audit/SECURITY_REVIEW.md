# Security review (source inspection)

## Controls observed

- Passwords use Argon2id in `backend/src/services/auth.ts`; session cookie is HttpOnly, SameSite=Lax, Secure when `APP_URL` is HTTPS. Session token hash is stored, CSRF header is checked for unsafe cookie-authenticated requests (`backend/src/http/middleware.ts`).
- Route registry centrally checks session/API key, workspace membership, role, scope, rate limits, and Zod schemas (`backend/src/http/router.ts`).
- API keys are hashed and scoped; provider secrets use AES-256-GCM keyring (`backend/src/core/crypto.ts`, workspace integration services).
- API and web configure security headers/CSP; research fetcher blocks private addresses and checks redirects; outgoing webhook targets are guarded and signed in their service.
- Audit log immutability is enforced by SQL trigger.

## Findings

| ID | Severity | Finding | Action/status |
|---|---|---|---|
| SEC-001 | High | Mailbox ingestion accepted account ID without confirming it belonged to the supplied workspace, allowing cross-tenant data association if job context mismatched. | Fixed by composite scoped lookup; regression test added, execution BLOCKED. |
| SEC-002 | Medium | Initial registration read user count before transaction, allowing concurrent requests to race. | Fixed with transaction-scoped advisory lock and in-transaction recheck; concurrency regression added, execution BLOCKED. |
| SEC-003 | Medium | `TRUST_PROXY` defaults true in config; correct only with known trusted proxy topology. Compose binds app ports to loopback but operators changing exposure must review this. | Operator/configuration risk; validate deployment-specific behavior. |
| SEC-004 | Medium | Safe error/log redaction needs systematic tests for arbitrary provider error bodies and credentials. | Not fully verified. |
| SEC-005 | Low | Frontend CSP permits `unsafe-inline` scripts for Next App Router bootstrap; this is documented in `next.config.mjs` and limits XSS defense depth. | Architectural tradeoff; nonce pipeline not present. |

No penetration test or runtime authorization test was performed. Tenant isolation must not be declared accepted until database-backed two-workspace tests run. No credentials were printed or external services contacted.
