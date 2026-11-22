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
- `npm audit`: resolved in the v1.3 audit with same-major overrides (`effect` 3.22.5, `postcss` 8.5.33). Remove the overrides once Prisma and Next ship the fixed versions themselves.

## Open after the v1.3 product audit (22 November 2026)

1. **Coverage below a comfortable level** in `outreach-brain.ts` (37%), `copilot.ts` (49%), `worker/processors.ts` (50%), the Gmail and Microsoft adapters (50%) and billing gateways (58%). Overall server line coverage is 76%; branch coverage 57%.
2. **SMTP probing paths** in first-party verification are not covered by tests (need a controllable mail server); probing stays off by default.
3. **No load test**; performance is unmeasured beyond removing one redundant query.
4. **Frontend Content-Security-Policy** allows inline scripts (Next.js bootstrap); a nonce pipeline would tighten it.
5. **16 lint warnings** (`any` types in older files); no errors.
6. **No frontend unit coverage**; screens are covered by browser tests only.
7. Everything in "Requires live credentials" and "Not verified" above still applies.
