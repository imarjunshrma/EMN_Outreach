# Email infrastructure implementation audit

Audit date: 2026-11-21. Database-backed tests ran against a disposable PostgreSQL cluster under `/private/tmp` and a separate temporary Redis port. Docker was unavailable. No production database, existing volume, or real provider account was used.

## Status definitions

- **COMPLETE** — relevant implementation and verification executed successfully.
- **IMPLEMENTED_UNVERIFIED** — implementation exists, but integration or live-provider verification is incomplete.
- **PARTIAL** — some required behavior exists; a documented gap remains.
- **MISSING** — no implementation found.
- **BROKEN** — implementation was found to fail in a reproducible check.

## Feature audit

| Area | Status | Evidence and limits |
|---|---|---|
| SMTP/IMAP connection form and API | IMPLEMENTED_UNVERIFIED | `backend/src/services/accounts.ts`, `integrations/src/email/smtp-imap.ts`, `frontend/app/w/[ws]/email-accounts/page.tsx`. SMTP and IMAP checks run independently; distinct credentials are accepted. Mocks verify both endpoints and independent errors. No live provider was contacted. |
| Credential storage and API redaction | COMPLETE (isolated test) | SMTP/IMAP passwords and usernames are encrypted with the configured keyring; legacy usernames are lazily upgraded. Account serializers omit connection configuration. Integration test verifies independent encrypted round-trip credentials and that secrets/configuration are absent from API responses. |
| Google OAuth | IMPLEMENTED_UNVERIFIED | PKCE consent, encrypted token storage, refresh lock, Gmail send/sync/revoke adapters, and mocked adapter tests exist. Google Cloud consent and an actual mailbox were not available for live verification. |
| Microsoft OAuth | IMPLEMENTED_UNVERIFIED | PKCE consent, encrypted token storage, refresh lock, Graph send/delta sync, optional Graph notifications and subscription renewal exist. Tenant consent and a real mailbox were not available for live verification. |
| Initial and incremental mailbox synchronization | IMPLEMENTED_UNVERIFIED | SMTP/IMAP UID+UIDVALIDITY, Gmail history, Graph delta; initial connect enqueues sync. Worker processor and database persistence were integration-tested with fake providers, but no live IMAP/OAuth provider was contacted. |
| Sync job safety and failure visibility | COMPLETE (isolated test) | Worker registers `sync.account`; per-mailbox Redis lock, cursor-preserving ingestion failure behavior, last success/error storage, rate-limited admin alerts. Integration test ran the registered processor against fake provider and temporary PostgreSQL/Redis. |
| Message deduplication and conversation threading | COMPLETE (isolated test) | Unique `(emailAccountId, providerMessageId)`; references, in-reply-to and provider thread IDs are used. Reply, duplicate sync, overlap lock, thread and campaign association integration tests passed. Unmatched messages stay unassigned rather than guessing. |
| Reply classification, sequence stopping, bounce and unsubscribe | COMPLETE (isolated test) | Human/auto reply, bounce suppression, unsubscribe and sequence stopping integration tests passed against isolated PostgreSQL. |
| SMTP send, retry and crash recovery | IMPLEMENTED_UNVERIFIED | Existing campaign engine uses atomic send claims and `X-EMN-Outbound-Id` reconciliation. Ambiguous SMTP outcomes fail closed when a Sent copy cannot prove delivery, avoiding blind duplicate sends. No real message was sent. |
| Workspace/mailbox/campaign limits and pauses | COMPLETE (isolated integration) | Workspace cap uses Redis lock and visible `SENDING` reservations; mailbox/campaign limits and automatic pause protections. Integration tests for quota behavior passed; no sustained multi-process stress test was performed. |
| Mailbox health and diagnostics | IMPLEMENTED_UNVERIFIED | Health page reports observed sync/send/error/bounce/domain data and independent SMTP/IMAP check results. Diagnostic is ADMIN-only and self-addressed. No live diagnostic was sent. |
| Frontend mailbox and inbox workflows | IMPLEMENTED_UNVERIFIED | Mailbox management, OAuth/SMTP connection, test, resync, pause/resume, self-test, inbox search/filter, conversation view and sanitized HTML rendering exist. Production frontend build passed; browser interaction was not run. |
| Tenant isolation | COMPLETE (isolated integration) | Full integration suite, including multi-tenant access controls, passed against temporary PostgreSQL. |
| Mailpool live compatibility | IMPLEMENTED_UNVERIFIED | Generic SMTP/IMAP consumes the actual host, ports, TLS modes and separate credentials configured by the administrator; no Mailpool values are hardcoded. Real credentials and a controlled live test are still required. |
| Artificial warm-up or inbox placement claims | COMPLETE | No reciprocal warm-up network exists. Health and diagnostic UI explicitly do not claim inbox placement based on SMTP acceptance. |

## Verification run

- `SKIP_TEST_DB=1 npm run test:unit -- --pool=forks --maxWorkers=1 --reporter=dot` — 58 tests passed.
- `TEST_DATABASE_URL=postgresql://emn@127.0.0.1:55432/emn_test TEST_REDIS_URL=redis://127.0.0.1:56379/15 npm run test:integration -- --pool=forks --maxWorkers=1 --reporter=dot` — 129 tests passed across 16 files.
- `npm run typecheck`, `npm run build`, `npm run build:frontend`, `npx prisma validate`, `npm run openapi`, and `npm run api-docs` passed. Targeted lint for changed backend/integration/test files passed. Full lint still reports two unrelated unused `store` imports in `backend/src/services/ai-studio.ts` and `backend/src/services/workflows.ts`.
- `node --import tsx scripts/generate-tenant-guards.ts` regenerated `prisma/sql/002_tenant_guards.sql` for the current schema; `tests/unit/tenant-guards.test.ts` passed.
- `SKIP_TEST_DB=1 npx vitest run tests/unit/smtp-protocol.test.ts --pool=forks --maxWorkers=1 --reporter=dot` — 4 tests passed with loopback enabled; it uses a local mock SMTP server only.
- No production database, existing volume, or live provider was targeted.
- No real email was sent and no Mailpool/Google/Microsoft credentials were used.

## Outstanding live checks

Run the SMTP/IMAP connection, initial sync, inbound reply, Sent folder, bounce, and pause workflows against an isolated test mailbox before describing a provider integration as live-verified. See [MAILPOOL_SETUP.md](MAILPOOL_SETUP.md).
