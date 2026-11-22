# Claude + Codex subscription AI — architecture, implementation and acceptance

Date: 2026-11-21 · Base: Mac repository at commit `3877d1d` plus your uncommitted email-verification work · Done as one pass, as requested.

## 1. Verified facts this design rests on

| Topic | What the official sources and packages say | How it was checked |
|---|---|---|
| Claude subscription auth | `claude setup-token` opens the normal browser login and **prints** a one-year OAuth token without saving it; you set it as `CLAUDE_CODE_OAUTH_TOKEN`. It can only make model requests. | Claude Code authentication docs |
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk` 0.3.330 runs the bundled Claude Code binary. `env` **replaces** process.env. Supports `outputFormat: {type:'json_schema'}`, `tools`, `permissionMode: 'dontAsk'`, `settingSources: []`, `persistSession: false`. Emits `rate_limit_event` (`allowed` / `allowed_warning` / `rejected`, `resetsAt`, `rateLimitType`, `utilization`) and `authentication_failed`. | Installed package typings. A live run with an invalid token returned `401 OAuth access token is invalid` with `api_retry error_status 401` and `assistant.error authentication_failed`. |
| Claude use rule | "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." Subscription Agent SDK use draws from your plan's limits. | Agent SDK overview and Claude Help Center article |
| Codex sign-in | `codex login --device-auth` (prints a link, a one-time code, "expires in 15 minutes"); `codex login status` → "Logged in using ChatGPT"; `codex logout`. Credentials are cached in `CODEX_HOME/auth.json`; Codex refreshes tokens itself. OpenAI recommends API keys for CI and treats ChatGPT-managed auth on private runners as advanced. | `@openai/codex` 0.171.0 `--help` and binary strings; OpenAI auth and non-interactive docs |
| Codex execution | `@openai/codex-sdk` 0.171.0 drives `codex exec`: `outputSchema`, `sandboxMode: 'read-only'`, `approvalPolicy: 'never'`, `webSearchMode`, `modelReasoningEffort`, `env` replaces process.env. Events: `turn.completed` (usage), `turn.failed`, `item.completed` (agent_message), top-level `error` (also non-fatal "Reconnecting…"). Limit text: `usage_limit_reached`, "You've hit your usage limit". | Installed typings. A live run here showed the non-fatal reconnect errors (this sandbox blocks chatgpt.com). |
| Codex App Server | Exists but is marked **experimental** in the CLI reference. The SDK is the stable, documented interface for this job, so it is used instead. | CLI reference |

Not implemented, because no official interface exists: OAuth flows of our own, cookie extraction, reusing client IDs, sending subscription tokens to raw HTTP APIs, and treating a ChatGPT login as an OpenAI API key.

## 2. Existing architecture that was reused

- **API.** Express route registry (`backend/src/http/router.ts`) with validation, rate limits, OpenAPI and the security matrix. A new `aiOwnerOnly` flag adds a central server-side owner check.
- **AI layer.** Workspace API-key providers (`AiProvider`, adapters in `integrations/src/ai`, `runAi()` with routing and fallbacks, `AiExecution` cost log). It is **unchanged**. Workflow stages that use an API provider call the same adapters and log `AiExecution` rows, but never go through the automatic fallback chain.
- **Research data.** Existing `ResearchReport`/`ResearchClaim` evidence feeds the "Saved research evidence" stage input, so stages without web access still have verified facts.
- **Queues.** BullMQ helpers, worker wrapper (timeouts, job-run log, dead letters), graceful shutdown.
- **Security.** Platform roles and staff 2FA, `platformAudit`, the AES-GCM `Keyring`, log redaction, tenant-guard triggers (regenerated for the new tables).
- **UI.** Existing design system (Card, Tabs, Field, Badge…), brand `#d134a0`, React Query hooks.

## 3. Design

```
Browser (owner only) ──HTTPS──► API (Express)
   Settings → AI providers         ├─ aiOwnerOnly gate (email allowlist + SUPER_ADMIN + 2FA; 404 for everyone else; never API keys or support access)
     · subscription cards          ├─ connections: Claude token (encrypted, dedicated key) / Codex device sign-in (official CLI)
     · AI Workflow Builder         ├─ workflows, stage templates, playbook versions (owner-scoped)
     · Writing Playbook            └─ runs (workspace + lead scoped) ──► BullMQ
     · AI queue                                                     ├─ ai-sub-claude    ─┐
   Lead → Generate emails                                           ├─ ai-sub-codex     ─┼─► worker: one job = one stage
   Campaign → Generate with my AI                                   └─ ai-workflow-api  ─┘     ├─ token claim (no double run)
                                                                                                ├─ per-provider slots + spacing (from settings)
                                                                                                ├─ Claude: Agent SDK (env: OAuth token only)
                                                                                                ├─ Codex: Codex SDK (CODEX_HOME, ChatGPT only)
                                                                                                └─ API: existing adapters (explicit choice only)
```

**Run rules:**

- **No silent fallback.**
  - A usage limit sets the run to `PAUSED_LIMIT`, with the exact message "Claude usage limit reached — workflow paused."
  - An expired or disconnected provider sets it to `PAUSED` with instructions.
  - From there, only you decide what happens: retry, resume automatically when the limit resets, or pick another provider for that stage (that choice is audited).
- **Per-stage settings:**
  - name, enabled, provider and model, task, custom instructions, inputs (prospect, saved evidence, playbook, previous, all, or a specific earlier stage)
  - output format, variants, temperature (API) or reasoning effort (Codex)
  - web research (subscriptions only), retry attempts with exponential back-off, timeout, continue-on-error
  - condition: always / if previous succeeded / skip if provider unavailable
- **Output validation:**
  - strict JSON schemas, and the exact variant count is enforced
  - a "verified" observation without a source URL is downgraded to an assumption
  - unresolved `{{placeholders}}` are rejected
- **Never sends.** "Save as draft" stores the chosen variant on the run; nothing goes to the sending pipeline.

## 4. Files

**Added:**

- `shared/src/ai-workflows.ts`: tasks, providers, output schemas, stage schema, presets
- `ai/playbook/cold-email.md`: initial playbook, your text
- `integrations/src/ai/subscription/types.ts`, `claude-agent.ts`, `codex.ts`
- `backend/src/services/ai-subscriptions.ts`, `ai-workflows.ts`, `ai-workflow-runs.ts`
- `backend/src/routes/ai-subscriptions.ts`
- `frontend/lib/ai-workflows.ts`
- `frontend/components/ai/hooks.ts`, `subscription-cards.tsx`, `workflow-builder.tsx`, `playbook-editor.tsx`, `ai-queue.tsx`, `generate-panel.tsx`
- `prisma/migrations/20261121210000_ai_subscriptions_workflows/migration.sql`
- `tests/integration/ai-subscriptions.test.ts`, `tests/unit/ai-subscription-runners.test.ts`, `e2e/personal-ai.spec.ts`
- `docs/ai-subscriptions/ARCHITECTURE_AND_ACCEPTANCE.md`, `UBUNTU_DEPLOYMENT.md`

**Modified:**

- `prisma/schema.prisma`: new models plus relation fields on User, Workspace, Lead, Campaign
- `prisma/sql/002_tenant_guards.sql`: regenerated
- `backend/src/http/router.ts`: `aiOwnerOnly`
- `backend/src/app.ts`: route import
- `backend/src/main.ts`: stops pending Codex sign-ins on shutdown
- `backend/src/core/queues.ts`: 3 queues
- `worker/src/processors.ts`: handlers, timeouts, limit-refresh job
- `worker/src/main.ts`: concurrency, schedule, start-up recovery
- `frontend/app/w/[ws]/settings/ai/page.tsx`: owner tabs and cards; title "AI providers"
- `frontend/app/w/[ws]/leads/[id]/page.tsx`: "Generate emails" tab
- `frontend/app/w/[ws]/campaigns/[id]/page.tsx`: "Generate with my AI" tab and a recipient link
- `tests/unit/frontend-sync.test.ts`
- `playwright.config.ts`: e2e owner env
- `package.json` / `package-lock.json`: `@anthropic-ai/claude-agent-sdk@0.3.330`, `@openai/codex-sdk@0.171.0`, both pinned
- `.env.example`, `.gitignore` (`.ai-subscriptions/`), `scripts/deploy.sh` (excludes `.ai-subscriptions`)
- Regenerated: `docs/openapi.json`, `frontend/content/openapi.json`, `API_DOCUMENTATION.md`, `docs/saas/API_TENANT_SECURITY_MATRIX.md`, `docs/saas/TENANT_DATA_OWNERSHIP_MATRIX.md`
- `CHANGELOG.md`

Not touched: Firebase files and config, existing AI providers and their routes, the sending pipeline.

## 5. Database

Migration `20261121210000_ai_subscriptions_workflows` is **additive only**: 3 enums and 6 tables, no changes to existing tables.

| Table | Contents |
|---|---|
| `AiSubscriptionConnection` | One row per owner and provider: status, encrypted Claude token, hint, expiry, limits/usage, concurrency, delay, paused |
| `AiWorkflow` | Owner workflows; the presets are created on first use; `isDefault` marks the active one |
| `AiStageTemplate` | Reusable stages |
| `AiPlaybookVersion` | Versioned playbook; restoring creates a new version |
| `AiWorkflowRun` | Per workspace and lead: snapshot of the stages used, playbook version, stage outputs, research, variants, draft, pause info, one-time job token |
| `AiWorkflowStageExecution` | Execution log: stage, provider, model, status, attempt, duration, scrubbed error, token counts |

Tenant guards cover `AiWorkflowRun → Lead/Campaign` and `AiWorkflowStageExecution → AiWorkflowRun`.

## 6. Environment variables

`AI_SUBSCRIPTION_ACCESS` (`owners` default, or `all` for every account on a private instance; ignored while public sign-up is open), `AI_SUBSCRIPTION_OWNER_EMAILS`, `AI_SUBSCRIPTION_ENCRYPTION_KEY`, `AI_SUBSCRIPTION_HOME`. Optional: `CLAUDE_CODE_PATH`, `CODEX_PATH`, `AI_API_STAGE_CONCURRENCY`, `AI_API_STAGE_DELAY_MS`, `AI_PLAYBOOK_PATH`. See `.env.example`.

## 7. API routes

All routes are owner-only except `/ai-subscriptions/access`.

| Area | Routes |
|---|---|
| Access check | `GET /ai-subscriptions/access` |
| Connections | `GET /ai-subscriptions/connections` · `POST /ai-subscriptions/claude/connect` · `POST\|GET\|DELETE /ai-subscriptions/codex/login` · `POST /ai-subscriptions/:provider/test` · `PUT /ai-subscriptions/:provider/settings` · `DELETE /ai-subscriptions/:provider` |
| Workflows | `GET\|POST /ai-workflows` · `GET\|PUT\|DELETE /ai-workflows/:id` · `POST /ai-workflows/:id/duplicate\|activate` |
| Stage templates | `GET\|POST /ai-stage-templates` · `DELETE /ai-stage-templates/:id` |
| Playbook | `GET\|POST /ai-playbook` · `GET /ai-playbook/versions/:id` · `POST /ai-playbook/versions/:id/restore` |
| Queues | `POST /ai-queue/pause\|resume` |
| Runs (in a workspace) | `POST\|GET /w/:ws/ai-runs` · `GET /w/:ws/ai-runs/:id` · `POST …/pause\|resume\|cancel\|draft` · `PUT …/variants/:i` · `POST …/variants/:i/select\|regenerate` · `GET /w/:ws/ai-queue` |

The common abstraction requested in the brief is `generateEmail(prospect, options, provider)` in `ai-workflow-runs.ts`. It works for `CLAUDE_SUBSCRIPTION`, `CODEX_SUBSCRIPTION` and any `API:<provider>`, and each provider implementation stays separate.

## 8. Tests run (exact results)

| Suite | Command | Result |
|---|---|---|
| New unit tests: adapters against SDK event streams shaped like the captured ones | `npx vitest run tests/unit/ai-subscription-runners.test.ts` | 11 passed |
| New integration tests: real DB, Redis, BullMQ and worker handlers; fake subscription runners | `npx vitest run tests/integration/ai-subscriptions.test.ts` | 22 passed |
| Frontend ↔ shared vocabulary | `npx vitest run tests/unit/frontend-sync.test.ts` | 4 passed |
| Full Vitest on the merged tree (yours + this work) | `npx vitest run` | 241 passed, **3 failed**. All 3 also fail on your work alone, without these changes: `domains-enrichment` waterfall and 2 in your new `email-verification.test.ts` |
| Browser (Playwright, Chrome, fresh DB) | `E2E_DATABASE_URL=… E2E_REDIS_URL=… bash scripts/e2e.sh` | **18 passed**, including the 2 new ones and your full crawl |
| Type check backend / frontend, lint, build | `npx tsc --noEmit`, `npm run lint`, `npm run build` | OK / OK / 0 errors (warnings were already there) / OK |

## 9. Acceptance criteria

The status scale, in increasing strength:

- **Code-complete:** the code is written.
- **Tested:** automated tests pass, with fake Claude/Codex runners where a real account was needed.
- **Live:** checked against a real account. Nothing here is live: there were no accounts in this environment.

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Existing OpenAI API generation still works | Tested | Existing personalization/AI suites pass; `runAi` untouched |
| 2 | Existing providers remain functional | Tested | Same; provider routes unchanged |
| 3 | Claude connects via the supported flow | Tested (live: **needs your token**) | Token validation, encryption, test call, expiry handling; real-401 mapping captured |
| 4 | Codex connects via ChatGPT sign-in | Tested (live: **needs your account**) | Device-flow parsing of the CLI's real text; API-key sign-ins refused |
| 5 | Both enabled together | Tested | Integration test |
| 6–9 | Claude only, Codex only, Claude → Codex, Codex → Claude | Tested | Provider per stage asserted; humanization receives the research and drafts |
| 10–11 | Custom workflows saved, reordered, edited | Tested (API + browser) | Integration test and e2e |
| 12 | Playbook changes affect later generations | Tested | The new rule appears in the next prompt |
| 13 | Three distinct variants | Tested (pipeline) | The count is enforced; whether the content really differs depends on the model and is **not verifiable without a live account** |
| 14 | Pause and resume | Tested | Integration test |
| 15 | Limits don't crash campaigns | Tested | Pause with the exact message; the sending pipeline is not involved |
| 16 | No paid API fallback without permission | Tested | Paid adapter call count stays 0; an override needs an explicit choice and is audited |
| 17 | Credentials not in responses or logs | Tested | A token injected into errors is scrubbed from every response, log and record |
| 18 | Non-admins blocked | Tested (API + browser) | 404 for other users, other staff, owner without 2FA, API keys, support access |
| 19 | Worker restart keeps auth | Tested (recovery logic) / **not verified on Ubuntu** | Token in DB; Codex `auth.json` on persistent disk; stage-claim recovery test |
| 20 | Drafts edited and saved | Tested | Edit, select, regenerate one, save draft; 0 outbound emails |

## 10. Not implemented / not verified

- No live call to Claude or Codex was possible here. Real limit messages, real expiry, real three-variant quality and Ubuntu systemd behaviour must be checked on your server (deployment guide, section 7).
- **Usage numbers.**
  - Claude: the SDK reports utilization and reset time when it sends rate-limit events.
  - Codex: no remaining-quota figure is available through the SDK, so the card shows a limit only when one is hit.
- **Temperature.** The Claude subscription path has no temperature setting, so the UI says "Not adjustable". Codex uses reasoning effort instead.
- **Codex `auth.json`.** It is protected by file permissions, not app encryption, because Codex must refresh it in place.
- **Playbook storage.** `ai/playbook/cold-email.md` is the shipped starting point. Edits are saved as versions in the database so they survive deploys; the file is not rewritten from the UI.
- **Drafts.** Drafts are saved on the generation run, not pushed into a campaign's approval queue. That was deliberate, so nothing can be sent by accident.
