---
title: Campaigns and sequences
section: Guides
order: 3
description: Build a sequence, choose who receives it, control when it sends, and follow its results.
---
## Create a campaign

:::steps
### Choose the audience
Pick one or more lead lists. Leads that are suppressed, unverified or outside your compliance rules are excluded, and the campaign shows how many and why.

### Write the sequence
Add steps — the first email and follow-ups — with a delay between each. Write each step yourself, generate it with AI, or mix both. Variables like `{{firstName}}` are filled from the lead; a draft with a missing value cannot be approved.

### Assign mailboxes
Select the mailboxes that send for this campaign. Each mailbox keeps its own sending window and daily limit, and a lead always receives every step from the same mailbox.

### Personalize and review
Run research and personalization. Drafts go to the **Review queue**. Approve them one by one, or in bulk once you trust the output.

### Start
Starting checks the campaign one last time: mailboxes connected, domain records valid, at least one approved email. Problems are listed so you can fix them.
:::

## When emails are sent

- Only inside the campaign's sending window — in the lead's own time zone when that option is on and the time zone is known.
- Never more than the mailbox's daily limit, with a minimum gap between two sends from the same mailbox.
- Follow-ups stop as soon as the lead replies, unsubscribes or bounces.

> [!note]
> An email counts toward your plan's monthly send allowance only when the mailbox provider accepts it. Failed attempts and retries are not counted twice.

## Results

Each campaign shows sent, delivered, opened (where tracking is on), replied, interested and bounced counts, plus per-step results. **Analytics** compares campaigns and mailboxes over time.
