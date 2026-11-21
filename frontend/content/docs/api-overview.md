---
title: API overview
section: Developers
order: 1
description: Authentication, tenancy, request conventions, errors, pagination and rate limits.
---
The REST API is the same one the web app uses. Every request and response is JSON over HTTPS, under `/api/v1` on your installation's address.

## Authentication

### API keys (server-to-server)

Create a key in a workspace under **Settings → API keys**, then send it as a bearer token:

```bash
curl https://app.example.com/api/v1/w/$WORKSPACE_ID/leads \
  -H "Authorization: Bearer emn_ab12cd34_…"
```

A key is bound to **one workspace**. It works only on `/w/{workspaceId}/…` endpoints of that workspace, with the role and scopes it was created with. Organization, billing, account and platform endpoints do not accept API keys.

### Sessions (browser)

The web app uses an HTTP-only session cookie. State-changing requests (POST, PUT, PATCH, DELETE) must also send the value of the `emn_csrf` cookie in an `X-CSRF-Token` header.

## Tenancy in URLs

| Prefix | Scope | Example |
|---|---|---|
| `/w/{workspaceId}` | One workspace | `/w/{workspaceId}/campaigns` |
| `/orgs/{organizationId}` | One organization | `/orgs/{organizationId}/billing` |
| `/auth`, `/public` | The caller, or nobody | `/auth/me`, `/public/plans` |

> [!security]
> The ids in the path select what you are asking for; they never grant access. The server checks your membership for every request, and a workspace or record you cannot access answers `404 NOT_FOUND`, exactly as if it did not exist.

## Requests

- Send JSON with `Content-Type: application/json`.
- Unknown fields are ignored; invalid fields return `400 VALIDATION_FAILED` with a `details` array of `{ path, message }`.
- Dates are ISO 8601 in UTC.

## Pagination

List endpoints accept `page` (from 1) and `pageSize` (usually up to 100) and return:

```json
{ "data": [ … ], "page": 1, "pageSize": 25, "total": 312, "totalPages": 13 }
```

## Errors

```json
{ "error": { "code": "QUOTA_EXCEEDED", "message": "Your plan allows 3 mailboxes.", "details": null, "requestId": "b0c7…" } }
```

Match on `code`. The full list is in the [API reference](/docs/api#errors). Include `requestId` when you contact support.

## Rate limits

Sensitive endpoints have their own limits, shown on each endpoint in the reference. API-key traffic is also limited per organization per minute and per month according to the plan. When limited you get `429 RATE_LIMITED` with a `Retry-After` header in seconds; `X-RateLimit-Remaining` shows what is left in the window.

## Retries and idempotency

Creating a lead whose email already exists in the workspace returns `409 CONFLICT` instead of a duplicate, so a retried create is safe. Sign-up accepts an `idempotencyKey`, so retrying the same request returns the organization it already created. For other POST requests, retry only after checking the result with a GET.
