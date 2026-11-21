# EMN Outreach OS — API documentation

Generated from the route registry by `npm run api-docs` (352 operations). The machine-readable
OpenAPI 3.1 document is `docs/openapi.json` (`npm run openapi`) and is also served at `GET /api/v1/openapi.json`.

## Conventions

* **Base URL**: `https://<your-domain>/api/v1`. Workspace resources live under `/w/:workspaceId/…`;
  a user who is not a member of that workspace receives **404** (existence is not revealed).
* **Browser auth**: `emn_session` cookie (httpOnly) + CSRF double submit — send the `emn_csrf` cookie value
  in the `X-CSRF-Token` header on every non-GET request.
* **API keys** (Settings → API keys): `Authorization: Bearer emn_<prefix>_<secret>`. A key is bound to one
  workspace and carries a role; no CSRF header is needed. Keys are shown once and stored hashed.
* **Roles** (highest first): OWNER > ADMIN > MANAGER > MEMBER > VIEWER. "MEMBER+" means MEMBER or higher.
* **Pagination**: `?page=1&pageSize=50` (max 200) → `{ data, page, pageSize, total, totalPages }`.
* **Errors**: `{ "error": { "code", "message", "details?", "requestId" } }`. Every response carries `X-Request-Id`.
* **Rate limits**: per-route limits below (Redis sliding window) plus Nginx per-IP limits. Exceeding one returns 429 with `Retry-After`.
* **Realtime**: `GET /w/:workspaceId/events` is a Server-Sent Events stream (new replies, job progress, notifications).
* `?` after a field name = optional.

## Error codes

| Code | Meaning |
|---|---|
| `VALIDATION_FAILED` | Request body, query or params failed validation (400) |
| `UNAUTHENTICATED` | Missing or expired session / API key (401) |
| `CSRF_FAILED` | Missing or wrong X-CSRF-Token header (403) |
| `FORBIDDEN` | Role does not allow this action (403) |
| `NOT_FOUND` | Resource does not exist in this workspace (404) |
| `RATE_LIMITED` | Too many requests (429) |
| `CONFLICT` | Unique constraint or state conflict (409) |
| `CAMPAIGN_INVALID` | Campaign failed validation and cannot be approved/started (400) |
| `CAMPAIGN_STATE` | Action not allowed in the campaign current status (409) |
| `PROVIDER_NOT_CONFIGURED` | Integration / AI provider / OAuth app not configured (400) |
| `PROVIDER_ERROR` | External provider returned an error (502) |
| `AI_BUDGET_EXCEEDED` | Monthly AI budget for this task is used up (402) |
| `AI_COST_LIMIT` | Per-lead AI cost limit would be exceeded (402) |
| `QUALITY_CHECK_FAILED` | Personalization has failing quality checks and cannot be approved (400) |
| `AI_OUTPUT_INVALID` | AI response failed schema validation (502) |
| `WEAK_PASSWORD` | Password does not meet the strength policy (400) |
| `INVALID_PASSWORD` | Current password is wrong (400) |
| `REGISTRATION_CLOSED` | Public registration is disabled; use an invitation (403) |
| `LOGIN_REQUIRED` | Invitation belongs to an existing account; log in first (400) |
| `INVITATION_INVALID` | Invitation token invalid, used or expired (400) |
| `INVITATION_EMAIL_MISMATCH` | Logged-in user is not the invited email (400) |
| `LAST_OWNER` | Cannot remove/demote the last workspace owner (400) |
| `OAUTH_STATE_INVALID` | OAuth state expired, reused or for another provider (400) |
| `OAUTH_DENIED` | User or tenant admin denied consent (400) |
| `OAUTH_NO_REFRESH` | Provider returned no refresh token (400) |
| `ACCOUNT_NOT_CONNECTED` | Mailbox is disconnected / needs re-authentication (400/409) |
| `UNRESOLVED_VARIABLES` | Template still contains unresolved {{variables}} (400) |
| `FACT_CHECK_FAILED` | Independent fact-check found unsupported claims (400) |
| `ICP_REQUIRED` | Scoring needs an ICP first (400) |
| `NOT_ELIGIBLE` | Lead fails a compliance/suppression/verification gate (400) |
| `REVIEW_REQUIRED` | Country rule needs explicit review before enabling (400) |
| `INVALID_TOKEN` | Unsubscribe/booking token invalid (400) |
| `MFA_REQUIRED` | Workspace requires two-factor authentication (403) |
| `INVALID_CODE` | Two-factor code invalid (400) |
| `QUOTA_EXCEEDED` | Plan limit reached for this resource (402) |
| `SUBSCRIPTION_INACTIVE` | Subscription inactive; feature unavailable (402) |
| `INVALID_SIGNATURE` | Webhook signature verification failed (400) |
| `TENANT_INACTIVE` | Organization is suspended, cancelled or being deleted; writes are blocked (403) |
| `EMAIL_NOT_VERIFIED` | Confirm your email address before this action (403) |
| `INVALID_TRANSITION` | Organization status change not allowed from the current status (409) |
| `SUPPRESSED` | Recipient is on the suppression list (400) |
| `INTERNAL` | Unexpected server error (500) |

## Non-registry endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/healthz` | public | Liveness |
| GET | `/readyz` | public (Nginx: localhost only) | DB + Redis readiness |
| GET | `/api/v1/openapi.json` | public | OpenAPI document |
| GET | `/api/v1/oauth/callback/:provider` | OAuth state | Google / Microsoft OAuth redirect target |
| POST | `/api/v1/webhooks/graph` | Graph clientState | Microsoft Graph change notifications (optional) |
| POST | `/api/v1/hooks/booking/:workspaceId` | HMAC `X-EMN-Signature: t=…,v1=…` | Meeting-booked webhook from any scheduler |
| POST | `/api/v1/public/unsubscribe/:token` | signed token | RFC 8058 one-click unsubscribe |
| GET | `/api/v1/public/t/o/:id.gif`, `/api/v1/public/t/c/:token` | public | Optional open / click tracking (off by default) |
| GET | `/api/v1/w/:workspaceId/events` | session | SSE realtime stream |

## AI

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/ai/providers` | session/API key · ADMIN+ | — | — | — | Configured AI providers (key shown as last 4 only) |
| PUT | `/w/:workspaceId/ai/providers` | session/API key · ADMIN+ | — | `provider`: OPENAI\|ANTHROPIC\|GOOGLE\|OPENROUTER\|GROQ\|TOGETHER…, `apiKey?`: string, `defaultModel`: string, `baseUrl?`: object, `isEnabled?`: boolean | — | Add/update an AI provider key and default model |
| DELETE | `/w/:workspaceId/ai/providers/:provider` | session/API key · ADMIN+ | — | — | — | Remove an AI provider |
| POST | `/w/:workspaceId/ai/providers/:provider/test` | session/API key · ADMIN+ | 20/600s per workspace | — | — | Test an AI provider connection |
| GET | `/w/:workspaceId/ai/providers/:provider/models` | session/API key · ADMIN+ | 30/600s per workspace | — | — | List models available to a configured provider |
| GET | `/w/:workspaceId/ai/routes` | session/API key · ADMIN+ | — | — | — | Model routing per task |
| PUT | `/w/:workspaceId/ai/routes` | session/API key · ADMIN+ | — | `task`: PERSONALIZATION\|COPILOT\|ICP_FROM_TEXT\|FACT_EXTRACTION\|LEAD_QUALIFICATION\|EMAIL_WRITING…, `provider`: OPENAI\|ANTHROPIC\|GOOGLE\|OPENROUTER\|GROQ\|TOGETHER…, `model`: string, `fallbackProvider?`: object, `fallbackModel?`: string\|null, `temperature?`: object, `maxOutputTokens?`: integer, `maxInputTokens?`: object, `monthlyBudgetUsd?`: object | — | Set model, fallback and budget for a task |
| GET | `/w/:workspaceId/ai/prompts` | session/API key · ADMIN+ | — | — | `task?`: PERSONALIZATION\|COPILOT\|ICP_FROM_TEXT\|FACT_EXTRACTION\|LEAD_QUALIFICATION\|EMAIL_WRITING… | Prompt versions |
| POST | `/w/:workspaceId/ai/prompts` | session/API key · ADMIN+ | — | `task`: PERSONALIZATION\|COPILOT\|ICP_FROM_TEXT\|FACT_EXTRACTION\|LEAD_QUALIFICATION\|EMAIL_WRITING…, `systemPrompt`: string, `userPromptTemplate`: string, `changeNote?`: string, `activate?`: boolean | — | Create a new prompt version (immutable history) |
| POST | `/w/:workspaceId/ai/prompts/:id/activate` | session/API key · ADMIN+ | — | — | — | Activate a prompt version |
| GET | `/w/:workspaceId/ai/usage` | session/API key · MANAGER+ | — | — | `days?`: integer | Token usage and estimated cost |
| GET | `/w/:workspaceId/ai/executions` | session/API key · ADMIN+ | — | — | `page?`: integer, `pageSize?`: integer, `task?`: PERSONALIZATION\|COPILOT\|ICP_FROM_TEXT\|FACT_EXTRACTION\|LEAD_QUALIFICATION\|EMAIL_WRITING…, `status?`: string | AI response logs |
| GET | `/w/:workspaceId/ai/prices` | session/API key · ADMIN+ | — | — | — | Model price table (USD per million tokens) |
| POST | `/w/:workspaceId/ai/prices` | session/API key · OWNER+ | — | `provider`: OPENAI\|ANTHROPIC\|GOOGLE\|OPENROUTER\|GROQ\|TOGETHER…, `model`: string, `inputPerMTokUsd`: number, `outputPerMTokUsd`: number, `cachedInputPerMTokUsd?`: object | — | Add a model price (owner only; applies to cost estimates) |

## AI Outreach Brain

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/ai-outreach-brain/overview` | session/API key · VIEWER+ | — | — | — | Training status, rules, examples, draft decisions and pending learning suggestions |
| GET | `/w/:workspaceId/ai-outreach-brain/rules` | session/API key · VIEWER+ | — | — | — | List workspace rules with conflict warnings |
| POST | `/w/:workspaceId/ai-outreach-brain/rules` | session/API key · ADMIN+ | — | `title`: string, `description`: string, `category`: PROSPECT_RESEARCH\|PROSPECT_QUALIFICATION\|OPPORTUNITY_IDENTIFICATION\|PERSONALIZATION\|EMAIL_OPENING\|VALUE_PROPOSITION…, `priority`: MANDATORY\|PREFERRED\|AVOID\|CONDITIONAL, `condition?`: object, `status?`: ACTIVE\|INACTIVE, `triggerTerms?`: array | — | Create an outreach rule |
| PATCH | `/w/:workspaceId/ai-outreach-brain/rules/:id` | session/API key · ADMIN+ | — | `title`: string, `description`: string, `category`: PROSPECT_RESEARCH\|PROSPECT_QUALIFICATION\|OPPORTUNITY_IDENTIFICATION\|PERSONALIZATION\|EMAIL_OPENING\|VALUE_PROPOSITION…, `priority`: MANDATORY\|PREFERRED\|AVOID\|CONDITIONAL, `condition?`: object, `status?`: ACTIVE\|INACTIVE, `triggerTerms?`: array | — | Update an outreach rule |
| DELETE | `/w/:workspaceId/ai-outreach-brain/rules/:id` | session/API key · ADMIN+ | — | — | — | Delete an outreach rule |
| GET | `/w/:workspaceId/ai-outreach-brain/examples` | session/API key · VIEWER+ | — | — | — | List workspace examples |
| POST | `/w/:workspaceId/ai-outreach-brain/examples` | session/API key · ADMIN+ | — | `name`: string, `content`: string, `correctedContent?`: object, `category`: EMAIL\|RESEARCH\|CONVERSATION, `polarity`: POSITIVE\|NEGATIVE, `explanation?`: object, `tags?`: array, `isActive?`: boolean | — | Add a positive or negative text example |
| PATCH | `/w/:workspaceId/ai-outreach-brain/examples/:id` | session/API key · ADMIN+ | — | `name`: string, `content`: string, `correctedContent?`: object, `category`: EMAIL\|RESEARCH\|CONVERSATION, `polarity`: POSITIVE\|NEGATIVE, `explanation?`: object, `tags?`: array, `isActive?`: boolean | — | Update a workspace example |
| DELETE | `/w/:workspaceId/ai-outreach-brain/examples/:id` | session/API key · ADMIN+ | — | — | — | Delete a workspace example |
| GET | `/w/:workspaceId/ai-outreach-brain/suggestions` | session/API key · VIEWER+ | — | — | — | Learning suggestions from repeated customer edits |
| POST | `/w/:workspaceId/ai-outreach-brain/suggestions/:id/decision` | session/API key · ADMIN+ | — | `decision`: ACCEPT\|REJECT | — | Accept or reject a learning suggestion |

## AI Studio

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/ai-studio/overview` | session/API key · VIEWER+ | — | — | — | Active configuration versions, documents, profiles and AI spend this month |
| GET | `/w/:workspaceId/ai-studio/config/:kind` | session/API key · VIEWER+ | — | — | — | Active business knowledge / writing / research configuration |
| PUT | `/w/:workspaceId/ai-studio/config/:kind` | session/API key · ADMIN+ | — | `data`: object, `changeNote?`: string | — | Save a new version (validated; becomes active) |
| GET | `/w/:workspaceId/ai-studio/config/:kind/versions` | session/API key · VIEWER+ | — | — | — | Version history |
| POST | `/w/:workspaceId/ai-studio/config-versions/:id/activate` | session/API key · ADMIN+ | — | — | — | Re-activate an earlier version |
| GET | `/w/:workspaceId/ai-studio/schemas` | session/API key · VIEWER+ | — | — | — | Defaults and JSON schemas for the configuration forms |
| GET | `/w/:workspaceId/ai-studio/documents` | session/API key · VIEWER+ | — | — | — | Knowledge documents |
| GET | `/w/:workspaceId/ai-studio/documents/:id` | session/API key · VIEWER+ | — | — | — | One knowledge document with its extracted text |
| POST | `/w/:workspaceId/ai-studio/documents` | session/API key · ADMIN+ | 60/3600s per workspace | — | — | Add a document (multipart "file" .txt/.md/.csv/.json/.html ≤5 MB, or fields title+text) |
| PATCH | `/w/:workspaceId/ai-studio/documents/:id` | session/API key · ADMIN+ | — | `title?`: string, `isActive?`: boolean, `text?`: string | — | Rename, (de)activate or replace document text |
| DELETE | `/w/:workspaceId/ai-studio/documents/:id` | session/API key · ADMIN+ | — | — | — | Delete a document |

## Analytics

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/campaigns/:id/steps` | session/API key · VIEWER+ | — | — | — | Per-step / per-variant (A/B) performance |
| GET | `/w/:workspaceId/analytics/overview` | session/API key · VIEWER+ | — | — | `days?`: integer | Measured totals, rates and clearly-labelled estimates |
| GET | `/w/:workspaceId/analytics/daily` | session/API key · VIEWER+ | — | — | `days?`: integer | Daily activity series |
| GET | `/w/:workspaceId/analytics/monthly` | session/API key · VIEWER+ | — | — | — | Monthly activity |
| GET | `/w/:workspaceId/analytics/campaigns` | session/API key · VIEWER+ | — | — | — | Campaign performance & attribution |
| GET | `/w/:workspaceId/analytics/mailboxes` | session/API key · VIEWER+ | — | — | `days?`: integer | Mailbox performance |
| GET | `/w/:workspaceId/analytics/providers` | session/API key · VIEWER+ | — | — | `days?`: integer | Data provider usage |
| GET | `/w/:workspaceId/analytics/campaigns/export` | session/API key · MEMBER+ | — | — | — | Export campaign performance as CSV |

## API keys

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/api-keys` | session/API key · ADMIN+ | — | — | — | List API keys (secrets never returned) |
| POST | `/w/:workspaceId/api-keys` | session/API key · ADMIN+ | — | `name`: string, `role?`: OWNER\|ADMIN\|MANAGER\|MEMBER\|VIEWER, `expiresInDays?`: integer, `scopes?`: array | — | Create an API key (shown once) |
| DELETE | `/w/:workspaceId/api-keys/:id` | session/API key · ADMIN+ | — | — | — | Revoke an API key |

## Auth

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/auth/bootstrap` | public | — | — | — | Whether the first admin account still needs to be created |
| POST | `/auth/register` | public | 5/3600s per ip | `email`: string, `name`: string, `password`: string, `workspaceName`: string | — | Create the first admin account (or register when public registration is enabled) |
| POST | `/auth/login` | public | 10/300s per ip | `email`: string, `password`: string | — | Log in with email + password (sets session cookie) |
| POST | `/auth/mfa/verify` | public | 10/300s per ip | `challenge`: string, `code`: string | — | Second login step: TOTP or recovery code for an MFA challenge |
| POST | `/auth/password/forgot` | public | 5/900s per ip | `email`: string | — | Email a single-use password reset link (same answer whether or not the account exists) |
| POST | `/auth/password/reset` | public | 10/900s per ip | `token`: string, `password`: string | — | Set a new password with a reset token (signs out all sessions) |
| GET | `/auth/mfa` | session | — | — | — | My two-factor status |
| POST | `/auth/mfa/setup` | session | 10/900s per user | — | — | Start TOTP setup (secret + QR, not active until confirmed) |
| POST | `/auth/mfa/enable` | session | 10/900s per user | `code`: string | — | Confirm TOTP setup with a code; returns recovery codes once |
| POST | `/auth/mfa/disable` | session | 5/900s per user | `password`: string, `code`: string | — | Turn off two-factor (password + current code or recovery code) |
| POST | `/auth/logout` | session | — | — | — | Log out (revokes session) |
| GET | `/auth/me` | session | — | — | — | Current user, CSRF token and workspaces |
| POST | `/auth/password` | session | 5/900s per user | `currentPassword`: string, `newPassword`: string | — | Change password (revokes other sessions) |
| GET | `/auth/sessions` | session | — | — | — | List my active sessions |
| DELETE | `/auth/sessions/:id` | session | — | — | — | Revoke one of my sessions |
| POST | `/invitations/:token/accept` | public | 10/600s per ip | `name?`: string, `password?`: string | — | Accept a workspace invitation (creates account if needed) |
| POST | `/auth/signup` | public | 10/3600s per ip | `name`: string, `email`: string, `password`: string, `organizationName`: string, `planCode?`: string, `acceptTerms`: boolean, `termsVersion?`: string, `timezone?`: string, `idempotencyKey?`: string | — | Create an account and a new organization (tenant) with its first workspace and trial |
| POST | `/auth/verify-email` | public | 20/900s per ip | `token`: string | — | Confirm an email address with the token from the verification email |
| POST | `/auth/verify-email/resend` | session | 3/900s per user | — | — | Send the verification email again |

## Automation

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/automations` | session/API key · VIEWER+ | — | — | — | Automation rules |
| POST | `/w/:workspaceId/automations` | session/API key · MANAGER+ | — | `name`: string, `isEnabled?`: boolean, `trigger`: reply.categorized\|lead.scored\|lead.status_changed, `conditions?`: object, `actions`: array | — | Create an automation rule |
| PUT | `/w/:workspaceId/automations/:id` | session/API key · MANAGER+ | — | `name`: string, `isEnabled?`: boolean, `trigger`: reply.categorized\|lead.scored\|lead.status_changed, `conditions?`: object, `actions`: array | — | Update an automation rule |
| DELETE | `/w/:workspaceId/automations/:id` | session/API key · MANAGER+ | — | — | — | Delete an automation rule |
| GET | `/w/:workspaceId/automations/runs` | session/API key · VIEWER+ | — | — | `ruleId?`: string | Automation run history |

## Billing

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/billing` | session/API key · VIEWER+ | — | — | — | Plan, status, usage and (for owners/billing managers) invoices of this workspace's organization |
| GET | `/orgs/:organizationId/billing` | session/API key · VIEWER+ | — | — | — | Plan, subscription, usage, invoices and available plans |
| POST | `/orgs/:organizationId/billing/checkout` | session/API key · VIEWER+ | 20/600s per user | `planCode`: string, `interval?`: month\|year, `provider`: stripe\|razorpay | — | Start hosted checkout for a plan (Stripe or Razorpay); activation only via verified webhook |
| POST | `/orgs/:organizationId/billing/portal` | session/API key · VIEWER+ | — | — | — | Open the Stripe customer portal (payment method, invoices) |
| POST | `/orgs/:organizationId/billing/cancel` | session/API key · VIEWER+ | — | `atPeriodEnd?`: boolean | — | Cancel the subscription (default: at the end of the period) |
| POST | `/orgs/:organizationId/billing/resume` | session/API key · VIEWER+ | — | — | — | Undo a scheduled cancellation (Stripe) |

## Campaigns

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/campaigns` | session/API key · VIEWER+ | — | — | — | Campaigns with headline stats |
| POST | `/w/:workspaceId/campaigns` | session/API key · MEMBER+ | — | `name`: string, `timezone?`: string, `useLeadTimezone?`: boolean, `sendingWindow?`: object, `dailyNewLeadLimit?`: integer, `dailySendLimit?`: integer, `stopOnReply?`: boolean, `stopOnAutoReply?`: boolean, `reviewMode?`: NONE\|AI_CONTENT_ONLY\|ALL, `requireFactCheck?`: boolean, `trackOpens?`: boolean, `trackClicks?`: boolean, `requireVerifiedEmail?`: boolean, `minLeadScore?`: object, `maxBounceRatePct?`: number, `maxComplaints?`: integer, `usePregeneratedAi?`: boolean, `scheduledStartAt?`: object | — | Create a campaign (DRAFT) |
| GET | `/w/:workspaceId/campaigns/:id` | session/API key · VIEWER+ | — | — | — | Campaign with sequence, lists and mailboxes |
| PATCH | `/w/:workspaceId/campaigns/:id` | session/API key · MEMBER+ | — | `name?`: string, `timezone?`: string, `useLeadTimezone?`: boolean, `sendingWindow?`: object, `dailyNewLeadLimit?`: integer, `dailySendLimit?`: integer, `stopOnReply?`: boolean, `stopOnAutoReply?`: boolean, `reviewMode?`: NONE\|AI_CONTENT_ONLY\|ALL, `requireFactCheck?`: boolean, `trackOpens?`: boolean, `trackClicks?`: boolean, `requireVerifiedEmail?`: boolean, `minLeadScore?`: object, `maxBounceRatePct?`: number, `maxComplaints?`: integer, `usePregeneratedAi?`: boolean, `scheduledStartAt?`: object | — | Update settings (invalidates approval) |
| DELETE | `/w/:workspaceId/campaigns/:id` | session/API key · MANAGER+ | — | — | — | Delete a never-sent draft |
| PUT | `/w/:workspaceId/campaigns/:id/sequence` | session/API key · MEMBER+ | — | `steps`: array | — | Save the email sequence (steps, delays, conditions, A/B variants) |
| PUT | `/w/:workspaceId/campaigns/:id/lists` | session/API key · MEMBER+ | — | `listIds`: array | — | Set target lead lists |
| PUT | `/w/:workspaceId/campaigns/:id/accounts` | session/API key · MEMBER+ | — | `accountIds`: array | — | Set sending mailboxes (each prospect gets one fixed sender) |
| POST | `/w/:workspaceId/campaigns/:id/validate` | session/API key · MEMBER+ | — | — | — | Validate and preview eligible recipients |
| POST | `/w/:workspaceId/campaigns/:id/submit` | session/API key · MEMBER+ | — | — | — | Submit for approval |
| POST | `/w/:workspaceId/campaigns/:id/approve` | session/API key · MANAGER+ | — | — | — | Approve (freezes a content hash; nothing unapproved is ever sent) |
| POST | `/w/:workspaceId/campaigns/:id/start` | session/API key · MANAGER+ | — | — | — | Start or resume an approved campaign |
| POST | `/w/:workspaceId/campaigns/:id/pause` | session/API key · MEMBER+ | — | `reason?`: string | — | Pause a running campaign |
| POST | `/w/:workspaceId/campaigns/:id/archive` | session/API key · MANAGER+ | — | — | — | Archive (stops all sequences) |
| GET | `/w/:workspaceId/campaigns/:id/recipients` | session/API key · VIEWER+ | — | — | `page?`: integer, `pageSize?`: integer, `status?`: string | Enrollments |
| POST | `/w/:workspaceId/campaigns/:id/enroll` | session/API key · MEMBER+ | — | `leadId`: string | — | Manually enroll one lead |
| POST | `/w/:workspaceId/enrollments/:id/stop` | session/API key · MEMBER+ | — | — | — | Stop one prospect’s sequence |
| POST | `/w/:workspaceId/campaigns/:id/export-smartlead` | session/API key · MANAGER+ | — | `smartleadCampaignId`: string | — | Optional: push this campaign’s eligible leads to a Smartlead campaign |
| GET | `/w/:workspaceId/campaigns/:id/preview` | session/API key · VIEWER+ | — | — | `leadId`: string, `stepOrder`: integer | Exact rendered email for one lead and step (no AI call) |
| POST | `/w/:workspaceId/campaigns/:id/test-email` | session/API key · MEMBER+ | 20/3600s per workspace | `leadId`: string, `stepOrder`: integer, `to`: string, `emailAccountId?`: string | — | Send a rendered step to a workspace member’s own address |
| GET | `/w/:workspaceId/campaigns/:id/versions` | session/API key · VIEWER+ | — | — | — | Sequence version history (one per approval) |
| POST | `/w/:workspaceId/campaigns/:id/versions/:version/restore` | session/API key · MANAGER+ | — | — | — | Restore an approved version into the editor (needs re-approval) |
| POST | `/w/:workspaceId/campaigns/:id/duplicate` | session/API key · MEMBER+ | — | `name?`: string | — | Clone a campaign (no recipients, sends or approvals) |
| PATCH | `/w/:workspaceId/campaigns/:id/organize` | session/API key · MEMBER+ | — | `folder?`: object, `tags?`: array | — | Folder and tags (does not affect approval) |

## Companies

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/companies` | session/API key · VIEWER+ | — | — | `page?`: integer, `pageSize?`: integer, `q?`: string | List companies |
| GET | `/w/:workspaceId/companies/:id` | session/API key · VIEWER+ | — | — | — | Company profile |
| PATCH | `/w/:workspaceId/companies/:id` | session/API key · MEMBER+ | — | `name?`: string, `website?`: object, `industry?`: object, `employeeCount?`: object, `country?`: object, `city?`: object, `description?`: object | — | Update a company |

## Compliance

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/compliance/rules` | session/API key · VIEWER+ | — | — | — | Country sending rules (technical safeguards, not legal advice) |
| PUT | `/w/:workspaceId/compliance/rules` | session/API key · ADMIN+ | — | `countryCode`: string, `label`: string, `sendingAllowed`: boolean, `allowedLawfulBases`: array, `requirePostalAddress`: boolean, `requireUnsubscribeLink`: boolean, `reviewedByOwner`: boolean, `notes?`: object | — | Create/update a country rule |
| DELETE | `/w/:workspaceId/compliance/rules/:id` | session/API key · ADMIN+ | — | — | — | Delete a country rule |
| GET | `/w/:workspaceId/compliance/check/:leadId` | session/API key · VIEWER+ | — | — | — | Explain whether a lead can be contacted now |

## Copilot

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/copilot/threads` | session/API key · VIEWER+ | — | — | — | My Copilot conversations |
| GET | `/w/:workspaceId/copilot/threads/:id` | session/API key · VIEWER+ | — | — | — | Conversation with messages and proposed actions |
| POST | `/w/:workspaceId/copilot/ask` | session/API key · VIEWER+ | 120/3600s per user | `threadId?`: object, `question`: string | — | Ask the Copilot (answers + recommendations + proposed actions; nothing is executed) |
| POST | `/w/:workspaceId/copilot/actions/:id/execute` | session/API key · MEMBER+ | — | — | — | Confirm and run a proposed action (role-checked, runs once) |
| POST | `/w/:workspaceId/copilot/actions/:id/reject` | session/API key · VIEWER+ | — | — | — | Reject a proposed action |
| GET | `/w/:workspaceId/copilot/repetition` | session/API key · VIEWER+ | — | — | `campaignId?`: string | Find repetitive wording across generated emails |
| GET | `/w/:workspaceId/copilot/memory` | session/API key · VIEWER+ | — | — | — | Business memory |
| POST | `/w/:workspaceId/copilot/memory` | session/API key · ADMIN+ | — | `content`: string | — | Add business memory |
| DELETE | `/w/:workspaceId/copilot/memory/:id` | session/API key · ADMIN+ | — | — | — | Delete business memory |

## CRM

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| POST | `/w/:workspaceId/leads/:id/notes` | session/API key · MEMBER+ | — | `body`: string | — | Add a note to a lead |
| DELETE | `/w/:workspaceId/notes/:id` | session/API key · MEMBER+ | — | — | — | Delete a note |
| POST | `/w/:workspaceId/companies/:id/notes` | session/API key · MEMBER+ | — | `body`: string | — | Add a note to a company |
| GET | `/w/:workspaceId/pipeline` | session/API key · VIEWER+ | — | — | — | Opportunity pipeline by stage |
| POST | `/w/:workspaceId/opportunities` | session/API key · MEMBER+ | — | `leadId`: string, `title`: string, `stage?`: NEW\|QUALIFIED\|MEETING\|PROPOSAL\|WON\|LOST, `valueCents?`: integer, `currency?`: string, `expectedCloseAt?`: object, `campaignId?`: object | — | Create an opportunity |
| PATCH | `/w/:workspaceId/opportunities/:id` | session/API key · MEMBER+ | — | `leadId?`: string, `title?`: string, `stage?`: NEW\|QUALIFIED\|MEETING\|PROPOSAL\|WON\|LOST, `valueCents?`: integer, `currency?`: string, `expectedCloseAt?`: object, `campaignId?`: object | — | Update an opportunity (stage, value…) |
| DELETE | `/w/:workspaceId/opportunities/:id` | session/API key · MANAGER+ | — | — | — | Delete an opportunity |
| GET | `/w/:workspaceId/tasks` | session/API key · VIEWER+ | — | — | `status?`: OPEN\|DONE\|CANCELLED, `assigneeId?`: string, `due?`: overdue\|today\|upcoming | Tasks / follow-up reminders |
| POST | `/w/:workspaceId/tasks` | session/API key · MEMBER+ | — | `title`: string, `description?`: object, `priority?`: LOW\|MEDIUM\|HIGH, `dueAt?`: object, `assigneeId?`: object, `leadId?`: object, `conversationId?`: object | — | Create a task |
| PATCH | `/w/:workspaceId/tasks/:id` | session/API key · MEMBER+ | — | `title?`: string, `description?`: object, `priority?`: LOW\|MEDIUM\|HIGH, `dueAt?`: object, `assigneeId?`: object, `leadId?`: object, `conversationId?`: object, `status?`: OPEN\|DONE\|CANCELLED | — | Update / complete a task |
| DELETE | `/w/:workspaceId/tasks/:id` | session/API key · MEMBER+ | — | — | — | Delete a task |
| GET | `/w/:workspaceId/crm/forecast` | session/API key · VIEWER+ | — | — | — | Weighted pipeline forecast, expected close by month, won revenue by month, win rate |
| GET | `/w/:workspaceId/crm/opportunities/export` | session/API key · MEMBER+ | — | — | — | Export opportunities as CSV |

## Deliverability

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/domains` | session/API key · VIEWER+ | — | — | — | Sending domains with latest SPF/DKIM/DMARC/MX status |
| POST | `/w/:workspaceId/domains` | session/API key · ADMIN+ | — | `name`: string, `dkimSelectors?`: array | — | Add a domain (queues a DNS check) |
| GET | `/w/:workspaceId/domains/:id` | session/API key · VIEWER+ | — | — | — | Domain check history and guidance |
| POST | `/w/:workspaceId/domains/:id/check` | session/API key · MEMBER+ | 30/600s per workspace | — | — | Run a DNS check now |
| DELETE | `/w/:workspaceId/domains/:id` | session/API key · ADMIN+ | — | — | — | Remove a domain |
| GET | `/w/:workspaceId/provider-registry` | session/API key · VIEWER+ | — | — | — | Registrar / DNS / mailbox-provider capability registry (what is automated vs manual) |
| POST | `/w/:workspaceId/domains/:id/verification` | session/API key · ADMIN+ | — | — | — | Start ownership verification (returns the TXT record to add) |
| POST | `/w/:workspaceId/domains/:id/verification/check` | session/API key · ADMIN+ | 30/600s per workspace | — | — | Check the ownership TXT record |
| POST | `/w/:workspaceId/domains/:id/propagation` | session/API key · MEMBER+ | 30/600s per workspace | — | — | Compare SPF/DMARC/verification across Cloudflare, Google and Quad9 resolvers |
| GET | `/w/:workspaceId/domains/:id/recommended-records` | session/API key · VIEWER+ | — | — | — | DNS guidance for the mailbox providers on this domain |
| POST | `/w/:workspaceId/domains/:id/dns-records` | session/API key · ADMIN+ | — | `type`: TXT\|CNAME, `name`: string, `content`: string | — | Create one DNS record via the connected DNS provider (Cloudflare) — explicit action only |
| GET | `/w/:workspaceId/domains/:id/zone-records` | session/API key · ADMIN+ | — | — | — | Live DNS records of the domain from the connected DNS provider |
| PUT | `/w/:workspaceId/domains/:id/zone-records/:recordId` | session/API key · ADMIN+ | 30/600s per workspace | `content`: string, `ttl?`: integer, `expectedContent`: string | — | Change one record’s value (refused if it changed since you loaded it; NS/SOA protected); audited |
| DELETE | `/w/:workspaceId/domains/:id/zone-records/:recordId` | session/API key · ADMIN+ | 30/600s per workspace | `confirmName`: string, `expectedContent`: string | — | Delete one record after typing its name (NS/SOA protected); audited |
| PATCH | `/w/:workspaceId/domains/:id/renewal` | session/API key · ADMIN+ | — | `registrar?`: object, `expiresAt?`: object, `autoRenew?`: boolean\|null | — | Registrar, expiry date and auto-renew (for renewal reminders) |

## Enrichment

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| POST | `/w/:workspaceId/leads/:id/verify-waterfall` | session/API key · MEMBER+ | 300/3600s per workspace | `force?`: boolean | — | Verify one lead now through the verifier waterfall |
| POST | `/w/:workspaceId/enrichment/verify-bulk` | session/API key · MEMBER+ | — | `leadIds`: array, `force?`: boolean | — | Queue waterfall verification (skips recently verified unless force) |
| POST | `/w/:workspaceId/enrichment/find-email` | session/API key · MEMBER+ | 300/3600s per workspace | `firstName`: string, `lastName`: string, `domain`: string | — | Email discovery waterfall (name + company domain) |
| GET | `/w/:workspaceId/enrichment/stats` | session/API key · VIEWER+ | — | — | `days?`: integer | Provider comparison: checks, definitive rate, credits |
| GET | `/w/:workspaceId/leads/:id/verifications` | session/API key · VIEWER+ | — | — | — | Verification / enrichment history for a lead |
| POST | `/w/:workspaceId/email-verification/verify` | session/API key · MEMBER+ | 60/3600s per workspace | `email`: string, `leadId?`: string | — | Queue first-party syntax, disposable, role, free-provider and DNS checks (no SMTP probe) |
| POST | `/w/:workspaceId/email-verification/bulk` | session/API key · MEMBER+ | 10/3600s per workspace | `emails`: array | — | Queue deduplicated first-party DNS verification for an email list |
| GET | `/w/:workspaceId/email-verification/batches` | session/API key · VIEWER+ | — | — | `page?`: integer, `pageSize?`: integer | List first-party verification batches |
| GET | `/w/:workspaceId/email-verification/batches/:id` | session/API key · VIEWER+ | — | — | — | Get tenant-scoped verification batch and results |
| GET | `/w/:workspaceId/email-verification/datasets` | session/API key · VIEWER+ | — | — | — | List shared disposable dataset metadata and workspace overrides |
| POST | `/w/:workspaceId/email-verification/datasets/refresh` | session/API key · ADMIN+ | 1/3600s per workspace | — | — | Queue refresh from the pinned public disposable-domain source |
| POST | `/w/:workspaceId/email-verification/domain-overrides` | session/API key · ADMIN+ | — | `domain`: string, `disposable`: boolean | — | Add or exclude a domain from this workspace disposable-domain classification |
| DELETE | `/w/:workspaceId/email-verification/domain-overrides/:id` | session/API key · ADMIN+ | — | — | — | Remove a workspace disposable-domain override |
| POST | `/w/:workspaceId/email-verification/role-patterns` | session/API key · ADMIN+ | — | `localPart`: string, `enabled?`: boolean | — | Add or disable a workspace role-based local-part pattern |
| GET | `/w/:workspaceId/email-verification/:id` | session/API key · VIEWER+ | — | — | — | Get tenant-scoped first-party verification result |
| POST | `/w/:workspaceId/email-verification/diagnostics` | session/API key · ADMIN+ | 1/3600s per workspace | — | — | Admin-only outbound SMTP port 25 diagnostic to the configured MAIL FROM domain MX; sends no recipient commands or email |

## ICP

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/icps` | session/API key · VIEWER+ | — | — | — | Ideal customer profiles |
| POST | `/w/:workspaceId/icps` | session/API key · MANAGER+ | — | `name`: string, `description?`: object, `criteria`: object, `minScore?`: integer, `isActive?`: boolean | — | Create an ICP |
| PUT | `/w/:workspaceId/icps/:id` | session/API key · MANAGER+ | — | `name`: string, `description?`: object, `criteria`: object, `minScore?`: integer, `isActive?`: boolean | — | Update an ICP |
| DELETE | `/w/:workspaceId/icps/:id` | session/API key · MANAGER+ | — | — | — | Delete an ICP |
| POST | `/w/:workspaceId/icps/from-text` | session/API key · MEMBER+ | 30/3600s per workspace | `description`: string | — | Convert a natural-language description into structured ICP filters (AI draft) |

## Imports

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/imports` | session/API key · VIEWER+ | — | — | — | Recent CSV imports |
| POST | `/w/:workspaceId/imports` | session/API key · MEMBER+ | 30/3600s per workspace | — | — | Upload a CSV (multipart field "file"); returns headers, sample rows and suggested mapping |
| POST | `/w/:workspaceId/imports/:id/start` | session/API key · MEMBER+ | — | `mapping`: object, `dedupeMode?`: skip\|update, `targetListId?`: object, `newListName?`: string, `sourceName?`: string, `lawfulBasis?`: UNKNOWN\|CONSENT\|LEGITIMATE_INTEREST\|EXISTING_RELATIONSHIP\|NOT_REQUIRED, `lawfulBasisNote?`: string, `defaultCountry?`: string | — | Start an uploaded import with a column mapping |
| GET | `/w/:workspaceId/imports/:id` | session/API key · VIEWER+ | — | — | — | Import progress and row errors |

## Inbox

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/conversations` | session/API key · VIEWER+ | — | — | `page?`: integer, `pageSize?`: integer, `q?`: string, `accountId?`: string, `category?`: string, `status?`: OPEN\|WAITING\|CLOSED, `unread?`: true\|false, `campaignId?`: string, `label?`: string, `assigneeId?`: string, `hasReply?`: true\|false, `starred?`: true\|false, `archived?`: true\|false\|all | Unified inbox (search, filters, labels) |
| GET | `/w/:workspaceId/conversations/:id` | session/API key · VIEWER+ | — | — | — | Conversation thread, notes and lead |
| PATCH | `/w/:workspaceId/conversations/:id` | session/API key · MEMBER+ | — | `status?`: OPEN\|WAITING\|CLOSED, `isUnread?`: boolean, `labels?`: array, `assigneeId?`: object, `isStarred?`: boolean, `isArchived?`: boolean, `category?`: INTERESTED\|WANTS_PRICING\|WANTS_MEETING\|NEEDS_INFO\|NOT_INTERESTED\|HAS_PROVIDER… | — | Read state, status, labels, assignee, category override |
| POST | `/w/:workspaceId/conversations/:id/reply` | session/API key · MEMBER+ | 120/3600s per user | `bodyText`: string, `idempotencyKey?`: string | — | Send a reply from the original mailbox (queued, idempotent) |
| POST | `/w/:workspaceId/conversations/:id/notes` | session/API key · MEMBER+ | — | `body`: string | — | Internal note on a conversation |
| POST | `/w/:workspaceId/conversations/:id/summary` | session/API key · MEMBER+ | — | — | — | AI summary of the conversation |
| POST | `/w/:workspaceId/conversations/:id/draft` | session/API key · MEMBER+ | — | — | — | AI reply draft (never sent automatically) |
| POST | `/w/:workspaceId/messages/:id/classify` | session/API key · MEMBER+ | — | — | — | Re-run AI classification for a message |
| GET | `/w/:workspaceId/attachments/:id` | session/API key · VIEWER+ | — | — | — | Download an attachment |
| POST | `/w/:workspaceId/conversations/:id/forward` | session/API key · MEMBER+ | 60/3600s per user | `to`: string, `note?`: string, `idempotencyKey?`: string | — | Forward a conversation from its mailbox (human action) |

## Integrations

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/integrations` | session/API key · ADMIN+ | — | — | — | Provider integrations (secrets never returned) |
| PUT | `/w/:workspaceId/integrations` | session/API key · ADMIN+ | — | `type`: apollo\|millionverifier\|zerobounce\|neverbounce\|hunter\|brave…, `secret?`: string, `publicConfig?`: object, `isEnabled?`: boolean | — | Set provider key / config |
| DELETE | `/w/:workspaceId/integrations/:type` | session/API key · ADMIN+ | — | — | — | Remove a provider integration |
| POST | `/w/:workspaceId/integrations/:type/test` | session/API key · ADMIN+ | 20/600s per workspace | — | — | Test a provider integration |

## Jobs

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/jobs/queues` | session/API key · ADMIN+ | — | — | — | Queue counts (all workspaces on this server) |
| GET | `/w/:workspaceId/jobs/failed` | session/API key · ADMIN+ | — | — | `queue`: scheduler\|outbound-prepare\|send\|reply-send\|mailbox-sync\|ai… | Failed jobs for a queue (this workspace) |
| POST | `/w/:workspaceId/jobs/retry` | session/API key · ADMIN+ | — | `queue`: scheduler\|outbound-prepare\|send\|reply-send\|mailbox-sync\|ai…, `jobId`: string | — | Retry a failed job |
| GET | `/w/:workspaceId/jobs/history` | session/API key · ADMIN+ | — | — | `page?`: integer, `pageSize?`: integer, `status?`: string, `queue?`: string | Recorded job runs |

## Leads

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/leads` | session/API key · VIEWER+ | — | — | `page?`: integer, `pageSize?`: integer, `q?`: string, `status?`: NEW\|RESEARCHED\|QUALIFIED\|DISQUALIFIED\|CONTACTED\|REPLIED…, `listId?`: string, `companyId?`: string, `verification?`: UNVERIFIED\|VALID\|INVALID\|RISKY\|CATCH_ALL\|UNKNOWN, `minScore?`: integer, `country?`: string, `tag?`: string, `sort?`: createdAt\|score\|lastRepliedAt\|email | Search / filter leads |
| POST | `/w/:workspaceId/leads` | session/API key · MEMBER+ | — | `email`: string, `firstName?`: object, `lastName?`: object, `title?`: object, `linkedinUrl?`: object, `website?`: object, `phone?`: object, `country?`: object, `city?`: object, `timezone?`: object, `companyName?`: object, `companyDomain?`: object, `lawfulBasis?`: UNKNOWN\|CONSENT\|LEGITIMATE_INTEREST\|EXISTING_RELATIONSHIP\|NOT_REQUIRED, `lawfulBasisNote?`: object, `tags?`: array, `customFields?`: object, `ownerId?`: object | — | Create a lead |
| GET | `/w/:workspaceId/leads/export` | session/API key · MEMBER+ | — | — | `page?`: integer, `pageSize?`: integer, `q?`: string, `status?`: NEW\|RESEARCHED\|QUALIFIED\|DISQUALIFIED\|CONTACTED\|REPLIED…, `listId?`: string, `companyId?`: string, `verification?`: UNVERIFIED\|VALID\|INVALID\|RISKY\|CATCH_ALL\|UNKNOWN, `minScore?`: integer, `country?`: string, `tag?`: string, `sort?`: createdAt\|score\|lastRepliedAt\|email | Export leads as CSV (same filters as list) |
| POST | `/w/:workspaceId/leads/bulk` | session/API key · MEMBER+ | — | `ids`: array, `action`: add_to_list\|remove_from_list\|add_tag\|set_status\|set_lawful_basis\|research…, `listId?`: string, `tag?`: string, `status?`: NEW\|RESEARCHED\|QUALIFIED\|DISQUALIFIED\|CONTACTED\|REPLIED…, `lawfulBasis?`: UNKNOWN\|CONSENT\|LEGITIMATE_INTEREST\|EXISTING_RELATIONSHIP\|NOT_REQUIRED, `icpId?`: string | — | Bulk action on leads |
| GET | `/w/:workspaceId/leads/:id` | session/API key · VIEWER+ | — | — | — | Lead profile with history, research, scores, conversations |
| PATCH | `/w/:workspaceId/leads/:id` | session/API key · MEMBER+ | — | `email?`: string, `firstName?`: object, `lastName?`: object, `title?`: object, `linkedinUrl?`: object, `website?`: object, `phone?`: object, `country?`: object, `city?`: object, `timezone?`: object, `companyName?`: object, `companyDomain?`: object, `lawfulBasis?`: UNKNOWN\|CONSENT\|LEGITIMATE_INTEREST\|EXISTING_RELATIONSHIP\|NOT_REQUIRED, `lawfulBasisNote?`: object, `tags?`: array, `customFields?`: object, `ownerId?`: object, `status?`: NEW\|RESEARCHED\|QUALIFIED\|DISQUALIFIED\|CONTACTED\|REPLIED… | — | Update a lead (status changes are recorded) |
| DELETE | `/w/:workspaceId/leads/:id` | session/API key · MANAGER+ | — | — | — | Delete a lead |
| POST | `/w/:workspaceId/leads/:id/verify` | session/API key · MEMBER+ | — | — | — | Verify the lead email now (uses configured verifier) |

## Lists

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/lists` | session/API key · VIEWER+ | — | — | — | Lead lists |
| POST | `/w/:workspaceId/lists` | session/API key · MEMBER+ | — | `name`: string, `description?`: object | — | Create a list |
| PATCH | `/w/:workspaceId/lists/:id` | session/API key · MEMBER+ | — | `name?`: string, `description?`: object | — | Rename a list |
| DELETE | `/w/:workspaceId/lists/:id` | session/API key · MANAGER+ | — | — | — | Delete a list (leads are kept) |

## Logs

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/audit-logs` | session/API key · ADMIN+ | — | — | `page?`: integer, `pageSize?`: integer, `action?`: string, `actorUserId?`: string, `entityType?`: string | Audit log |
| GET | `/w/:workspaceId/error-logs` | session/API key · ADMIN+ | — | — | `page?`: integer, `pageSize?`: integer, `source?`: api\|worker | Error log (API + worker) |

## Mailboxes

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/email-accounts` | session/API key · VIEWER+ | — | — | — | Connected mailboxes with today’s usage and health |
| POST | `/w/:workspaceId/email-accounts/oauth/:provider` | session/API key · ADMIN+ | — | `loginHint?`: string | — | Start Google / Microsoft OAuth (returns the consent URL) |
| POST | `/w/:workspaceId/email-accounts/smtp` | session/API key · ADMIN+ | — | `emailAddress`: string, `displayName?`: string, `password?`: string, `smtpPassword?`: string, `imapPassword?`: string, `smtpHost`: string, `smtpPort`: integer, `smtpSecure`: boolean, `imapHost`: string, `imapPort`: integer, `imapSecure`: boolean, `username?`: string, `smtpUsername?`: string, `imapUsername?`: string, `sentFolder?`: string, `appendToSent?`: boolean | — | Connect an SMTP/IMAP mailbox (only where the provider permits it) |
| PATCH | `/w/:workspaceId/email-accounts/:id` | session/API key · ADMIN+ | — | `displayName?`: object, `replyTo?`: object, `signatureText?`: object, `dailySendLimit?`: integer, `minSecondsBetweenSends?`: integer, `sendingWindow?`: object | — | Sender identity, limits and sending window |
| POST | `/w/:workspaceId/email-accounts/:id/test` | session/API key · ADMIN+ | — | — | — | Test mailbox connection |
| POST | `/w/:workspaceId/email-accounts/:id/delivery-diagnostic` | session/API key · ADMIN+ | 1/900s per workspace | — | — | Send one clearly labeled diagnostic message from an authorized mailbox to itself |
| POST | `/w/:workspaceId/email-accounts/:id/pause` | session/API key · ADMIN+ | — | — | — | Pause sending from a mailbox |
| POST | `/w/:workspaceId/email-accounts/:id/resume` | session/API key · ADMIN+ | — | — | — | Resume a paused mailbox |
| POST | `/w/:workspaceId/email-accounts/:id/resync` | session/API key · ADMIN+ | — | — | — | Full resync of the mailbox |
| DELETE | `/w/:workspaceId/email-accounts/:id` | session/API key · ADMIN+ | — | — | — | Disconnect (revokes tokens, pauses its sequences) |
| GET | `/w/:workspaceId/mailbox-health` | session/API key · VIEWER+ | — | — | — | Connection, auth, sync, send/receive, errors, bounces, complaints and DNS per mailbox |

## Notifications

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/notifications` | session/API key · VIEWER+ | — | — | — | My notifications |
| POST | `/w/:workspaceId/notifications/read` | session/API key · VIEWER+ | — | `ids?`: array | — | Mark notifications read (all if ids omitted) |
| GET | `/w/:workspaceId/notification-channels` | session/API key · ADMIN+ | — | — | — | Slack / email notification channels (secrets never returned) |
| POST | `/w/:workspaceId/notification-channels` | session/API key · ADMIN+ | — | see OpenAPI | — | Add a Slack incoming webhook or email channel |
| DELETE | `/w/:workspaceId/notification-channels/:id` | session/API key · ADMIN+ | — | — | — | Remove a channel |
| POST | `/w/:workspaceId/notification-channels/test` | session/API key · ADMIN+ | 10/600s per workspace | — | — | Send a test notification to all channels |

## Organizations

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/orgs` | session | — | — | — | Organizations I belong to, with the workspaces I can open |
| GET | `/orgs/:organizationId` | session/API key · VIEWER+ | — | — | — | Organization profile, status, plan, entitlements and usage |
| PATCH | `/orgs/:organizationId` | session/API key · VIEWER+ | — | `name?`: string, `timezone?`: string, `locale?`: string, `currency?`: string, `branding?`: object, `billingOwnerId?`: string | — | Update name, time zone, locale, currency, branding, billing owner |
| GET | `/orgs/:organizationId/members` | session/API key · VIEWER+ | — | — | — | Organization members, roles and workspace access |
| PATCH | `/orgs/:organizationId/members/:userId` | session/API key · VIEWER+ | — | `role`: OWNER\|ADMIN\|BILLING\|MEMBER | — | Change a member's organization role |
| DELETE | `/orgs/:organizationId/members/:userId` | session/API key · VIEWER+ | — | — | — | Remove a member from the organization (and all its workspaces) |
| GET | `/orgs/:organizationId/workspaces` | session/API key · VIEWER+ | — | — | — | Workspaces I can open in this organization |
| POST | `/orgs/:organizationId/workspaces` | session/API key · VIEWER+ | — | `name`: string, `timezone?`: string | — | Create a workspace (team, client or brand) — counts against the plan |
| POST | `/orgs/:organizationId/workspaces/:workspaceId/archive` | session/API key · VIEWER+ | — | — | — | Archive a workspace (data kept; hidden from members) |
| GET | `/orgs/:organizationId/onboarding` | session/API key · VIEWER+ | — | — | — | Setup checklist computed from real configuration |
| POST | `/orgs/:organizationId/onboarding/:step/skip` | session/API key · VIEWER+ | — | `skip?`: boolean | — | Skip (or un-skip) an optional setup step |
| GET | `/orgs/:organizationId/support-access` | session/API key · VIEWER+ | — | — | — | When EMN support accessed this organization, why, and how many pages they viewed |
| GET | `/orgs/:organizationId/usage` | session/API key · VIEWER+ | — | — | — | Usage this period and the last 6 months |
| POST | `/orgs/:organizationId/export` | session/API key · VIEWER+ | 3/3600s per user | — | — | Download a JSON export of the organization and all its workspaces (secrets excluded) |
| POST | `/orgs/:organizationId/deletion` | session/API key · VIEWER+ | — | `confirmName`: string | — | Schedule permanent deletion of the organization (grace period, then erased) |
| DELETE | `/orgs/:organizationId/deletion` | session/API key · VIEWER+ | — | — | — | Cancel a scheduled deletion |

## Personalization

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| PUT | `/w/:workspaceId/leads/:id/ai-instructions` | session/API key · MEMBER+ | — | `aiInstructions`: object | — | Set instructions for this individual prospect (applied last in the hierarchy) |
| PUT | `/w/:workspaceId/campaigns/:id/ai` | session/API key · MEMBER+ | — | `aiProfileId?`: object, `icpId?`: object, `aiOverrides?`: object, `maxAiCostPerLeadUsd?`: object, `usePregeneratedAi?`: boolean | — | Campaign AI profile, ICP, overrides and cost limit (requires re-approval) |
| GET | `/w/:workspaceId/campaigns/:id/personalizations` | session/API key · VIEWER+ | — | — | `page?`: integer, `pageSize?`: integer, `status?`: QUEUED\|GENERATING\|NEEDS_RESEARCH\|GENERATED\|BLOCKED\|APPROVED…, `stepId?`: string, `q?`: string | Per-lead generated content, status, score, warnings and cost |
| GET | `/w/:workspaceId/campaigns/:id/personalizations/lead/:leadId` | session/API key · VIEWER+ | — | — | — | Review one recipient: research, evidence, every step, warnings, cost |
| GET | `/w/:workspaceId/campaigns/:id/personalizations/prompt-preview` | session/API key · VIEWER+ | — | — | `leadId`: string, `stepId`: string | Resolved instructions and prompt for one lead/step (no AI call) |
| POST | `/w/:workspaceId/campaigns/:id/personalizations/generate` | session/API key · MEMBER+ | 300/3600s per workspace | `leadId`: string, `stepId`: string, `force?`: boolean, `note?`: string | — | Generate (or regenerate with force) one lead/step now |
| POST | `/w/:workspaceId/campaigns/:id/personalizations/estimate` | session/API key · MEMBER+ | — | `stepIds?`: array, `leadIds?`: array, `force?`: boolean, `onlyMissing?`: boolean, `maxCostUsd?`: object | — | Estimate cost of bulk generation |
| POST | `/w/:workspaceId/campaigns/:id/personalizations/batches` | session/API key · MANAGER+ | 30/3600s per workspace | `stepIds?`: array, `leadIds?`: array, `force?`: boolean, `onlyMissing?`: boolean, `maxCostUsd?`: object | — | Start bulk generation (queued; approved and manually edited content is preserved unless force) |
| GET | `/w/:workspaceId/campaigns/:id/personalizations/batches` | session/API key · VIEWER+ | — | — | — | Bulk generation runs |
| POST | `/w/:workspaceId/personalization-batches/:batchId/cancel` | session/API key · MANAGER+ | — | — | — | Cancel a running batch |
| POST | `/w/:workspaceId/campaigns/:id/personalizations/retry-failed` | session/API key · MANAGER+ | — | — | — | Re-queue failed generations |
| POST | `/w/:workspaceId/campaigns/:id/personalizations/research-missing` | session/API key · MEMBER+ | — | `maxAgeDays?`: integer | — | Queue research for recipients without recent research |
| GET | `/w/:workspaceId/personalizations/:pid` | session/API key · VIEWER+ | — | — | — | One generated email with revisions, evidence and quality report |
| PATCH | `/w/:workspaceId/personalizations/:pid` | session/API key · MEMBER+ | — | `subject?`: object, `openingLine?`: object, `body?`: string, `cta?`: object, `rerunFactCheck?`: boolean, `feedbackNote?`: string, `feedbackScope?`: GLOBAL\|CAMPAIGN\|PROSPECT\|FACTUAL | — | Manually edit (preserved; re-checked; needs approval again) |
| POST | `/w/:workspaceId/personalizations/approve` | session/API key · MANAGER+ | — | `ids`: array | — | Approve one or many (only when quality checks pass) |
| POST | `/w/:workspaceId/personalizations/:pid/reject` | session/API key · MANAGER+ | — | `reason`: string | — | Reject |

## Platform

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/platform/me` | session/API key · VIEWER+ | — | — | — | My platform role, permissions and whether 2FA is on (required for every other platform route) |
| GET | `/platform/users` | session/API key · VIEWER+ | — | — | `q`: string, `page?`: integer | Find user accounts by email or name |
| POST | `/platform/users/:id/status` | session/API key · VIEWER+ | — | `status`: ACTIVE\|DISABLED, `reason`: string | — | Disable (signs out everywhere) or re-enable a user account; reason required |
| GET | `/platform/metrics` | session/API key · VIEWER+ | — | — | — | SaaS metrics: tenants by status, MRR/ARR, churn, plan and usage distribution, operations |
| GET | `/platform/tenants` | session/API key · VIEWER+ | — | — | `q?`: string, `status?`: PENDING_SETUP\|TRIAL\|ACTIVE\|PAST_DUE\|SUSPENDED\|CANCELLED…, `plan?`: string, `page?`: integer, `pageSize?`: integer, `sort?`: createdAt\|name | Search and filter tenants |
| GET | `/platform/tenants/:id` | session/API key · VIEWER+ | — | — | — | Tenant detail: subscription, usage, workspaces, users, integration status (no secrets), audit |
| POST | `/platform/tenants/:id/lifecycle` | session/API key · VIEWER+ | — | `action`: suspend\|reactivate\|cancel\|schedule_deletion\|restore\|purge_now, `reason`: string | — | Suspend, reactivate, cancel, schedule deletion, restore or purge (reason required) |
| POST | `/platform/tenants/:id/subscription` | session/API key · VIEWER+ | — | `planCode?`: string, `status?`: TRIALING\|ACTIVE\|PAST_DUE\|CANCELED\|INCOMPLETE, `trialEndsAt?`: object, `graceUntil?`: object, `overrides?`: object, `reason`: string | — | Override plan, status, trial, grace or entitlements (reason required) |
| POST | `/platform/tenants/:id/refunds` | session/API key · VIEWER+ | 20/3600s per user | `invoiceId`: string, `amountCents?`: integer, `reason`: string, `cancelSubscription?`: boolean, `requestKey`: string | — | Refund all or part of a paid invoice (optionally cancelling the subscription); idempotent on requestKey |
| GET | `/platform/tenants/:id/billing` | session/API key · VIEWER+ | — | — | — | Invoices, refunds and disputes of a tenant (no payment secrets) |
| GET | `/platform/plans` | session/API key · VIEWER+ | — | — | — | All plans including archived, with subscriber counts |
| POST | `/platform/plans` | session/API key · VIEWER+ | — | `code`: string, `name`: string, `description?`: string, `priceMonthlyCents`: integer, `priceYearlyCents`: integer, `currency?`: string, `trialDays?`: integer, `isPublic?`: boolean, `isActive?`: boolean, `sortOrder?`: integer, `providerPriceIds?`: object, `entitlements`: object | — | Create a plan |
| PUT | `/platform/plans/:id` | session/API key · VIEWER+ | — | `code`: string, `name`: string, `description?`: string, `priceMonthlyCents`: integer, `priceYearlyCents`: integer, `currency?`: string, `trialDays?`: integer, `isPublic?`: boolean, `isActive?`: boolean, `sortOrder?`: integer, `providerPriceIds?`: object, `entitlements`: object | — | Update a plan (prices, limits, features, provider price ids) |
| POST | `/platform/plans/:id/archive` | session/API key · VIEWER+ | — | `archived`: boolean | — | Archive / unarchive a plan |
| GET | `/platform/operations` | session/API key · VIEWER+ | — | — | — | Queue depths, dead-lettered jobs and failure counters (last 24 h) |
| POST | `/platform/operations/retry` | session/API key · VIEWER+ | — | `queue`: string, `jobId`: string, `reason`: string | — | Retry one dead-lettered job (reason required, audited) |
| GET | `/platform/support/grants` | session/API key · VIEWER+ | — | — | — | My active support-access grants |
| POST | `/platform/support/grants` | session/API key · VIEWER+ | — | `organizationId`: string, `reason`: string, `minutes?`: integer | — | Open time-limited, read-only, audited access to one tenant (reason required) |
| DELETE | `/platform/support/grants/:id` | session/API key · VIEWER+ | — | — | — | End a support-access grant |
| GET | `/platform/audit` | session/API key · VIEWER+ | — | — | `organizationId?`: string, `action?`: string, `page?`: integer, `pageSize?`: integer | Platform audit trail (append-only) |

## Privacy

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/privacy/requests` | session/API key · ADMIN+ | — | — | — | Data export / erasure requests |
| POST | `/w/:workspaceId/privacy/requests` | session/API key · ADMIN+ | — | `type`: EXPORT\|ERASURE, `subjectEmail`: string | — | Create an export or erasure request for one email address |
| GET | `/w/:workspaceId/privacy/requests/:id/download` | session/API key · ADMIN+ | — | — | — | Download a completed export (JSON) |
| GET | `/w/:workspaceId/export` | session/API key · OWNER+ | 3/3600s per workspace | — | — | Full workspace data export (JSON) |

## Prompt library

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/ai-studio/profiles` | session/API key · VIEWER+ | — | — | `archived?`: boolean | Prompt profiles (folders, tags, approval) |
| POST | `/w/:workspaceId/ai-studio/profiles` | session/API key · MEMBER+ | — | `name`: string, `description?`: string, `instructions?`: string, `settings?`: object, `folder?`: string, `tags?`: array | — | Create a prompt profile (version 1) |
| GET | `/w/:workspaceId/ai-studio/profiles/:id` | session/API key · VIEWER+ | — | — | — | Profile with all versions and campaigns using it |
| PATCH | `/w/:workspaceId/ai-studio/profiles/:id` | session/API key · MEMBER+ | — | `name?`: string, `description?`: object, `folder?`: object, `tags?`: array, `isArchived?`: boolean, `isApproved?`: boolean | — | Rename, move to folder, tag, approve for team use or archive |
| POST | `/w/:workspaceId/ai-studio/profiles/:id/versions` | session/API key · MEMBER+ | — | `instructions`: string, `settings?`: object, `changeNote?`: string, `activate?`: boolean | — | Save a new version (approved campaigns keep their frozen version) |
| POST | `/w/:workspaceId/ai-studio/profiles/:id/versions/:versionId/activate` | session/API key · MEMBER+ | — | — | — | Activate an earlier version |
| GET | `/w/:workspaceId/ai-studio/profiles/:id/compare` | session/API key · VIEWER+ | — | — | `a`: integer, `b`: integer | Compare two versions (line diff + settings) |
| POST | `/w/:workspaceId/ai-studio/profiles/:id/duplicate` | session/API key · MEMBER+ | — | `name`: string | — | Duplicate a profile |
| POST | `/w/:workspaceId/ai-studio/profiles/lint` | session/API key · VIEWER+ | — | `instructions`: string | — | Check prompt syntax and variables |
| GET | `/w/:workspaceId/ai-studio/profiles-export` | session/API key · MEMBER+ | — | — | `ids?`: string | Export profiles as JSON |
| POST | `/w/:workspaceId/ai-studio/profiles-import` | session/API key · MEMBER+ | — | `format`: string, `profiles`: array | — | Import profiles from an export file |
| POST | `/w/:workspaceId/ai-studio/profiles/:id/test` | session/API key · MEMBER+ | 60/3600s per workspace | `leadId`: string, `campaignId`: string, `stepOrder?`: integer | — | Test the profile on a sample lead (real AI call, costs recorded; nothing is saved to campaigns) |

## Prospecting

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| POST | `/w/:workspaceId/prospecting/search` | session/API key · MEMBER+ | 60/3600s per workspace | `icpId?`: object, `query?`: string, `criteria`: object, `page?`: integer, `perPage?`: integer | — | Search the configured licensed data provider |
| POST | `/w/:workspaceId/prospecting/import` | session/API key · MEMBER+ | — | `searchId`: string, `externalIds`: array, `listId?`: object, `lawfulBasis`: UNKNOWN\|CONSENT\|LEGITIMATE_INTEREST\|EXISTING_RELATIONSHIP\|NOT_REQUIRED, `lawfulBasisNote?`: string, `enrich?`: boolean, `autoVerify?`: boolean, `autoResearch?`: boolean, `autoScore?`: boolean | — | Import selected search results (enrich, dedupe, verify, research, score) |
| GET | `/w/:workspaceId/prospecting/searches` | session/API key · VIEWER+ | — | — | — | Recent searches |
| GET | `/w/:workspaceId/prospecting/searches/:id` | session/API key · VIEWER+ | — | — | — | Search results |

## Public

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/public/plans` | public | 120/60s per ip | — | — | Public plan catalogue (prices, limits, features) for the pricing page |

## Qualification

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| POST | `/w/:workspaceId/leads/:id/score` | session/API key · MEMBER+ | — | `icpId?`: object | — | Score a lead against an ICP now |

## Reply assistant

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/reply-suggestions` | session/API key · VIEWER+ | — | — | `status?`: PENDING\|APPROVED\|SENT\|DISMISSED\|FAILED, `conversationId?`: string | AI reply drafts / suggestions / auto-reply log |
| POST | `/w/:workspaceId/reply-suggestions/:id/approve` | session/API key · MEMBER+ | 300/3600s per user | `body?`: string | — | Approve (optionally edited) and send from the original mailbox |
| POST | `/w/:workspaceId/reply-suggestions/:id/dismiss` | session/API key · MEMBER+ | — | — | — | Dismiss a suggestion |
| POST | `/w/:workspaceId/conversations/:id/suggest` | session/API key · MEMBER+ | 120/3600s per workspace | — | — | Generate an AI suggestion for the latest inbound message now |
| GET | `/w/:workspaceId/reply-templates` | session/API key · VIEWER+ | — | — | — | Reply templates (only approved ones can be auto-sent) |
| POST | `/w/:workspaceId/reply-templates` | session/API key · MEMBER+ | — | `name`: string, `body`: string, `categories`: array | — | Create a reply template |
| PUT | `/w/:workspaceId/reply-templates/:id` | session/API key · MEMBER+ | — | `name`: string, `body`: string, `categories`: array | — | Edit a template (resets approval) |
| POST | `/w/:workspaceId/reply-templates/:id/approve` | session/API key · MANAGER+ | — | `approve`: boolean | — | Approve / withdraw a template for auto-reply use |
| DELETE | `/w/:workspaceId/reply-templates/:id` | session/API key · MANAGER+ | — | — | — | Delete a template |

## Reports

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/reports` | session/API key · VIEWER+ | — | — | — | Scheduled email reports |
| POST | `/w/:workspaceId/reports` | session/API key · MANAGER+ | — | `name`: string, `kind`: campaign_summary\|pipeline\|ai_cost, `frequency`: DAILY\|WEEKLY, `recipients`: array, `isActive?`: boolean | — | Create a scheduled report (recipients must be members) |
| PUT | `/w/:workspaceId/reports/:id` | session/API key · MANAGER+ | — | `name`: string, `kind`: campaign_summary\|pipeline\|ai_cost, `frequency`: DAILY\|WEEKLY, `recipients`: array, `isActive?`: boolean | — | Update a scheduled report |
| DELETE | `/w/:workspaceId/reports/:id` | session/API key · MANAGER+ | — | — | — | Delete a scheduled report |
| GET | `/w/:workspaceId/reports/preview/:kind` | session/API key · VIEWER+ | — | — | — | Preview report text |

## Research

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| POST | `/w/:workspaceId/leads/:id/research` | session/API key · MEMBER+ | — | `thenScore?`: boolean | — | Queue research for a lead |
| POST | `/w/:workspaceId/companies/:id/research` | session/API key · MEMBER+ | — | — | — | Queue research for a company |
| GET | `/w/:workspaceId/research` | session/API key · VIEWER+ | — | — | `page?`: integer, `pageSize?`: integer, `status?`: string | Research reports |
| GET | `/w/:workspaceId/research/:id` | session/API key · VIEWER+ | — | — | — | Report with claims and evidence URLs |
| PATCH | `/w/:workspaceId/research/claims/:id` | session/API key · MEMBER+ | — | `status`: SUPPORTED\|REJECTED | — | Reject / restore a claim (rejected claims are never used in emails) |

## Saved filters

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/saved-filters` | session/API key · VIEWER+ | — | — | — | My saved filters plus shared ones |
| POST | `/w/:workspaceId/saved-filters` | session/API key · VIEWER+ | — | `entity`: leads\|conversations\|campaigns\|opportunities, `name`: string, `query`: object, `isShared?`: boolean | — | Save a filter (optionally shared with the workspace) |
| DELETE | `/w/:workspaceId/saved-filters/:id` | session/API key · VIEWER+ | — | — | — | Delete my filter (managers can delete shared filters) |

## Sending

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/outbound` | session/API key · VIEWER+ | — | — | `page?`: integer, `pageSize?`: integer, `campaignId?`: string, `status?`: string, `awaitingApproval?`: true\|false | Send history and message status |
| GET | `/w/:workspaceId/outbound/:id` | session/API key · VIEWER+ | — | — | — | One outbound email with fact-check report and evidence |
| POST | `/w/:workspaceId/outbound/:id/review` | session/API key · MEMBER+ | — | `decision`: approve\|reject, `subject?`: string, `bodyText?`: string, `reason?`: string | — | Approve (optionally edited) or reject an email awaiting review |

## Suppression

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/suppressions` | session/API key · VIEWER+ | — | — | `page?`: integer, `pageSize?`: integer, `q?`: string, `reason?`: string | Suppression / unsubscribe list |
| POST | `/w/:workspaceId/suppressions` | session/API key · MEMBER+ | — | `type`: EMAIL\|DOMAIN, `value`: string, `reason?`: UNSUBSCRIBED\|DO_NOT_CONTACT_REQUEST\|MANUAL\|LEGAL\|COMPLAINT, `note?`: string | — | Add an email or domain to the suppression list |
| POST | `/w/:workspaceId/suppressions/import` | session/API key · MANAGER+ | — | — | — | Bulk import suppressions from CSV (first column = email or @domain) |
| GET | `/w/:workspaceId/suppressions/export` | session/API key · MANAGER+ | — | — | — | Export suppression list as CSV |
| DELETE | `/w/:workspaceId/suppressions/:id` | session/API key · ADMIN+ | — | — | `reason?`: string | Remove a suppression entry (opt-outs need a documented reason) |

## Team

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/members` | session/API key · VIEWER+ | — | — | — | Members and pending invitations |
| PATCH | `/w/:workspaceId/members/:memberId` | session/API key · ADMIN+ | — | `role`: OWNER\|ADMIN\|MANAGER\|MEMBER\|VIEWER | — | Change a member role |
| DELETE | `/w/:workspaceId/members/:memberId` | session/API key · ADMIN+ | — | — | — | Remove a member |
| POST | `/w/:workspaceId/invitations` | session/API key · ADMIN+ | — | `email`: string, `role`: OWNER\|ADMIN\|MANAGER\|MEMBER\|VIEWER | — | Invite a member (returns a link to share) |
| DELETE | `/w/:workspaceId/invitations/:id` | session/API key · ADMIN+ | — | — | — | Revoke an invitation |

## Webhooks

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/webhooks` | session/API key · ADMIN+ | — | — | — | Outbound webhooks |
| POST | `/w/:workspaceId/webhooks` | session/API key · ADMIN+ | — | `name`: string, `url`: string, `events`: array, `isEnabled?`: boolean | — | Create a webhook (signing secret shown once) |
| PUT | `/w/:workspaceId/webhooks/:id` | session/API key · ADMIN+ | — | `name`: string, `url`: string, `events`: array, `isEnabled?`: boolean | — | Update a webhook |
| DELETE | `/w/:workspaceId/webhooks/:id` | session/API key · ADMIN+ | — | — | — | Delete a webhook |
| POST | `/w/:workspaceId/webhooks/:id/test` | session/API key · ADMIN+ | — | — | — | Send a test delivery |
| GET | `/w/:workspaceId/webhooks/:id/deliveries` | session/API key · ADMIN+ | — | — | — | Recent deliveries |

## Workflows

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| GET | `/w/:workspaceId/workflows` | session/API key · VIEWER+ | — | — | — | List workflows |
| POST | `/w/:workspaceId/workflows` | session/API key · MANAGER+ | — | `name`: string, `trigger`: lead.created\|lead.enriched\|lead.scored\|lead.status_changed\|reply.categorized\|email.bounced…, `graph`: object, `maxRunsPerDay?`: integer, `changeNote?`: string | — | Create a workflow (version 1) |
| GET | `/w/:workspaceId/workflows/:id` | session/API key · VIEWER+ | — | — | — | Workflow with all versions |
| PUT | `/w/:workspaceId/workflows/:id` | session/API key · MANAGER+ | — | `name`: string, `trigger`: lead.created\|lead.enriched\|lead.scored\|lead.status_changed\|reply.categorized\|email.bounced…, `graph`: object, `maxRunsPerDay?`: integer, `changeNote?`: string | — | Save a new version (becomes active version) |
| DELETE | `/w/:workspaceId/workflows/:id` | session/API key · MANAGER+ | — | — | — | Delete a workflow |
| POST | `/w/:workspaceId/workflows/:id/active` | session/API key · MANAGER+ | — | `active`: boolean | — | Activate / deactivate |
| POST | `/w/:workspaceId/workflows/:id/versions/:versionId/restore` | session/API key · MANAGER+ | — | — | — | Make an older version active |
| POST | `/w/:workspaceId/workflows/:id/run` | session/API key · MANAGER+ | 60/600s per workspace | `testMode?`: boolean, `payload?`: object | — | Run now (testMode=true is a dry run that changes nothing) |
| GET | `/w/:workspaceId/workflows/:id/runs` | session/API key · VIEWER+ | — | — | — | Execution history with per-block log |
| POST | `/w/:workspaceId/workflows/:id/webhook-token` | session/API key · ADMIN+ | — | — | — | Rotate the inbound webhook token (shown once) |

## Workspaces

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| POST | `/workspaces` | session | — | `name`: string | — | Create a workspace |
| GET | `/w/:workspaceId` | session/API key · VIEWER+ | — | — | — | Workspace details & settings |
| PATCH | `/w/:workspaceId` | session/API key · ADMIN+ | — | `name?`: string, `timezone?`: string, `senderLegalName?`: object, `postalAddress?`: object, `settings?`: object | — | Update workspace settings (sender identity, postal address, retention, providers) |
| GET | `/w/:workspaceId/dashboard` | session/API key · VIEWER+ | — | — | — | Overview dashboard counters |
| GET | `/w/:workspaceId/access` | session/API key · VIEWER+ | — | — | — | How the caller is accessing this workspace (member, organization admin, or audited support access) and the tenant status |

## Writing

| Method | Path | Auth · role | Rate limit | Body | Query | Summary |
|---|---|---|---|---|---|---|
| POST | `/w/:workspaceId/writing/generate` | session/API key · MEMBER+ | 120/3600s per workspace | `leadId`: string, `mode?`: first_line\|full\|followup, `templateSubject?`: string, `templateBody?`: string, `previousEmails?`: string, `instructions?`: string | — | Generate an evidence-backed email draft + fact-check |
| POST | `/w/:workspaceId/writing/subjects` | session/API key · MEMBER+ | — | `leadId`: string, `body`: string, `count?`: integer | — | Subject line suggestions |
| POST | `/w/:workspaceId/writing/fact-check` | session/API key · MEMBER+ | — | `leadId`: string, `text`: string | — | Fact-check any draft against the lead’s supported claims |

