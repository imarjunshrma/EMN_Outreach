---
title: Security model
section: Security & operations
order: 1
description: How tenants are isolated, how access is decided, and how credentials and staff access are handled.
---
## Isolation between customers

Each customer is an **organization**. Every workspace belongs to exactly one organization, and every business record — leads, campaigns, messages, mailboxes, domains, AI knowledge, files, API keys, integrations, usage and invoices — belongs to one workspace or directly to the organization.

Isolation is enforced at four layers:

| Layer | Mechanism |
|---|---|
| Request | Every request resolves the caller's membership from the session or API key. Ids in the URL are only selectors. Records outside the caller's scope answer `404`. |
| Query | Every data access is filtered by the workspace (or organization) resolved for the request, never by an id from the body. |
| Database | Triggers reject any row that references a record in a different workspace, and a workspace can never be moved to another organization. |
| Background jobs | Each job carries its workspace; the worker re-checks the organization's status before running work that costs money or contacts third parties. |

Redis keys for rate limits and fair-use slots include the organization or workspace id. Uploaded files and exports are stored under a per-workspace prefix and served only through authenticated endpoints.

> [!note]
> PostgreSQL row-level security was evaluated and is **not** used: the application connects through a connection pool without a per-transaction tenant context, so RLS policies would give a false sense of protection. The layers above are what enforce isolation, and the automated test suite exercises them with separate tenants.

## Accounts

- Passwords: Argon2id; at least 12 characters with letters and numbers.
- Sessions: random tokens in HTTP-only, `SameSite=Lax` cookies, a new session on every sign-in, other sessions revoked when the password changes; CSRF tokens on every state-changing request.
- Two-factor authentication with TOTP and one-time recovery codes; workspaces can require it.
- Email verification before inviting others or starting campaigns.

## Credentials

Mailbox tokens, SMTP passwords, AI keys, DNS tokens and integration secrets are encrypted with AES-256-GCM using a key held outside the database, support key rotation, and are never returned by the API. Platform-level credentials (for example the payment provider keys) live only in the server environment and are separate from customer credentials.

## Staff access

EMN staff have platform roles (Super admin, Support, Finance) that are separate from customer roles. Staff cannot open a customer's workspace by default. Support access requires a **grant** for one organization, with a written reason, for at most four hours. Granted access is read-only, recorded in the customer's audit log, and every page viewed is recorded in the platform audit log, which cannot be edited or deleted.

## Web security

Strict Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`, a strict referrer policy, same-origin CORS, and rate limits on sign-in, sign-up, password reset and other sensitive endpoints. Inbound webhooks from payment and booking providers are verified by signature and processed once.
