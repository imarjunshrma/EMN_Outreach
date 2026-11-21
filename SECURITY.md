# Security

This file has two parts. The first is the security controls built into EMN Outreach OS 1.0.0. The second is what the operator is responsible for. To report a vulnerability, email info@elitemedianetworks.com. Do not open a public issue.

## Built-in controls

### Authentication and sessions
- Passwords are hashed with argon2id (64 MiB of memory, t=3) and must be at least 12 characters long.
- When a login email is unknown, the server still runs a password check against a dummy hash. This keeps response times the same whether or not an account exists.
- The session token is a random 256-bit value. It lives in the `emn_session` cookie, which is httpOnly, `Secure` when served over HTTPS, and `SameSite=Lax`. Only its SHA-256 hash is stored in the database. Sessions last 7 days, and users can list and revoke them.
- CSRF protection uses the double-submit pattern. Every non-GET request needs an `X-CSRF-Token` header that matches the per-session token.
- API keys are scoped to one workspace and one role. A key is shown once at creation and only its hash is stored. Keys can be revoked and are throttled by the same rate limits as other requests.
- Login, registration, password changes and the other public endpoints are rate-limited by Redis per IP and per account, and by Nginx per IP.

### Authorization and isolation
- Every route declares an auth mode and a minimum role (OWNER > ADMIN > MANAGER > MEMBER > VIEWER), and the route registry enforces it centrally.
- Every query on a workspace's data is scoped by `workspaceId`. If a user is not a member of a workspace, the API returns 404 so the workspace's existence is not revealed. Integration tests cover isolation between workspaces.
- Background jobs carry the `workspaceId` and validate it. Ids from one workspace are never resolved in another.

### Secrets
- OAuth tokens, SMTP passwords, AI keys and provider keys are encrypted with AES-256-GCM using a versioned keyring (`ENCRYPTION_KEYS`, `ENCRYPTION_ACTIVE_KEY`), so keys can be rotated.
- Secrets are never sent to the frontend. The API returns only whether a secret is configured and a masked hint.
- Logs pass through pino redaction, which removes authorization and cookie headers and any field named like a password, token, secret or key.
- `.env` is mode 600, belongs to the `emn` user and is excluded from the release zip.

### Input, output and outbound requests
- Zod validates every request body, query and set of URL parameters.
- Uploads are limited to 20 MB. CSV exports prefix cells that start with `= + - @` to block spreadsheet formula injection.
- Inbound HTML email is sanitized with sanitize-html before the UI shows it.
- The research fetcher guards against SSRF:
  - It allows only http and https on ports 80 and 443.
  - It resolves DNS and blocks private, loopback, link-local and metadata addresses, and checks again on every redirect.
  - It caps response size and timeouts.
  - It honours `robots.txt` and never follows a login wall.
- Pages, emails and search results are untrusted content to the AI. They are wrapped in `<untrusted_content>` with tag injection neutralized, and outputs are checked against strict JSON schemas. The AI cannot run tools or send email.
- Facts the AI writer uses must quote evidence verbatim, and the quote is substring-checked against the source. A separate fact-check blocks approval if it finds unsupported claims.

### Webhooks and public links
- Outgoing webhooks are signed with HMAC-SHA256 (`X-EMN-Signature: t=<ts>,v1=<sig>`). Their target URL is checked against private IPs both when the webhook is saved and on every delivery. They do not follow redirects, retry with backoff and log every delivery.
- Incoming booking webhooks must carry a valid HMAC. Generic, Cal.com and Calendly formats are supported, and Calendly signatures older than 5 minutes are rejected.
- Unsubscribe and click-tracking links use HMAC-signed tokens. One-click unsubscribe follows RFC 8058.

### Audit and infrastructure
- `AuditLog` is append-only: a database trigger rejects UPDATE and DELETE. Security-relevant actions write audit rows, including logins, role changes, key and integration changes, campaign approvals and starts, suppression changes and privacy requests.
- HTTP security headers are set on both the API and the UI: `X-Frame-Options: DENY`, `nosniff`, a strict `Referrer-Policy`, `Cross-Origin-Resource-Policy` on the API, and HSTS through Nginx. (A Content-Security-Policy is not set yet; adding one is listed in the roadmap.)
- The API and UI bind to 127.0.0.1. PostgreSQL and Redis listen only on localhost, and Redis requires a password.
- The app runs under a separate least-privilege database role (`emn_app`), and systemd units are hardened (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`).

## Sending safeguards (anti-abuse)
- Sending never uses mailbox rotation, warm-up networks or account cycling. Each lead keeps one fixed sender for the whole sequence.
- Daily limits, minimum spacing between emails and sending windows are enforced at the moment of sending, not only when a job is scheduled.
- A campaign cannot start until it passes validation and someone approves it. Any change to its content after approval pauses it.
- Before each email is sent, the system checks:
  - suppression (by email and domain)
  - the lead's status and email verification result
  - the country rule and lawful basis
  - that the postal address and unsubscribe link are present
  - that no reply has arrived
- Campaigns pause automatically when the bounce-rate or complaint threshold is reached.

These are technical safeguards, not legal advice. You remain responsible for having a lawful basis for each contact and for following the law in each recipient's country and the terms of your email provider.

## Operator responsibilities
- Keep the OS, Node.js, PostgreSQL, Redis and Nginx patched (`unattended-upgrades` is recommended).
- Keep `.env` and backups private. Copy backups off the server and test restoring them.
- Use strong, unique passwords for owners and admins, and limit how many people have those roles.
- Rotate the Microsoft client secret before it expires. Review connected mailboxes and API keys regularly.
- Run `npm audit` before you upgrade dependencies.
