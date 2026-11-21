---
title: Export & deletion
section: Security & operations
order: 2
description: Download your data, erase individual contacts, and delete your organization.
---
## Export everything

Organization owners and admins can download a JSON export of the organization and every workspace from **Organization settings → Data & deletion → Download export**. Credentials and secrets are never included. A single workspace can be exported from its own settings. Export stays available even while the organization is suspended or cancelled.

## Erase or export one person

Under **Deliverability → Compliance**, create a privacy request for an email address:

- **Export** collects everything stored about that person in the workspace.
- **Erasure** deletes the person's lead record, messages and research, and adds the address to the suppression list so they are never contacted again.

## Delete the organization

:::steps
### Request deletion
The owner opens **Organization settings → Data & deletion → Delete organization** and types the organization's name to confirm. Running campaigns pause immediately and the subscription is cancelled.

### Grace period
For 14 days the organization is marked *deletion pending*. Workspaces are closed, and the owner can cancel the deletion at any time from the same page.

### Erasure
After the grace period, all workspaces, records and stored files are permanently deleted. A minimal record that the organization existed and was deleted remains, together with the platform audit trail, as required for accounting and security.
:::

## Retention and backups

Message bodies, research and event logs follow the retention periods set in each workspace's compliance settings. Database backups taken before a deletion expire on the backup schedule of the installation (see [Self-hosting & operations](/docs/self-hosting)); deleted data is not restored from backups except to recover from a platform incident.
