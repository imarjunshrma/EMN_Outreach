# API route review

Current declared route count: **284** across `9` route modules. Prefix is `/api/v1`. Route declarations use Zod schemas where supplied; `mountRoutes()` handles auth, membership, role, API-key scope, rate limit and validation. A complete HTTP-level pass is BLOCKED without DB/Redis.

| Method | Path | Tag | Auth | Declared role / enforcement | Summary | Source |
|---|---|---|---|---|---|---|
| GET | /w/:workspaceId/ai-studio/overview | AI Studio | Active configuration versions, documents, profiles and AI spend this month | workspace | VIEWER | backend/src/routes/ai-studio.ts |
| GET | /w/:workspaceId/ai-studio/config/:kind | AI Studio | Active business knowledge / writing / research configuration | workspace | VIEWER | backend/src/routes/ai-studio.ts |
| PUT | /w/:workspaceId/ai-studio/config/:kind | AI Studio | Save a new version (validated; becomes active) | workspace | ADMIN | backend/src/routes/ai-studio.ts |
| GET | /w/:workspaceId/ai-studio/config/:kind/versions | AI Studio | Version history | workspace | VIEWER | backend/src/routes/ai-studio.ts |
| POST | /w/:workspaceId/ai-studio/config-versions/:id/activate | AI Studio | Re-activate an earlier version | workspace | ADMIN | backend/src/routes/ai-studio.ts |
| GET | /w/:workspaceId/ai-studio/schemas | AI Studio | Defaults and JSON schemas for the configuration forms | workspace | VIEWER | backend/src/routes/ai-studio.ts |
| GET | /w/:workspaceId/ai-studio/documents | AI Studio | Knowledge documents | workspace | VIEWER | backend/src/routes/ai-studio.ts |
| GET | /w/:workspaceId/ai-studio/documents/:id | AI Studio | One knowledge document with its extracted text | workspace | VIEWER | backend/src/routes/ai-studio.ts |
| POST | /w/:workspaceId/ai-studio/documents | AI Studio | Add a document (multipart "file" .txt/.md/.csv/.json/.html ≤5 MB, or fields title+text) | workspace | ADMIN | backend/src/routes/ai-studio.ts |
| PATCH | /w/:workspaceId/ai-studio/documents/:id | AI Studio | Rename, (de)activate or replace document text | workspace | ADMIN | backend/src/routes/ai-studio.ts |
| DELETE | /w/:workspaceId/ai-studio/documents/:id | AI Studio | Delete a document | workspace | ADMIN | backend/src/routes/ai-studio.ts |
| GET | /w/:workspaceId/ai-studio/profiles | Prompt library | Prompt profiles (folders, tags, approval) | workspace | VIEWER | backend/src/routes/ai-studio.ts |
| POST | /w/:workspaceId/ai-studio/profiles | Prompt library | Create a prompt profile (version 1) | workspace | MEMBER | backend/src/routes/ai-studio.ts |
| GET | /w/:workspaceId/ai-studio/profiles/:id | Prompt library | Profile with all versions and campaigns using it | workspace | VIEWER | backend/src/routes/ai-studio.ts |
| PATCH | /w/:workspaceId/ai-studio/profiles/:id | Prompt library | Rename, move to folder, tag, approve for team use or archive | workspace | MEMBER | backend/src/routes/ai-studio.ts |
| POST | /w/:workspaceId/ai-studio/profiles/:id/versions | Prompt library | Save a new version (approved campaigns keep their frozen version) | workspace | MEMBER | backend/src/routes/ai-studio.ts |
| POST | /w/:workspaceId/ai-studio/profiles/:id/versions/:versionId/activate | Prompt library | Activate an earlier version | workspace | MEMBER | backend/src/routes/ai-studio.ts |
| GET | /w/:workspaceId/ai-studio/profiles/:id/compare | Prompt library | Compare two versions (line diff + settings) | workspace | VIEWER | backend/src/routes/ai-studio.ts |
| POST | /w/:workspaceId/ai-studio/profiles/:id/duplicate | Prompt library | Duplicate a profile | workspace | MEMBER | backend/src/routes/ai-studio.ts |
| POST | /w/:workspaceId/ai-studio/profiles/lint | Prompt library | Check prompt syntax and variables | workspace | VIEWER | backend/src/routes/ai-studio.ts |
| GET | /w/:workspaceId/ai-studio/profiles-export | Prompt library | Export profiles as JSON | workspace | MEMBER | backend/src/routes/ai-studio.ts |
| POST | /w/:workspaceId/ai-studio/profiles-import | Prompt library | Import profiles from an export file | workspace | MEMBER | backend/src/routes/ai-studio.ts |
| POST | /w/:workspaceId/ai-studio/profiles/:id/test | Prompt library | Test the profile on a sample lead (real AI call, costs recorded; nothing is saved to campaigns) | workspace | MEMBER | backend/src/routes/ai-studio.ts |
| PUT | /w/:workspaceId/leads/:id/ai-instructions | Personalization | Set instructions for this individual prospect (applied last in the hierarchy) | workspace | MEMBER | backend/src/routes/ai-studio.ts |
| PUT | /w/:workspaceId/campaigns/:id/ai | Personalization | Campaign AI profile, ICP, overrides and cost limit (requires re-approval) | workspace | MEMBER | backend/src/routes/ai-studio.ts |
| GET | /w/:workspaceId/campaigns/:id/personalizations | Personalization | Per-lead generated content, status, score, warnings and cost | workspace | VIEWER | backend/src/routes/ai-studio.ts |
| GET | /w/:workspaceId/campaigns/:id/personalizations/lead/:leadId | Personalization | Review one recipient: research, evidence, every step, warnings, cost | workspace | VIEWER | backend/src/routes/ai-studio.ts |
| GET | /w/:workspaceId/campaigns/:id/personalizations/prompt-preview | Personalization | Resolved instructions and prompt for one lead/step (no AI call) | workspace | VIEWER | backend/src/routes/ai-studio.ts |
| POST | /w/:workspaceId/campaigns/:id/personalizations/generate | Personalization | Generate (or regenerate with force) one lead/step now | workspace | MEMBER | backend/src/routes/ai-studio.ts |
| POST | /w/:workspaceId/campaigns/:id/personalizations/estimate | Personalization | Estimate cost of bulk generation | workspace | MEMBER | backend/src/routes/ai-studio.ts |
| POST | /w/:workspaceId/campaigns/:id/personalizations/batches | Personalization | Start bulk generation (queued; approved and manually edited content is preserved unless force) | workspace | MANAGER | backend/src/routes/ai-studio.ts |
| GET | /w/:workspaceId/campaigns/:id/personalizations/batches | Personalization | Bulk generation runs | workspace | VIEWER | backend/src/routes/ai-studio.ts |
| POST | /w/:workspaceId/personalization-batches/:batchId/cancel | Personalization | Cancel a running batch | workspace | MANAGER | backend/src/routes/ai-studio.ts |
| POST | /w/:workspaceId/campaigns/:id/personalizations/retry-failed | Personalization | Re-queue failed generations | workspace | MANAGER | backend/src/routes/ai-studio.ts |
| POST | /w/:workspaceId/campaigns/:id/personalizations/research-missing | Personalization | Queue research for recipients without recent research | workspace | MEMBER | backend/src/routes/ai-studio.ts |
| GET | /w/:workspaceId/personalizations/:pid | Personalization | One generated email with revisions, evidence and quality report | workspace | VIEWER | backend/src/routes/ai-studio.ts |
| PATCH | /w/:workspaceId/personalizations/:pid | Personalization | Manually edit (preserved; re-checked; needs approval again) | workspace | MEMBER | backend/src/routes/ai-studio.ts |
| POST | /w/:workspaceId/personalizations/approve | Personalization | Approve one or many (only when quality checks pass) | workspace | MANAGER | backend/src/routes/ai-studio.ts |
| POST | /w/:workspaceId/personalizations/:pid/reject | Personalization | Reject | workspace | MANAGER | backend/src/routes/ai-studio.ts |
| GET | /w/:workspaceId/campaigns/:id/preview | Campaigns | Exact rendered email for one lead and step (no AI call) | workspace | VIEWER | backend/src/routes/ai-studio.ts |
| POST | /w/:workspaceId/campaigns/:id/test-email | Campaigns | Send a rendered step to a workspace member’s own address | workspace | MEMBER | backend/src/routes/ai-studio.ts |
| GET | /w/:workspaceId/campaigns/:id/versions | Campaigns | Sequence version history (one per approval) | workspace | VIEWER | backend/src/routes/ai-studio.ts |
| POST | /w/:workspaceId/campaigns/:id/versions/:version/restore | Campaigns | Restore an approved version into the editor (needs re-approval) | workspace | MANAGER | backend/src/routes/ai-studio.ts |
| POST | /w/:workspaceId/campaigns/:id/duplicate | Campaigns | Clone a campaign (no recipients, sends or approvals) | workspace | MEMBER | backend/src/routes/ai-studio.ts |
| GET | /w/:workspaceId/reply-suggestions | Reply assistant | AI reply drafts / suggestions / auto-reply log | workspace | VIEWER | backend/src/routes/assist.ts |
| POST | /w/:workspaceId/reply-suggestions/:id/approve | Reply assistant | Approve (optionally edited) and send from the original mailbox | workspace | MEMBER | backend/src/routes/assist.ts |
| POST | /w/:workspaceId/reply-suggestions/:id/dismiss | Reply assistant | Dismiss a suggestion | workspace | MEMBER | backend/src/routes/assist.ts |
| POST | /w/:workspaceId/conversations/:id/suggest | Reply assistant | Generate an AI suggestion for the latest inbound message now | workspace | MEMBER | backend/src/routes/assist.ts |
| GET | /w/:workspaceId/reply-templates | Reply assistant | Reply templates (only approved ones can be auto-sent) | workspace | VIEWER | backend/src/routes/assist.ts |
| POST | /w/:workspaceId/reply-templates | Reply assistant | Create a reply template | workspace | MEMBER | backend/src/routes/assist.ts |
| PUT | /w/:workspaceId/reply-templates/:id | Reply assistant | Edit a template (resets approval) | workspace | MEMBER | backend/src/routes/assist.ts |
| POST | /w/:workspaceId/reply-templates/:id/approve | Reply assistant | Approve / withdraw a template for auto-reply use | workspace | MANAGER | backend/src/routes/assist.ts |
| DELETE | /w/:workspaceId/reply-templates/:id | Reply assistant | Delete a template | workspace | MANAGER | backend/src/routes/assist.ts |
| GET | /w/:workspaceId/copilot/threads | Copilot | My Copilot conversations | workspace | VIEWER | backend/src/routes/assist.ts |
| GET | /w/:workspaceId/copilot/threads/:id | Copilot | Conversation with messages and proposed actions | workspace | VIEWER | backend/src/routes/assist.ts |
| POST | /w/:workspaceId/copilot/ask | Copilot | Ask the Copilot (answers + recommendations + proposed actions; nothing is executed) | workspace | VIEWER | backend/src/routes/assist.ts |
| POST | /w/:workspaceId/copilot/actions/:id/execute | Copilot | Confirm and run a proposed action (role-checked, runs once) | workspace | MEMBER | backend/src/routes/assist.ts |
| POST | /w/:workspaceId/copilot/actions/:id/reject | Copilot | Reject a proposed action | workspace | VIEWER | backend/src/routes/assist.ts |
| GET | /w/:workspaceId/copilot/repetition | Copilot | Find repetitive wording across generated emails | workspace | VIEWER | backend/src/routes/assist.ts |
| GET | /w/:workspaceId/copilot/memory | Copilot | Business memory | workspace | VIEWER | backend/src/routes/assist.ts |
| POST | /w/:workspaceId/copilot/memory | Copilot | Add business memory | workspace | ADMIN | backend/src/routes/assist.ts |
| DELETE | /w/:workspaceId/copilot/memory/:id | Copilot | Delete business memory | workspace | ADMIN | backend/src/routes/assist.ts |
| GET | /auth/bootstrap | Auth | Whether the first admin account still needs to be created | public | route default / handler | backend/src/routes/core.ts |
| POST | /auth/register | Auth | Create the first admin account (or register when public registration is enabled) | public | route default / handler | backend/src/routes/core.ts |
| POST | /auth/login | Auth | Log in with email + password (sets session cookie) | public | route default / handler | backend/src/routes/core.ts |
| POST | /auth/mfa/verify | Auth | Second login step: TOTP or recovery code for an MFA challenge | public | route default / handler | backend/src/routes/core.ts |
| POST | /auth/password/forgot | Auth | Email a single-use password reset link (same answer whether or not the account exists) | public | route default / handler | backend/src/routes/core.ts |
| POST | /auth/password/reset | Auth | Set a new password with a reset token (signs out all sessions) | public | route default / handler | backend/src/routes/core.ts |
| GET | /auth/mfa | Auth | My two-factor status | user | route default / handler | backend/src/routes/core.ts |
| POST | /auth/mfa/setup | Auth | Start TOTP setup (secret + QR, not active until confirmed) | user | route default / handler | backend/src/routes/core.ts |
| POST | /auth/mfa/enable | Auth | Confirm TOTP setup with a code; returns recovery codes once | user | route default / handler | backend/src/routes/core.ts |
| POST | /auth/mfa/disable | Auth | Turn off two-factor (password + current code or recovery code) | user | route default / handler | backend/src/routes/core.ts |
| POST | /auth/logout | Auth | Log out (revokes session) | user | route default / handler | backend/src/routes/core.ts |
| GET | /auth/me | Auth | Current user, CSRF token and workspaces | user | route default / handler | backend/src/routes/core.ts |
| POST | /auth/password | Auth | Change password (revokes other sessions) | user | route default / handler | backend/src/routes/core.ts |
| GET | /auth/sessions | Auth | List my active sessions | user | route default / handler | backend/src/routes/core.ts |
| DELETE | /auth/sessions/:id | Auth | Revoke one of my sessions | user | route default / handler | backend/src/routes/core.ts |
| POST | /invitations/:token/accept | Auth | Accept a workspace invitation (creates account if needed) | public | route default / handler | backend/src/routes/core.ts |
| POST | /workspaces | Workspaces | Create a workspace | user | route default / handler | backend/src/routes/core.ts |
| GET | /w/:workspaceId | Workspaces | Workspace details & settings | workspace | VIEWER | backend/src/routes/core.ts |
| PATCH | /w/:workspaceId | Workspaces | Update workspace settings (sender identity, postal address, retention, providers) | workspace | ADMIN | backend/src/routes/core.ts |
| GET | /w/:workspaceId/dashboard | Workspaces | Overview dashboard counters | workspace | VIEWER | backend/src/routes/core.ts |
| GET | /w/:workspaceId/members | Team | Members and pending invitations | workspace | VIEWER | backend/src/routes/core.ts |
| PATCH | /w/:workspaceId/members/:memberId | Team | Change a member role | workspace | ADMIN | backend/src/routes/core.ts |
| DELETE | /w/:workspaceId/members/:memberId | Team | Remove a member | workspace | ADMIN | backend/src/routes/core.ts |
| POST | /w/:workspaceId/invitations | Team | Invite a member (returns a link to share) | workspace | ADMIN | backend/src/routes/core.ts |
| DELETE | /w/:workspaceId/invitations/:id | Team | Revoke an invitation | workspace | ADMIN | backend/src/routes/core.ts |
| GET | /w/:workspaceId/api-keys | API keys | List API keys (secrets never returned) | workspace | ADMIN | backend/src/routes/core.ts |
| POST | /w/:workspaceId/api-keys | API keys | Create an API key (shown once) | workspace | ADMIN | backend/src/routes/core.ts |
| DELETE | /w/:workspaceId/api-keys/:id | API keys | Revoke an API key | workspace | ADMIN | backend/src/routes/core.ts |
| GET | /w/:workspaceId/notifications | Notifications | My notifications | workspace | VIEWER | backend/src/routes/core.ts |
| POST | /w/:workspaceId/notifications/read | Notifications | Mark notifications read (all if ids omitted) | workspace | VIEWER | backend/src/routes/core.ts |
| GET | /w/:workspaceId/audit-logs | Logs | Audit log | workspace | ADMIN | backend/src/routes/core.ts |
| GET | /w/:workspaceId/error-logs | Logs | Error log (API + worker) | workspace | ADMIN | backend/src/routes/core.ts |
| GET | /w/:workspaceId/jobs/queues | Jobs | Queue counts (all workspaces on this server) | workspace | ADMIN | backend/src/routes/core.ts |
| GET | /w/:workspaceId/jobs/failed | Jobs | Failed jobs for a queue (this workspace) | workspace | ADMIN | backend/src/routes/core.ts |
| POST | /w/:workspaceId/jobs/retry | Jobs | Retry a failed job | workspace | ADMIN | backend/src/routes/core.ts |
| GET | /w/:workspaceId/jobs/history | Jobs | Recorded job runs | workspace | ADMIN | backend/src/routes/core.ts |
| GET | /w/:workspaceId/privacy/requests | Privacy | Data export / erasure requests | workspace | ADMIN | backend/src/routes/core.ts |
| POST | /w/:workspaceId/privacy/requests | Privacy | Create an export or erasure request for one email address | workspace | ADMIN | backend/src/routes/core.ts |
| GET | /w/:workspaceId/privacy/requests/:id/download | Privacy | Download a completed export (JSON) | workspace | ADMIN | backend/src/routes/core.ts |
| GET | /w/:workspaceId/export | Privacy | Full workspace data export (JSON) | workspace | OWNER | backend/src/routes/core.ts |
| GET | /w/:workspaceId/provider-registry | Deliverability | Registrar / DNS / mailbox-provider capability registry (what is automated vs manual) | workspace | VIEWER | backend/src/routes/domains-enrichment.ts |
| POST | /w/:workspaceId/domains/:id/verification | Deliverability | Start ownership verification (returns the TXT record to add) | workspace | ADMIN | backend/src/routes/domains-enrichment.ts |
| POST | /w/:workspaceId/domains/:id/verification/check | Deliverability | Check the ownership TXT record | workspace | ADMIN | backend/src/routes/domains-enrichment.ts |
| POST | /w/:workspaceId/domains/:id/propagation | Deliverability | Compare SPF/DMARC/verification across Cloudflare, Google and Quad9 resolvers | workspace | MEMBER | backend/src/routes/domains-enrichment.ts |
| GET | /w/:workspaceId/domains/:id/recommended-records | Deliverability | DNS guidance for the mailbox providers on this domain | workspace | VIEWER | backend/src/routes/domains-enrichment.ts |
| POST | /w/:workspaceId/domains/:id/dns-records | Deliverability | Create one DNS record via the connected DNS provider (Cloudflare) — explicit action only | workspace | ADMIN | backend/src/routes/domains-enrichment.ts |
| PATCH | /w/:workspaceId/domains/:id/renewal | Deliverability | Registrar, expiry date and auto-renew (for renewal reminders) | workspace | ADMIN | backend/src/routes/domains-enrichment.ts |
| GET | /w/:workspaceId/mailbox-health | Mailboxes | Connection, auth, sync, send/receive, errors, bounces, complaints and DNS per mailbox | workspace | VIEWER | backend/src/routes/domains-enrichment.ts |
| POST | /w/:workspaceId/leads/:id/verify-waterfall | Enrichment | Verify one lead now through the verifier waterfall | workspace | MEMBER | backend/src/routes/domains-enrichment.ts |
| POST | /w/:workspaceId/enrichment/verify-bulk | Enrichment | Queue waterfall verification (skips recently verified unless force) | workspace | MEMBER | backend/src/routes/domains-enrichment.ts |
| POST | /w/:workspaceId/enrichment/find-email | Enrichment | Email discovery waterfall (name + company domain) | workspace | MEMBER | backend/src/routes/domains-enrichment.ts |
| GET | /w/:workspaceId/enrichment/stats | Enrichment | Provider comparison: checks, definitive rate, credits | workspace | VIEWER | backend/src/routes/domains-enrichment.ts |
| GET | /w/:workspaceId/leads/:id/verifications | Enrichment | Verification / enrichment history for a lead | workspace | VIEWER | backend/src/routes/domains-enrichment.ts |
| GET | /w/:workspaceId/crm/forecast | CRM | Weighted pipeline forecast, expected close by month, won revenue by month, win rate | workspace | VIEWER | backend/src/routes/insights.ts |
| GET | /w/:workspaceId/crm/opportunities/export | CRM | Export opportunities as CSV | workspace | MEMBER | backend/src/routes/insights.ts |
| GET | /w/:workspaceId/analytics/campaigns/export | Analytics | Export campaign performance as CSV | workspace | MEMBER | backend/src/routes/insights.ts |
| GET | /w/:workspaceId/saved-filters | Saved filters | My saved filters plus shared ones | workspace | VIEWER | backend/src/routes/insights.ts |
| POST | /w/:workspaceId/saved-filters | Saved filters | Save a filter (optionally shared with the workspace) | workspace | VIEWER | backend/src/routes/insights.ts |
| DELETE | /w/:workspaceId/saved-filters/:id | Saved filters | Delete my filter (managers can delete shared filters) | workspace | VIEWER | backend/src/routes/insights.ts |
| GET | /w/:workspaceId/reports | Reports | Scheduled email reports | workspace | VIEWER | backend/src/routes/insights.ts |
| POST | /w/:workspaceId/reports | Reports | Create a scheduled report (recipients must be members) | workspace | MANAGER | backend/src/routes/insights.ts |
| PUT | /w/:workspaceId/reports/:id | Reports | Update a scheduled report | workspace | MANAGER | backend/src/routes/insights.ts |
| DELETE | /w/:workspaceId/reports/:id | Reports | Delete a scheduled report | workspace | MANAGER | backend/src/routes/insights.ts |
| GET | /w/:workspaceId/reports/preview/:kind | Reports | Preview report text | workspace | VIEWER | backend/src/routes/insights.ts |
| GET | /w/:workspaceId/notification-channels | Notifications | Slack / email notification channels (secrets never returned) | workspace | ADMIN | backend/src/routes/insights.ts |
| POST | /w/:workspaceId/notification-channels | Notifications | Add a Slack incoming webhook or email channel | workspace | ADMIN | backend/src/routes/insights.ts |
| DELETE | /w/:workspaceId/notification-channels/:id | Notifications | Remove a channel | workspace | ADMIN | backend/src/routes/insights.ts |
| POST | /w/:workspaceId/notification-channels/test | Notifications | Send a test notification to all channels | workspace | ADMIN | backend/src/routes/insights.ts |
| PATCH | /w/:workspaceId/campaigns/:id/organize | Campaigns | Folder and tags (does not affect approval) | workspace | MEMBER | backend/src/routes/insights.ts |
| POST | /w/:workspaceId/conversations/:id/forward | Inbox | Forward a conversation from its mailbox (human action) | workspace | MEMBER | backend/src/routes/insights.ts |
| GET | /w/:workspaceId/icps | ICP | Ideal customer profiles | workspace | VIEWER | backend/src/routes/intelligence.ts |
| POST | /w/:workspaceId/icps | ICP | Create an ICP | workspace | MANAGER | backend/src/routes/intelligence.ts |
| PUT | /w/:workspaceId/icps/:id | ICP | Update an ICP | workspace | MANAGER | backend/src/routes/intelligence.ts |
| DELETE | /w/:workspaceId/icps/:id | ICP | Delete an ICP | workspace | MANAGER | backend/src/routes/intelligence.ts |
| POST | /w/:workspaceId/icps/from-text | ICP | Convert a natural-language description into structured ICP filters (AI draft) | workspace | MEMBER | backend/src/routes/intelligence.ts |
| POST | /w/:workspaceId/prospecting/search | Prospecting | Search the configured licensed data provider | workspace | MEMBER | backend/src/routes/intelligence.ts |
| POST | /w/:workspaceId/prospecting/import | Prospecting | Import selected search results (enrich, dedupe, verify, research, score) | workspace | MEMBER | backend/src/routes/intelligence.ts |
| GET | /w/:workspaceId/prospecting/searches | Prospecting | Recent searches | workspace | VIEWER | backend/src/routes/intelligence.ts |
| GET | /w/:workspaceId/prospecting/searches/:id | Prospecting | Search results | workspace | VIEWER | backend/src/routes/intelligence.ts |
| GET | /w/:workspaceId/research | Research | Research reports | workspace | VIEWER | backend/src/routes/intelligence.ts |
| GET | /w/:workspaceId/research/:id | Research | Report with claims and evidence URLs | workspace | VIEWER | backend/src/routes/intelligence.ts |
| PATCH | /w/:workspaceId/research/claims/:id | Research | Reject / restore a claim (rejected claims are never used in emails) | workspace | MEMBER | backend/src/routes/intelligence.ts |
| POST | /w/:workspaceId/writing/generate | Writing | Generate an evidence-backed email draft + fact-check | workspace | MEMBER | backend/src/routes/intelligence.ts |
| POST | /w/:workspaceId/writing/subjects | Writing | Subject line suggestions | workspace | MEMBER | backend/src/routes/intelligence.ts |
| POST | /w/:workspaceId/writing/fact-check | Writing | Fact-check any draft against the lead’s supported claims | workspace | MEMBER | backend/src/routes/intelligence.ts |
| GET | /w/:workspaceId/ai/providers | AI | Configured AI providers (key shown as last 4 only) | workspace | ADMIN | backend/src/routes/intelligence.ts |
| PUT | /w/:workspaceId/ai/providers | AI | Add/update an AI provider key and default model | workspace | ADMIN | backend/src/routes/intelligence.ts |
| DELETE | /w/:workspaceId/ai/providers/:provider | AI | Remove an AI provider | workspace | ADMIN | backend/src/routes/intelligence.ts |
| POST | /w/:workspaceId/ai/providers/:provider/test | AI | Test an AI provider connection | workspace | ADMIN | backend/src/routes/intelligence.ts |
| GET | /w/:workspaceId/ai/routes | AI | Model routing per task | workspace | ADMIN | backend/src/routes/intelligence.ts |
| PUT | /w/:workspaceId/ai/routes | AI | Set model, fallback and budget for a task | workspace | ADMIN | backend/src/routes/intelligence.ts |
| GET | /w/:workspaceId/ai/prompts | AI | Prompt versions | workspace | ADMIN | backend/src/routes/intelligence.ts |
| POST | /w/:workspaceId/ai/prompts | AI | Create a new prompt version (immutable history) | workspace | ADMIN | backend/src/routes/intelligence.ts |
| POST | /w/:workspaceId/ai/prompts/:id/activate | AI | Activate a prompt version | workspace | ADMIN | backend/src/routes/intelligence.ts |
| GET | /w/:workspaceId/ai/usage | AI | Token usage and estimated cost | workspace | MANAGER | backend/src/routes/intelligence.ts |
| GET | /w/:workspaceId/ai/executions | AI | AI response logs | workspace | ADMIN | backend/src/routes/intelligence.ts |
| GET | /w/:workspaceId/ai/prices | AI | Model price table (USD per million tokens) | workspace | ADMIN | backend/src/routes/intelligence.ts |
| POST | /w/:workspaceId/ai/prices | AI | Add a model price (owner only; applies to cost estimates) | workspace | OWNER | backend/src/routes/intelligence.ts |
| GET | /w/:workspaceId/integrations | Integrations | Provider integrations (secrets never returned) | workspace | ADMIN | backend/src/routes/intelligence.ts |
| PUT | /w/:workspaceId/integrations | Integrations | Set provider key / config | workspace | ADMIN | backend/src/routes/intelligence.ts |
| DELETE | /w/:workspaceId/integrations/:type | Integrations | Remove a provider integration | workspace | ADMIN | backend/src/routes/intelligence.ts |
| POST | /w/:workspaceId/integrations/:type/test | Integrations | Test a provider integration | workspace | ADMIN | backend/src/routes/intelligence.ts |
| GET | /w/:workspaceId/leads | Leads | Search / filter leads | workspace | VIEWER | backend/src/routes/leads.ts |
| POST | /w/:workspaceId/leads | Leads | Create a lead | workspace | MEMBER | backend/src/routes/leads.ts |
| GET | /w/:workspaceId/leads/export | Leads | Export leads as CSV (same filters as list) | workspace | MEMBER | backend/src/routes/leads.ts |
| POST | /w/:workspaceId/leads/bulk | Leads | Bulk action on leads | workspace | MEMBER | backend/src/routes/leads.ts |
| GET | /w/:workspaceId/leads/:id | Leads | Lead profile with history, research, scores, conversations | workspace | VIEWER | backend/src/routes/leads.ts |
| PATCH | /w/:workspaceId/leads/:id | Leads | Update a lead (status changes are recorded) | workspace | MEMBER | backend/src/routes/leads.ts |
| DELETE | /w/:workspaceId/leads/:id | Leads | Delete a lead | workspace | MANAGER | backend/src/routes/leads.ts |
| POST | /w/:workspaceId/leads/:id/notes | CRM | Add a note to a lead | workspace | MEMBER | backend/src/routes/leads.ts |
| DELETE | /w/:workspaceId/notes/:id | CRM | Delete a note | workspace | MEMBER | backend/src/routes/leads.ts |
| POST | /w/:workspaceId/leads/:id/verify | Leads | Verify the lead email now (uses configured verifier) | workspace | MEMBER | backend/src/routes/leads.ts |
| POST | /w/:workspaceId/leads/:id/research | Research | Queue research for a lead | workspace | MEMBER | backend/src/routes/leads.ts |
| POST | /w/:workspaceId/leads/:id/score | Qualification | Score a lead against an ICP now | workspace | MEMBER | backend/src/routes/leads.ts |
| GET | /w/:workspaceId/companies | Companies | List companies | workspace | VIEWER | backend/src/routes/leads.ts |
| GET | /w/:workspaceId/companies/:id | Companies | Company profile | workspace | VIEWER | backend/src/routes/leads.ts |
| PATCH | /w/:workspaceId/companies/:id | Companies | Update a company | workspace | MEMBER | backend/src/routes/leads.ts |
| POST | /w/:workspaceId/companies/:id/notes | CRM | Add a note to a company | workspace | MEMBER | backend/src/routes/leads.ts |
| POST | /w/:workspaceId/companies/:id/research | Research | Queue research for a company | workspace | MEMBER | backend/src/routes/leads.ts |
| GET | /w/:workspaceId/lists | Lists | Lead lists | workspace | VIEWER | backend/src/routes/leads.ts |
| POST | /w/:workspaceId/lists | Lists | Create a list | workspace | MEMBER | backend/src/routes/leads.ts |
| PATCH | /w/:workspaceId/lists/:id | Lists | Rename a list | workspace | MEMBER | backend/src/routes/leads.ts |
| DELETE | /w/:workspaceId/lists/:id | Lists | Delete a list (leads are kept) | workspace | MANAGER | backend/src/routes/leads.ts |
| GET | /w/:workspaceId/imports | Imports | Recent CSV imports | workspace | VIEWER | backend/src/routes/leads.ts |
| POST | /w/:workspaceId/imports | Imports | Upload a CSV (multipart field "file"); returns headers, sample rows and suggested mapping | workspace | MEMBER | backend/src/routes/leads.ts |
| POST | /w/:workspaceId/imports/:id/start | Imports | Start an uploaded import with a column mapping | workspace | MEMBER | backend/src/routes/leads.ts |
| GET | /w/:workspaceId/imports/:id | Imports | Import progress and row errors | workspace | VIEWER | backend/src/routes/leads.ts |
| GET | /w/:workspaceId/suppressions | Suppression | Suppression / unsubscribe list | workspace | VIEWER | backend/src/routes/leads.ts |
| POST | /w/:workspaceId/suppressions | Suppression | Add an email or domain to the suppression list | workspace | MEMBER | backend/src/routes/leads.ts |
| POST | /w/:workspaceId/suppressions/import | Suppression | Bulk import suppressions from CSV (first column = email or @domain) | workspace | MANAGER | backend/src/routes/leads.ts |
| GET | /w/:workspaceId/suppressions/export | Suppression | Export suppression list as CSV | workspace | MANAGER | backend/src/routes/leads.ts |
| DELETE | /w/:workspaceId/suppressions/:id | Suppression | Remove a suppression entry (opt-outs need a documented reason) | workspace | ADMIN | backend/src/routes/leads.ts |
| GET | /w/:workspaceId/pipeline | CRM | Opportunity pipeline by stage | workspace | VIEWER | backend/src/routes/leads.ts |
| POST | /w/:workspaceId/opportunities | CRM | Create an opportunity | workspace | MEMBER | backend/src/routes/leads.ts |
| PATCH | /w/:workspaceId/opportunities/:id | CRM | Update an opportunity (stage, value…) | workspace | MEMBER | backend/src/routes/leads.ts |
| DELETE | /w/:workspaceId/opportunities/:id | CRM | Delete an opportunity | workspace | MANAGER | backend/src/routes/leads.ts |
| GET | /w/:workspaceId/tasks | CRM | Tasks / follow-up reminders | workspace | VIEWER | backend/src/routes/leads.ts |
| POST | /w/:workspaceId/tasks | CRM | Create a task | workspace | MEMBER | backend/src/routes/leads.ts |
| PATCH | /w/:workspaceId/tasks/:id | CRM | Update / complete a task | workspace | MEMBER | backend/src/routes/leads.ts |
| DELETE | /w/:workspaceId/tasks/:id | CRM | Delete a task | workspace | MEMBER | backend/src/routes/leads.ts |
| GET | /w/:workspaceId/campaigns | Campaigns | Campaigns with headline stats | workspace | VIEWER | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/campaigns | Campaigns | Create a campaign (DRAFT) | workspace | MEMBER | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/campaigns/:id | Campaigns | Campaign with sequence, lists and mailboxes | workspace | VIEWER | backend/src/routes/outreach.ts |
| PATCH | /w/:workspaceId/campaigns/:id | Campaigns | Update settings (invalidates approval) | workspace | MEMBER | backend/src/routes/outreach.ts |
| DELETE | /w/:workspaceId/campaigns/:id | Campaigns | Delete a never-sent draft | workspace | MANAGER | backend/src/routes/outreach.ts |
| PUT | /w/:workspaceId/campaigns/:id/sequence | Campaigns | Save the email sequence (steps, delays, conditions, A/B variants) | workspace | MEMBER | backend/src/routes/outreach.ts |
| PUT | /w/:workspaceId/campaigns/:id/lists | Campaigns | Set target lead lists | workspace | MEMBER | backend/src/routes/outreach.ts |
| PUT | /w/:workspaceId/campaigns/:id/accounts | Campaigns | Set sending mailboxes (each prospect gets one fixed sender) | workspace | MEMBER | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/campaigns/:id/validate | Campaigns | Validate and preview eligible recipients | workspace | MEMBER | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/campaigns/:id/submit | Campaigns | Submit for approval | workspace | MEMBER | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/campaigns/:id/approve | Campaigns | Approve (freezes a content hash; nothing unapproved is ever sent) | workspace | MANAGER | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/campaigns/:id/start | Campaigns | Start or resume an approved campaign | workspace | MANAGER | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/campaigns/:id/pause | Campaigns | Pause a running campaign | workspace | MEMBER | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/campaigns/:id/archive | Campaigns | Archive (stops all sequences) | workspace | MANAGER | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/campaigns/:id/recipients | Campaigns | Enrollments | workspace | VIEWER | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/campaigns/:id/enroll | Campaigns | Manually enroll one lead | workspace | MEMBER | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/enrollments/:id/stop | Campaigns | Stop one prospect’s sequence | workspace | MEMBER | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/campaigns/:id/steps | Analytics | Per-step / per-variant (A/B) performance | workspace | VIEWER | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/campaigns/:id/export-smartlead | Campaigns | Optional: push this campaign’s eligible leads to a Smartlead campaign | workspace | MANAGER | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/outbound | Sending | Send history and message status | workspace | VIEWER | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/outbound/:id | Sending | One outbound email with fact-check report and evidence | workspace | VIEWER | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/outbound/:id/review | Sending | Approve (optionally edited) or reject an email awaiting review | workspace | MEMBER | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/email-accounts | Mailboxes | Connected mailboxes with today’s usage and health | workspace | VIEWER | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/email-accounts/oauth/:provider | Mailboxes | Start Google / Microsoft OAuth (returns the consent URL) | workspace | ADMIN | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/email-accounts/smtp | Mailboxes | Connect an SMTP/IMAP mailbox (only where the provider permits it) | workspace | ADMIN | backend/src/routes/outreach.ts |
| PATCH | /w/:workspaceId/email-accounts/:id | Mailboxes | Sender identity, limits and sending window | workspace | ADMIN | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/email-accounts/:id/test | Mailboxes | Test mailbox connection | workspace | ADMIN | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/email-accounts/:id/pause | Mailboxes | Pause sending from a mailbox | workspace | ADMIN | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/email-accounts/:id/resume | Mailboxes | Resume a paused mailbox | workspace | ADMIN | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/email-accounts/:id/resync | Mailboxes | Full resync of the mailbox | workspace | ADMIN | backend/src/routes/outreach.ts |
| DELETE | /w/:workspaceId/email-accounts/:id | Mailboxes | Disconnect (revokes tokens, pauses its sequences) | workspace | ADMIN | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/domains | Deliverability | Sending domains with latest SPF/DKIM/DMARC/MX status | workspace | VIEWER | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/domains | Deliverability | Add a domain (queues a DNS check) | workspace | ADMIN | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/domains/:id | Deliverability | Domain check history and guidance | workspace | VIEWER | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/domains/:id/check | Deliverability | Run a DNS check now | workspace | MEMBER | backend/src/routes/outreach.ts |
| DELETE | /w/:workspaceId/domains/:id | Deliverability | Remove a domain | workspace | ADMIN | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/conversations | Inbox | Unified inbox (search, filters, labels) | workspace | VIEWER | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/conversations/:id | Inbox | Conversation thread, notes and lead | workspace | VIEWER | backend/src/routes/outreach.ts |
| PATCH | /w/:workspaceId/conversations/:id | Inbox | Read state, status, labels, assignee, category override | workspace | MEMBER | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/conversations/:id/reply | Inbox | Send a reply from the original mailbox (queued, idempotent) | workspace | MEMBER | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/conversations/:id/notes | Inbox | Internal note on a conversation | workspace | MEMBER | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/conversations/:id/summary | Inbox | AI summary of the conversation | workspace | MEMBER | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/conversations/:id/draft | Inbox | AI reply draft (never sent automatically) | workspace | MEMBER | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/messages/:id/classify | Inbox | Re-run AI classification for a message | workspace | MEMBER | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/attachments/:id | Inbox | Download an attachment | workspace | VIEWER | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/analytics/overview | Analytics | Measured totals, rates and clearly-labelled estimates | workspace | VIEWER | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/analytics/daily | Analytics | Daily activity series | workspace | VIEWER | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/analytics/monthly | Analytics | Monthly activity | workspace | VIEWER | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/analytics/campaigns | Analytics | Campaign performance & attribution | workspace | VIEWER | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/analytics/mailboxes | Analytics | Mailbox performance | workspace | VIEWER | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/analytics/providers | Analytics | Data provider usage | workspace | VIEWER | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/compliance/rules | Compliance | Country sending rules (technical safeguards, not legal advice) | workspace | VIEWER | backend/src/routes/outreach.ts |
| PUT | /w/:workspaceId/compliance/rules | Compliance | Create/update a country rule | workspace | ADMIN | backend/src/routes/outreach.ts |
| DELETE | /w/:workspaceId/compliance/rules/:id | Compliance | Delete a country rule | workspace | ADMIN | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/compliance/check/:leadId | Compliance | Explain whether a lead can be contacted now | workspace | VIEWER | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/automations | Automation | Automation rules | workspace | VIEWER | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/automations | Automation | Create an automation rule | workspace | MANAGER | backend/src/routes/outreach.ts |
| PUT | /w/:workspaceId/automations/:id | Automation | Update an automation rule | workspace | MANAGER | backend/src/routes/outreach.ts |
| DELETE | /w/:workspaceId/automations/:id | Automation | Delete an automation rule | workspace | MANAGER | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/automations/runs | Automation | Automation run history | workspace | VIEWER | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/webhooks | Webhooks | Outbound webhooks | workspace | ADMIN | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/webhooks | Webhooks | Create a webhook (signing secret shown once) | workspace | ADMIN | backend/src/routes/outreach.ts |
| PUT | /w/:workspaceId/webhooks/:id | Webhooks | Update a webhook | workspace | ADMIN | backend/src/routes/outreach.ts |
| DELETE | /w/:workspaceId/webhooks/:id | Webhooks | Delete a webhook | workspace | ADMIN | backend/src/routes/outreach.ts |
| POST | /w/:workspaceId/webhooks/:id/test | Webhooks | Send a test delivery | workspace | ADMIN | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/webhooks/:id/deliveries | Webhooks | Recent deliveries | workspace | ADMIN | backend/src/routes/outreach.ts |
| GET | /w/:workspaceId/workflows | Workflows | List workflows | workspace | VIEWER | backend/src/routes/workflows-billing.ts |
| POST | /w/:workspaceId/workflows | Workflows | Create a workflow (version 1) | workspace | MANAGER | backend/src/routes/workflows-billing.ts |
| GET | /w/:workspaceId/workflows/:id | Workflows | Workflow with all versions | workspace | VIEWER | backend/src/routes/workflows-billing.ts |
| PUT | /w/:workspaceId/workflows/:id | Workflows | Save a new version (becomes active version) | workspace | MANAGER | backend/src/routes/workflows-billing.ts |
| DELETE | /w/:workspaceId/workflows/:id | Workflows | Delete a workflow | workspace | MANAGER | backend/src/routes/workflows-billing.ts |
| POST | /w/:workspaceId/workflows/:id/active | Workflows | Activate / deactivate | workspace | MANAGER | backend/src/routes/workflows-billing.ts |
| POST | /w/:workspaceId/workflows/:id/versions/:versionId/restore | Workflows | Make an older version active | workspace | MANAGER | backend/src/routes/workflows-billing.ts |
| POST | /w/:workspaceId/workflows/:id/run | Workflows | Run now (testMode=true is a dry run that changes nothing) | workspace | MANAGER | backend/src/routes/workflows-billing.ts |
| GET | /w/:workspaceId/workflows/:id/runs | Workflows | Execution history with per-block log | workspace | VIEWER | backend/src/routes/workflows-billing.ts |
| POST | /w/:workspaceId/workflows/:id/webhook-token | Workflows | Rotate the inbound webhook token (shown once) | workspace | ADMIN | backend/src/routes/workflows-billing.ts |
| GET | /w/:workspaceId/billing | Billing | Plan, status, entitlements, usage, invoices | workspace | VIEWER | backend/src/routes/workflows-billing.ts |
| POST | /w/:workspaceId/billing/checkout | Billing | Start hosted checkout (Stripe or Razorpay) | workspace | OWNER | backend/src/routes/workflows-billing.ts |
| POST | /w/:workspaceId/billing/portal | Billing | Open the payment provider customer portal (Stripe) | workspace | OWNER | backend/src/routes/workflows-billing.ts |
| POST | /w/:workspaceId/billing/cancel | Billing | Cancel subscription (default: at period end) | workspace | OWNER | backend/src/routes/workflows-billing.ts |
| GET | /admin/workspaces | Platform admin | All workspaces with plan and status (platform admin) | user | route default / handler | backend/src/routes/workflows-billing.ts |
| POST | /admin/workspaces/:id/subscription | Platform admin | Override plan / status / trial / entitlements (platform admin) | user | route default / handler | backend/src/routes/workflows-billing.ts |

## Verification notes

- Exact route count comes from parsing the source declarations in `backend/src/routes/*.ts`.
- No claim that every handler succeeds: the complete Vitest global setup invokes `prisma migrate deploy` and failed locally because PostgreSQL did not answer.
- `backend/src/http/router.ts` defaults an omitted workspace role to VIEWER only when route definition has no role; the handler still has its own business validation.
- Dynamic routes, status semantics, middleware and service-level workspace scoping require API integration tests.
