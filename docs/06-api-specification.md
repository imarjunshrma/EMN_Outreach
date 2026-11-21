# 06 — API specification

The complete, generated reference is **`../API_DOCUMENTATION.md`** (method, path, auth/role, rate limit,
body and query fields for all 169 operations) and **`openapi.json`** (OpenAPI 3.1, also served at
`GET /api/v1/openapi.json`). Both are generated from the route registry, so they cannot drift from the code:
`npm run openapi && npm run api-docs`.

## Conventions
- Base `/api/v1`. Workspace resources: `/api/v1/w/:workspaceId/...` *(changed from plan: the workspace is in
  the path rather than an `X-Workspace-Id` header — explicit, cache-safe, easy to authorise)*.
- JSON in/out; Zod validation on body, query and params → `400 VALIDATION_FAILED` with per-field details.
- Auth: session cookie + `X-CSRF-Token` for browsers; `Authorization: Bearer emn_<prefix>_<secret>` for API keys.
- RBAC per route: `OWNER > ADMIN > MANAGER > MEMBER > VIEWER`; non-members get `404`.
- Pagination *(changed from plan: offset instead of cursor)*: `?page&pageSize` → `{ data, page, pageSize, total, totalPages }`.
- Errors: `{ error: { code, message, details?, requestId } }`; codes listed in `API_DOCUMENTATION.md`.
- Mutations that start long work return `202` with a job/resource id; progress arrives over SSE and is
  visible in the job monitor.
- Idempotency: sending and replying are idempotent server-side (unique keys + atomic claims), so client retries are safe.

## Route groups (tags, 30)
AI, API keys, Analytics, Auth, Automation, Campaigns, Companies, Compliance, CRM, Deliverability, ICP,
Imports, Inbox, Integrations, Jobs, Leads, Lists, Logs, Mailboxes, Notifications, Privacy, Prospecting,
Qualification, Research, Sending, Suppression, Team, Webhooks, Workspaces, Writing.

## Public endpoints
OAuth callback, Graph notifications, booking webhook (HMAC), one-click unsubscribe (signed token),
optional open/click tracking, health checks — see the table in `API_DOCUMENTATION.md`.
