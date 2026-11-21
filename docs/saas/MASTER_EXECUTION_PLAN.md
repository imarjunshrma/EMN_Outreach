# Master execution plan (v1.4 hardening pass)

Status legend: DONE (implemented + tested here), PARTIAL, BLOCKED (external dependency), DOCUMENTED (limitation recorded, not built).

| Phase | Work | Acceptance | Status |
|---|---|---|---|
| 0 | Discovery, Mac/build reconciliation, inventory, baseline tests | Inventory written; baseline 160 + 16 tests green | DONE |
| 1 | Organization/workspace isolation | Existing model verified; exhaustive route sweep; triggers | DONE (v1.3, re-verified) |
| 2 | Platform-staff MFA, user disable, session revocation/rotation, support banner + customer-visible access history, auth event logging | Tests: staff without 2FA blocked; disabled user cannot sign in and sessions die; suspended org sessions; support banner API | see final report |
| 3 | Refunds, disputes, out-of-order events, reconciliation job, annual allowance policy, trial-once policy | Webhook fixture tests for refunds/disputes/out-of-order; trial reuse blocked | see final report |
| 4 | Storage metering and enforcement | Uploads counted from actual bytes; limit enforced atomically; deletes release usage | see final report |
| 5 | Lifecycle | Suspension revokes expensive work; deletion revokes provider connections | see final report |
| 6 | Worker timeouts, dead-letter view, SSE tenant status | Tests | see final report |
| 7 | Mailboxes / inbox / deliverability | Existing; re-verified by suites | Existing |
| 8 | DNS record list/edit/delete with approval, provider abstraction | Fake-provider tests; unrelated records untouched | see final report |
| 9–11 | AI studio, prospecting, CRM, campaigns | Existing; re-verified by suites; CRM connectors | Existing; connectors DOCUMENTED |
| 12 | Contact page, metrics additions, docs updates | Browser tests | see final report |
| 13 | Observability: health/readiness/metrics endpoint, alerts doc | Endpoint test | see final report |
| 14 | Security scans (npm audit, secret scan), load test, backup/restore drill | Results recorded with commands | see final report |
| 15 | Final report, release gates, Mac sync, ZIP | Gates marked honestly | see final report |

Dependencies: 2 before 5 (session revocation used by suspension); 3 before 4 (entitlement source for storage); 8 independent.
