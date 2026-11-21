# 04 — Backend modules

All business logic is in `backend/src/services/*`. Routes (`backend/src/routes/*`) are thin declarations
handled by the route registry; the worker calls the same services.

| Service | Responsibility | Important invariants |
|---|---|---|
| `auth` | Register/bootstrap, login, sessions, CSRF tokens, password change, session revocation | argon2id, constant-time unknown-user path, hashed session tokens |
| `workspace` | Workspace settings, members, roles, invitations, API keys, secret encryption helpers, unsubscribe tokens | last OWNER cannot be removed/demoted; defaults (compliance rules, prompts) seeded on create |
| `leads` | Leads, companies, lists, notes, bulk actions, CSV import (map/preview/commit as job) and export | dedupe by normalised email; formula-injection guard on export; status history recorded |
| `intelligence` | ICPs (manual / AI from text), prospect search/import (Apollo), verification, research, scoring, email generation, fact-check, subject lines, lead variables | research only from public pages via SafeFetcher; claims require exact quotes; writer only sees SUPPORTED claims |
| `ai` | Orchestrator `runAi`: provider + route resolution, prompt versions, schema validation + one repair retry, fallback provider, budgets, cost logging | untrusted content wrapped; budget exceeded → `AI_BUDGET_EXCEEDED` |
| `accounts` | OAuth start/callback (PKCE, signed state), SMTP/IMAP connect, token refresh under Redis lock, sync, Graph subscriptions | 401 → `NEEDS_REAUTH`; tokens encrypted |
| `engine` | Campaign lifecycle (validate, approve, start, pause, resume, stop), tick, prepare, send, finalise, reconciliation, auto-pause | gates re-checked at send; content hash; fixed sender; idempotent claim; no rotation |
| `inbox` | Ingest messages, thread matching, bounce/auto-reply handling, classification effects, replies, AI reply drafts, summaries | replies sent from the original mailbox; AI drafts never auto-sent |
| `crm` | Opportunities, pipeline, tasks, reminders, timeline | |
| `automation` | Rules (trigger, conditions, actions) and runs | actions limited to internal effects + webhook |
| `webhooks` | Outgoing webhooks: create/test, signed delivery with retries | public-URL check at save and at delivery; no redirects |
| `compliance` | Country rules, `canContact` evaluation, suppression add/remove/import | restricted countries need explicit review to enable |
| `integrations` | Provider credentials (Apollo, MillionVerifier, Brave, Serper, Smartlead, booking) + test | secrets never returned |
| `analytics` | Campaign/mailbox/step metrics, AI usage | tracking metrics flagged as estimates |
| `ops` | Dashboard, domains + DNS checks, jobs, logs, notifications, privacy export/erasure, retention, tracking endpoints, booking webhook, suppression export | erasure keeps a DO_NOT_CONTACT suppression hash entry |

Core: `config` (zod-validated env), `logger` (redaction), `db`, `crypto`, `errors`, `storage`, `redis`
(locks, sliding-window rate limits), `queues`, `audit` (audit rows, error log, SSE publish, notifications),
`container` (adapter injection; tests swap in fakes via `setAdapters`).
