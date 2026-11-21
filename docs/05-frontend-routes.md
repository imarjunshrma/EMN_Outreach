# 05 — Frontend routes

Next.js 15 App Router, React 19, TanStack Query, Tailwind. Basic, functional UI (no design system).
All data comes from the API (`/api/v1/...`) through `lib/api.ts` (adds `X-CSRF-Token`, maps errors);
realtime updates via `useRealtime()` (SSE). Navigation is filtered by role; the API enforces roles anyway.

## Public / account
| Route | Purpose |
|---|---|
| `/` | Redirects to the last workspace, `/select-workspace` or `/login` |
| `/login` | Email + password sign-in |
| `/setup` | First-run owner + workspace creation (only while no user exists) |
| `/invite/[token]` | Accept an invitation (create account or attach to existing) |
| `/select-workspace` | Choose / create a workspace |
| `/oauth-error` | Readable OAuth failure page |
| `/u/[token]` | Recipient unsubscribe page (posts to the one-click endpoint) |

## Workspace (`/w/[ws]/...`)
| Group | Route | Purpose |
|---|---|---|
| Overview | `` (dashboard) | Today's sends, replies, meetings, health warnings, recent activity, chart |
| | `analytics` | Campaign, step, variant and mailbox metrics; measured vs estimated clearly labelled |
| Prospects | `prospecting` | ICP-driven Apollo search, preview, import selected into a list |
| | `leads`, `leads/[id]` | Lead table (filters, bulk actions, export), lead detail (profile, research, scores, emails, timeline, notes, tasks, status) |
| | `leads/import` | CSV upload → column mapping → preview → import job progress |
| | `leads/lists` | Lead lists |
| | `companies`, `companies/[id]` | Companies and their leads/research |
| | `icps` | Ideal customer profiles (manual or AI draft from text) |
| | `research`, `research/[id]` | Research reports with evidence and claim status |
| Outreach | `writing` | AI writing studio: generate, fact-check, subject lines, edit |
| | `campaigns`, `campaigns/[id]` | Campaign list; detail tabs: sequence builder (steps, delays, conditions, variants), settings (window, limits, thresholds, tracking), audience (lists), senders, review & approval, recipients, send log, results |
| | `followups` | Due follow-ups and per-email review queue |
| | `inbox`, `inbox/[id]` | Unified inbox with category filters; thread view, classification override, AI draft, reply, summary |
| CRM | `pipeline` | Opportunities by stage |
| | `tasks` | Tasks & reminders |
| | `automations` | Rule list, create/edit, run history |
| Deliverability | `email-accounts` | Connect Google / Microsoft / SMTP; limits, windows, status, reconnect, sync now |
| | `domains`, `domains/[id]` | SPF/DKIM/DMARC/MX checks and history |
| | `settings/suppression` | Suppression list (add, import, export, remove) |
| Settings | `settings/ai` | Providers, model routes per task, prompts (versions), budgets, prices |
| | `usage` | AI usage & cost (estimates flagged) |
| | `settings/integrations` | Apollo, MillionVerifier, Brave/Serper, Smartlead, booking secret; test buttons |
| | `settings/api-keys`, `settings/webhooks` | API keys; outgoing webhooks + delivery log |
| | `settings/general`, `settings/team`, `settings/compliance` | Workspace settings; members/invitations/roles; country rules |
| | `settings/audit`, `settings/jobs`, `settings/logs` | Audit log; queue monitor + retry; error log |
| | `settings/privacy`, `settings/account` | Export/erasure requests; own password and sessions |
| | `notifications` | Notification centre |

Verification: `tsc --noEmit` clean and `next build` succeeds (47 routes). No component tests yet.
