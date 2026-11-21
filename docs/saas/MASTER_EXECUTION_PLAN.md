# Master execution plan (v1.4 hardening pass)

Status legend: DONE (implemented + tested here), PARTIAL, BLOCKED (external dependency), DOCUMENTED (limitation recorded, not built).

| Phase | Work | Status |
|---|---|---|
| 0 | Discovery, Mac/build reconciliation, inventory, baseline tests | DONE |
| 1 | Organization/workspace isolation | DONE (re-verified) |
| 2 | Staff MFA, user disable, session revocation, support banner and access log | DONE |
| 3 | Refunds, disputes, out-of-order events, reconciliation, annual allowances, trial-once | DONE (live payments BLOCKED) |
| 4 | Storage metering and enforcement | DONE |
| 5 | Lifecycle (suspension, deletion) | DONE; provider token revocation DOCUMENTED |
| 6 | Worker timeouts, dead letters, SSE tenant status | DONE |
| 7 | Mailboxes / inbox / deliverability | Existing, re-verified; live BLOCKED |
| 8 | DNS list/edit/delete with provider abstraction | DONE (Cloudflare only; live BLOCKED) |
| 9–11 | AI studio, prospecting, CRM, campaigns | Existing, re-verified; HubSpot/Pipedrive DOCUMENTED |
| 12 | Contact page, platform metrics, docs | DONE |
| 13 | Health/readiness/metrics, alerts guidance | DONE |
| 14 | Scans, load test, restore drill | DONE (single node); pen test DOCUMENTED |
| 15 | Final report, release gates, merge into Mac folder | DONE — gates C–F not PASS |
