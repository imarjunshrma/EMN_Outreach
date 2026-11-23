# 14 — Instantly feature-parity audit (November 2026)

This audit compares Outvexa 1.1.0 with Instantly's feature set as Instantly and independent reviewers described it in late 2026. The Instantly side comes from public pages, not from hands-on testing of an Instantly account.

**What Instantly offers (per its public pages and reviews):**
- **Lead Finder (formerly SuperSearch).** A 450M+ B2B contact database with waterfall enrichment across about seven providers. Verification is metered on a credit system.
- **AI Copilot.** Writes sequences, finds leads, runs recurring tasks and summarizes analytics.
- **AI Reply Agent.** Works in human-in-the-loop or autopilot mode.
- **AI Sales Agent.** Turns a website URL into a running campaign.
- **Lead Finder Agent.** Refills campaigns with new leads automatically.
- **AI Deliverability Agent.** Watches DNS, blocklists, bounces and complaints.
- **Unibox.** A unified inbox with sentiment labels.
- **Inbox Placement tests.** Automated tests covering 94 blacklists.
- **Sending infrastructure.**
  - Unlimited sending accounts.
  - Done-for-you domains and mailboxes.
  - A warm-up network of about 4.2M accounts.
- **CRM, website visitor identification and an API.**

Classification key:
- **Full**: implemented and covered by automated tests (fake providers where external).
- **Partial**: some of the capability exists.
- **Missing**: not built.
- **External**: needs a third-party service or credentials, or approval from one.

A feature marked External cannot be called working until it has been tested against the live service.

| Area | Instantly | Outvexa 1.1.0 | Class |
|---|---|---|---|
| Email account management | Unlimited accounts, OAuth/SMTP, health | Google OAuth, Microsoft 365 OAuth and SMTP/IMAP. Encrypted tokens, health status, reauth flow, daily limits and sending windows per mailbox | Full (code) · External (live OAuth apps) |
| Domain & mailbox provisioning | Done-for-you domains and inboxes, DNS automation | DNS checks with history, TXT ownership verification, propagation across 3 resolvers, recommended records with confirmed one-record apply via Cloudflare, renewal reminders, mailbox health, capability registry. No registrar purchasing or mailbox provisioning (no reviewed APIs) | Partial · External (registrar or provider APIs) |
| Warm-up | 4.2M-account engagement network | **Deliberately not built.** Artificial engagement is excluded by policy | Out of scope (by design) |
| Mailbox rotation | Rotates across many inboxes | **Deliberately not built.** Each lead keeps one fixed sender | Out of scope (by design) |
| Campaign builder | Steps, variants, scheduling | Multi-step sequences, A/B variants, delays, conditions, sending windows, approval with content hash, scheduled start, cloning, version history, per-lead preview, test emails | Full |
| Email sequences | Subsequences on events | Linear steps with conditions (opened / not opened) and automatic stop on reply, unsubscribe or bounce. No event-triggered subsequences | Partial |
| Personalization | Variables, spintax, AI lines | Template variables, plus per-lead AI emails grounded in research evidence. Instructions combine in a hierarchy, prompt profiles have versions, and every email goes through quality control. No spintax: emails are generated, not spun | Full (deeper than spintax) |
| AI Copilot | Chat assistant that also takes actions | Copilot answering from workspace data, with allow-listed actions that need role-checked confirmation and run once. It cannot send email or start campaigns (v1.2) | Full (code) · External (AI key) |
| AI enrichment | AI web research on leads | Research agent: company website plus search covering news and podcasts/interviews. Claims must quote the source, and each source's URL and retrieval time are stored. Results are scored against the ICP | Full (code) · External (search API key) |
| Lead finder | 450M+ own database | Apollo search through an adapter, plus CSV import. **No proprietary database** | Partial · External (Apollo plan) |
| Contact verification | Built in, credits | MillionVerifier adapter. Results are stored, and invalid addresses are never emailed | Full (code) · External (key) |
| Waterfall enrichment | 7-provider waterfall | 3-verifier waterfall in a configurable order with freshness skip, disposable-domain list, per-step credits and provider comparison, plus a Hunter finder (v1.2) | Full (code) · External (keys) |
| Company research | AI web research | Same research agent as AI enrichment, with research rules set in AI Studio | Full (code) · External (search key optional) |
| Unified inbox | Unibox | Unified inbox with threading, bounce and auto-reply detection, AI classification into 11 categories, and replies sent from the original mailbox | Full |
| AI reply assistant | Reply Agent (human-in-the-loop or autopilot) | Suggest / draft for approval (default) / narrow auto mode, which sends only an approved template for allow-listed categories, once per conversation, never for pricing or complaints. Template approval workflow (v1.2) | Full (narrow by design) |
| Analytics | Campaign/step/variant, revenue | Campaign, step, variant, mailbox and AI-cost analytics. Opens are labelled as estimates | Full (no revenue attribution) |
| A/B testing | Up to 26 variants | Up to 5 variants per step with weights. AI variants can each have their own angle | Partial (variant count) |
| CRM & pipeline | Built-in CRM | Opportunities by stage, tasks, notes, timeline, weighted forecast, won-by-month, win rate, CSV export, saved filters (v1.2) | Full |
| Workflow automation | Automations, Copilot-built | Visual builder: nested if/else, 12 actions, versions, dry-run test mode, execution log, daily and webhook triggers. Simple rules are kept as well (v1.2) | Full (not Copilot-built) |
| Team collaboration | Workspaces, roles | Workspaces, 5 roles, invitations, API keys, audit log | Full |
| API & webhooks | v2 API, webhooks | 284 REST operations with generated OpenAPI docs, signed webhooks, scoped API keys | Full |
| Deliverability monitoring | Placement tests, blocklists, Deliverability Agent | DNS checks, bounce and complaint thresholds with auto-pause, mailbox health. No seed-list placement tests and no blocklist monitoring | Partial · External (placement-test provider) |
| Suppression & compliance | Unsubscribe, blocklist | Suppression by email and domain, RFC 8058 one-click unsubscribe, country rules, privacy export and erasure, retention, append-only audit log | Full |
| Reporting & exports | CSV exports | CSV exports (leads, suppressions, opportunities, campaigns), workspace JSON export, scheduled email reports, Slack and email alerts (v1.2) | Full · External (system SMTP, Slack) |
| Website visitor ID | Built in | Not built | Missing |
| AI Sales Agent (URL → campaign) | Built in | Not built. Campaigns are configured by people | Missing |

## Gaps this release closed (Parts 1–7 of the AI personalization brief)

- **AI Studio.** Versioned business knowledge (with reference documents), writing rules and research rules.
- **Models and budgets.** Per-task maximum input tokens, a workspace monthly budget, a maximum cost per lead, and redacted prompt logs.
- **Campaign-specific AI profiles** with a documented precedence order: workspace → profile → campaign → ICP → step → variant → prospect.
- **Per-lead personalization engine:**
  - Inputs: research evidence, business knowledge and the previous emails in the sequence.
  - Checks: an independent fact-check and 10 deterministic quality checks.
  - Score: a personalization score with an explanation.
  - Records: revision history and per-lead cost tracking.
- **Prompt library.** Variables and conditionals, versions with comparison, folders, tags, approval, duplicate, import/export, and testing on a sample lead.
- **Bulk generation.** Cost estimate, batch cost cap, cancel, and retry of failed items.
- **Approval-safe sending.** The send engine only sends approved personalized content and never calls AI at send time. Approved campaigns run on an AI configuration that is frozen at approval.
- **Campaign editor.** Per-lead preview, test emails (to members only), versions with restore, and cloning.

## Remaining gaps, in recommended order (after v1.2)

v1.2 closed the Copilot, reply-mode, waterfall, visual-workflow and scheduled-report gaps.

1. **Inbox placement testing** through a seed-list provider.
2. **Subsequences and meeting-booked branches** inside sequences (workflows cover event-driven actions).
3. **Revenue attribution** beyond campaign → opportunity.
4. **Registrar and mailbox-provisioning adapters**, built only where official APIs exist.
