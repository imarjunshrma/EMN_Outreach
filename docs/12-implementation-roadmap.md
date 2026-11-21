# 12 — Implementation roadmap (status as of 1.0.0)

The plan had phases 0–7 with approval gates. The final build instruction asked for the complete system
in one delivery, so all phases were built and are tested together. Status is stated honestly: **"Built &
tested"** means automated tests against real PostgreSQL/Redis with *fake* external providers.
**"Needs live check"** means the code path exists but has not run against the real third-party service.

| Phase | Scope | Status |
|---|---|---|
| 0 Foundation | Repo, config, Prisma schema + migration, auth, sessions, CSRF, RBAC, workspaces, invitations, API keys, audit, route registry, OpenAPI | Built & tested |
| 1 Leads | CRUD, companies, lists, notes, CSV import/export, suppression, compliance rules | Built & tested |
| 2 Mailboxes | Google/Microsoft OAuth, SMTP/IMAP, token encryption & refresh, sync, domain DNS checks | Built & tested with fakes. **Needs live check** with real Google/Microsoft apps. |
| 3 AI & research | Orchestrator, prompts, budgets, research fetcher, evidence/claims, scoring, writing, fact-check | Built & tested with fakes. **Needs live check** with real Anthropic/OpenAI keys (schema-forcing behaviour of real models). |
| 4 Campaign engine | Sequences, approval hash, enrolment, tick, prepare/send, reconciliation, auto-pause, unsubscribe | Built & tested |
| 5 Inbox & CRM | Threading, bounces, auto-replies, classification effects, replies, pipeline, tasks | Built & tested |
| 6 Integrations | Apollo, MillionVerifier, Brave, Serper, Smartlead export, booking webhook, outgoing webhooks, automations | Built & tested with fakes/recorded shapes. **Needs live check** for each paid provider. |
| 7 Ops & deploy | Dashboard, analytics, usage, jobs, logs, privacy, retention, Nginx/systemd/PM2, scripts, docs | Built. Scripts were checked as described in doc 11. |

## Before the first real campaign (recommended order)
1. Deploy to the VPS and create the owner. Fill in Settings → General (postal address, offer facts) and review Compliance.
2. Connect **one** Google or Microsoft mailbox. Send a test campaign to 2–3 of your own addresses in different providers. Confirm the threading, the unsubscribe link, the List-Unsubscribe header, and that reply sync and classification work.
3. Add the Anthropic key. Generate 10 drafts and read every one: check the claims panel and fact-check results.
4. Add Apollo and MillionVerifier keys and import a small list (≤50). Verify before enrolling.
5. Start with low limits (for example 10–20 new leads a day per mailbox) and watch bounces and replies for two weeks. These numbers are cautious starting points, not a statement that any volume is safe.

## Next (not in 1.0.0)
- 2FA (TOTP) for owners and admins, and a Content-Security-Policy header for the UI.
- Frontend component and E2E tests (Playwright).
- An S3-compatible storage adapter (optional), and a Postmark/SES transactional adapter for system emails (invites currently show a copyable link).
- Calendar OAuth (Google/Microsoft) if a native booking flow is wanted beyond the webhook.
- Multi-step visual automation builder (1.0 has rule-based automations).
