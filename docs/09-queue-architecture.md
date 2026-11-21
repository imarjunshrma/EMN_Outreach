# 09 — Queue architecture

BullMQ 6 on Redis (`QUEUE_PREFIX`, default `emn`). Redis must use `maxmemory-policy noeviction` (set by the installer).
Default job options: 3 attempts, exponential backoff from 5 s; completed jobs trimmed, failed jobs kept for the job monitor.
Every job payload carries `workspaceId` (UUID-validated); `processorFor()` records each run in `JobRun` and failures in `ErrorLog`.

| Queue | Jobs | Concurrency | Notes |
|---|---|---|---|
| `scheduler` | `campaign.tick` | 1 | Every 60 s (job scheduler `campaign-tick`) + on start/resume; Redis lock per campaign |
| `outbound-prepare` | `outbound.prepare` | 4 | Render, variant, review gate, fact-check gate |
| `send` | `outbound.send` | `WORKER_CONCURRENCY_SEND` (4) | Atomic claim, gates re-checked, reconciliation on ambiguity |
| `reply-send` | `reply.send` | 2 | Replies from the original mailbox, idempotency key |
| `mailbox-sync` | `sync.account`, `sync.pollAll`, `graph.renew` | 4 | Poll every 120 s (`mailbox-poll`), Graph subscription renewal every 12 h; per-mailbox sync lock, cursor commits only after ingestion succeeds |
| `ai` | `ai.classifyReply`, `ai.qualify` | 4 | |
| `research` | `research.lead`, `research.company` | 2 | SafeFetcher + optional search |
| `import` | `import.csv` | 1 | Streams the stored CSV, progress via SSE |
| `verify` | `verify.lead` | 2 | Configured verifier |
| `domain-health` | `domain.check`, `domain.checkAll` | 2 | Daily at 03:17 UTC |
| `maintenance` | `maintenance.retention`, `maintenance.taskReminders` | 2 | Retention nightly 02:43 UTC; task reminders every 5 min |
| `automation` | `automation.dispatch` | 2 | Rule evaluation for domain events |
| `webhooks` | `webhook.deliver` | 4 | Signed delivery, retries with backoff, delivery log |
| `privacy` | `privacy.export`, `privacy.erasure` | 2 | Export to storage; erasure + DO_NOT_CONTACT suppression |

## Idempotency rules
- Database uniqueness is the source of truth (`OutboundEmail(enrollmentId, stepId)`, event `dedupeKey`s,
  message `providerMessageId`), not job ids alone.
- Sends use an atomic `updateMany ... where status = QUEUED` claim; a sweeper re-enqueues rows stuck in
  `QUEUED`/`SENDING` and reconciles `SENDING` rows against the mailbox Sent folder via `X-EMN-Outbound-Id`.
- Schedulers are registered with `upsertJobScheduler` on every worker start (safe to restart / run twice).

## Operations
Settings → Jobs shows counts per queue and recent failures with a retry button (ADMIN). The worker drains
active jobs on SIGTERM (systemd `TimeoutStopSec=90`). Scale by raising concurrency or running a second
worker process on the same host — queues are safe for multiple consumers.
