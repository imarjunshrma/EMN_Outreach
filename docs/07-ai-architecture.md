# 07 — AI architecture

The AI writes and classifies. It never sends email, changes lead status by itself, or acts outside its typed outputs.

## Providers and routing
- Adapters: `integrations/src/ai/anthropic.ts` uses the Messages API with a forced tool call to get structured output. `openai.ts` uses the Responses API with a strict `json_schema`; its strict-schema transform makes all properties required and allows null for optional ones.
- `AiProvider` rows hold the encrypted key and a default model per workspace.
- `AiModelRoute` sets, per task, the provider/model, an optional fallback provider/model, the max output tokens, the temperature and a monthly USD budget.
- When no route exists, the workspace's enabled providers are used in order.
- Suggested Anthropic models: `claude-haiku-5-5` for fast tasks (classification, subject lines, ICP from text) and `claude-sonnet-5-5` for quality tasks. No OpenAI model name is assumed; the admin enters one.
- Admins can edit any model name in Settings → AI.

## Tasks (typed, Zod-validated outputs in `shared/src/ai-schemas.ts`)
| Task | Output |
|---|---|
| `ICP_FROM_TEXT` | Structured ICP filters drafted from a description. The user reviews them before saving. |
| `FACT_EXTRACTION` | Facts, each with an exact quote and a source URL. |
| `LEAD_QUALIFICATION` | Fit score, reasons and risks, scored against the ICP. |
| `EMAIL_WRITING` / `FOLLOWUP_WRITING` | Subject, body and the claim ids it uses. |
| `SUBJECT_LINES` | Subject-line alternatives. |
| `FACT_CHECK` | A verdict for each statement and an overall pass/fail. |
| `REPLY_CLASSIFICATION` | One of 11 categories, a confidence score, and an OOO return date. |
| `CONVERSATION_SUMMARY`, `REPLY_DRAFT` | A summary, or a suggested reply that a person must send. |

## Orchestrator (`backend/src/services/ai.ts → runAi`)
1. Resolve the candidates: the primary route, then the fallback.
2. Check the monthly budget for the task. Exceeding it returns `AI_BUDGET_EXCEEDED`. Reply classification is exempt and always runs, so opt-outs are still detected.
3. Load the active `PromptTemplate` version for the task. Defaults are in `shared/src/prompts.ts`, seeded as v1, and admins can create new versions and activate them.
4. Call the provider. If the output fails schema validation, retry once with the validation errors. If that also fails, or the provider errors, try the next candidate.
5. Write an `AiExecution` row with the provider, model, prompt version, token counts, cost, an `isEstimate` flag (set when the model has no price row) and the status. Old outputs are cleared by the retention job.

## Prompt-injection and hallucination controls
- All fetched page text, search snippets and inbound email are passed inside `<untrusted_content>`. Any tag-like text in that content is neutralised first, and the system prompts tell the model to treat the block as data.
- **Evidence rule.** A claim is stored as SUPPORTED only if its quote appears verbatim, after whitespace normalisation, in the stored evidence text. Claims that fail this check are UNSUPPORTED.
- **Writer constraint.** The writer receives only SUPPORTED claims and the workspace's own "offer facts". It is told not to invent achievements, metrics, news or personal details.
- **Independent fact-check.** A separate `FACT_CHECK` call reviews the draft against the same evidence. A failed check blocks approval of the email when the campaign requires it (on by default).
- **Hard checks before send.** Unresolved `{{variables}}` block sending, and every email that needs review must be approved.
- Reply classification is backed by a deterministic keyword fallback for unsubscribe and complaint phrases, so a model error can never cause an opt-out to be missed.

## Cost reporting
`UsageRecord` and `AiExecution` feed Settings → Usage. Costs are calculated from the editable `AiModelPrice` table and shown as estimates. They are not invoices from the provider.
