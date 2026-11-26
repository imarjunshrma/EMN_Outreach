# Controlled email provider acceptance

Run this procedure only after an operator explicitly approves the provider, sending account, recipient addresses, send count, and test environment. Use isolated workspaces and mailboxes you control. Disable campaign automation and never use prospect addresses.

Record the provider, timestamp, Outvexa outbound ID, RFC Message-ID, provider ID, and observed outcome. Redact credentials and message content.

| Check | Procedure | Evidence classification |
| --- | --- | --- |
| Provider acceptance | Send one approved diagnostic to an owned mailbox and compare identifiers with the sender's provider record. | Provider accepted |
| Sent reconciliation | Compare the SMTP or Graph Sent copy and identifiers. Exercise an interrupted acknowledgment with a fixture. | Provider observed or locally simulated |
| Recipient delivery | Confirm the message in an owned recipient mailbox, independently of sender acceptance. Record folder placement only for this controlled recipient. | Recipient observed |
| Permanent and temporary failures | Use a provider-approved bounce address for a hard bounce and a local SMTP fixture for temporary errors. Verify suppression, bounded retries, and no resend after permanent failure. | Provider observed or locally simulated |
| Inbound reply | Send one reply from the owned recipient, then sync. Check threading, event attribution, and sequence stop using an isolated fixture. | Recipient and application observed |
| Unsubscribe | Use the approved test message's one-click POST. Replay it and verify suppression, attribution, and event deduplication. | Application observed |
| Pixel and link | Request the pixel and redirect with a browser, then replay them and send prefetch headers. Confirm the destination, raw click count, and estimated engagement. | Application observed |
| Webhook replay | Replay a captured test Graph change notification in isolation and compare the queued sync and stored message counts. Test invalid client state separately. | Provider observed or locally simulated |
| Mailbox pause and recovery | Simulate authentication and transient provider failures. Verify the account pauses and manual recovery rechecks connectivity before sending. | Locally simulated |

Record unsupported or unavailable provider signals as unknown. SMTP acceptance does not establish recipient delivery or inbox placement.

## Prerequisites

Use an isolated workspace and dedicated Gmail OAuth, Microsoft OAuth, or SMTP/IMAP credentials. For Microsoft change notifications, use a dedicated HTTPS callback and a fresh subscription client-state secret. Use an owned recipient and a provider-sanctioned bounce simulator. Before sending, approve the account, recipients, maximum send count, and spacing. Keep campaign automation off. Revoke test credentials and remove webhook subscriptions after recording results.

| Additional check | Procedure and expected result | Evidence classification |
| --- | --- | --- |
| Authentication and reconnect | Connect and sync each dedicated mailbox. Revoke its grant or invalidate its password, apply an operator hold, reconnect, and check the hold remains until a successful resume. | Provider-confirmed authentication, application-observed hold |
| Pacing and limits | Use the local scheduler fixture with two campaigns sharing one sender. For an authorized live diagnostic, record provider timestamps and stay below the separate approved test cap. | Fixture-tested campaign pacing, provider-observed diagnostic timestamps |
| Interrupted send and restart | Simulate loss just before and just after acceptance. Restart the worker. A positive Sent match finalizes once. A missing match leaves the send unresolved and prevents resubmission. Never induce an ambiguous live submission. | Locally simulated |
| Verification | On an owned test domain, create deliverable, nonexistent, catch-all, null MX, and no-MX-with-address cases. Use the workspace verifier and any separately approved verifier credentials. Record DNS results, SMTP responses if enabled, provider statuses, cache hits and expiry. For timeout and retry cases, prefer local fixtures. | DNS or provider-observed response, local timeout fixture |
| Verified versus reachable | Verify the UI labels SMTP acceptance as evidence with limitations. Verify DNS alone leaves mailbox existence unknown. Use a test message received by an owned account only as evidence for that message. | Fixture-tested and, separately, recipient-observed |
| Complaint feedback | Gmail API, Graph Mail and generic SMTP/IMAP have no authenticated complaint feedback integration here. Use a local reply fixture to exercise suppression and sequence stopping. | Provider feedback unsupported, reply behavior fixture-tested |

## Tracking and delivery definitions

Raw metrics count requests made while tracking is enabled. Unique pixel identifiers are outbound messages with a pixel hit. Unique links are tracking identifiers with a redirect hit. Estimated opens deduplicate by outbound message, and estimated clicks by tracked link. Known scanner and prefetch signals are counted separately. Privacy proxies and scanners can still resemble ordinary requests. The app shows lifetime tracking totals alongside explicitly time-filtered operational metrics. Raw pixel and suspected automated request counts begin when the counter migration is deployed.

Provider acceptance and a Sent copy support reconciliation. Neither confirms delivery to the recipient. Gmail API message submission, Microsoft Graph sendMail, and generic SMTP/IMAP do not supply a usable delivery or complaint event in the current integrations. Automatic cross-mailbox failover stays disabled for all three. Gmail and Graph Sent searches can lag, and SMTP servers need not retain a Sent copy. These paths have no verified cross-mailbox idempotency guarantee.

## Setup and approvals

1. Use a disposable database, isolated Redis queue prefix, and a dedicated HTTPS test deployment. Set `APP_URL` to that deployment. Keep campaign sending off. Record the approved sender, controlled recipients, test count, and approver in the operator's test record before making a provider call.
2. For Gmail, create a test OAuth client and register `APP_URL/api/v1/oauth/callback/google` as its exact redirect URI. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` through the deployment secret store and allow the dedicated test user in the consent screen. The requested scopes are `openid`, `email`, `profile`, `https://www.googleapis.com/auth/gmail.send`, and `https://www.googleapis.com/auth/gmail.modify`.
3. For Microsoft, register `APP_URL/api/v1/oauth/callback/microsoft`, set `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and `MICROSOFT_TENANT` for the test tenant, and grant delegated `User.Read`, `Mail.ReadWrite`, and `Mail.Send` plus `openid`, `profile`, `email`, and `offline_access`. Enable `GRAPH_WEBHOOKS_ENABLED` only in the dedicated test deployment if testing notifications. Check notification validation and rejection of incorrect client state before allowing the webhook into the acceptance run.
4. For SMTP/IMAP, use the operator's test account and provider-documented hosts, TLS modes, ports, credentials and Sent folder. Verify SMTP and IMAP independently from Mailboxes. Use the provider's authenticated submission port, commonly 465 for implicit TLS or 587 for STARTTLS, and IMAP over port 993 where supported. Do not use a fallback that sends unencrypted credentials.
5. Connect from Mailboxes and compare the returned mailbox identity with the approved test sender. Run sync, test refresh and reconnection, and verify the hold and health checks before resuming. Use only the approved one-message diagnostic or a separately approved controlled test path. Keep campaigns inactive. Use local failure injection for dropped responses, restarts, and throttling that would otherwise require deliberately disrupting live traffic.
6. Inspect the controlled recipient separately from the sender. Use multiple devices or browser profiles to replay a pixel and link, then compare raw, unique, suspected automated, and estimated counts. Run scanner and prefetch simulations separately and verify tracking-disabled requests preserve the link destination without recording activity.
7. Record UTC timestamp, provider, scenario, test-workspace ID, outbound ID, provider message ID if available, submission result, Sent observation, recipient observation, and acceptance decision. Keep addresses and confidential message data in the operator's restricted test records. Never log credentials, raw provider responses or OAuth tokens.
8. Disconnect test mailboxes, revoke test grants, remove Graph subscriptions, remove test-only OAuth credential mappings, and dispose of the test infrastructure under the operator's retention policy.

### Results for the 2026-11-26 run

Gmail, Graph, and SMTP/IMAP tests used fake adapters, mocked HTTP, or local SMTP protocol servers. The local configuration did not supply Gmail or Microsoft OAuth application credentials, and this session had no confirmed dedicated sender or controlled recipient for any provider. No live provider tests ran. Recipient delivery, provider throttling and revocation behavior, and live mailbox sync remain unverified. Provider feedback events remain unsupported by the existing integrations.

### Migration and recovery

The tracking SQL applies once through Prisma's migration ledger. Run `prisma migrate deploy` twice to verify the second deploy is a no-op. Do not rerun the raw SQL manually. Before deployment, take a custom-format backup of the intended source, verify it with `pg_restore --list`, and rehearse restore to a new database. Provision required extensions, including pgvector, under a database administrator before restoring with the application role. Restore with `pg_restore --exit-on-error --no-owner --no-privileges --dbname <new-empty-database> <backup>`. Add `--no-comments` if the restore role cannot alter extension comments. Stop writes and preserve the failed database for diagnosis if recovery is needed. Validate row counts, historical click data, new zero defaults, indexes, and migration status before switching the application to a restored database. See the [deployment and recovery guide](../saas/DEPLOYMENT_AND_RECOVERY_GUIDE.md).

The disposable rehearsal passed at 2026-11-26 08:02:23 UTC. The fixture had two workspaces, one campaign, one mailbox, one prospect, one outbound, one tracked link with historical clicks, and four events. The migration preserved every legacy field in those records, added both indexes, and initialized all new counters to zero. A second deploy was a no-op. Restoring the verified pre-migration archive into a separate empty database and reapplying the migration produced the same result.

### Future failover design

Require provider-backed proof of non-submission. An empty Sent search, timeout, or lost acknowledgment leaves the attempt ambiguous and blocks failover. Keep the original prospect, campaign, sequence step, outbound ID, and message identifier. Under an atomic outbound claim, serialize retries across workers and mailboxes and persist the provider evidence before considering another sender. Recheck suppression, current approval and sender limits, reputation and cooldown. Record the old and proposed mailbox, evidence class and decision reason in the workspace audit history. Require per-adapter contract tests with real acceptance evidence before enabling the capability. Current configuration keeps it disabled for every adapter.

## Operator send reconciliation

Open **Mailbox health → Send reconciliation** as a workspace administrator. The open queue lists attempts whose provider submission could not be established. Compare the mailbox, prospect, campaign, attempt number, Message-ID, timestamps and retry history with the controlled provider's Sent folder or incident reference. An empty lookup leaves the attempt uncertain. Do not use it as evidence for **Confirmed not submitted**.

Choose **Confirmed accepted or submitted**, **Confirmed not submitted**, **Still uncertain**, or **Close with insufficient provider evidence**. Confirmed decisions require a provider evidence reference. Enter a reason and redact credentials and message content. Use **Show closed reviews** to inspect who made the decision and when. Operator decisions are attestations and do not synthesize a SENT event, unblock the original sequence, or authorize a resend. A worker that receives an actual matching Sent record can finalize a still-open attempt once. It does not restart an enrollment held due to the ambiguity.

## Preflight and migration for reconciliation

- Run `node --import tsx scripts/provider-acceptance-preflight.ts` in the isolated test deployment. It prints missing configuration names only and cannot connect to a provider. Supply the provider's controlled sender identifier, the controlled recipient, and `OUTVEXA_ACCEPTANCE_APPROVAL_REF` from the operator's test record. SMTP/IMAP credentials, TLS settings, and Sent folder still need to be entered through Mailboxes. A successful preflight only checks configuration presence.
- Before restoration, point `DATABASE_URL` at the empty restore target and run `node --import tsx scripts/db-preflight.ts`. The API and worker perform the same extension check at startup. For an empty target, have a database administrator use PostgreSQL connection settings to run `bash scripts/provision-pgvector.sh --confirm-database <target>`. This does not grant the application role administrator privileges. Verify the preflight with the application role before restoring.
- Stop old workers and take a verified backup before applying the two reconciliation migrations. The first deploy adds the enum value. The second adds the queue index and review fields and backfills previously failed sends with the known uncertainty marker. Deploy the updated API and workers together. Older binaries may not read the new state. For rollback, stop writes, preserve the affected database, and restore a verified backup into a separate extension-ready database. Review the recovery point and any intervening writes before switching.
