# First-party email verification

This module reuses EMN's PostgreSQL/Prisma, Express, BullMQ/Redis, object storage, suppression list, and workspace permission model. It does not use paid verification APIs.

## Results and accuracy

Syntax, IDN normalization, DNS/MX, disposable/free-provider/role attributes, and an explainable operational risk indicator are recorded. DNS records and SMTP responses do not prove mailbox existence or inbox placement. An SMTP RCPT 250 is `ACCEPTED_BUT_UNCONFIRMED`; only a recipient server's explicit 550 5.1.1/user-unknown response is treated as invalid. SMTP never sends `DATA` or a message. Disposable and role-based classifications are attributes; they do not overwrite technical mailbox status.

SMTP is disabled by default. If enabled, probes connect only to public IPs resolved from the target domain's MX records, use the configured `MAIL FROM`, serialize probes per destination domain, and use global and per-domain limits. Catch-all comparison is separately disabled by default and, when enabled, makes one randomized control-recipient probe; an accepted control produces `SUSPECTED`, not confirmed catch-all. The administrator diagnostic checks an SMTP greeting/EHLO against the MX for the configured `MAIL FROM` domain and sends no recipient command.

## Available flows and APIs

Open **Workspace → Verification & enrichment**. The page supports individual checks, JSON email lists, CSV upload, batch progress/control, CSV export, SMTP/worker diagnostics, disposable-domain overrides, and workspace role-pattern overrides.

- `POST /api/v1/w/{workspaceId}/email-verification/verify` — `{ "email": "person@example.com", "leadId": "optional-workspace-lead-uuid" }`
- `POST /api/v1/w/{workspaceId}/email-verification/bulk` — `{ "emails": ["person@example.com"] }`, up to 1,000 input entries
- `POST /api/v1/w/{workspaceId}/email-verification/bulk.csv` — multipart field `file`, plus optional `emailColumn` (header name or zero-based index) and `hasHeader` (`true`/`false`)
- `GET /api/v1/w/{workspaceId}/email-verification/history?email=...&page=1&pageSize=25`
- `GET /api/v1/w/{workspaceId}/email-verification/{id}`
- `GET /api/v1/w/{workspaceId}/email-verification/batches?page=1&pageSize=25`
- `GET /api/v1/w/{workspaceId}/email-verification/batches/{id}?page=1&pageSize=100`
- `GET /api/v1/w/{workspaceId}/email-verification/batches/{id}/export.csv`
- `POST /api/v1/w/{workspaceId}/email-verification/batches/{id}/pause|resume|retry|cancel`
- `POST /api/v1/w/{workspaceId}/email-verification/diagnostics` (workspace ADMIN)
- `GET /api/v1/w/{workspaceId}/email-verification/datasets` (workspace VIEWER or higher)
- `POST /api/v1/w/{workspaceId}/email-verification/datasets/refresh` (workspace ADMIN)
- `POST /api/v1/w/{workspaceId}/email-verification/domain-overrides` and `DELETE /api/v1/w/{workspaceId}/email-verification/domain-overrides/{id}` (workspace ADMIN)
- `POST /api/v1/w/{workspaceId}/email-verification/role-patterns` (workspace ADMIN)

Every API query is tenant-scoped. Batch CSV parsing runs in the worker from the existing object storage adapter. Uploads are bounded to 10 MB and 500,000 non-empty rows; oversized files are rejected, not truncated. CSV exports stream database pages and escape spreadsheet formula cells. XLSX is not supported. Pausing stops pending checks; an active SMTP check may finish. Cancellation marks pending work and cannot interrupt a network call already in progress.

## SMTP configuration

No SMTP probe runs unless all of these are configured on API and worker services:

```env
EMAIL_VERIFY_SMTP_ENABLED=true
EMAIL_VERIFY_MAIL_FROM=verification@your-controlled-domain.example
# Optional; defaults shown
EMAIL_VERIFY_SMTP_TIMEOUT_MS=5000
EMAIL_VERIFY_CATCH_ALL_ENABLED=false
EMAIL_VERIFY_WORKER_CONCURRENCY=2
EMAIL_VERIFY_PER_DOMAIN_PER_MINUTE=5
EMAIL_VERIFY_GLOBAL_PER_MINUTE=60
EMAIL_VERIFY_RETRY_DELAYS_MS=300000,1800000,7200000
```

`EMAIL_VERIFY_MAIL_FROM` must be an address controlled by the operator. Port 25 outbound access depends on the host. Run the admin diagnostics after deployment. `CONNECTED` proves only that the configured sender-domain MX answered a greeting and EHLO; it does not prove arbitrary destination SMTP access. Production port 25 connectivity has not been tested in this development environment.

## Dataset and caching

The daily worker refreshes the pinned plain-text source from [disposable-email-domains/disposable-email-domains](https://github.com/disposable-email-domains/disposable-email-domains). The repository describes its list as disposable/temporary domains and says its entries are not guaranteed to remain disposable; classifications remain explainable flags rather than proof of mailbox invalidity. The list's published license page permits commercial use, but operators should review the source's current terms and provenance. A bundled set remains as fallback. Dataset metadata includes the source URL, last refresh, count, checksum, status, and error. Refresh is size-bounded and runs transactionally so a bad download does not replace the existing dataset. Workspace admins can add or exclude domains and add/disable exact role local-part tokens.

Verification cache duration is seven days and is workspace-scoped. Dataset and override version changes invalidate reuse for new requests. DNS TTL-specific caching and configurable cache duration are not implemented.

## Campaign safety and limitations

The existing campaign gate still blocks suppressed, unsubscribed, bounced, and invalid leads; it additionally blocks addresses classified disposable by the current verification record. Campaigns requiring verified addresses continue to reject `UNKNOWN`; the first-party DNS flow never upgrades an address to `VALID`. SMTP user-unknown results mark linked leads invalid. Existing suppression import/export and APIs are reused.

There is no commercial spam-trap intelligence, broad reputation history, validated delivery probability, full domain-history dashboard, XLSX support, configurable campaign exclusions for every secondary attribute, SMTP interoperability testing against real providers, or a guarantee that a provider permits recipient probes. These are not simulated.

## Deploy

Apply migrations with `npm run db:migrate`, run Prisma Client generation if deployment does not run `postinstall`, then deploy API, worker, and frontend together. The migrations are `20261121193000_first_party_email_verification` and `20261121200000_email_verification_datasets`. They have been schema-validated but not applied to a live database in this environment.
