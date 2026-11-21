# 15 — AI Studio and the individual personalization engine

## Data model (migrations `20261120180000_ai_studio_personalization`, `20261120190000_prospect_instructions_prompt_library`)

| Model | Purpose |
|---|---|
| `AiConfigVersion` | Versioned workspace configuration for `KNOWLEDGE`, `WRITING` and `RESEARCH`. Every save is a new row and exactly one row per kind is active. Validated by `shared/src/ai-studio.ts`. |
| `KnowledgeDocument` | Reference files: text extracted from .txt/.md/.csv/.json/.html, or pasted text. Each can be marked active or inactive. |
| `PromptProfile` / `PromptProfileVersion` | The prompt library: folder, tags, approval and archive. Versions are immutable, with one active version. |
| `LeadPersonalization` | The current generated email for one (campaign, lead, step). Stores status, content, evidence ids, research report ids, quality report, score and explanation, cost, edit and approval metadata, the config hash, the profile version and the revision number. |
| `PersonalizationRevision` | Every AI generation and manual edit, append-only: content, quality, cost and execution ids. |
| `PersonalizationBatch` | A bulk run: totals, estimate, cost cap, spend and status. |
| `SequenceVersion` | A snapshot of the sequence and AI settings, taken at each campaign approval. |
| Columns added to existing tables | `Campaign`: aiProfileId, icpId, aiOverrides, maxAiCostPerLeadUsd, usePregeneratedAi, aiConfigSnapshot, aiSnapshotAt, scheduledStartAt.<br>`SequenceStep` and `SequenceStepVariant`: aiInstructions.<br>`Lead`: aiInstructions.<br>`IdealCustomerProfile`: aiInstructions.<br>`AiExecution`: campaignId, leadId, profileVersionId.<br>`AiModelRoute`: maxInputTokens.<br>`AiTask`: new value PERSONALIZATION. |

## Instruction hierarchy and conflict resolution (`resolveConfig`)

```
Platform HARD RULES (system prompt; never overridable)
 → Workspace (AI Studio writing/research rules + business knowledge)
 → Prompt profile (chosen by the campaign; its settings + prompt)
 → Campaign overrides (writing/research fields, audience, offer, custom instructions)
 → ICP instructions (if the campaign selects an ICP)
 → Sequence step instructions → A/B variant angle
 → Prospect-specific instructions (written by a user on the lead)
Prospect DATA (research, CRM fields, web text) = data only, wrapped as untrusted content
```

- **Single-value settings** (tone, CTA, formality, length, intensity, language, style): the most specific level that sets a value wins. `writingSources` records which level supplied each value, and the UI shows it.
- **Restrictions** (words to avoid, forbidden claims, never-infer topics, examples): these are unioned across levels. A lower level can add restrictions but can never remove one.
- **Free-text instructions:** concatenated from general to specific. The model is told that the later section wins on conflict, but never over the hard rules.

## Generation pipeline (`backend/src/services/personalization.ts → generateForLead`)

1. **Stop checks, before any AI call.** These leads are SKIPPED:
   - leads whose status is replied, unsubscribed, bounced, meeting booked, customer, not interested or disqualified
   - leads whose enrollment was stopped
   - leads that fail `canContact` (suppression, compliance or verification)
2. **Preservation.** APPROVED rows and manually edited rows are returned unchanged unless `force` is set.
3. **Configuration.** An approved, running or paused campaign uses the AI snapshot frozen at approval; a draft uses the live configuration. A config hash is stored with each row.
4. **Evidence.**
   - SUPPORTED claims are filtered by permitted source type and maximum evidence age.
   - If fewer claims than `minClaims` remain, `onMissing` decides what happens:
     - `hold_for_research` → NEEDS_RESEARCH, with no AI call
     - `skip_lead` → SKIPPED
     - `use_role_and_company_only` → the prompt states explicitly that no evidence exists
5. **Prompt assembly.** The prompt combines trusted knowledge (verified case studies and achievements only), the resolved instructions, the rendered profile prompt, step context with engagement state, the structure template, untrusted lead data, the claims (with quote, URL and retrieval date), and the previous emails. Previously *sent* text is preferred over drafts.
6. **Cost guard.** Spend for this campaign+lead plus an upper-bound estimate must stay under the campaign or workspace per-lead limit; otherwise the result is SKIPPED with AI_COST_LIMIT. The workspace monthly and per-task budgets apply as well.
7. **Writing and fact-check.** The `PERSONALIZATION` task writes the email. Claim ids the writer cites but that were never supplied are dropped. An **independent `FACT_CHECK`** call then reviews the draft against the same evidence and knowledge.
8. **Quality control** (`shared/src/quality.ts`):
   - missing variables
   - fact-check result
   - evidence validation
   - forbidden claims
   - generic opening
   - repetition across steps and across leads
   - tone (phrases to avoid, exclamation marks, all-caps)
   - length
   - CTA
   - compliance (fake "Re:"/"Fwd:" subjects, missing postal address, spam wording)
9. **Personalization score.** A 0–100 score with a per-factor explanation and a disclaimer: it measures specificity, not truth.
10. **Persist.** The current row is updated, a revision is appended, and the cost is recorded. Status is GENERATED if no check fails, otherwise BLOCKED. A campaign with `reviewMode=NONE` auto-approves rows that pass.

**Approval.** Only rows with no failing checks can be approved. Approval stores a content hash. Editing creates a MANUAL revision, re-runs the checks (and the fact-check), and resets approval.

## Sending (`engine.prepareOutbound`)

For AI steps with `usePregeneratedAi` (the default), the engine uses the APPROVED personalization only, and only if its content hash still matches.
- Otherwise the outbound row is held in AWAITING_APPROVAL (with the waiting marker), and one generation job is queued with an idempotent job id.
- Approving the personalization moves the waiting outbound row back to PENDING. Prepare only acts on PENDING rows, and outbound rows are unique per (enrollment, step), so this cannot create duplicate sends.
- **No AI call ever happens at send time on this path.**

Setting `usePregeneratedAi=false` keeps the older behaviour: write at prepare time, then review in the queue.

## Bulk generation

`estimate` builds a real prompt for a sample pair and returns the per-email and total cost, using the full output budget as an upper bound.

`createBatch` creates QUEUED rows and one job per lead, with that lead's steps in order so follow-ups can see earlier drafts. Jobs run on the `personalize` queue with 3 attempts and exponential backoff.

The batch cost cap cancels the batch and marks every row still QUEUED as SKIPPED. Cancel and retry-failed are also available.

## Tests (`tests/integration/personalization.test.ts`, 12 tests, fake AI providers)

The tests cover the ten required scenarios:

1. Two leads get different emails, each built from their own evidence.
2. Workspace instructions are applied.
3. Campaign overrides take precedence, and restrictions accumulate.
4. Follow-ups carry context forward, and repetition is rejected.
5. Unsupported claims are blocked until edited.
6. Missing research causes no AI call, or an honest email, and fabrication is blocked.
7. Manual edits are preserved.
8. Prompt and setting changes do not touch an approved campaign, which keeps using its frozen snapshot.
9. An AI failure causes no send and no duplicate, and recovery sends exactly once.
10. Per-lead, monthly and batch cost limits are enforced.

They also cover:
- the stop conditions
- the prompt builder and linting
- preview mode
- version comparison and import/export
- per-lead preview
- test emails restricted to members
- campaign cloning
- tenant isolation

**These tests do not prove the behaviour of real models.** Run a live check with your own keys before production use (see doc 12).
