# First-party email verification (initial release)

This module provides a tenant-scoped syntax, IDN normalization, disposable/free/role attributes, and DNS/MX inspection flow. It deliberately does not connect to recipient SMTP servers, send mail, or claim that a mailbox exists. A domain with working MX or fallback A/AAAA records therefore receives `UNKNOWN`, not `VALID`. Syntax failures and domains with NXDOMAIN, null MX, or no mail route receive `INVALID`; this only means the address/domain cannot be routed based on that evidence, not that an SMTP recipient was queried.

## Use

Open **Workspace → Verification & enrichment**. Submit one address or a newline/comma/semicolon separated list of at most 1,000 unique addresses. The bulk API returns a batch ID; batch results and progress are available on the same page. Results are cached for seven days per workspace. Bulk work uses the existing BullMQ `verify` queue and uses job IDs tied to verification record IDs.

Authenticated workspace APIs:

- `POST /api/v1/w/{workspaceId}/email-verification/verify` with `{ "email": "person@example.com", "leadId": "optional-workspace-lead-uuid" }`
- `POST /api/v1/w/{workspaceId}/email-verification/bulk` with `{ "emails": ["person@example.com"] }` (1–1,000 entries)
- `GET /api/v1/w/{workspaceId}/email-verification/{id}`
- `GET /api/v1/w/{workspaceId}/email-verification/batches?page=1&pageSize=25`
- `GET /api/v1/w/{workspaceId}/email-verification/batches/{id}`

All reads include the authenticated workspace in their database query. When attached to a lead, only syntax-invalid addresses update the lead to `INVALID`; DNS cannot confirm mailbox validity and updates the lead to `UNKNOWN`. Known disposable-domain evidence is separately checked by campaign eligibility and does not overwrite mailbox status.

## Deployment

Apply the new Prisma migration with the standard `npm run db:migrate`, regenerate Prisma Client if your deployment process does not run `postinstall`, and deploy API, worker, and frontend together. No new environment variables or paid API keys are required. DNS lookups use the operating system resolver. Existing legacy paid-verifier settings and endpoints remain unchanged.

## Limits and data provenance

The implementation reuses the repository's current bundled disposable-domain set. That set is not automatically refreshed, has no source/version metadata or administrator management UI, and should be reviewed before relying on it. Free-provider and role-address dictionaries are small built-in sets. DNS caching is currently fixed at seven days rather than honoring each record's TTL. Bulk submission is JSON bounded to 1,000 addresses; this is not a streaming CSV upload, XLSX importer, or large-file pipeline.

SMTP recipient checks, catch-all comparison probes, retries specific to SMTP/greylisting, domain reputation history, suppression list editing, detailed risk scoring, configurable category policy, and DNS/SMTP health diagnostics are not provided in this initial release. These checks require separate policy and infrastructure work; SMTP acceptance would not establish inbox placement or definite mailbox validity.
