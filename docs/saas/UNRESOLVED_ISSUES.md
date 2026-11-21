# Unresolved issues and limitations — v1.4.0

## Resolved in v1.4
Storage metering and enforcement; refunds and disputes; out-of-order webhooks; billing reconciliation; annual pooled allowances; trial abuse (one trial per person, organization cap); platform staff MFA; DNS record listing, editing and deletion; SSE tenant status; restore drill (scripted and run); load test (scripted and run on one node).

## Requires live credentials (code exists, not verified live)
Stripe, Razorpay, system SMTP, Gmail and Microsoft 365 OAuth, Cloudflare DNS, AI providers, Apollo, verifiers, search. See `PROVIDER_READINESS_MATRIX.md`.

## Not implemented
1. HubSpot / Pipedrive native connectors (webhooks and API remain the path).
2. Per-domain daily send cap (per-mailbox limits exist).
3. Revoking Google/Microsoft OAuth tokens at the provider when a tenant is deleted (tokens are deleted locally).
4. Payment-method fingerprinting for trial abuse (trial-once is by normalized email).
5. Malware scanning of uploaded files.
6. Seat-based pricing; overage billing (overage is a hard stop).
7. Custom organization roles; per-tenant data residency; row-level security (rejected with reasons).

## Not verified
- External penetration test — none has taken place.
- Legal documents — drafts for lawyer review.
- Load — single node, 2 vCPU VM only; no multi-node or production capacity numbers.
- Staging/production infrastructure, alerts and backups on real servers.

## Accepted risks
- `npm audit`: 3 high (backend, build-time Prisma tooling), 1 high + 1 moderate (frontend, build-time). Fixes need major-version changes; revisit when Prisma and Next releases allow.
