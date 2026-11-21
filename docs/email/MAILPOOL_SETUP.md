# Mailpool setup

EMN uses the generic SMTP/IMAP connector for Mailpool. It does not hardcode Mailpool hostnames, ports, or TLS assumptions. Use the values displayed for the specific Mailpool inbox. Mailpool's guide places SMTP and IMAP host, port, username, password, and TLS settings in the inbox **Edit → Settings** panel: [Access Inbox Details](https://docs.mailpool.ai/en/articles/10749454-access-inbox-details).

## Manual controlled test

1. Select one Mailpool inbox whose provider status is active and whose settings allow external SMTP/IMAP use.
2. In Mailpool, open **Inboxes → Edit → Settings** and retrieve that inbox's actual SMTP and IMAP values. Do not copy credentials into tickets, chat, or source files.
3. In EMN, open **Workspace → Email Accounts → SMTP / IMAP**. Enter the address, SMTP host/port/TLS/username/password, and IMAP host/port/TLS/username/password. Use distinct values if Mailpool supplies distinct credentials.
4. Click **Test & connect**. Confirm the independent SMTP and IMAP statuses both pass. A failure should identify which side failed without displaying its credentials.
5. Wait for the initial background sync. Check **Mailbox Health** for the last successful sync, the two connection checks, and any actionable error.
6. To test inbound processing, use an independently controlled mailbox to send a test message to this inbox. Wait for the next sync and confirm the message appears in the EMN inbox. If testing a campaign reply, use a dedicated test contact and an approved test campaign with a mailbox you control; confirm the message, thread, contact and campaign association and that follow-ups stop.
7. If Mailpool exposes a Sent folder, confirm a controlled sent message is synchronized there. Sent-folder synchronization is optional; INBOX synchronization is the primary reply path.
8. Check the resulting health data. SMTP acceptance is not evidence of delivery or inbox placement.

Automated tests use mocks and do not send real email. This repository has not been live-tested with Mailpool credentials. The explicit EMN self-diagnostic also sends a message to the same mailbox; it is not required to verify the SMTP and IMAP login checks.
