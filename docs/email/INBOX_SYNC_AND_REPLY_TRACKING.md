# Inbox sync and reply tracking

## Job lifecycle

Mailbox connection and manual resync enqueue `sync.account` on the existing BullMQ `mailbox-sync` queue. The worker polls connected and paused accounts every 120 seconds. BullMQ uses the application's standard retry policy (three attempts, exponential backoff beginning at five seconds); failed jobs and `JobRun`/`ErrorLog` records are available in operations views. A Redis lock prevents simultaneous sync jobs for one mailbox. Worker shutdown closes active workers and queue/Redis/database connections.

The SMTP/IMAP cursor stores UIDVALIDITY and last UID per folder. Gmail stores its history cursor and requests full resync when history expires. Microsoft Graph stores delta links and can use change notifications when enabled. Sync advances the cursor only after provider fetch and local ingestion succeed. If local message persistence fails, the job fails; a retry skips already stored provider IDs and retries the failed work. Last success and last error are recorded on the mailbox. Repeated sync failures notify administrators at most once per six hours; authentication errors move the mailbox to `NEEDS_REAUTH`.

## Message and conversation matching

Messages are parsed into normalized sender/recipient, subject, date, Message-ID, In-Reply-To, References, provider thread, body and bounce/auto-reply metadata. HTML is sanitized before rendering. Matching checks parent Message-IDs, then provider thread ID. The message is scoped to its sending mailbox and workspace. A message without a confident contact/thread match stays in its own conversation with no guessed campaign association.

Campaign association comes from the matched outbound conversation. Replies are not assigned to the first arbitrary enrollment for a contact. A human reply records a reply event and stops relevant active sequences when campaign policy says to stop. Auto-replies are marked separately and only stop when configured. Messages are unique by `(emailAccountId, providerMessageId)`.

## Bounce and unsubscribe handling

DSN/report messages and known mailer-daemon patterns are classified as bounces. Hard bounces create suppression and stop affected sequences. Unsubscribe headers point to the public unsubscribe endpoint; inbound unsubscribe intent is classified and suppressed. Suppression is checked again immediately before each campaign send.

Classification is heuristic for non-standard providers and automated replies. Provider complaint feedback loops are not universally available and are not inferred when providers do not supply the signal.
