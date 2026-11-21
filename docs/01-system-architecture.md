# 01 — System architecture

## Processes

| Process | Code | Binds | Role |
|---|---|---|---|
| `emn-web` | `frontend/` (Next.js 15, `next start`) | 127.0.0.1:3000 | Basic UI. Client components call the API with `fetch` and TanStack Query. No secrets reach the browser. |
| `emn-api` | `backend/src/main.ts` (Express 5) | 127.0.0.1:4000 | REST API, auth, validation, RBAC, OAuth callbacks, public endpoints (unsubscribe, tracking, webhooks), SSE. It enqueues work but never sends email directly. |
| `emn-worker` | `worker/src/main.ts` (BullMQ) | none | All slow or external work: sending, mailbox sync, AI, research, imports, verification, DNS checks, webhooks, privacy jobs, retention. It also registers the repeatable schedules. |
| PostgreSQL | — | 127.0.0.1:5432 | System of record (Prisma 7, `@prisma/adapter-pg`). Uses two roles: an owner for migrations and an app role at runtime. |
| Redis | — | 127.0.0.1:6379 | BullMQ queues, rate limits, locks (token refresh, campaign tick), and pub/sub for realtime events. |
| Nginx | `deployment/nginx/emn.conf` | :80/:443 | TLS, HSTS, per-IP rate limits. Routes `/api` to the API (SSE unbuffered) and everything else to the web UI. |

Changed from plan: there is no Docker, no S3 and no separate object store. Files are written through `LocalDiskStorage`, which guards against path traversal, at `STORAGE_ROOT`. Because storage sits behind an adapter interface, an S3-compatible adapter can be added later.

## Main flows

1. **Lead in.** Leads arrive by CSV upload (`import.csv` job), Apollo search and import, or manual entry. All three paths dedupe by normalised email per workspace, record a lead source and lawful basis, and can optionally run verification (`verify.lead`).
2. **Research.** `research.lead` and `research.company` call the SafeFetcher on the company site (respecting robots.txt, SSRF-guarded) plus an optional web search. The AI extracts facts, keeping each fact only if its exact quote appears in the evidence text. The result is `ResearchReport`, `ResearchEvidence` and `ResearchClaim` rows marked SUPPORTED, UNSUPPORTED or CONFLICTING. The lead is then scored against the ICP.
3. **Write.** The `EMAIL_WRITING` task sees only SUPPORTED claims plus the workspace's "offer facts". A separate `FACT_CHECK` task re-checks the draft. Unresolved `{{variables}}` or a failed check block approval.
4. **Campaign.** You build the sequence, audience and senders, then the campaign is validated and approved. Approval stores a content hash of all steps and variants. Starting the campaign enrols leads, and each enrolment gets one fixed sender (the least-loaded at enrolment time).
5. **Send loop.** Every 60 s, `campaign.tick` finds due enrolments inside their windows and limits, creates one `OutboundEmail` per (enrollment, step), and enqueues `outbound.prepare`. That job renders the message, re-checks every gate and enqueues `outbound.send`. `outbound.send` atomically claims the row (moving it from QUEUED to SENDING), sends it through the mailbox adapter and finalises it. A sweeper re-enqueues stuck rows. If a crash leaves the outcome ambiguous, the sweeper reconciles it by looking up the `X-EMN-Outbound-Id` header in the Sent folder.
6. **Replies.** Polling (every 2 min) or Graph push runs `sync.account`, which matches threads using In-Reply-To/References and then the provider thread id. It also detects bounces and auto-replies. `ai.classifyReply` sorts each reply into one of 11 categories with a keyword fallback for opt-outs. Deterministic effects follow: suppression, lead status changes, opportunities, stopping or resuming the sequence, and notifications. Each new reply is published over SSE.
7. **Downstream.** Automation rules and outgoing signed webhooks react to domain events. Inbound booking webhooks mark a lead as MEETING_BOOKED.

## Realtime
The API subscribes to the Redis channel `events:<workspaceId>` and streams it to browsers over SSE at `GET /api/v1/w/:ws/events`. The UI invalidates its queries when an event arrives.

## Failure model
- Every job is idempotent and retried 3 times with exponential backoff. Each run is recorded in `JobRun`, and failures are recorded in `ErrorLog`.
- On provider errors: a 401 marks the mailbox `NEEDS_REAUTH`, and that mailbox's sends wait until it is reconnected. Other 4xx errors fail that one email. 5xx errors and timeouts are retried or reconciled.
- The API and the worker are stateless, so restarting either is safe. The worker drains active jobs when it receives SIGTERM.
