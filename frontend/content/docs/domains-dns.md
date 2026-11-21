---
title: Domains & DNS
section: Guides
order: 5
description: Verify SPF, DKIM, DMARC and MX, prove ownership, and create records in Cloudflare with explicit approval.
---
Every domain belongs to one workspace. DNS provider tokens are encrypted and used only for that workspace.

## Check a domain

:::steps
### Add the domain
Open **Deliverability → Domains → Add domain** and enter the domain your mailboxes send from.

### Read the report
The check looks up live DNS and reports, for each record type, what was found and whether it is correct:

| Record | What it proves |
|---|---|
| MX | The domain can receive replies and bounces. |
| SPF | Which servers may send for the domain. There must be exactly one SPF record. |
| DKIM | Emails are signed by your provider (selector such as `google` or `selector1`). |
| DMARC | What receivers should do with unauthenticated mail, and where reports go. |

### Fix what is missing
Each problem comes with the exact record to add. Copy it into your DNS provider, or connect Cloudflare to create it from here.
:::

## Prove you own the domain

Choose **Verify ownership**. You get a TXT record — name `_emn-verify.yourdomain.com`, value `emn-verify=…` — to add at your DNS provider. Once it is visible, the domain is marked verified. Only verified domains count as done in the setup checklist.

## Add records through Cloudflare

Connect Cloudflare under **Settings → Integrations** with an API token limited to **Zone → DNS → Edit** for the zones you need. Then, on a domain's recommended records:

1. Review the record — type, name and value — exactly as it will be created.
2. Choose **Create in Cloudflare**. This explicit click is the approval; nothing is created in the background.
3. The record is created in the zone that matches the domain. Existing records are never changed or deleted.

> [!warning]
> If an SPF record already exists, a second one is refused (two SPF records break SPF). Edit the existing record in Cloudflare and merge the `include:` instead.

## Propagation

A provider accepting a change does not mean the world can see it yet. **Check propagation** queries Cloudflare (1.1.1.1), Google (8.8.8.8) and Quad9 (9.9.9.9) directly and shows which of them already return the new value. Treat the record as live only when all three do.

## History

Ownership checks and every record created through the app are written to the workspace's audit log, with the person who did it.
