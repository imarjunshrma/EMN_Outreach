# SMTP/IMAP architecture

## Connection and credential flow

The workspace-admin route `POST /api/v1/w/:workspaceId/email-accounts/smtp` validates mailbox settings and calls the `SMTP_IMAP` adapter. SMTP verification and IMAP login are independent, so one can report success while the other reports a sanitized failure. A mailbox is marked connected only when both checks pass.

The API accepts shared credentials for older clients and separate SMTP and IMAP usernames/passwords. Passwords are encrypted using the application keyring and stored in the existing `ProviderCredential`/mailbox configuration fields. Usernames are encrypted in `EmailAccount.connectionConfig`. The `publicAccount` serializer removes that configuration from API results and only returns non-secret connection-health status. Existing legacy usernames are encrypted when first read by the service.

Never log a `SmtpImapConfig`, `AuthHandle`, request body, password, or username. Adapter errors intentionally discard server response bodies and return a provider stage/status that is useful for troubleshooting without echoing credentials.

## Sending

The campaign engine builds MIME with Message-ID, threading headers, compliance headers and the outbound idempotency header, then uses Nodemailer SMTP. Plain text and optional HTML are supported. The engine tracks provider acceptance and message identifiers; it does not label SMTP acceptance as delivery. Ambiguous SMTP outcomes are reconciled against the Sent folder when possible and otherwise fail closed to avoid an unsafe resend.

## Receiving

ImapFlow reads INBOX and, where available, the configured Sent folder. Cursor state includes folder UIDVALIDITY and last UID. An INBOX failure fails the job. A missing optional Sent folder does not prevent INBOX retrieval. Provider message IDs are scoped to the mailbox and protected by a database uniqueness constraint.

See [INBOX_SYNC_AND_REPLY_TRACKING.md](INBOX_SYNC_AND_REPLY_TRACKING.md) for job lifecycle and message matching.
