# Email warm-up and mailbox-health audit

Audit date: 2026-11-21. This audit checked the current Prisma schema, provider integrations, services, route registry, workers, navigation, billing and tests.

## Existing components reused

- `EmailAccount` and `ProviderCredential` provide workspace ownership and encrypted OAuth/password credentials. OAuth flows, refresh locks, revocation and disconnect handling are in `backend/src/services/accounts.ts`.
- Gmail, Microsoft Graph, and SMTP/IMAP send/sync adapters are already implemented under `integrations/src/email`. Existing inbound messages are ingested by `backend/src/services/inbox.ts`; Graph webhook notifications enqueue the existing mailbox-sync queue.
- BullMQ/Redis worker infrastructure is centralized in `backend/src/core/queues.ts` and `worker/src`. Existing queue names include send, mailbox sync and domain health.
- Existing campaign sending has mailbox/campaign daily limits, send intervals, opt-out and compliance checks in `backend/src/services/engine.ts`.
- Domain authentication checks and history exist in `backend/src/services/domains.ts`; provider capability disclosures exist in `shared/src/provider-registry.ts`.
- Workspace-scoped mailbox-health API and UI already exist at `GET /api/v1/w/:workspaceId/mailbox-health` and `/w/[ws]/mailbox-health`. Mailbox, domain and mailbox-health screens are linked in navigation.
- Subscription entitlements already gate mailbox connection. No warm-up-specific plan feature exists.

## Safety boundary

The requested shared network would automate reciprocal messages and replies between participating mailboxes. In this context, repeated automated engagement is designed to alter sender-reputation or spam-placement signals even when the participants know the messages are automated. That conflicts with this prompt's own prohibition on artificial engagement and reputation manipulation. The automated pairing, message exchange, replies, and ramping traffic to build reputation are therefore not implemented. No provider credentials, mailboxes, queues, migrations, or existing volumes were changed for such a network.

Google's current sender guidance requires accurate identity/content and focuses on wanted mail, authentication, and recipient-reported spam; it says bulk senders should monitor Postmaster Tools and does not promise placement ([Gmail sender FAQ](https://support.google.com/mail/answer/14229414), [Gmail sender guidelines](https://support.google.com/mail/answer/81126)). A warm-up exchange is not a substitute for these controls.

## Implemented in this change

- Added a deterministic health classification derived only from observed mailbox authorization/status, domain health/verification, sync recency, provider-error recency, complaints, hard-bounce rate, and whether a 30-day sent sample exists.
- Added explicit Healthy, Monitoring, Warning, Paused, and Disconnected statuses with reason text and a disclaimer that inbox placement is not measured.
- Surfaced the health classification in the existing workspace mailbox-health dashboard.
- Added an explicit ADMIN-only, workspace-scoped, rate-limited self-delivery diagnostic. It sends one transparent message from an authorized mailbox to that same mailbox, records provider acceptance in the audit log, and never asks for or fabricates engagement.
- Added unit tests for status classification and an integration test for self-only addressing and tenant isolation. No new database tables, message queues, or provider scopes were added; outbound behavior is limited to an explicit one-off self-test.

## Not available

- No shared network or pairing history; no automated warm-up sends/replies; no mailbox-to-mailbox automated message matching.
- The self-delivery diagnostic is a one-off operational test, not a scheduled warm-up or reputation feature.
- No Google Postmaster Tools connector. Its account/domain authorization and provider-side measurements are not configured here.
- No Microsoft or SMTP-specific independent reputation or spam-folder measurement.
- No global network administrator controls or warm-up billing plan. Existing platform admin, subscription and audit systems remain unchanged.

## Status thresholds

- Paused maps to Paused; disconnected or reauthorization-required maps to Disconnected.
- A provider connection state outside CONNECTED, a recent provider error (24 hours), a stale sync over 24 hours, any complaint, or hard-bounce rate at/above 2% maps to Warning.
- Missing 30-day send sample, missing/unknown/unverified domain health, or sync older than 6 hours maps to Monitoring unless a Warning condition takes precedence.
- Healthy means only that measured connection/domain/sync and recent sending indicators passed these application checks; it is not an objective deliverability score.

Thresholds are explainable product guardrails, not provider limits or guarantees. Provider quota remains unavailable through the existing APIs and daily send limits remain workspace settings.
