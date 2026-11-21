# Safe mailbox operations

## Existing operational flow

1. Connect a mailbox from **Mailboxes** using Google OAuth, Microsoft OAuth, or SMTP/IMAP credentials. Credentials are encrypted by the existing keyring.
2. Confirm the provider's authorization and the domain's SPF/DKIM/DMARC/MX state in **Domain health**.
3. Set a conservative mailbox daily send limit and sending window. This limit applies to campaign traffic and is not a warm-up allowance.
4. Review **Mailbox health** for measured provider connection, sync, send, bounce, complaint, and DNS signals. The app does not estimate spam placement.
5. Pause a mailbox or campaign when authorization, DNS, provider, bounce, complaint, or sync signals need investigation.

An ADMIN can select **Send self-test** from Mailboxes to send one clearly labeled diagnostic from a connected mailbox back to itself. The API limits this action to one request per workspace every 15 minutes. A successful response means the provider accepted the submission; the customer can run existing mailbox sync to check for a copy. This is not a placement measurement and does not request a reply.

## Queue and receiving behavior

Campaign sends and existing inbound sync use the application's current BullMQ queues and provider adapters. Gmail history and Graph notification flows feed existing mailbox synchronization; SMTP/IMAP uses the existing sync adapter. No second receiver or hidden reply generator was added.

## Configuration

No new environment variables or database models were introduced. Use the existing Google/Microsoft OAuth app settings, application encryption keyring, Redis, PostgreSQL, and provider setup described in the repository's `INSTALLATION.md`. Do not paste provider secrets into tickets, rule text, or this document.

## Interpreting the health labels

Open the health label's reason for the observed signals. Monitoring means evidence is missing or delayed; Warning indicates a measured issue; Paused and Disconnected reflect mailbox state. Healthy means the listed application checks passed. It never means inbox placement was measured.

Automated reputation warm-up exchanges, cross-customer message pairing, and fabricated replies are intentionally unavailable. Use provider-authenticated sending, accurate message identity, wanted recipients, functioning unsubscribe/suppression controls, and provider reporting tools instead.
