# Complete product feature inventory — Outvexa

Generated from the code on 22 November 2026 (API tables from the live route registry, pages from the `frontend/app` tree), then annotated. Counts are exact at the time of writing.

## Size of the product

| Item | Count |
|---|---|
| API operations | 410 (public 10, signed-in user 38, workspace 308, organization 20, platform staff 34) |
| API areas (tags) | 46 |
| Frontend pages | 94 (59 inside a workspace, 11 platform console, 24 public, account and onboarding) |
| Database models / enums | 111 / 50 |
| Migrations | 13 |
| Backend services / route modules | 38 / 12 |
| Background queues | 12 (scheduler, outbound-prepare, send, reply-send, mailbox-sync, ai, research, import, verify, domain-health, maintenance, automation) |
| Automated tests | 278 unit and integration tests in 33 files; 18 browser tests in 5 files |

## Modules

| Module | What it does | Main tests |
|---|---|---|
| Accounts and sign-in | Sign-up, email verification, password reset, sessions, two-factor, invitations | `auth-isolation`, `saas` e2e |
| Organizations and workspaces | Multi-tenant organizations with workspaces, roles (Owner, Admin, Billing, Member at organization level; Owner, Admin, Manager, Member, Viewer in a workspace) | `multi-tenant`, `tenant-guards` (unit), `saas` e2e |
| Leads and companies | Leads, companies, lists, saved filters, CSV import with mapping, notes, tasks | `leads-import` |
| Email verification | First-party syntax, DNS, disposable, role and free-provider checks; JSON and CSV batches; export; optional SMTP probing (off by default, never sends mail) | `email-verification*` |
| Enrichment | Waterfall of finders and verifiers, workspace dictionaries | `domains-enrichment` |
| Mailboxes | Google and Microsoft OAuth, SMTP/IMAP, limits, readiness ramp, sync, diagnostics | `mailboxes`, `mailbox-diagnostic`, `smtp-imap` (unit) |
| Domains and deliverability | Ownership verification, SPF/DKIM/DMARC checks, Cloudflare DNS records | `domains-enrichment`, `ops-dns-v14` |
| Campaigns | Sequences, steps, variants, scheduling windows, sending engine, suppression, compliance checks | `campaign-engine` |
| Inbox | Threads, reply classification, suggested replies, approvals | `inbox-replies` |
| AI | Research, personalization, Copilot, AI studio, provider routing, personal Claude/Codex subscriptions (private instances only) | `ai-research`, `ai-subscriptions`, `personalization`, `outreach-brain` |
| Workflows and automation | Triggers on replies, stages and schedules | `workflows-billing`, `assist-copilot` |
| Analytics and reports | Dashboards, campaign and mailbox metrics | `crm-insights`, `app` e2e |
| Billing | Plans, trials, Stripe and Razorpay gateways, metering, invoices, refunds (disabled on self-hosted installs) | `billing-v14` |
| Platform console (super admin) | Tenants, lifecycle, subscriptions, plans, support access, user accounts, operations, audit, **staff and roles, permission matrix, global settings, tenant members, modules and limits** (new) | `platform-admin`, `saas` e2e |
| Public website and docs | Marketing pages, pricing, legal drafts, guides, generated API reference | `saas` e2e, `crawl` e2e |

## API areas (from the route registry)

| Area (API tag) | Operations | Access | Roles / permissions used | Examples |
|---|---|---|---|---|
| AI Outreach Brain | 11 | workspace | VIEWER, ADMIN | Training status, rules, examples, draft decisions and pending learning; List workspace rules with conflict warnings; Create an outreach rule |
| AI Studio | 11 | workspace | VIEWER, ADMIN | Active configuration versions, documents, profiles and AI spend this m; Active business knowledge / writing / research configuration; Save a new version (validated; becomes active) |
| AI subscriptions | 36 | user, workspace | MEMBER | Whether the signed-in user may use personal AI subscriptions; Subscription connection status (no credentials are returned); Connect Claude with a token from `claude setup-token` |
| AI | 14 | workspace | ADMIN, MANAGER, OWNER | Configured AI providers (key shown as last 4 only); Add/update an AI provider key and default model; Remove an AI provider |
| API keys | 3 | workspace | ADMIN | List API keys (secrets never returned); Create an API key (shown once); Revoke an API key |
| Account | 1 | user | — | Platform-wide announcement to show to signed-in users, if any |
| Analytics | 8 | workspace | VIEWER, MEMBER | Per-step / per-variant (A/B) performance; Measured totals, rates and clearly-labelled estimates; Daily activity series |
| Auth | 19 | public, user | — | Whether the first admin account still needs to be created; Create the first admin account (or register when public registration i; Log in with email + password (sets session cookie) |
| Automation | 5 | workspace | VIEWER, MANAGER | Automation rules; Create an automation rule; Update an automation rule |
| Billing | 6 | workspace, org | VIEWER | Plan, status, usage and (for owners/billing managers) invoices of this; Plan, subscription, usage, invoices and available plans; Start hosted checkout for a plan (Stripe or Razorpay); activation only |
| CRM | 13 | workspace | MEMBER, VIEWER, MANAGER | Add a note to a lead; Delete a note; Add a note to a company |
| Campaigns | 24 | workspace | VIEWER, MEMBER, MANAGER | Campaigns with headline stats; Create a campaign (DRAFT); Campaign with sequence, lists and mailboxes |
| Companies | 3 | workspace | VIEWER, MEMBER | List companies; Company profile; Update a company |
| Compliance | 4 | workspace | VIEWER, ADMIN | Country sending rules (technical safeguards, not legal advice); Create/update a country rule; Delete a country rule |
| Copilot | 9 | workspace | VIEWER, MEMBER, ADMIN | My Copilot conversations; Conversation with messages and proposed actions; Ask the Copilot (answers + recommendations + proposed actions; nothing |
| Deliverability | 15 | workspace | VIEWER, ADMIN, MEMBER | Sending domains with latest SPF/DKIM/DMARC/MX status; Add a domain (queues a DNS check); Domain check history and guidance |
| Enrichment | 23 | workspace | MEMBER, VIEWER, MANAGER, ADMIN | Verify one lead using the workspace-selected custom or external mode; Queue lead verification using the workspace-selected custom or externa; Email discovery waterfall (name + company domain) |
| ICP | 5 | workspace | VIEWER, MANAGER, MEMBER | Ideal customer profiles; Create an ICP; Update an ICP |
| Imports | 4 | workspace | VIEWER, MEMBER | Recent CSV imports; Upload a CSV (multipart field "file"); returns headers, sample rows an; Start an uploaded import with a column mapping |
| Inbox | 10 | workspace | VIEWER, MEMBER | Unified inbox (search, filters, labels); Conversation thread, notes and lead; Read state, status, labels, assignee, category override |
| Integrations | 4 | workspace | ADMIN | Provider integrations (secrets never returned); Set provider key / config; Remove a provider integration |
| Jobs | 4 | workspace | ADMIN | Queue counts (all workspaces on this server); Failed jobs for a queue (this workspace); Retry a failed job |
| Leads | 8 | workspace | VIEWER, MEMBER, MANAGER | Search / filter leads; Create a lead; Export leads as CSV (same filters as list) |
| Lists | 4 | workspace | VIEWER, MEMBER, MANAGER | Lead lists; Create a list; Rename a list |
| Logs | 2 | workspace | ADMIN | Audit log; Error log (API + worker) |
| Mailboxes | 11 | workspace | VIEWER, ADMIN | Connected mailboxes with today’s usage and health; Start Google / Microsoft OAuth (returns the consent URL); Connect an SMTP/IMAP mailbox (only where the provider permits it) |
| Notifications | 6 | workspace | VIEWER, ADMIN | My notifications; Mark notifications read (all if ids omitted); Slack / email notification channels (secrets never returned) |
| Organizations | 16 | user, org | — | Organizations I belong to, with the workspaces I can open; Organization profile, status, plan, entitlements and usage; Update name, time zone, locale, currency, branding, billing owner |
| Personalization | 16 | workspace | MEMBER, VIEWER, MANAGER | Set instructions for this individual prospect (applied last in the hie; Campaign AI profile, ICP, overrides and cost limit (requires re-approv; Per-lead generated content, status, score, warnings and cost |
| Platform | 34 | platform | tenants:read, tenants:lifecycle, metrics:read, billing:refund, billing:read, plans:write, support:access, audit:read, staff:manage, settings:write | My platform role, permissions and whether 2FA is on (required for ever; Find user accounts by email or name; Disable (signs out everywhere) or re-enable a user account; reason req |
| Privacy | 4 | workspace | ADMIN, OWNER | Data export / erasure requests; Create an export or erasure request for one email address; Download a completed export (JSON) |
| Prompt library | 12 | workspace | VIEWER, MEMBER | Prompt profiles (folders, tags, approval); Create a prompt profile (version 1); Profile with all versions and campaigns using it |
| Prospecting | 4 | workspace | MEMBER, VIEWER | Search the configured licensed data provider; Import selected search results (enrich, dedupe, verify, research, scor; Recent searches |
| Public | 1 | public | — | Public plan catalogue (prices, limits, features) for the pricing page |
| Qualification | 1 | workspace | MEMBER | Score a lead against an ICP now |
| Reply assistant | 9 | workspace | VIEWER, MEMBER, MANAGER | AI reply drafts / suggestions / auto-reply log; Approve (optionally edited) and send from the original mailbox; Dismiss a suggestion |
| Reports | 5 | workspace | VIEWER, MANAGER | Scheduled email reports; Create a scheduled report (recipients must be members); Update a scheduled report |
| Research | 5 | workspace | MEMBER, VIEWER | Queue research for a lead; Queue research for a company; Research reports |
| Saved filters | 3 | workspace | VIEWER | My saved filters plus shared ones; Save a filter (optionally shared with the workspace); Delete my filter (managers can delete shared filters) |
| Sending | 3 | workspace | VIEWER, MEMBER | Send history and message status; One outbound email with fact-check report and evidence; Approve (optionally edited) or reject an email awaiting review |
| Suppression | 5 | workspace | VIEWER, MEMBER, MANAGER, ADMIN | Suppression / unsubscribe list; Add an email or domain to the suppression list; Bulk import suppressions from CSV (first column = email or @domain) |
| Team | 5 | workspace | VIEWER, ADMIN | Members and pending invitations; Change a member role; Remove a member |
| Webhooks | 6 | workspace | ADMIN | Outbound webhooks; Create a webhook (signing secret shown once); Update a webhook |
| Workflows | 10 | workspace | VIEWER, MANAGER, ADMIN | List workflows; Create a workflow (version 1); Workflow with all versions |
| Workspaces | 5 | user, workspace | VIEWER, ADMIN | Create a workspace; Workspace details & settings; Update workspace settings (sender identity, postal address, retention, |
| Writing | 3 | workspace | MEMBER | Generate an evidence-backed email draft + fact-check; Subject line suggestions; Fact-check any draft against the lead’s supported claims |
## Pages

- **/** (1): `/`
- **/admin** (1): `/admin`
- **/app** (1): `/app`
- **/contact** (1): `/contact`
- **/docs** (4): `/docs`, `/docs/[slug]`, `/docs/api`, `/docs/api/[tag]`
- **/features** (1): `/features`
- **/forgot-password** (1): `/forgot-password`
- **/invite** (1): `/invite/[token]`
- **/legal** (1): `/legal/[doc]`
- **/login** (1): `/login`
- **/oauth-error** (1): `/oauth-error`
- **/onboarding** (1): `/onboarding/[orgId]`
- **/org** (1): `/org/[orgId]`
- **/platform** (11): `/platform`, `/platform/audit`, `/platform/operations`, `/platform/permissions`, `/platform/plans`, `/platform/settings`, `/platform/staff`, `/platform/support`, `/platform/tenants`, `/platform/tenants/[id]`, `/platform/users`
- **/pricing** (1): `/pricing`
- **/reset-password** (1): `/reset-password/[token]`
- **/security** (1): `/security`
- **/select-workspace** (1): `/select-workspace`
- **/setup** (1): `/setup`
- **/signup** (1): `/signup`
- **/u** (1): `/u/[token]`
- **/verify-email** (1): `/verify-email/[token]`
- **/w** (59): `/w/[ws]`, `/w/[ws]/ai-studio`, `/w/[ws]/ai-studio/knowledge`, `/w/[ws]/ai-studio/models`, `/w/[ws]/ai-studio/profiles`, `/w/[ws]/ai-studio/profiles/[id]`, `/w/[ws]/ai-studio/research`, `/w/[ws]/ai-studio/training`, `/w/[ws]/ai-studio/writing`, `/w/[ws]/analytics`, `/w/[ws]/automations`, `/w/[ws]/billing`, `/w/[ws]/campaigns`, `/w/[ws]/campaigns/[id]`, `/w/[ws]/companies`, `/w/[ws]/companies/[id]`, `/w/[ws]/copilot`, `/w/[ws]/domains`, `/w/[ws]/domains/[id]`, `/w/[ws]/email-accounts`, `/w/[ws]/enrichment`, `/w/[ws]/enrichment/batches/[id]`, `/w/[ws]/followups`, `/w/[ws]/icps`, `/w/[ws]/inbox`, `/w/[ws]/inbox/[id]`, `/w/[ws]/leads`, `/w/[ws]/leads/[id]`, `/w/[ws]/leads/import`, `/w/[ws]/leads/lists`, `/w/[ws]/mailbox-health`, `/w/[ws]/notifications`, `/w/[ws]/pipeline`, `/w/[ws]/prospecting`, `/w/[ws]/reply-assistant`, `/w/[ws]/reports`, `/w/[ws]/research`, `/w/[ws]/research/[id]`, `/w/[ws]/settings/account`, `/w/[ws]/settings/ai`, `/w/[ws]/settings/api-keys`, `/w/[ws]/settings/audit`, `/w/[ws]/settings/compliance`, `/w/[ws]/settings/email-verification`, `/w/[ws]/settings/general`, `/w/[ws]/settings/integrations`, `/w/[ws]/settings/jobs`, `/w/[ws]/settings/logs`, `/w/[ws]/settings/outreach`, `/w/[ws]/settings/policies`, `/w/[ws]/settings/privacy`, `/w/[ws]/settings/suppression`, `/w/[ws]/settings/team`, `/w/[ws]/settings/webhooks`, `/w/[ws]/tasks`, `/w/[ws]/usage`, `/w/[ws]/workflows`, `/w/[ws]/workflows/[id]`, `/w/[ws]/writing`
## Marker scan

`TODO`, `FIXME` and `HACK` markers in product code: none. No "coming soon" or placeholder screens were found. Every console button added in this audit is wired to an API operation and covered by the browser walk-through.
