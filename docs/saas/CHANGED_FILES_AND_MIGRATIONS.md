# Changed files and migrations — v1.4.0

Base: Mac repository commit `9013ca4` ("first commit") plus the v1.3.0 state. All changes are uncommitted in the working tree for review.

## Database
| File | Kind | Effect |
|---|---|---|
| `prisma/schema.prisma` | Schema | Subscription `currentPeriodStart`, `lastEventAt`; Invoice `providerPaymentId`, `amountRefundedCents`; new models Refund, BillingDispute, TrialGrant, StoredObject |
| `prisma/migrations/20261121150000_v1_4_billing_storage_trials/migration.sql` | Migration (additive) | Creates the four tables and new columns, unique and lookup indexes. No drops, no data rewrites |
| `prisma/sql/003_storage_guard.sql` | SQL guard | Trigger `emn_stored_object_org`: StoredObject organization must match its workspace; bytes ≥ 0 |

Apply: `npm run db:migrate` (or `bash scripts/mac-dev.sh start` on the Mac).

## Shared
`shared/src/tenancy.ts` (billing:refund permission), `shared/src/plans.ts` (`allowancePeriod`).

## Backend
- HTTP: `backend/src/http/router.ts`, `backend/src/http/middleware.ts`, `backend/src/http/openapi.ts`, `backend/src/app.ts`
- New: `backend/src/core/metrics.ts`, `backend/src/services/storage-accounting.ts`
- Services: `security.ts`, `platform.ts`, `billing.ts`, `tenancy.ts`, `entitlements.ts`, `usage.ts`, `leads.ts`, `domains.ts`, `ai-studio.ts`, `workflows.ts`, `inbox.ts`, `ops.ts`
- Routes: `backend/src/routes/saas.ts`, `backend/src/routes/domains-enrichment.ts`

## Integrations
`integrations/src/billing/gateways.ts` (refunds, disputes, event time, subscription fetch), `integrations/src/providers/extra.ts` (DNS update/delete).

## Worker
`worker/src/processors.ts` (timeouts, storage and billing reconcile jobs), `worker/src/main.ts` (schedules, dead-letter logging).

## Frontend
- New: `app/platform/users/page.tsx`, `app/platform/operations/page.tsx`, `app/contact/page.tsx`, `components/zone-records.tsx`
- Changed: `app/platform/page.tsx`, `app/platform/plans/page.tsx`, `app/platform/tenants/[id]/page.tsx`, `app/w/[ws]/layout.tsx`, `app/org/[orgId]/page.tsx`, `components/platform/shell.tsx`, `components/org/billing-panel.tsx`, `components/domain-manager.tsx`, `components/site/site-shell.tsx`, `lib/theme-script.ts`, `package.json`
- Docs content: `content/docs/{billing,domains-dns,platform-admin,security,self-hosting}.md`, `content/openapi.json`

## Tests
- New: `tests/integration/billing-v14.test.ts`, `tests/integration/ops-dns-v14.test.ts`
- Changed: `tests/integration/multi-tenant.test.ts`, `tests/integration/workflows-billing.test.ts`, `tests/helpers/fakes.ts`
- E2E: `e2e/helpers.ts`, `e2e/saas.spec.ts`, `e2e/app.spec.ts`, `e2e/crawl.spec.ts`

## Scripts and config
New `scripts/load-test.ts`, `scripts/restore-drill.sh`; changed `.env.example`, `package.json` (1.4.0).

## Documentation
`API_DOCUMENTATION.md`, `docs/openapi.json`, `CHANGELOG.md`, `README.md`, and in `docs/saas`: new MASTER_PROJECT_INVENTORY, MASTER_EXECUTION_PLAN, SECURITY_AUDIT_REPORT, TENANT_ISOLATION_REPORT, BILLING_AND_USAGE_REPORT, PROVIDER_READINESS_MATRIX, DEPLOYMENT_AND_RECOVERY_GUIDE, PRODUCTION_LAUNCH_CHECKLIST, CHANGED_FILES_AND_MIGRATIONS; updated FINAL_SAAS_ACCEPTANCE_REPORT, UNRESOLVED_ISSUES, API_TENANT_SECURITY_MATRIX, TENANT_DATA_OWNERSHIP_MATRIX, INTERNAL_MULTI_TENANT_TESTS, IMPLEMENTATION_PROGRESS, PLATFORM_ADMIN_GUIDE, REMEDIATION_LOG; SAAS_SECURITY_REVIEW now points to SECURITY_AUDIT_REPORT.

## Not changed
`.env`, `frontend/tsconfig.json` (your version kept), existing migrations, existing tests (only extended).
