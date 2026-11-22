# Outreach automation controls

The admin pages **Settings → Email verification**, **Settings → Outreach automation**, and **Deliverability → Mailbox health** control existing outreach services. These settings are stored in the workspace JSON settings and mailbox connection JSON, so this change adds no database migration.

## Verification gate

Campaign enrollment and the final send check require a verification result within the configured freshness window. A missing or stale result is queued according to the selected mode and is not enrolled until the result meets policy. The default mode is the EMN first-party engine; it does not call a paid verification API. The external mode uses the already configured workspace verifier. Disabled mode performs no automatic lookup, but still requires an eligible, fresh result. Unknown results are held by default. Invalid addresses are always blocked. Disposable and role-based policy can be changed explicitly.

The first-party engine checks address syntax, domain and DNS signals. It cannot prove that an individual mailbox exists, so its normal outcome is `UNKNOWN`, which remains held by default. SMTP recipient probing requires both the workspace toggle and server-side `EMAIL_VERIFY_SMTP_ENABLED=true` plus `EMAIL_VERIFY_MAIL_FROM`; SMTP acceptance is not proof of mailbox existence. The configured freshness period is also the first-party result cache duration.

## Sending controls

The emergency pause blocks campaign sends and manually queued replies/forwards at execution time. It leaves campaign and enrollment data intact and makes campaign messages defer. Disabling automatic campaign sending has the same deferral behavior for campaigns. Follow-ups can be paused separately; due enrollments keep their position and are reconsidered hourly. Incoming synchronization, reply sequence stopping, unsubscribe handling, suppression checks, compliance checks, send windows, idempotency and hard-bounce protection remain active safety controls.

Mailbox, campaign, workspace and domain daily limits stack: the lowest limit wins. Domain limits count all configured mailboxes in the workspace using the same sender domain. New campaigns start with editable follow-up steps at 3, 5 and 7 additional days; campaign owners can change their delays, content, send windows, thread behavior, approval mode and reply stopping before approval.

## Mailbox readiness cap

Readiness management is off by default. An admin must enable it globally in Outreach Automation and per mailbox in Mailbox Health. Enabling starts that mailbox at the lower of its configured initial cap (default 5/day) and its existing mailbox daily limit. The daily worker reviews actual campaign sends. It increases the cap by the configured increment (default 5) no sooner than every 7 days when the period has sends on at least five days, at least three sends per current cap, a healthy/verified domain check, hard-bounce rate within the workspace threshold, soft-bounce rate within the readiness threshold, and no complaint signal. Otherwise, it records a hold reason and notifies admins when the reason changes. It never sends test, warm-up or engagement messages. The configured mailbox limit and all other quotas remain upper bounds.

Provider complaint feedback is not available for every connected mailbox. The dashboard only reports complaint events the application actually observes; absence of complaint data does not mean there were no complaints at the provider.

## Deployment

No migration is required for these settings. For an Ubuntu release, use the repository deployment procedure:

```bash
# Install once on a fresh Ubuntu host; this provisions the existing systemd/PM2 and Nginx layout.
sudo bash scripts/install.sh

# For a later release, unpack the source into the project directory and run:
sudo bash scripts/deploy.sh
# With PM2 instead of systemd:
sudo PROCESS_MANAGER=pm2 bash scripts/deploy.sh

# If running the health check manually after deployment:
bash scripts/healthcheck.sh
```

Configure the existing PostgreSQL, Redis, application secret/keyring, `APP_URL`, provider OAuth credentials and mailbox credentials before deployment. IMAP polling requires outbound IMAP connectivity; SMTP sending requires the provider's configured submission port (often 465 or 587). Do not assume outbound port 25 is available. `deploy.sh` backs up the database before migration; follow [the deployment and recovery guide](saas/DEPLOYMENT_AND_RECOVERY_GUIDE.md) for rollback. No live mailbox or provider connection was exercised as part of local verification.
