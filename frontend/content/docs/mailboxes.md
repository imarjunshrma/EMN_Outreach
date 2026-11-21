---
title: Connecting mailboxes
section: Guides
order: 4
description: Connect Google Workspace, Microsoft 365 or SMTP/IMAP mailboxes and keep them healthy.
---
Mailboxes belong to one workspace. Their credentials are encrypted and are never shown again after you save them, and no other workspace or organization can use them.

## Google Workspace or Gmail

1. Open **Deliverability → Mailboxes → Add mailbox → Google**.
2. Sign in with the mailbox account and allow access to send and read email.
3. The mailbox appears as **Connected**. Set its daily limit and sending window.

## Microsoft 365

1. Choose **Add mailbox → Microsoft**.
2. Sign in. If your company restricts third-party apps, an Microsoft 365 administrator may need to approve the app once for your tenant.

## SMTP and IMAP

Enter the SMTP host, port and security (for sending) and the IMAP host, port and security (for reading replies), plus the username and password or app password. The connection is tested before it is saved.

## Mailbox health

**Deliverability → Mailbox health** shows sends, hard bounces and bounce rate per mailbox over the last 30 days. Campaigns also protect your reputation on their own: a campaign pauses automatically when its bounce rate passes its limit (5% by default, after at least 20 sends) or when complaints reach their limit. Resume it after you have found the cause.

> [!warning]
> Start new mailboxes slowly — 20 to 30 emails a day — and raise the limit over a few weeks. The product does not use warm-up networks.
