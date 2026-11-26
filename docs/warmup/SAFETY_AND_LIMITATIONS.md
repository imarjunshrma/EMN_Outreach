# Warm-up safety and limitations

This is for legitimate communication with controlled, consenting mailboxes. It has no reciprocal provider network and generates no replies, tracking pixels, clicks or artificial engagement. A correlated observed reply is a signal and does not establish the identity or intent of its author. Provider acceptance and Sent visibility cannot establish delivery or inbox placement.

DNS checks use stored domain evidence with freshness checks. Per-message authentication alignment and transport TLS require independent provider evidence. Provider credentials stay in existing mailbox storage. No third-party warm-up dependency is used. The existing Smartlead adapter exports eligible campaign leads and provides no warm-up operations.

Validate each provider with separately approved test senders and recipients before live use. Review [controlled provider acceptance](../email/CONTROLLED_PROVIDER_ACCEPTANCE.md).

## Scope of this version

Each program uses one reviewed message. Configuration can be edited before start. To change the message or schedule after starting, stop the program and create a new one. The activity screen offers recent submissions and day, week and month date-range filters. It does not expose a separate template library, tenant defaults screen or downloadable reports.

An application-detected failure holds the program for operator review. This version does not automatically retry even a proven non-submission. A restart or resume cannot resubmit the original attempt. Warm-up uncertainty uses the same decision validation as campaign reconciliation and is reviewed from its own program history.
