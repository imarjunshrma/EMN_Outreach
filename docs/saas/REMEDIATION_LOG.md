# Remediation log (v1.3 SaaS transformation)

| # | Finding | Fix | Evidence |
|---|---|---|---|
| R1 | Workspaces were the only tenant; billing per workspace | Organization model, org-level subscription/invoices/usage, additive migration with backfill | Migration applied to dev DB; all suites pass |
| R2 | Cross-workspace references possible at DB level | 40 `emn_same_workspace` triggers over 72 relations | multi-tenant › DB refuses |
| R3 | Tenant could be moved between organizations | `emn_workspace_org_immutable` trigger | multi-tenant › DB refuses |
| R4 | `/admin/*` routes revealed themselves with 403 and used a boolean flag | Replaced by `/platform/*` with permissions; 404 to non-staff | workflows-billing, multi-tenant › platform |
| R5 | No audited support access | Time-boxed read-only grants with reason; `support.read` audit per request; tenant-visible audit entry | multi-tenant › support access |
| R6 | Sign-up not idempotent; no terms | `registrationKey` unique + transaction; `acceptTerms` literal true | multi-tenant › provisioning |
| R7 | Workers did not re-check tenant state | `tenantGate` in the processor wrapper | multi-tenant › lifecycle |
| R8 | One tenant could monopolize AI/research workers | Per-tenant Redis slot set (`TENANT_JOB_SLOTS`) | multi-tenant › fair use |
| R9 | API-key throughput limited per workspace (agency could multiply limits) | Per-organization minute key + monthly metering | code review |
| R10 | Usage derived from mutable counts | `UsageEvent` + atomic `UsageCounter`, idempotency keys | multi-tenant › usage |
| R11 | Storage download did not re-check the key prefix | `assertKeyBelongsTo` on attachment and privacy export downloads | code review |
| R12 | Checkout metadata carried a workspace id | Gateways send `organizationId` (keeping `workspaceId` for old checkouts) and parse it first | multi-tenant › billing |
| R13 | Checkout/portal returned to a workspace page | Return to organization billing | code review |
| R14 | Signup rate limit 5/h blocked offices behind one IP during tests | Raised to 10/h/IP | multi-tenant |
| R15 | Plan dist / metric definitions absent | `saasMetrics` with definitions returned and displayed | e2e › platform |
| R16 | Documentation claimed HubSpot/Pipedrive sync, mailbox auto-pause, record editing (not implemented) | Docs and website corrected to match the code (webhooks for CRM sync; campaign-level auto-pause; create-only DNS records) | doc review |
| R17 | Code blocks rendered invisible on the website/docs (`ink-100/200` missing from the palette) | Palette extended; `pre > code` reset | screenshots |
| R18 | Terms checkbox used native `required`, hiding the app's explanation | App-level validation message | e2e › sign-up |
| R19 | Forced onboarding redirect on every login would trap migrated tenants | Onboarding after sign-up only; dismissible reminder afterwards | e2e › all |
| R20 | Tenant detail showed misleading limits (0/1) for self-hosted or blocked tenants | Limits shown only when entitlements come from a plan/trial/grace | screenshot review |
| R21 | A parallel hardening pass had changed the Mac copy (API keys refused on user routes, advisory-locked first registration, mailbox sync scoped by workspace, Cloudflare writes not retried, safer e2e runner, least-privilege Docker DB roles) | Three-way merged into v1.3; the registration lock now also guards `/auth/signup`, and the open-registration check runs under the lock | auth-isolation › concurrent first registrations; full suites green |
