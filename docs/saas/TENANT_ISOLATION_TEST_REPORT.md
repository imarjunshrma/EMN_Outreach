# Tenant isolation test report — v1.3 product audit

Isolation model: every workspace record carries `workspaceId`; every workspace route resolves membership before the handler runs, and services query with both the record ID and the caller's workspace ID. A record from another workspace is answered with 404, so its existence is not revealed.

## Tests (all passing)

| Area | What is attempted from another tenant | Expected | Test |
|---|---|---|---|
| Workspace access | Open another organization's workspace or settings by URL | 404 / sign-in redirect | `saas` e2e, `auth-isolation` |
| Leads, campaigns, inbox, files | Read or change another workspace's records | 404 | `multi-tenant`, `auth-isolation` |
| Email verification | Read a result, a batch, export it, or cancel it | 404 | `email-verification.test`, `email-verification-flow.test` |
| Verification dictionaries | One workspace's disposable-domain override affecting another | Not applied | `email-verification-flow.test` |
| Verification dictionaries | Delete another workspace's override | 404 | `email-verification-flow.test` |
| Mailboxes | Pause or disconnect another workspace's mailbox | 404, mailbox unchanged | `mailboxes.test` |
| Mailboxes | Finish another user's OAuth connection | Refused, nothing connected | `mailboxes.test` |
| Database | Insert a verification row pointing at another workspace's batch | Refused by a constraint | `email-verification.test` |
| Platform console | Customer opens `/platform/*` | 404 | `platform-admin.test`, `security-baseline.test` |
| Platform console | Support staff try write actions | 404 (permission missing) | `platform-admin.test` |
| Support access | Staff inside a customer workspace | Read-only, time-limited, shown to the customer, audited | existing `saas` e2e |
| Suspended tenant | Customer writes while suspended | 403 `TENANT_INACTIVE` | `saas` e2e |
| Admin overrides | Tenant writes `settings.adminOverrides` through its own settings | Ignored | `platform-admin.test` |

## Result

No cross-tenant read or write was possible in any test. Two isolation-adjacent defects were found and fixed: the OAuth login CSRF (a mailbox could be attached to the wrong workspace through a tricked consent) and a 500 instead of 404 on another tenant's export. Row-level security in PostgreSQL is not used; isolation is enforced in the application (decision recorded in `TENANT_ISOLATION_DESIGN.md`).
