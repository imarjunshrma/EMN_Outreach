# Implementation progress — v1.3 (2026-11-21)

| Area | Status |
|---|---|
| Existing architecture assessment | Done |
| Organization model, roles, statuses, transitions | Done, tested |
| Additive migration + backfill | Done, applied to dev DB |
| DB tenant guards (triggers) | Done, tested |
| Router auth modes `org` / `platform`, status gate, support grants | Done, tested |
| Sign-up with terms, idempotent provisioning, recovery | Done, tested |
| Email verification | Done, tested (delivery needs SMTP) |
| Onboarding checklist (computed) + wizard UI | Done, tested (API + browser) |
| Organization settings UI (profile, branding, members, workspaces, billing, usage, export, deletion) | Done, browser-tested |
| Agency workspaces | Done, tested |
| Plans in DB + platform CRUD | Done, tested |
| Entitlement engine (API + workers) | Done, tested |
| Usage metering (idempotent, atomic, monthly or annual pooled; storage from real bytes) | Done, tested (v1.4) |
| Billing per organization (Stripe/Razorpay adapters, webhooks, grace, cancel/resume) | Done, fixture-tested; live not verified |
| Tenant lifecycle (suspend, reactivate, cancel, deletion, purge) + daily jobs | Done, tested |
| Worker tenant gate + fair-share slots | Done, tested |
| Platform console (metrics, tenants, detail, plans, support, audit) | Done, browser-tested |
| Public website (home, product, pricing, security, legal) | Done, browser-tested |
| Documentation site (21 guides, search, API reference from OpenAPI) | Done, browser-tested |
| API security matrix + data ownership matrix (generated) | Done (`npm run saas:matrices`) |
| docs/saas reports (17) | Done |
| Mac sync + ZIP | Done (see final report) |

## v1.4.0 additions

| Item | Status |
|---|---|
| Platform staff MFA, user disable/session revocation, support banner and access log | Done, tested |
| Refunds, disputes, out-of-order events, reconciliation, trial-once, org cap | Done, fixture-tested; live not verified |
| Storage metering and enforcement | Done, tested |
| Worker timeouts, dead letters, operations page | Done, tested |
| DNS record list/edit/delete | Done, fake-provider tested |
| `/metrics`, safer `/readyz` | Done, tested |
| Contact page, platform metric additions, docs | Done, browser-tested |
| Restore drill, load test | Run in build VM (see final report) |
| docs/saas reports required by the v1.4 brief (11) | Done |
