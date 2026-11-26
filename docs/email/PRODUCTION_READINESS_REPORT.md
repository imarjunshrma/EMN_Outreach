# Outvexa production readiness

**Verdict: READY FOR CONTROLLED PROVIDER TESTING.** The disposable restore rehearsal and synthetic acceptance checks support proceeding to dedicated test mailboxes once an operator supplies and authorizes them.

| Area | Local evidence | Real-provider evidence |
| --- | --- | --- |
| Gmail API | Mocked OAuth and API calls, synthetic throttling, Sent reconciliation and empty lookup safety | Pending dedicated mailbox and OAuth client |
| Microsoft Graph | Mocked sendMail acceptance, Sent lookup and authenticated notification replay | Pending test tenant, mailbox and callback |
| SMTP/IMAP | Local protocol stubs, injected submission failures, explicit recipient rejection and ambiguous outcome handling | Pending dedicated submission and IMAP account |
| Send safety | Atomic send claim, retry and reconciliation fixtures, workspace isolation, and submission decision audit trail | Pending controlled provider timings and error handling |
| Mailbox health | Bounce threshold, cooldown, operator hold, credential recovery and shared send-limit fixtures | Pending live connectivity, revocation and refresh checks |
| Tracking | HTTP and browser checks for request counters, deduplication, attribution and tracking settings | Pending controlled inbox, scanner and multiple-device observations |
| Migration recovery | PostgreSQL migration, repeat deploy and pre-migration backup restored into separate disposable databases | Production database outside this rehearsal |

## Submission and delivery evidence

An outbound claim records an attempt. Gmail API success or SMTP acceptance records provider acceptance. Graph sends an asynchronous acknowledgment and can populate message identifiers later. A Sent-folder match supports reconciliation. Recipient delivery requires independent observation or an authenticated provider event tied to the outbound ID. The current integrations expose no provider-confirmed delivery or complaint feed. SMTP rejection and correlated delivery-status notifications can support bounce classification. Reply detection and reply-detected complaint intent are application signals and do not represent provider-confirmed complaint feedback.

Raw tracking counts measure requests. The unique identifiers count is per outbound pixel or tracked link, rather than per person or device. Scanners and privacy proxies can resemble ordinary browser traffic. Estimated engagement can overcount or undercount human activity. The raw pixel and automated request counters begin at migration deployment.

## Operational risks

- **Critical before external outreach** Complete dedicated-account acceptance for Gmail, Graph and SMTP/IMAP, including actual refresh and revocation, observed Sent visibility, recipient checks and sync checkpoint progression.
- **High** A first empty Sent lookup ends automated send recovery. Delayed provider visibility can leave a genuine submission unresolved. Operators must reconcile manually before considering another send. Automatic cross-mailbox failover stays disabled for all providers.
- **High** The Retry-After change covers definitive same-mailbox submission rejections carrying that header. Provider-specific throttling for all other API operations still needs controlled measurement.
- **High** Provider-confirmed delivery or complaint reporting requires an authenticated event capability that exposes authoritative event IDs and a stable message correlation key. Use verified signatures, workspace routing, deduplication and suppression before counting such events.
- **Operational** Submission decisions are written using whitelisted metadata. Audit persistence is best-effort, and a process crash during audit or finalization can leave an incomplete trail. Review audit write failures during the controlled pilot. Existing tracking counters store aggregate classifications.
- **Operational** Recovery was rehearsed with a local synthetic archive. On production-like infrastructure, repeat the backup and restore drill with the intended roles, extensions, data volume, and a measured recovery window.

## Release sequence

1. Confirm ownership and explicit authorization for the test mailboxes, recipients, and send limit. Provision the isolated OAuth clients and callback and record each provider result separately.
2. Resolve provider-specific risks observed in those tests. Keep failover and campaign automation disabled during the controlled checks.
3. Rehearse the intended deployment and restore on a production-like database. Review the backup and migration ledger, then obtain a separate rollout approval.

Use the [controlled provider acceptance procedure](CONTROLLED_PROVIDER_ACCEPTANCE.md) for setup, logging, cleanup, and database recovery. Neither production data nor live provider accounts were used in this run.

## Database evidence

The rehearsal used `emn_outvexa_rehearse_1795680141317` and `emn_outvexa_rehearse_1795680141317_restored` on local PostgreSQL. The first restore attempt exposed a required dependency: the application role cannot install pgvector in an empty database. Provisioning it with the local administrator before restore resolved the failure. The final comparison verified both tracking indexes, zero-initialized counters, preserved historical clicks, and equality of every legacy field across the seven fixture tables. No schema migration was added or edited in this pass.

## Software verification

The isolated run passed 240 integration tests across 26 files, 187 unit tests across 25 files, and four Playwright acceptance tests. Backend and frontend typechecks and builds and Prisma schema validation passed. Maintained-source lint reported zero errors and 23 warnings. The frontend has no separate unit-test command, so the frontend checks were the build, typecheck, lint and Playwright run.

## One-phase reconciliation update

The admin reconciliation queue is implemented. Ambiguous submissions persist as `UNCERTAIN` and retain their attempt and mailbox identity. The API atomically records the reviewer, timestamp, decision, evidence reference and audit entry. Operator decisions never queue a send, resume an enrollment, or create a delivery claim. Empty Sent lookups block automatic resend. A positive provider match can still finalize an open attempt; unresolved attempts remain visible when the worker restarts. First and repeated uncertain sends produce workspace admin notifications, and retry history shows the provider response class and throttling decisions.

API and worker startup now require the pgvector extension. A disposable rehearsal used the application role to prove that an empty database fails preflight. A local administrator provisioned pgvector, after which application-role backup restoration and re-migration succeeded. The rehearsal backfilled a legacy uncertain send and preserved its tracking links. The second deployment was a no-op. No production database was used.

The configuration-only provider preflight found no confirmed dedicated Gmail, Graph, or SMTP/IMAP sender, controlled recipient, or approval reference. Gmail and Graph OAuth test-client credentials and an isolated HTTPS origin are also absent. These are the external prerequisites for live evidence. Automatic mailbox failover remains disabled.

Final isolated re-verification passed 241 integration tests across 26 files, 187 unit tests across 25 files, and five browser tests. The reconciliation checks covered administrator authorization, cross-workspace isolation, concurrent close actions, an empty Sent lookup, and no resend after an operator decision. Backend and frontend typechecks and builds, Prisma validation and Git whitespace checks passed. Maintained-source lint reported zero errors and 23 warnings.
