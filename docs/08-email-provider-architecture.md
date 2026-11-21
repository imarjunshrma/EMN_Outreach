# 08 — Email provider architecture and sending engine

## Adapters (`integrations/src/email/*`, interface `EmailProvider`)
| Provider | Auth | Send | Sync | Notes |
|---|---|---|---|---|
| Google Workspace | OAuth 2.0 + PKCE, scopes `gmail.send`, `gmail.modify` (+ openid/email/profile) | `users.messages.send` with raw MIME (keeps threadId) | `history.list` since the stored historyId, with full resync if it expired | `gmail.modify` is a restricted scope (see INSTALLATION.md) |
| Microsoft 365 | OAuth 2.0 + PKCE, `Mail.ReadWrite`, `Mail.Send`, `User.Read`, `offline_access` | `sendMail` with a MIME body (keeps custom headers) | Delta query on Inbox and Sent, plus optional change-notification subscriptions renewed every 12 h | Admin consent may be required |
| SMTP + IMAP | Encrypted per-protocol username/password (shared credentials remain accepted) | Nodemailer SMTP | IMAP (imapflow), UID-based with optional special-use Sent-folder discovery | Reconciliation needs a Sent-folder copy |

- Tokens are refreshed under a Redis lock so concurrent jobs don't race.
- If a refresh fails, or a provider returns 401, the mailbox is set to `NEEDS_REAUTH` and its sends wait.
- SMTP and IMAP credentials are verified independently and their separate last-check results are shown in mailbox health. Raw provider response text and connection configuration are not exposed in account APIs.
- MIME is built with nodemailer's MailComposer and includes Message-ID, In-Reply-To/References for follow-ups in the same thread, `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058), and `X-EMN-Outbound-Id`.

## Sending engine (`backend/src/services/engine.ts`)
**Approval.**
- `validateCampaign` checks that the sequence has steps, senders are connected, an audience exists, the workspace has a postal address, the unsubscribe placeholder is present, templates lint cleanly, and limits are sane.
- `approve` stores a SHA-256 hash of all step/variant content and settings. Any later edit moves the campaign back to `PENDING_APPROVAL`, and the tick pauses a running campaign whose hash no longer matches.

**Enrolment.**
- Starting a campaign enrols the eligible leads from its lists.
- Each enrolment gets **one fixed sender**, the least-loaded connected campaign mailbox at enrolment time, and keeps it for the whole sequence. There is no rotation.
- The first step is scheduled at the next window opening in the lead's time zone, or the campaign's time zone if the lead's is unknown.

**Tick (every 60 s, Redis-locked).** For each due active enrolment, the tick checks:
- the campaign window and the mailbox's own window
- daily new-lead and send limits for the campaign
- the mailbox daily limit and minimum spacing (default 180 s)
- step conditions (e.g. "only if no reply")

It then creates the `OutboundEmail` (unique per enrolment+step) and enqueues prepare.

**Prepare.**
- Render the variables. Any unresolved variable fails the email.
- Pick the A/B variant deterministically per lead.
- Apply the review mode (`NONE`, `AI_CONTENT_ONLY`, `ALL`). An email waiting for review stays PENDING until it is approved.
- If the campaign requires it, the fact-check must have passed.
- Optional tracking rewrites are applied (off by default).

**Send.** Every gate is re-evaluated at this point, because state can change between prepare and send:
- campaign running and hash intact
- enrolment active
- approval present
- mailbox connected
- `canContact` (suppression by email/domain, lead status, verification, compliance rule + lawful basis, postal address)
- no reply received
- send window
- daily limits and spacing

Then the row is atomically claimed (`QUEUED→SENDING`), sent and finalised (`SENT`, message ids, next step scheduled). On failure:
- 4xx → `FAILED`
- 401 → mailbox `NEEDS_REAUTH`
- 5xx or timeout → the row stays `SENDING` and the sweeper reconciles it by looking up `X-EMN-Outbound-Id` in Sent before retrying, so a crash can never cause a double send. For SMTP mailboxes, where a Sent copy isn't guaranteed, an ambiguous send that can't be found is marked FAILED rather than retried.

**Auto-pause** triggers when:
- the bounce rate is ≥ `maxBounceRatePct` (default 5 %) after at least 20 sends
- complaints reach `maxComplaints` (default 1)
- the content hash doesn't match
- every sender is disconnected

## Sync and replies (`accounts.syncAccount`, `inbox.ingest`)
- **Polling.** Every 2 minutes for all connected mailboxes, deduplicated by a job id per minute bucket and serialized per mailbox with a Redis lock. Graph push, when enabled, triggers an extra sync.
- **Threading.** In-Reply-To/References are matched against stored Message-IDs first, then the provider thread id. Messages that don't match create a new conversation.
- **Bounces.** DSN (`multipart/report`, `message/delivery-status`) or mailer-daemon heuristics. A bounce marks the outbound email bounced, sets the lead's verification to INVALID for hard bounces, adds a suppression entry and counts toward auto-pause.
- **Auto-replies.** Detected from `Auto-Submitted`, `X-Autoreply`, `Precedence` and OOO patterns. An auto-reply does not stop the sequence unless the campaign has `stopOnAutoReply`.
- **Any human reply** stops the lead's active sequences (`stopOnReply`, default on) as soon as it is ingested. Classification then applies these deterministic effects:

| Category | Effect |
|---|---|
| UNSUBSCRIBE (or any reply with unsubscribe intent) | suppression entry, lead status UNSUBSCRIBED, unsubscribe event |
| COMPLAINT | suppression, complaint event (counts toward auto-pause), notification to managers |
| INTERESTED / WANTS_MEETING / WANTS_PRICING / NEEDS_INFO | lead status INTERESTED, notification. The user creates the opportunity from the thread (one click). |
| NOT_INTERESTED / HAS_PROVIDER | lead status NOT_INTERESTED |
| OUT_OF_OFFICE | if the reply had stopped a running sequence in the last 2 days, that sequence is re-activated with the next step in 3 days (no return-date parsing) |
| WRONG_PERSON / OTHER | no automatic effect beyond stopping the sequence; visible in the inbox filter |

- Users can override the category, and an AI reply draft is only a suggestion until a person sends it.
- **Replies** are always sent from the mailbox that holds the conversation, through the `reply-send` queue (idempotent).

## Not available / not done
- No warm-up, no mailbox rotation, no inbox-placement promises.
- No feedback-loop complaints for mailbox sending.
- Open and click data are estimates.
