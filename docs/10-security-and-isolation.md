# 10 — Security and isolation

The full control list is in `../SECURITY.md`. This doc covers the design.

## Tenancy
- Every request to a workspace route resolves `(user | apiKey) → membership(workspaceId) → role` in the route registry before the handler runs. Handlers receive `workspaceId` and are written to put it in every `where` clause, including the `findFirst({ id, workspaceId })` checks for ids that come from request bodies.
- A non-member gets **404**, never 403, so the response does not reveal whether a workspace exists.
- Workers validate the `workspaceId` in each job and load entities scoped to it.
- Integration tests (`tests/integration/auth-isolation.test.ts`) confirm that two workspaces cannot read or modify each other's leads, campaigns, conversations or API keys.

## Roles
| Role | Typical rights (each route declares its own minimum; see API_DOCUMENTATION.md) |
|---|---|
| VIEWER | Read workspace data |
| MEMBER | Leads, CSV import/export, prospect import, research, writing, replies, notes, campaign drafts |
| MANAGER | Approve/start/pause campaigns, delete leads/lists/ICPs, automations, suppression management, Smartlead export |
| ADMIN | Members & invitations, integrations, AI providers/routes, mailboxes, domains, API keys, webhooks, compliance rules, privacy requests, jobs/logs/audit |
| OWNER | Everything, plus model prices and the full workspace data export; the last owner cannot be removed or demoted |

## Secrets
- **Storage.** Secrets are encrypted with AES-256-GCM using a versioned keyring, so keys can be rotated without downtime.
- **Visibility.**
  - Secrets are never returned by the API; it reports only `configured: true` and a masked hint.
  - They are never present in frontend bundles.
  - They are redacted in logs.
- **Process isolation.** OAuth tokens are decrypted only in the process that uses them.

## Outbound network
- Research fetches go through `SafeFetcher`. It allows only http(s) on ports 80 and 443, and blocks private, loopback and link-local IPs after DNS resolution and again on each redirect. It caps size and time, follows `robots.txt`, and never logs in or scrapes LinkedIn.
- Outgoing webhooks get the same public-address check, applied both when a webhook is saved and on every delivery, and they never follow redirects.

## Prompt-injection model
Content fetched from outside is data, not instructions (see 07). The model has no tools that change anything. Its outputs are schema-validated, and any action they lead to is applied by deterministic code with fixed rules.

## Audit
`audit()` writes the actor, action, entity, IP and request id. The table is append-only, enforced by database triggers (see 03).
