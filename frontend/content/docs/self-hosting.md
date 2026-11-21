---
title: Self-hosting & operations
section: Security & operations
order: 4
description: Running your own installation — modes, environment settings, scheduled jobs and backups.
---
## Two modes

| Setting | Self-hosted company | SaaS for many customers |
|---|---|---|
| `BILLING_ENABLED` | `false` — no plans or limits | `true` — plans, trials and payments |
| Sign-up | Invite-only after the first user | Open (`REGISTRATION_OPEN` can close it) |
| Email verification | Optional (`REQUIRE_EMAIL_VERIFICATION`) | Required for invitations and campaigns |

Tenant isolation, roles, statuses and audit logs work the same in both modes.

## Important settings

```env title=".env"
BILLING_ENABLED=true
REGISTRATION_OPEN=
REQUIRE_EMAIL_VERIFICATION=false
BILLING_GRACE_DAYS=7
TENANT_DELETION_GRACE_DAYS=14
TENANT_JOB_SLOTS=2
SYSTEM_SMTP_URL=smtps://user:pass@smtp.example.com:465
```

`SYSTEM_SMTP_URL` is a transactional sender for verification, password-reset and notification emails — never a prospecting mailbox. `TENANT_JOB_SLOTS` caps how many AI, research, personalization, verification and import jobs one organization can run at the same time, so a large customer cannot slow everyone else down.

## Scheduled jobs

The worker registers these automatically:

| Job | Schedule | Purpose |
|---|---|---|
| `campaign.tick` | every minute | Schedule due emails |
| `sync.pollAll` | every 2 minutes | Read new mail |
| `tenant.sync` | every 15 minutes | Suspend expired trials and lapsed grace periods |
| `tenant.purge` | daily 01:23 UTC | Erase organizations whose deletion grace period ended |
| `maintenance.retention` | daily 02:43 UTC | Apply data retention |
| `domain.checkAll` | daily 03:17 UTC | Re-check every domain's DNS |

## Backups

Back up PostgreSQL daily (for example `pg_dump -Fc`) and keep backups encrypted, off the server, for a fixed period such as 30 days, so data deleted by customers also disappears from backups within that period. Back up the encryption key separately — without it, stored credentials cannot be decrypted. Test a restore regularly.
