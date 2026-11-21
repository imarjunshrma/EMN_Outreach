---
title: Webhooks
section: Developers
order: 2
description: Receive signed events when replies arrive, leads change, meetings are booked and more.
---
## Create a webhook

1. In the workspace, open **Settings → Webhooks → Add webhook**, or call `POST /api/v1/w/{workspaceId}/webhooks`.
2. Enter an HTTPS URL on the public internet and choose events.
3. Copy the signing secret. It is shown once.

## Events

| Event | Sent when |
|---|---|
| `reply.categorized` | A reply is received and classified |
| `lead.scored` | A lead gets a new ICP score |
| `lead.status_changed` | A lead's status changes |
| `email.sent` | A mailbox provider accepts an email |
| `email.bounced` | An email bounces |
| `lead.unsubscribed` | A lead opts out |
| `meeting.booked` | A booking is matched to a lead |
| `campaign.paused` | A campaign pauses, including automatic pauses |
| `opportunity.stage_changed` | A deal moves to another stage |

## Request format

Each delivery is a `POST` with a JSON body and these headers:

| Header | Value |
|---|---|
| `X-EMN-Event` | The event name |
| `X-EMN-Delivery` | A unique delivery id — use it to ignore duplicates |
| `X-EMN-Signature` | `t=<unix seconds>,v1=<hex HMAC-SHA256>` |

## Verify the signature

The signature is an HMAC-SHA256, keyed with your signing secret, of the timestamp, a dot, and the raw request body. Reject requests whose timestamp is more than five minutes old.

```ts title="Node.js"
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(rawBody: string, header: string, secret: string) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1 ?? ''));
}
```

```python title="Python"
import hmac, hashlib, time

def verify(raw_body: bytes, header: str, secret: str) -> bool:
    parts = dict(p.split("=", 1) for p in header.split(","))
    t = int(parts.get("t", 0))
    if abs(time.time() - t) > 300:
        return False
    expected = hmac.new(secret.encode(), f"{t}.".encode() + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))
```

> [!warning]
> Compute the signature over the raw body exactly as received. Parsing and re-serializing the JSON changes the bytes and the signature will not match.

## Delivery and retries

Respond with any `2xx` status within 10 seconds. Other responses, timeouts and redirects count as failures and are retried with exponential back-off, up to 8 attempts per event. After 50 consecutive failures the webhook is disabled; re-enable it once your endpoint is fixed. Each workspace's delivery log shows every attempt and response status.
