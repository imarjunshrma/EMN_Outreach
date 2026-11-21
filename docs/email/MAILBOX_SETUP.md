# Mailbox setup

EMN supports Google and Microsoft mailboxes through OAuth and SMTP/IMAP mailboxes where the provider permits those protocols. Use OAuth for Google Workspace and Microsoft 365; do not replace OAuth with passwords.

## Connect

1. Open **Workspace → Email Accounts** as an administrator.
2. Choose Google, Microsoft, or **SMTP / IMAP**.
3. For SMTP/IMAP, enter the exact hosts, ports, TLS settings, usernames, and passwords shown by the mailbox provider. SMTP and IMAP credentials may differ.
4. Choose **Test & connect**. EMN verifies SMTP and IMAP independently and only reports success when both checks pass.
5. Check the mailbox status and the separate SMTP/IMAP results. A successful connection test does not measure inbox placement.

Successful connection queues initial synchronization. Later synchronization runs through the existing BullMQ `mailbox-sync` worker every two minutes. The mailbox page's **Resync** action resets the cursor and queues a full sync.

## Operations

- **Test connection** performs provider authentication checks; it does not send a message.
- **Pause** stops campaign sending from that mailbox. Sync continues for connected and paused mailboxes so replies and unsubscribes can still be processed.
- **Resume** is available for manually or automatically paused mailboxes. Reconnect a mailbox in `ERROR` or `NEEDS_REAUTH` state before sending again.
- **Send self-test** is an explicit action that sends one clearly labeled email to the same mailbox. It is not part of automated tests and does not request a reply.
- **Resync** queues mailbox retrieval; check Mailbox Health for last success and provider errors.

SMTP/IMAP passwords and usernames use the application's credential encryption key. Back up and protect that key with the database; losing it makes saved mailbox credentials unreadable. API responses omit the stored connection configuration.

## Sending and compliance

EMN re-checks campaign approval, contact eligibility, suppression, account status, sending windows and daily quotas immediately before a send. It adds standard unsubscribe headers and provides a public unsubscribe route. Provider acceptance is recorded as accepted/sent by the provider; it is not proof of delivery, inbox placement, or a human read.

Do not exceed provider limits or terms. Do not use artificial reciprocal warm-up networks. Review applicable email and privacy rules for each recipient jurisdiction.
