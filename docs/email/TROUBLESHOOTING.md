# Mailbox troubleshooting

## SMTP verification fails

- Recheck the SMTP hostname, port, TLS mode, username, and password in the provider dashboard.
- Confirm the provider permits SMTP access for this mailbox and that app-password or third-party access policy is satisfied.
- Check Mailbox Health for the SMTP-specific failure and timestamp. EMN does not expose the provider's raw response text.

## IMAP verification or sync fails

- Recheck IMAP host, port, TLS mode, username, and password independently of SMTP.
- Confirm INBOX exists and is accessible. Sent folder discovery is optional; enter the provider's exact Sent folder name if needed.
- A sync error remains visible as the last error; recurring errors generate an administrator notification. Authentication errors require reconnection.
- Sync continues for paused mailboxes so incoming replies and unsubscribes can still be processed.

## No replies appear

- Check that the mailbox has a recent successful sync and that its INBOX connection passed.
- Check **Settings → Jobs** for failed `mailbox-sync` work; retry only after correcting the connection problem.
- Confirm the message arrived in the connected mailbox's INBOX. Forwarding is not required and is not the primary detection path.
- If a reply is present but has no contact or campaign association, review its sender, Message-ID, In-Reply-To, References and thread. EMN leaves uncertain associations unassigned instead of guessing.

## SMTP accepted but a message is not visible

Provider acceptance is not a delivery or inbox-placement guarantee. Check the provider's sent records and recipient mailbox independently. For an interrupted SMTP send without a provable Sent copy, EMN avoids an automatic resend because that could create a duplicate.

## Reconnect and key management

Use **Test connection** after updating credentials. Protect the application encryption key and preserve it through backup/restore; database backups alone cannot decrypt mailbox credentials. Never include credentials in logs, screenshots, or support tickets.
