# Complete engineering audit — v1.3

Phase-by-phase findings. Bug details are in `BUGS_FOUND_AND_FIXED.md`; the running log is `AUDIT_PROGRESS.md`.

| Phase | Area | Findings | Outcome |
|---|---|---|---|
| 1 | Inventory | 410 API operations, 94 pages, 111 models, 12 queues; no TODO/FIXME markers or placeholder screens | `COMPLETE_PRODUCT_FEATURE_INVENTORY.md` |
| 2 | Authentication | Sessions, CSRF, two-factor, rate limits behave as designed | Baseline tests added |
| 3 | Multi-tenant | Isolation holds; OAuth login CSRF and a 500-instead-of-404 fixed | `TENANT_ISOLATION_TEST_REPORT.md` |
| 4 | Frontend | New console screens (staff, permissions, settings, new tenant, members, modules, password reset, announcement banner); every button wired and browser-tested | 18/18 e2e |
| 5 | Leads and import | No defects found | Suites green |
| 6 | Mailboxes | OAuth CSRF fixed; lifecycle now tested end to end | 8 new tests |
| 7 | Campaigns | 30 tests were stale after the verification-freshness rule; product behaviour correct | Helper fixed |
| 8 | Inbox | No defects found | Suites green |
| 9 | AI | No defects found; subscription mode stays owner/private-instance only | Suites green |
| 10 | Workflows | Admin switch for workflows now enforced in self-hosted mode | Tested |
| 11 | Analytics | No defects found | Suites green |
| 12 | Billing | No defects found; refunds stay manual with confirmation | Suites green |
| 13 | Platform admin | ERP-style console completed: staff roles, tenant creation, member management, per-tenant modules and limits, permission matrix, global sign-up mode and announcements | 8 tests + browser walk-through |
| 14 | Integrations | Adapters unit-tested; live providers not verified | See unresolved issues |
| 15 | Database | Edited-after-apply migration repaired additively; drift check empty | Repair migration |
| 16 | Jobs | Verification jobs: pause, resume, retry, cancel, crash recovery keep data; a data-loss bug in exports fixed | Tested |
| 17 | Security | Dependency advisories fixed; secrets scan clean | `SECURITY_AUDIT.md` |
| 18 | Performance | One redundant query per verification removed. No load test run | Not measured |
| 19 | Deployment | Migrations apply cleanly from zero (e2e) and on an existing database; no deployment to real servers in this audit | Not verified live |
| 20 | Testing | 278 + 18 tests green; line coverage 72.3% → 76.0% | `COMPLETE_TEST_RESULTS.md` |
| 21 | Fixes | 13 items fixed | `BUGS_FOUND_AND_FIXED.md` |

## Design changes worth knowing

- **Admin overrides** live in `Organization.settings.adminOverrides` and apply on top of the plan (SaaS) or on top of "unlimited" (self-hosted). Tenants cannot write them.
- **Global settings** are a new `PlatformSetting` table (one additive migration). Sign-up mode `open`/`closed` overrides `REGISTRATION_OPEN`; staff can always create tenants.
- **Malformed IDs** are rejected in the router for parameters that always name a database record.
