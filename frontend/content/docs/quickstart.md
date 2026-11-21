---
title: Quickstart
section: Getting started
order: 2
description: From sign-up to your first approved email in about thirty minutes.
---
This guide takes you from a new account to a small, approved campaign. You need a mailbox you own (Google Workspace, Microsoft 365 or any SMTP/IMAP account), access to a supported hosted or local text model, and a short list of prospects.

:::steps
### Create your account
Go to [Sign up](/signup), enter your name, work email, company name and a password of at least 12 characters, and accept the terms. This creates your organization, a first workspace and — on the hosted service — a 14-day trial.

We send a confirmation link to your email. Confirm it before inviting teammates or starting a campaign.

### Finish the setup checklist
After sign-up you land on **Set up your organization**. Each item shows its real state, read from your configuration. Two items are required: **Organization details** (your postal address, which appears in every email footer by law in most countries) and **Business profile** (what you sell and to whom). The rest can be skipped and done later.

### Add an AI provider
Open **Settings → AI providers**, choose a provider, enter its model ID and credentials, then test the connection. Keys are encrypted at rest and never shown again. OpenAI-compatible endpoints include OpenRouter, Groq, Together AI, DeepSeek, Mistral and Ollama, as well as custom compatible servers. Set a monthly budget under **AI Studio → Models & budgets**.

### Connect a mailbox
Open **Deliverability → Mailboxes → Add mailbox**. Google and Microsoft use a secure sign-in window; for other providers enter SMTP and IMAP details. Set a daily limit — start at 20–30 emails a day for a mailbox that has not sent cold email before.

### Check your domain
Open **Deliverability → Domains → Add domain** and enter the domain of your mailbox. The check reads your SPF, DKIM and DMARC records and tells you exactly what to add or change. See [Domains & DNS](/docs/domains-dns).

### Import leads
Open **Prospects → Import & export**, upload a CSV, and map the columns. Duplicates and suppressed addresses are skipped automatically. Run **Verification** on the list before sending.

### Create a campaign and approve the drafts
Open **Outreach → Campaigns → New campaign**, pick the leads and the mailbox, write or generate the sequence, and run research and personalization. Every draft goes to the **Review queue**. Read, edit and approve — only approved emails are scheduled.
:::

> [!note]
> Emails go out only inside the sending window and daily limits of each mailbox, so a campaign started in the evening begins sending the next working morning.

## Next steps

- Learn how drafts are grounded in [Research & AI writing](/docs/research-ai).
- Set up [Reply handling](/docs/inbox-replies) so answers reach the right person.
