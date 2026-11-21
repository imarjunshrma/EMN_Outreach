---
title: Deals, tasks & CRM sync
section: Guides
order: 8
description: Track opportunities that come out of replies and keep an external CRM in sync.
---
## Pipeline

When a reply turns into a real conversation, create a deal from the conversation. **Pipeline → Deals & forecast** shows deals by stage with weighted value, and stage changes can trigger workflows and webhooks.

## Tasks

Create tasks from a lead, a conversation or a workflow. When a task with an assignee becomes due, the assignee gets a notification.

## Keeping an external CRM in sync

There is no built-in HubSpot or Pipedrive connector yet. To mirror activity into another CRM, subscribe a [webhook](/docs/webhooks) to `reply.categorized`, `meeting.booked`, `lead.status_changed` and `opportunity.stage_changed`, and use the [API](/docs/api-overview) to read leads and deals. Tools such as Zapier or Make can sit in between.
